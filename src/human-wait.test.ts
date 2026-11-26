// ENG-HUMAN-WAIT-STATE: a state with `human:` waits for the task's owner without holding a window slot. Entering it
// moves the queue line to `awaiting` (the next line is admitted), an answer marks it answered, and the pick resumes an
// answered line before any pending one, by priority then the longest wait; a `human_gate:` line never lands unpassed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./dashboard.js";
import { formatQueueNext } from "./tools.js";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import {
  addQueueLine,
  describeQueue,
  editQueueLine,
  formatPickSummary,
  formatTask,
  gateDue,
  markAnswered,
  markAwaiting,
  markQueue,
  pickQueue,
  planPick,
  readQueue,
} from "./queue.js";
import { Storage } from "./storage.js";
import { cleanupDir, createTestEngine, createTestLoader, InMemoryStorage } from "./test-helpers.js";
import type { Loader as LoaderType } from "./loader.js";

vi.mock("claude-code", () => ({ atom: () => ({}), read: () => ({}), update: () => ({}) }));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const tmp = (tag: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `wf-human-${tag}-`));
  dirs.push(d);
  return d;
};

/** A git repo with one commit (no global git config needed). */
function repo(dir: string): string {
  const r = path.join(dir, "repo");
  fs.mkdirSync(r);
  const git = (...a: string[]) =>
    spawnSync("git", ["-C", r, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
      encoding: "utf8",
    });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "first");
  return r;
}

const WF = {
  look: {
    name: "look",
    initial: "work",
    max_transitions: 50,
    states: {
      work: {
        prompt: "work on it",
        max_visits: 2,
        on_exhausted: "blocked",
        transitions: { done: "hold" },
      },
      hold: {
        prompt: "the owner looks",
        max_visits: 4,
        on_exhausted: "blocked",
        human: {
          question: "Look at {{context.task}}",
          show: ["http://127.0.0.1:9/{{context.task}}", "a.md\nb.md"],
          answer_key: "owner_words",
          passes: ["go"],
          stop: "touch stopped-{{context.task}}",
        },
        transitions: { go: "land", fix: "work", close: "closed" },
      },
      land: { prompt: "land it", transitions: { finish: "done" } },
      blocked: { terminal: true, outcome: "fail" },
      closed: { terminal: true, outcome: "complete" },
      done: { terminal: true, outcome: "complete" },
    },
  },
};

async function queueOf(dir: string, lines: Record<string, unknown>[], window = 1): Promise<string> {
  fs.mkdirSync(path.join(dir, "q"), { recursive: true });
  const q = path.join(dir, "q", "queue.yaml");
  fs.writeFileSync(q, `batch_size: ${window}\ntasks: []\n`);
  for (const l of lines)
    await addQueueLine(q, {
      status: "pending",
      difficulty: 3,
      touches: [`src/${String(l.id)}`],
      ...l,
    });
  return q;
}

/** A task session of `look` for line A (running), its repo a git checkout, beside a pending line B. */
async function taskSetup(extra: Record<string, unknown> = {}) {
  const d = tmp("task");
  const cwd = repo(d);
  const queue = await queueOf(d, [
    { id: "A", human_gate: "look", text: "line A", ...extra },
    { id: "B", text: "line B" },
  ]);
  await markQueue(queue, "A", "running", undefined, { force: "test" });
  const t = createTestEngine(WF);
  const s = await t.engine.start("look", undefined, undefined, cwd, undefined, {
    task: "A",
    queue_file: queue,
  });
  return { ...t, sid: s.sessionId, queue, cwd };
}

const lineOf = (queue: string, id: string) => readQueue(queue).lines.find(l => l.id === id)!;

