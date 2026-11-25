import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPAWN_DEPTH_ENV } from "./driver.js";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { markQueue, readQueue, setQueueWindow } from "./queue.js";
import { InMemoryStorage, cleanupDir, createFixtureDir } from "./test-helpers.js";
import { registerTools } from "./tools.js";

// ENG-PARENT-PROTOCOL-AT-THE-TRANSITION: the main conversation's side of dispatcher mode is delivered by the
// engine at the moment it is needed: the NEEDS-PARENT's driver and routes, the DRIVER block's duties, the
// terminal state that fails its own queue line, a window that ends with its task, an ask nobody answered.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), "utf8");
const TEMPLATES = path.join(ROOT, "templates");

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["WF_DISPATCHER", SPAWN_DEPTH_ENV]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  vi.useRealTimers();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-ppt-"));
  dirs.push(d);
  return d;
};

type Reply = { isError?: boolean; text: string };

function mount(loader: Loader) {
  const storage = new InMemoryStorage();
  const engine = new Engine(storage, loader, new Executor());
  const handlers = new Map<
    string,
    (args: object) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
  >();
  const server = { registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h) };
  registerTools(server as never, engine, {} as never, loader, storage);
  const call = async (name: string, args: object): Promise<Reply> => {
    const r = await handlers.get(name)!(args);
    return { isError: r.isError, text: r.content[0].text };
  };
  return { storage, engine, call };
}

const sid = (text: string): string => /SESSION: (\w+)/.exec(text)![1];

const FIXTURE = {
  disp: {
    initial: "plan",
    states: {
      plan: { prompt: "plan", transitions: { go: "collect" } },
      collect: { prompt: "collect", transitions: { end: "fin" } },
      fin: { terminal: true, outcome: "complete" },
    },
  },
  task: {
    initial: "claim",
    states: {
      claim: {
        prompt: "claim",
        transitions: { review: "review", stop: "stopped", close: "closed", release: "released" },
      },
      review: { prompt: "review", transitions: { land: "done", fixes: "claim", reject: "closed" } },
      done: { terminal: true, outcome: "complete" },
      closed: { terminal: true, outcome: "complete", queue_mark: "failed" },
      released: { terminal: true, outcome: "complete", queue_mark: "released" },
      stopped: { terminal: true, outcome: "fail", queue_mark: "failed" },
    },
  },
};

function fixture(workflows: Record<string, object> = FIXTURE) {
  const dir = createFixtureDir(workflows);
  dirs.push(dir);
  return mount(new Loader(null, dir, null));
}

function queueFile(lines: Record<string, string>, header = "batch_size: 2\nreason: base window\n") {
  const file = path.join(tmp(), "q.yaml");
  const body = Object.entries(lines)
    .map(
      ([id, status]) =>
        `  - id: ${id}\n    status: ${status}\n    difficulty: 3\n    text: |-\n      t\n`,
    )
    .join("");
  fs.writeFileSync(file, `${header}tasks:\n${body}`);
  return file;
}

const statusOf = (file: string, id: string): string =>
  readQueue(file).lines.find(l => l.id === id)!.status;

describe("(1) a NEEDS-PARENT carries what main needs to answer: the driver and the state's routes", () => {
  it("the dispatcher reads routes with status key `routes`, appends driver= and routes=, and main answers through the engine", () => {
    const md = read("templates/drivers/dispatch-driver.md");
    expect(md).toContain("` driver=<the agent id of that task in `tasks`>`");
    expect(md).toContain('`status({session_id: <P>, key: "routes"})`');
    expect(md).toContain("` routes=<a|b|c>`");
    expect(md).toContain("Main answers by recording `parent_answer` on that task's session");
    expect(md).toContain("`driver_call` or `routes` key");
  });

  it("the engine answers status key `routes` with the session's transitions, `(none)` at a state with none", async () => {
    const m = fixture();
    const d = sid((await m.call("start", { workflow: "disp", reply: "id" })).text);
    const p = sid(
      (await m.call("start", { workflow: "task", reply: "id", parent_session_id: d })).text,
    );
    expect((await m.call("status", { session_id: p, key: "routes" })).text).toBe(
      "review|stop|close|release",
    );
    await m.call("transition", { session_id: p, transition: "review" });
    expect((await m.call("status", { session_id: p, key: "routes" })).text).toBe(
      "land|fixes|reject",
    );
  });

  it("a context key named `routes` wins over the engine's answer", async () => {
    const m = fixture();
    const d = sid((await m.call("start", { workflow: "disp", reply: "id" })).text);
    await m.call("context_set", { session_id: d, key: "routes", value: "mine" });
    expect((await m.call("status", { session_id: d, key: "routes" })).text).toBe("mine");
  });

  it("the DRIVER block tells main to record the answer in the engine, routes only from the line, and lists the duties", async () => {
    process.env.WF_DISPATCHER = "1";
    const m = mount(new Loader(TEMPLATES, tmp(), null));
    const block = (await m.call("start", { workflow: "batch" })).text;
    expect(block).toContain("`NEEDS-PARENT … driver=<agent id> routes=<a|b|c>` line");
    expect(block).toContain(
      'record the answer in the engine: `context_set({session_id: <its session=>, key: "parent_answer"',
    );
    expect(block).toContain("no SendMessage to the driver");
    expect(block).not.toContain("SendMessage your decision to the DISPATCHER");
  });
});