describe("entering a human wait frees the slot", () => {
  it("the line goes awaiting with the question, the next line is admitted, and the reply hands back AWAITING", async () => {
    const { engine, sid, queue } = await taskSetup();
    expect(planPick(readQueue(queue)).admitted.map(a => a.id)).toEqual([]);
    const r = await engine.transition(sid, "done");
    expect(r.currentStateName).toBe("hold");
    expect(r.prompt).toContain(`HUMAN WAIT task=A session=${sid}`);
    expect(r.prompt).toContain(`AWAITING task=A session=${sid} question=Look at A`);
    const a = lineOf(queue, "A");
    expect(a.status).toBe("awaiting");
    expect(a.humanWait).toMatchObject({ session: sid, state: "hold", question: "Look at A" });
    expect(a.humanWait?.show).toEqual(["http://127.0.0.1:9/A", "a.md", "b.md"]);
    // window 1: the awaiting line holds no slot, so B is admitted
    expect(planPick(readQueue(queue)).admitted.map(a => a.id)).toEqual(["B"]);
    // nothing else can take A: it is not pending, and a mark to running is refused
    await expect(markQueue(queue, "A", "running")).rejects.toThrow(/awaiting, expected pending/u);
  });

  it("refuses the move out until the owner answers, and takes only the answered route", async () => {
    const { engine, sid } = await taskSetup();
    await engine.transition(sid, "done");
    await expect(engine.transition(sid, "go")).rejects.toThrow(/waits for a human answer/u);
    await expect(engine.answer(sid, "ship", "")).rejects.toThrow(/not an answer of hold/u);
    await engine.answer(sid, "fix", "rename it");
    await expect(engine.transition(sid, "go")).rejects.toThrow(/recorded answer is `fix`/u);
    const r = await engine.transition(sid, "fix");
    expect(r.currentStateName).toBe("work");
    expect(r.context.owner_words).toBe("rename it");
  });
});

describe("an answered line resumes before Next", () => {
  it("the answer marks the line, the pick admits it ahead of a pending line with its session, and the driver takes the route", async () => {
    const { engine, sid, queue } = await taskSetup();
    await engine.transition(sid, "done");
    await addQueueLine(queue, {
      id: "C",
      status: "pending",
      difficulty: 3,
      touches: ["src/C"],
      text: "line C",
      priority: "urgent",
    });
    const note = (await engine.answer(sid, "go", "ship it")).note;
    expect(note).toMatch(/resumes on the next free slot, before any pending line/u);
    expect(lineOf(queue, "A").humanWait).toMatchObject({ route: "go" });
    const plan = planPick(readQueue(queue));
    // even an urgent pending line comes after the resumed one
    expect(plan.admitted.map(a => a.id)).toEqual(["A"]);
    expect(plan.admitted[0]?.resume).toBe(sid);
    const next = formatQueueNext({ ...plan, dryRun: false }, false);
    expect(next).toContain(`RESUMED (running) A`);
    expect(next).toContain(
      `resume: ${sid} — an answered human wait: start nothing; spawn its driver from status`,
    );
    expect(formatTask(plan.admitted[0])).toMatch(new RegExp(`\\tresume=${sid}$`, "u"));
    const picked = await pickQueue(queue);
    expect(picked.admitted.map(a => a.id)).toEqual(["A"]);
    expect(lineOf(queue, "A").status).toBe("running");
    expect(lineOf(queue, "A").humanWait).toBeUndefined();
    // the fresh driver's status shows the answer; its move writes the owner's words and records the pass
    expect(engine.getStatus(sid).prompt).toContain("HUMAN-ANSWER route=go");
    const r = await engine.transition(sid, "go");
    expect(r.currentStateName).toBe("land");
    expect(r.context.owner_words).toBe("ship it");
    expect(lineOf(queue, "A").meta.human_passed).toBeDefined();
  });

  it("two answered lines resume by priority, then the longest wait", async () => {
    const d = tmp("prio");
    const queue = await queueOf(
      d,
      [
        { id: "OLD", text: "x" },
        { id: "HIGH", text: "x", priority: "high" },
        { id: "NEWER", text: "x" },
        { id: "NEXT", text: "x" },
      ],
      1,
    );
    const since = [
      "2026-11-01T10:00:00.000Z",
      "2026-11-02T10:00:00.000Z",
      "2026-11-03T10:00:00.000Z",
    ];
    for (const [i, id] of ["OLD", "HIGH", "NEWER"].entries()) {
      await markQueue(queue, id, "running", undefined, { force: "test" });
      await markAwaiting(queue, id, {
        since: since[i],
        session: `s${i}`,
        state: "hold",
        question: "q",
        show: [],
      });
      await markAnswered(queue, id, `s${i}`, "go");
    }
    expect(planPick(readQueue(queue)).admitted.map(a => a.id)).toEqual(["HIGH"]);
    await markQueue(queue, "NEXT", "shelved");
    const wide = planPick({ ...readQueue(queue), batchSize: 3 });
    expect(wide.admitted.map(a => a.id)).toEqual(["HIGH", "OLD", "NEWER"]);
  });

  it("an unanswered wait is never admitted, keeps its touches, and keeps the pick at WAIT, not done", async () => {
    const d = tmp("wait");
    const queue = await queueOf(
      d,
      [
        { id: "W", text: "x" },
        { id: "SAME", text: "x" },
      ],
      1,
    );
    await editQueueLine(queue, "SAME", { touches: ["src/W"] });
    await markQueue(queue, "W", "running", undefined, { force: "test" });
    await markAwaiting(queue, "W", {
      since: "2026-11-01T10:00:00.000Z",
      session: "s",
      state: "hold",
      question: "q",
      show: [],
    });
    const plan = planPick(readQueue(queue));
    expect(plan.admitted).toEqual([]);
    expect(plan.reasons.find(r => r.id === "SAME")?.why).toMatch(/overlaps W/u);
    await markQueue(queue, "SAME", "shelved");
    const alone = planPick(readQueue(queue));
    expect(alone.code).toBe(10);
    expect(formatPickSummary({ ...alone, dryRun: true }, false)).toMatch(
      /awaiting a human \(no slot held\): W \(since/u,
    );
  });
});

describe("a human_gate line cannot land without passing the wait", () => {
  it("its done mark is refused until a passing answer was taken", async () => {
    const { engine, sid, queue } = await taskSetup();
    expect(gateDue(queue, "A")).toBe("look");
    expect(gateDue(queue, "B")).toBeNull();
    await expect(markQueue(queue, "A", "done", "landed abcdef1")).rejects.toThrow(
      /has not passed its human wait/u,
    );
    await engine.transition(sid, "done");
    // a fix answer does not pass the gate
    await engine.answer(sid, "fix", "again");
    await pickQueue(queue);
    await engine.transition(sid, "fix");
    expect(gateDue(queue, "A")).toBe("look");
    await engine.transition(sid, "done");
    await engine.answer(sid, "go", "");
    await pickQueue(queue);
    const went = await engine.transition(sid, "go");
    expect(went.currentStateName, fs.readFileSync(queue, "utf8")).toBe("land");
    expect(gateDue(queue, "A"), fs.readFileSync(queue, "utf8")).toBeNull();
    expect((await markQueue(queue, "A", "done", "landed abcdef1")).to).toBe("done");
  });

  it("the bundled batch-task routes a reviewed MERGE through the gate check into its owner_look wait before the land", () => {
    const wf = new Loader(path.join(ROOT, "templates"), tmp("loader"), null).get("batch-task")!;
    expect(wf.states.review?.transitions?.land).toBe("look_route");
    expect(wf.states.look_route?.command).toContain("--gate");
    expect(wf.states.look_route?.cases).toMatchObject({ "0": "project_land", "10": "owner_look" });
    expect(wf.states.owner_look?.human?.passes).toEqual(["go"]);
    expect(wf.states.owner_look?.transitions).toMatchObject({
      go: "project_land",
      fix: "work",
      close: "blocked",
    });
  });

  const cli = path.join(ROOT, "build", "queue-cli.js");
  it.skipIf(!fs.existsSync(cli))("wf-queue --gate exits 10 while the gate is due", () => {
    const d = tmp("gatecli");
    fs.writeFileSync(
      path.join(d, "q.yaml"),
      "batch_size: 1\ntasks:\n  - id: G\n    status: running\n    human_gate: look\n    text: x\n",
    );
    const r = spawnSync(process.execPath, [cli, path.join(d, "q.yaml"), "--gate", "G"], {
      encoding: "utf8",
    });
    expect(r.stdout).toContain("human_gate: look due");
    expect(r.status).toBe(10);
  });
});

describe("main moved during the wait", () => {
  it("a passing answer enters the moved state first; a fix answer keeps its target", async () => {
    const d = tmp("moved");
    const cwd = repo(d);
    const queue = await queueOf(d, [{ id: "A", text: "x" }]);
    await markQueue(queue, "A", "running", undefined, { force: "test" });
    const look = WF.look;
    const wf = {
      look: {
        ...look,
        states: {
          ...look.states,
          hold: { ...look.states.hold, human: { ...look.states.hold.human, moved: "rebase" } },
          rebase: { prompt: "rebase onto main", transitions: { done: "land" } },
        },
      },
    };
    const { engine } = createTestEngine(wf);
    const s = await engine.start("look", undefined, undefined, cwd, undefined, {
      task: "A",
      queue_file: queue,
    });
    await engine.transition(s.sessionId, "done");
    spawnSync("git", [
      "-C",
      cwd,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "main moved",
    ]);
    await engine.answer(s.sessionId, "go", "");
    expect(engine.getStatus(s.sessionId).prompt).toContain(
      "enters `rebase` (the rebase route) first",
    );
    expect((await engine.transition(s.sessionId, "go")).currentStateName).toBe("rebase");
  });
});

describe("an owner's round", () => {
  it("does not use up the worker's cap: max_visits counts from the answer", async () => {
    const { engine, sid } = await taskSetup();
    for (let round = 0; round < 3; round++) {
      await engine.transition(sid, "done");
      await engine.answer(sid, "fix", `round ${round}`);
      expect((await engine.transition(sid, "fix")).currentStateName).toBe("work");
    }
  });

  it("a move out taken without a pick still takes the line back to running", async () => {
    const { engine, sid, queue } = await taskSetup();
    await engine.transition(sid, "done");
    await engine.answer(sid, "fix", "");
    expect(lineOf(queue, "A").status).toBe("awaiting");
    await engine.transition(sid, "fix");
    expect(lineOf(queue, "A").status).toBe("running");
    expect(lineOf(queue, "A").humanWait).toBeUndefined();
  });

  it("the wait's own cap counts every round", async () => {
    const { engine, sid } = await taskSetup();
    for (let round = 0; round < 3; round++) {
      await engine.transition(sid, "done");
      await engine.answer(sid, "fix", "");
      await engine.transition(sid, "fix");
    }
    await engine.transition(sid, "done");
    await engine.answer(sid, "fix", "");
    await engine.transition(sid, "fix");
    // a fifth entry of `hold` (max_visits 4) is exhausted
    const ended = await engine.transition(sid, "done");
    expect(ended.currentStateName).toBe("(failed)");
    expect(ended.history.at(-2)?.to).toBe("blocked");
  });
});

describe("the end of a waiting task", () => {
  it("an abort at the wait fails its awaiting line and runs the wait's stop command", async () => {
    const { engine, sid, queue, cwd } = await taskSetup();
    await engine.transition(sid, "done");
    await engine.abort(sid);
    expect(lineOf(queue, "A").status).toBe("failed");
    expect(lineOf(queue, "A").humanWait).toBeUndefined();
    expect(fs.existsSync(path.join(cwd, "stopped-A"))).toBe(true);
  });

  it("a wait is not STALE until its answered line is resumed; then the clock runs from the answer", async () => {
    const { engine, sid, storage, queue } = await taskSetup();
    await engine.transition(sid, "done");
    const old = (): Parameters<typeof engine.staleness>[0] => ({
      ...storage.read(sid)!,
      updated_at: "2020-01-01T00:00:00.000Z",
    });
    // no answer: not stale
    expect(engine.staleness(old(), new Set(), Date.now())).toBeUndefined();
    // answered, the line still awaiting a slot: not stale
    await engine.answer(sid, "go", "");
    expect(engine.staleness(old(), new Set(), Date.now())).toBeUndefined();
    // resumed by the pick, and no driver moved it: stale
    await pickQueue(queue);
    expect(engine.staleness(old(), new Set(), Date.now())).toBeDefined();
  });

  it("a dispatching session cannot end its run as stalled while a line awaits", async () => {
    const d = tmp("stalled");
    const queue = await queueOf(d, [{ id: "W", text: "x" }]);
    await markQueue(queue, "W", "running", undefined, { force: "test" });
    await markAwaiting(queue, "W", {
      since: "2026-11-01T10:00:00.000Z",
      session: "s",
      state: "hold",
      question: "q",
      show: [],
    });
    const saved = process.env.WF_DISPATCHER;
    delete process.env.WF_DISPATCHER;
    try {
      const storage = new InMemoryStorage();
      const engine = new Engine(
        storage,
        new Loader(path.join(ROOT, "templates"), d, null),
        new Executor(),
      );
      const disp = await engine.start("batch");
      const cur = storage.read(disp.sessionId)!;
      cur.stack[cur.active_frame].current_state = "collect";
      cur.context.queue_file = queue;
      cur.context.task_workflow = "batch-task";
      await storage.write(disp.sessionId, cur);
      await expect(engine.transition(disp.sessionId, "stalled")).rejects.toThrow(
        /await their owner's answer \(W\)/u,
      );
    } finally {
      if (saved !== undefined) process.env.WF_DISPATCHER = saved;
    }
  });
});

describe("the queue key and its warning", () => {
  it("human_gate is one word; human_wait / human_passed are the engine's", async () => {
    const d = tmp("keys");
    const queue = await queueOf(d, [{ id: "K", text: "x" }]);
    await expect(editQueueLine(queue, "K", { human_gate: "Look Here" })).rejects.toThrow(
      /one lower-case word/u,
    );
    await expect(editQueueLine(queue, "K", { human_passed: "now" })).rejects.toThrow(
      /engine's human wait/u,
    );
    await expect(addQueueLine(queue, { id: "K2", difficulty: 3, human_wait: {} })).rejects.toThrow(
      /engine's human wait/u,
    );
    await editQueueLine(queue, "K", { human_gate: "look" });
    expect(lineOf(queue, "K").meta.human_gate).toBe("look");
  });

  it("a line whose text asks for an owner's look and has no human_gate is warned at add, edit and pick", async () => {
    const d = tmp("hint");
    const queue = await queueOf(d, []);
    const added = await addQueueLine(queue, {
      id: "H",
      difficulty: 3,
      touches: ["src/H"],
      text: "Build it. HOLD BEFORE LAND: the owner looks first.",
    });
    expect(added.warnings?.join("\n")).toMatch(
      /H: its text asks for an owner's look \("HOLD BEFORE LAND"\)/u,
    );
    const plan = planPick(readQueue(queue));
    expect(plan.gateHints?.[0]).toMatch(/no human_gate: key — it would land unseen/u);
    const edited = await editQueueLine(queue, "H", { human_gate: "look" });
    expect(edited.warnings ?? []).toEqual([]);
    expect(planPick(readQueue(queue)).gateHints).toBeUndefined();
  });
});

describe("the loader", () => {
  it("refuses a human wait on an exec, without transitions, or with a pass that is no answer", () => {
    const bad = {
      bad: {
        name: "bad",
        initial: "a",
        states: {
          a: { human: { question: "q", passes: ["nope"] }, transitions: { go: "end" } },
          b: { human: { question: "q" } },
          end: { terminal: true },
        },
      },
    };
    const { loader } = createTestLoader(bad);
    expect(loader.get("bad")).toBeUndefined();
    const errs = loader.brokenNote("bad");
    expect(errs).toContain(`human.passes "nope" is not one of its transitions`);
    expect(errs).toContain(`state "b" human needs transitions`);
  });
});

describe("the dashboard section lists a waiting task", () => {
  it("/api/queue carries the wait, the pane draws `⏸ Awaiting you (N)` with the question and the links, oldest first", async () => {
    const d = tmp("pane");
    const queue = await queueOf(
      d,
      [
        { id: "LOOK-1", text: "x" },
        { id: "LOOK-2", text: "x" },
      ],
      2,
    );
    for (const [i, id] of ["LOOK-2", "LOOK-1"].entries()) {
      await markQueue(queue, id, "running", undefined, { force: "test" });
      await markAwaiting(queue, id, {
        since: `2026-11-0${i + 1}T10:00:00.000Z`,
        session: `s${i}`,
        state: "hold",
        question: `compare ${id}`,
        show: [`http://127.0.0.1:9/${id}`],
      });
    }
    await markAnswered(queue, "LOOK-1", "s1", "go");
    const api = describeQueue(readQueue(queue));
    expect(api.lines.find(l => l.id === "LOOK-2")?.humanWait?.question).toBe("compare LOOK-2");
    const pane = (await import("../hooks/plan-pane.tsx")) as {
      queueView: (f: string, a: unknown) => { awaiting: { id: string; answered?: string }[] };
    };
    const view = (await import("../hooks/pane-view.ts")) as {
      paneTree: (i: unknown) => unknown;
      nodeText: (n: unknown) => string;
    };
    const q = pane.queueView(queue, JSON.parse(JSON.stringify(api)));
    expect(q.awaiting.map(a => a.id)).toEqual(["LOOK-2", "LOOK-1"]);
    expect(q.awaiting[1]?.answered).toBe("go");
    const tree = view.paneTree({
      snapshot: { at: 0, sessions: [], queue: q, lands: [], recent: 0, days: {}, error: "" },
      tab: "plan",
      expanded: "",
      folded: [],
      now: Date.parse("2026-11-03T10:00:00.000Z"),
      columns: 100,
      rows: 60,
      poolCounts: null,
      pool: null,
    });
    const text = view.nodeText(tree);
    expect(text).toContain("⏸ Awaiting you (2)");
    expect(text).toContain("compare LOOK-2");
    expect(text).toContain("http://127.0.0.1:9/LOOK-2");
    expect(text).toContain("answered go · resumes first");
    expect(text.indexOf("LOOK-2")).toBeLessThan(text.indexOf("LOOK-1"));
    expect(text.indexOf("Running")).toBeLessThan(text.indexOf("Awaiting you"));
    expect(text.indexOf("Awaiting you")).toBeLessThan(text.indexOf("Next ("));
  });

  it("the dashboard records an answer posted as JSON, and refuses one that is no answer", async () => {
    const d = tmp("dash");
    const cwd = repo(d);
    const queue = await queueOf(d, [{ id: "A", text: "x" }]);
    await markQueue(queue, "A", "running", undefined, { force: "test" });
    const storage = new Storage(path.join(d, "state"), { eventLog: false });
    const { loader } = createTestLoader(WF);
    const engine = new Engine(storage, loader, new Executor());
    const s = await engine.start("look", undefined, undefined, cwd, undefined, {
      task: "A",
      queue_file: queue,
    });
    await engine.transition(s.sessionId, "done");
    const server: Server = buildApp(storage, {} as LoaderType).listen(0, "127.0.0.1");
    await new Promise(r => server.once("listening", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/session/${s.sessionId}/answer`;
      const post = (body: unknown, type = "application/json") =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": type },
          body: JSON.stringify(body),
        });
      expect((await post({ route: "go" }, "text/plain")).status).toBe(400);
      expect((await post({ route: "nope" })).status).toBe(409);
      const ok = await post({ route: "go", text: "looks right" });
      expect(ok.status).toBe(200);
      expect(storage.read(s.sessionId)?.human_wait?.answer).toMatchObject({
        route: "go",
        text: "looks right",
        by: "dashboard",
      });
      expect(lineOf(queue, "A").humanWait?.route).toBe("go");
    } finally {
      await new Promise(r => server.close(r));
    }
  });
});