describe("(2) the DRIVER block lists main's duties in dispatcher mode, once", () => {
  it("routes from TRANSITIONS, `lines added`, what CLOSED means, a window with its end", async () => {
    process.env.WF_DISPATCHER = "1";
    const m = mount(new Loader(TEMPLATES, tmp(), null));
    const block = (await m.call("start", { workflow: "batch" })).text;
    expect(block).toContain("Your duties in this mode");
    expect(block).toContain("one of the line's `routes=`");
    expect(block).toContain("`lines added` to the dispatcher");
    expect(block).toContain("a `CLOSED` line = the task session ended without landing");
    expect(block).toContain('`queue_header` with `until: "<TASK-ID> done"`');
    expect(block).toContain("`reason=unanswered <n>");
  });
});

describe("(3) a task session that ends stopped or closed fails its own queue line", () => {
  it("bundled batch-task: closed and stopped fail, released releases, done marks nothing", () => {
    const wf = new Loader(TEMPLATES, tmp(), null).get("batch-task")!;
    expect(wf.states.closed.queue_mark).toBe("failed");
    expect(wf.states.stopped.queue_mark).toBe("failed");
    expect(wf.states.released.queue_mark).toBe("released");
    expect(wf.states.done.queue_mark).toBeUndefined();
  });

  it("entering `stopped` or `closed` while the line is running marks it failed, with a note", async () => {
    for (const route of ["stop", "close"]) {
      const m = fixture();
      const file = queueFile({ T1: "running" });
      const d = sid((await m.call("start", { workflow: "disp", reply: "id" })).text);
      const p = sid(
        (
          await m.call("start", {
            workflow: "task",
            reply: "id",
            parent_session_id: d,
            context: { task: "T1", queue_file: file },
          })
        ).text,
      );
      await m.call("transition", { session_id: p, transition: route });
      expect(statusOf(file, "T1")).toBe("failed");
      expect(readQueue(file).lines[0].notes.at(-1)?.text).toMatch(/pipeline made no mark/);
    }
  });

  it("`released` puts a running line back to pending", async () => {
    const m = fixture();
    const file = queueFile({ T1: "running" });
    const d = sid((await m.call("start", { workflow: "disp", reply: "id" })).text);
    const p = sid(
      (
        await m.call("start", {
          workflow: "task",
          reply: "id",
          parent_session_id: d,
          context: { task: "T1", queue_file: file },
        })
      ).text,
    );
    await m.call("transition", { session_id: p, transition: "release" });
    expect(statusOf(file, "T1")).toBe("pending");
  });

  it("a line the pipeline already marked (done, failed) is left as it is, and a missing queue never blocks the end", async () => {
    const m = fixture();
    const file = queueFile({ T1: "failed", T2: "done" });
    const d = sid((await m.call("start", { workflow: "disp", reply: "id" })).text);
    for (const [task, queue_file] of [
      ["T1", file],
      ["T2", file],
      ["T3", file],
      ["T1", path.join(tmp(), "nope.yaml")],
    ]) {
      const p = sid(
        (
          await m.call("start", {
            workflow: "task",
            reply: "id",
            parent_session_id: d,
            context: { task, queue_file },
          })
        ).text,
      );
      const r = await m.call("transition", { session_id: p, transition: "close" });
      expect(r.isError).toBeUndefined();
      expect(m.storage.read(p)!.stack).toHaveLength(0);
    }
    expect(statusOf(file, "T1")).toBe("failed");
    expect(statusOf(file, "T2")).toBe("done");
  });

  it("a session without a queue line context ends untouched", async () => {
    const m = fixture();
    const d = sid((await m.call("start", { workflow: "disp", reply: "id" })).text);
    const p = sid(
      (await m.call("start", { workflow: "task", reply: "id", parent_session_id: d })).text,
    );
    expect((await m.call("transition", { session_id: p, transition: "stop" })).isError).toBe(
      undefined,
    );
  });

  it("queue_mark is refused on a state that is not a terminal without transitions", () => {
    const load = (queueMark?: string) => {
      const dir = createFixtureDir({
        w: {
          initial: "a",
          states: {
            a: {
              prompt: "a",
              ...(queueMark ? { queue_mark: queueMark } : {}),
              transitions: { go: "z" },
            },
            z: { terminal: true, outcome: "complete" },
          },
        },
      });
      dirs.push(dir);
      return new Loader(null, dir, null).get("w");
    };
    expect(load()).toBeDefined();
    expect(load("failed")).toBeUndefined();
  });

  it("wf-queue --failed --if-running leaves a line that is not running, and refuses --if-running elsewhere", async () => {
    const file = queueFile({ T1: "done", T2: "running" });
    const skipped = await markQueue(file, "T1", "failed", undefined, { ifRunning: true });
    expect(skipped).toMatchObject({ skipped: true, from: "done", to: "done" });
    expect(statusOf(file, "T1")).toBe("done");
    await markQueue(file, "T2", "failed", undefined, { ifRunning: true });
    expect(statusOf(file, "T2")).toBe("failed");
    await expect(markQueue(file, "T2", "done", undefined, { ifRunning: true })).rejects.toThrow(
      /if-running/,
    );
  });

  it("the dispatcher treats a stopped driver's CLOSED line as a freed slot and tells main at once", () => {
    const md = read("templates/drivers/dispatch-driver.md");
    expect(md).toContain("`CLOSED` line whose `reason=` starts `stopped`");
    expect(md).toContain("whatever `lessons_pending` holds");
    expect(md).toContain("`CLOSED … reason=stopped: … see=state stopped`");
    expect(md).not.toContain("`NEEDS-PARENT … see=state stopped`");
    expect(read("templates/batch-task.yaml")).toContain(
      "reply with the last line `CLOSED task=<ID> reason=stopped:",
    );
  });
});

describe("(4) a temporary window carries its end", () => {
  it("until: <ID> done writes the revert; the mark of that line restores the window and says so", async () => {
    const file = queueFile({ T1: "running", T2: "pending" });
    const set = await setQueueWindow(file, 3, "temporary +1 for T1", "T1 done");
    expect(set).toMatchObject({ from: 2, to: 3, until: "T1" });
    expect(readQueue(file).batchSize).toBe(3);
    const done = await markQueue(file, "T1", "done");
    expect(done.windowRestored).toMatchObject({
      task: "T1",
      from: 3,
      to: 2,
      reason: "base window",
    });
    const q = readQueue(file);
    expect(q.batchSize).toBe(2);
    expect(q.batchComment).toBe("base window");
    expect(q.header).not.toHaveProperty("window_until");
  });

  it("promoting or shelving the until line leaves the window: only a mark that leaves running ends it", async () => {
    const file = queueFile({ T1: "backlog", T2: "pending" });
    await setQueueWindow(file, 4, "wide", "T1 done");
    const promoted = await markQueue(file, "T1", "promoted");
    expect(promoted.windowRestored).toBeUndefined();
    expect(readQueue(file).batchSize).toBe(4);
    await markQueue(file, "T1", "shelved");
    expect(readQueue(file).batchSize).toBe(4);
    expect(readQueue(file).header).toHaveProperty("window_until");
  });

  it("a mark of another line, or a retry, leaves the window; failed and released end it", async () => {
    for (const to of ["failed", "released"] as const) {
      const file = queueFile({ T1: "running", T2: "running" });
      await setQueueWindow(file, 4, "wide", "T1 done");
      await markQueue(file, "T2", "done");
      expect(readQueue(file).batchSize).toBe(4);
      const r = await markQueue(file, "T1", to);
      expect(r.windowRestored).toMatchObject({ from: 4, to: 2 });
      expect(readQueue(file).batchSize).toBe(2);
    }
  });

  it("the answer of the engine's own mark (wf-queue) names the restored window", async () => {
    const file = queueFile({ T1: "running" });
    await setQueueWindow(file, 5, "wide", "T1 done");
    const { formatMark } = await import("./queue.js");
    const text = formatMark(await markQueue(file, "T1", "done"));
    expect(text).toContain("T1: running → done");
    expect(text).toContain("batch_size 5 → 2  # base window");
    expect(text).toContain("until T1 done");
  });

  it("a plain window while one is pending drops the revert and says so; a second temporary one is refused", async () => {
    const file = queueFile({ T1: "running", T2: "running" });
    await setQueueWindow(file, 3, "wide", "T1 done");
    await expect(setQueueWindow(file, 4, "wider", "T2 done")).rejects.toThrow(/is pending/);
    const plain = await setQueueWindow(file, 1, "narrow");
    expect(plain.droppedUntil).toBe("T1");
    expect(readQueue(file).header).not.toHaveProperty("window_until");
    await markQueue(file, "T1", "done");
    expect(readQueue(file).batchSize).toBe(1);
  });

  it("refuses an until that is not `<ID> done`, a line already ended, an unknown line", async () => {
    const file = queueFile({ T1: "done", T2: "running" });
    await expect(setQueueWindow(file, 3, "x", "T2 landed")).rejects.toThrow(/until is/);
    await expect(setQueueWindow(file, 3, "x", "T1 done")).rejects.toThrow(/would never end/);
    await expect(setQueueWindow(file, 3, "x", "T9 done")).rejects.toThrow(/no task T9/);
    expect(readQueue(file).batchSize).toBe(2);
  });

  it("queue_header takes until with the window only, and its answer says when it ends", async () => {
    const m = fixture();
    const file = queueFile({ T1: "running" });
    const bare = await m.call("queue_header", { file, until: "T1 done" });
    expect(bare.isError).toBe(true);
    const r = await m.call("queue_header", {
      file,
      batch_size: 3,
      reason: "temporary",
      until: "T1 done",
    });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("batch_size 2 → 3  # temporary");
    expect(r.text).toContain("until T1 done");
    const marked = await m.call("queue_mark", { file, id: "T1", to: "done" });
    expect(marked.text).toContain("batch_size 3 → 2");
  });

  it("the engine's terminal mark of a line ends its window too", async () => {
    const m = fixture();
    const file = queueFile({ T1: "running" });
    await setQueueWindow(file, 3, "temporary", "T1 done");
    const d = sid((await m.call("start", { workflow: "disp", reply: "id" })).text);
    const p = sid(
      (
        await m.call("start", {
          workflow: "task",
          reply: "id",
          parent_session_id: d,
          context: { task: "T1", queue_file: file },
        })
      ).text,
    );
    await m.call("transition", { session_id: p, transition: "stop" });
    expect(readQueue(file).batchSize).toBe(2);
  });
});

describe("(5) an answer that never reached a driver is visible on the next event", () => {
  async function asked() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T10:00:00.000Z"));
    const m = fixture();
    const d = sid((await m.call("start", { workflow: "disp", reply: "id" })).text);
    const p = sid(
      (
        await m.call("start", {
          workflow: "task",
          reply: "id",
          parent_session_id: d,
          context: { task: "T1" },
        })
      ).text,
    );
    await m.call("context_set", { session_id: p, key: "ask_parent", value: "review rejected" });
    return { m, d, p };
  }

  it("a question open past ten minutes rides on the dispatcher's status and transition as UNANSWERED", async () => {
    const { m, d, p } = await asked();
    vi.setSystemTime(new Date("2026-11-21T10:05:00.000Z"));
    expect((await m.call("status", { session_id: d })).text).not.toContain("UNANSWERED");
    vi.setSystemTime(new Date("2026-11-21T10:11:00.000Z"));
    const line = `UNANSWERED: task=T1 session=${p} asked=2026-11-21T10:00:00.000Z (11m ago): review rejected`;
    expect((await m.call("status", { session_id: d })).text).toContain(line);
    const moved = await m.call("transition", { session_id: d, transition: "go" });
    expect(moved.text).toContain(line);
  });

  it("an answer (the driver clears the key, or the session moves) ends the notice", async () => {
    const { m, d, p } = await asked();
    vi.setSystemTime(new Date("2026-11-21T10:30:00.000Z"));
    expect(m.engine.unansweredAskLines(d)).toHaveLength(1);
    await m.call("context_set", { session_id: p, key: "ask_parent", value: "" });
    expect(m.engine.unansweredAskLines(d)).toEqual([]);
  });

  it("the dispatcher reports each ask once: it keeps the asked= values it handed back", () => {
    const md = read("templates/drivers/dispatch-driver.md");
    expect(md).toContain("`UNANSWERED: task=<ID> session=<P> driver=<id> asked=<time>");
    expect(md).toContain("`asks_reminded`");
    expect(md).toContain("`reason=` starting `unanswered <n>:`");
  });
});

describe("the driver's side: an answer relayed by the dispatcher, a direct one still taken", () => {
  it("both driver instruction files take `task=<ID>: <route>` from main as the answer", () => {
    for (const f of ["templates/drivers/task-driver.md", "agents/driver.md"]) {
      const md = read(f);
      expect(md).toContain("sent to your agent id directly by the main conversation");
      expect(md).toContain("`driver=`");
      expect(md).toContain("`closed` / `released` / `stopped`");
    }
  });
});
