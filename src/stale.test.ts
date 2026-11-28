import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import {
  STALE_AFTER_DEFAULTS,
  STALE_EXEC_GRACE_S,
  ANSWER_ACK_KEY,
  activeParents,
  askStanding,
  formatSeconds,
  staleAfter,
  staleness,
} from "./stale.js";
import { registerTools } from "./tools.js";
import { POOL_WAIT_CEILING_FACTOR } from "./types.js";
import { InMemoryStorage, cleanupDir, createTestLoader } from "./test-helpers.js";
import type { SessionState, StateDefinition } from "./types.js";

const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();

function session(over: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "s1",
    stack: [{ workflow: "w", current_state: "a", state_visits: { a: 1 }, total_transitions: 0 }],
    active_frame: 0,
    started_at: at(0),
    updated_at: at(0),
    history: [],
    overrides: {},
    context: {},
    ...over,
  };
}

const none = new Set<string>();
const prompt: StateDefinition = { prompt: "go" };

describe("staleAfter: per state, else by type", () => {
  it("prompt short, exec long, heavy exec longer; an exec never before its own timeout", () => {
    expect(staleAfter(prompt)).toBe(STALE_AFTER_DEFAULTS.prompt);
    expect(staleAfter(undefined)).toBe(STALE_AFTER_DEFAULTS.prompt);
    expect(staleAfter({ skills: ["x"] })).toBe(STALE_AFTER_DEFAULTS.prompt);
    expect(staleAfter({ type: "exec", command: "x" })).toBe(STALE_AFTER_DEFAULTS.exec);
    expect(staleAfter({ type: "fetch", url: "http://x" })).toBe(STALE_AFTER_DEFAULTS.exec);
    expect(staleAfter({ type: "exec", command: "x", resource: { locks: ["l"] } })).toBe(
      STALE_AFTER_DEFAULTS.heavy_exec,
    );
    expect(staleAfter({ type: "exec", command: "x", fanout: { count: 2, threads_each: 1 } })).toBe(
      STALE_AFTER_DEFAULTS.heavy_exec,
    );
    expect(staleAfter({ type: "exec", command: "x", timeout: 60_000 })).toBe(
      STALE_AFTER_DEFAULTS.exec,
    );
    expect(staleAfter({ type: "exec", command: "x", timeout: 7_200_000 })).toBe(
      7200 * POOL_WAIT_CEILING_FACTOR + STALE_EXEC_GRACE_S,
    );
    // a plain exec under a long timeout is not STALE inside its stretched deadline
    const plain: StateDefinition = { type: "exec", command: "x", timeout: 1_800_000 };
    expect(staleness(session(), plain, none, T0 + 3700 * 1000, true)).toBeUndefined();
  });

  it("an explicit stale_after wins, 0 = never; a terminal state is never stale", () => {
    expect(staleAfter({ prompt: "x", stale_after: 7200 })).toBe(7200);
    expect(staleAfter({ type: "exec", command: "x", stale_after: 60 })).toBe(60);
    expect(staleAfter({ prompt: "x", stale_after: 0 })).toBe(0);
    expect(staleAfter({ terminal: true, transitions: { again: "a" } })).toBe(0);
  });
});

describe("staleness", () => {
  const limit = STALE_AFTER_DEFAULTS.prompt;
  const heavy = STALE_AFTER_DEFAULTS.heavy_exec;
  const leased: StateDefinition = { type: "exec", command: "x", resource: { threads: 2 } };
  const fanout: StateDefinition = {
    type: "exec",
    command: "x",
    fanout: { count: 2, threads_each: 1 },
  };
  const run = {
    frame: 0,
    state: "a",
    pgid: 1,
    out: "o",
    err: "e",
    rc: "r",
    started_at: at(1000),
    boot_ms: 0,
  };
  const pending = { frame: 0, state: "a", at: at(0) };

  it("past the state's limit since the last write: STALE; at or under it: not", () => {
    expect(staleness(session(), prompt, none, T0 + limit * 1000, true)).toBeUndefined();
    expect(staleness(session(), prompt, none, T0 + (limit + 1) * 1000, true)).toEqual({
      since: at(0),
      idle_s: limit + 1,
      after_s: limit,
    });
    expect(
      staleness(session(), { prompt: "x", stale_after: 0 }, none, T0 + 1e9, true),
    ).toBeUndefined();
  });

  it("never: ended, suspended, or waiting for an active child", () => {
    const late = T0 + 1e8;
    expect(staleness(session({ stack: [] }), prompt, none, late, true)).toBeUndefined();
    expect(staleness(session({ suspended_at: at(1) }), prompt, none, late, true)).toBeUndefined();
    expect(staleness(session(), prompt, new Set(["s1"]), late, true)).toBeUndefined();
  });

  it("an exec: the clock runs from its run's start, or from a later write", () => {
    const running = session({ pending_action: pending, running_exec: run });
    expect(staleness(running, leased, none, T0 + (heavy + 500) * 1000, true)).toBeUndefined();
    expect(staleness(running, leased, none, T0 + (heavy + 1001) * 1000, true)?.since).toBe(
      at(1000),
    );
    // a takeover, resume or context_set during the run resets the clock
    const touched = session({ pending_action: pending, running_exec: run, updated_at: at(2000) });
    expect(staleness(touched, leased, none, T0 + (heavy + 1001) * 1000, true)).toBeUndefined();
    expect(staleness(touched, leased, none, T0 + (heavy + 2001) * 1000, true)?.since).toBe(
      at(2000),
    );
    // a record of another state is not this state's run
    const elsewhere = session({ running_exec: { ...run, state: "b" } });
    expect(staleness(elsewhere, leased, none, T0 + (heavy + 1) * 1000, true)?.since).toBe(at(0));
  });

  it("a running fanout times from its run_at; its lease wait before it is exempt while the owner lives", () => {
    const waiting = session({ pending_action: pending });
    expect(staleness(waiting, fanout, none, T0 + 1e9, true)).toBeUndefined();
    const started = session({ pending_action: { ...pending, run_at: at(1000) } });
    expect(staleness(started, fanout, none, T0 + (heavy + 500) * 1000, true)).toBeUndefined();
    expect(staleness(started, fanout, none, T0 + (heavy + 1001) * 1000, true)?.since).toBe(
      at(1000),
    );
  });

  it("a fetch (no lease) is timed from its last write: its pending_action exempts nothing", () => {
    const fetch: StateDefinition = { type: "fetch", url: "http://x" };
    const s = session({ pending_action: pending });
    const exec = STALE_AFTER_DEFAULTS.exec;
    expect(staleness(s, fetch, none, T0 + exec * 1000, true)).toBeUndefined();
    expect(staleness(s, fetch, none, T0 + (exec + 1) * 1000, true)?.since).toBe(at(0));
    // nor a light exec's
    const light: StateDefinition = { type: "exec", command: "x" };
    expect(staleness(s, light, none, T0 + (exec + 1) * 1000, true)?.since).toBe(at(0));
  });

  it("a dead owner's lease wait or starved mark exempts nothing", () => {
    const late = T0 + (heavy + 1) * 1000;
    const waiting = session({ pending_action: pending });
    expect(staleness(waiting, leased, none, late, true)).toBeUndefined();
    expect(staleness(waiting, leased, none, late, false)?.since).toBe(at(0));
    const starved = session({ pool_starved: { since: at(900), note: "n" } });
    expect(staleness(starved, leased, none, late, true)).toBeUndefined();
    expect(staleness(starved, leased, none, late, false)?.since).toBe(at(0));
  });

  it("activeParents: only active children count", () => {
    const parents = activeParents([
      session({ session_id: "c1", parent_session_id: "p1" }),
      session({ session_id: "c2", parent_session_id: "p2", stack: [] }),
      session({ session_id: "p1" }),
    ]);
    expect([...parents]).toEqual(["p1"]);
  });

  it("formatSeconds", () => {
    expect(formatSeconds(45)).toBe("45s");
    expect(formatSeconds(47 * 60 + 5)).toBe("47m");
    expect(formatSeconds(2 * 3600 + 5 * 60)).toBe("2h05m");
  });
});

describe("STALE in sessions / status / transition and {{stale_sessions}}", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) cleanupDir(dir);
    dir = undefined;
  });

  const WORKFLOWS = {
    run: {
      initial: "collect",
      states: {
        collect: {
          prompt: "Stale:\n{{stale_sessions}}",
          transitions: { again: "collect", peek: "peek", end: "end" },
        },
        peek: { prompt: "Peek:\n{{stale_sessions}}", transitions: { back: "collect" } },
        end: { terminal: true },
      },
    },
    act: {
      initial: "p",
      states: {
        p: { prompt: "p", transitions: { go: "x" } },
        x: {
          type: "exec",
          command: "printf ok",
          success_prompt: "out={{stdout}}\n{{stale_sessions}}",
          context_set: { seen: "{{stale_sessions}}" },
          on_success: "p",
          on_error: "p",
        },
        end: { terminal: true },
      },
    },
    task: {
      initial: "work",
      states: {
        work: { prompt: "work", transitions: { wait: "wait", end: "end" } },
        wait: { prompt: "for the user", stale_after: 0, transitions: { end: "end" } },
        end: { terminal: true },
      },
    },
  };

  function mount() {
    const storage = new InMemoryStorage();
    const result = createTestLoader(WORKFLOWS);
    dir = result.dir;
    const engine = new Engine(storage, result.loader, new Executor());
    const handlers = new Map<
      string,
      (args: object) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
    >();
    const server = {
      registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h),
    };
    registerTools(server as never, engine, {} as never, result.loader, storage);
    const call = async (name: string, args: object) =>
      (await handlers.get(name)!(args)).content[0].text;
    return { storage, engine, call };
  }

  /** Move a session's last write back by `s` seconds. */
  async function age(storage: InMemoryStorage, id: string, s: number): Promise<void> {
    const cur = storage.read(id)!;
    await storage.write(id, {
      ...cur,
      updated_at: new Date(Date.parse(cur.updated_at) - s * 1000).toISOString(),
    });
  }

  it("an idle child is listed under its parent; the parent waiting for it is not", async () => {
    const { storage, engine, call } = mount();
    const run = await engine.start("run");
    const task = await engine.start("task", undefined, run.sessionId);
    await storage.write(task.sessionId, { ...storage.read(task.sessionId)!, agent_id: "ag1" });
    await age(storage, run.sessionId, 7200);

    expect(engine.staleLines(run.sessionId)).toEqual([]);
    expect(engine.getStatus(run.sessionId).prompt).toBe("Stale:\nnone");

    await age(storage, task.sessionId, STALE_AFTER_DEFAULTS.prompt + 120);
    const lines = engine.staleLines(run.sessionId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      new RegExp(
        `^STALE: session ${task.sessionId} \\(task @ work, child of ${run.sessionId}, agent ag1\\) — no engine call for 32m \\(since .*\\), past its state's stale_after 30m$`,
      ),
    );
    expect(engine.getStatus(run.sessionId).prompt).toBe(`Stale:\n${lines[0]}`);
    expect(engine.staleLines(run.sessionId, true)).toEqual(lines);

    const sessions = await call("sessions", { all: true });
    expect(sessions).toMatch(
      new RegExp(`${task.sessionId}: task @ work .*\\[STALE: no engine call for 32m`),
    );
    expect(sessions).not.toMatch(new RegExp(`${run.sessionId}: [^\\n]*STALE`));

    // the run's prompt lists them: no second copy above it
    const runStatus = await call("status", { session_id: run.sessionId });
    expect(runStatus.match(/STALE: session/g)).toHaveLength(1);
    expect(runStatus).not.toContain("A STALE session's agent may be dead or stuck");
    // a session's own status lists only what is below it: the task itself is its parent's to see
    const own = await call("status", { session_id: task.sessionId });
    expect(own).not.toContain("STALE: session");
    expect(own).not.toContain("A STALE session's agent");
    // a transition names it exactly once: in the prompt that renders it, else (a revisit's digest) below
    const count = (t: string) => t.split(lines[0]).length - 1;
    const peek = await call("transition", { session_id: run.sessionId, transition: "peek" });
    expect(peek).toContain(`Peek:\n${lines[0]}`);
    expect(count(peek)).toBe(1);
    expect(peek).not.toContain("A STALE session's agent may be dead or stuck");
    const again = await call("transition", { session_id: run.sessionId, transition: "back" });
    expect(again).toContain("Revisit #2");
    expect(count(again)).toBe(1);
    expect(again).toContain("A STALE session's agent may be dead or stuck");
    // the child's own write clears it
    await engine.setContext(task.sessionId, "progress", "alive");
    expect(engine.staleLines(run.sessionId)).toEqual([]);
  });

  it("status of a parent whose prompt does not render them lists its stale descendants on top", async () => {
    const { storage, engine, call } = mount();
    const mid = await engine.start("task");
    const worker = await engine.start("task", undefined, mid.sessionId);
    await age(storage, worker.sessionId, STALE_AFTER_DEFAULTS.prompt + 120);
    const [line] = engine.staleLines(mid.sessionId, true);
    expect(line).toContain(`STALE: session ${worker.sessionId} (task @ work, child of`);
    const text = await call("status", { session_id: mid.sessionId });
    expect(text.startsWith(`${line}\nA STALE session's agent may be dead or stuck`)).toBe(true);
    expect(await call("transition", { session_id: mid.sessionId, transition: "wait" })).toContain(
      line,
    );
  });

  it("{{stale_sessions}} renders in an action's success_prompt and context_set too", async () => {
    const { storage, engine } = mount();
    const a = await engine.start("act");
    const c = await engine.start("task", undefined, a.sessionId);
    await age(storage, c.sessionId, STALE_AFTER_DEFAULTS.prompt + 120);
    const [line] = engine.staleLines(a.sessionId, true);
    const st = await engine.transition(a.sessionId, "go");
    expect(st.prompt).toBe(`out=ok\n${line}`);
    expect(storage.read(a.sessionId)!.context.seen).toBe(line);
  });

  it("stale_after: 0 never marks; the parent stale once its children ended", async () => {
    const { storage, engine } = mount();
    const run = await engine.start("run");
    const task = await engine.start("task", undefined, run.sessionId);
    await engine.transition(task.sessionId, "wait");
    await age(storage, task.sessionId, 1e6);
    expect(engine.staleLines(run.sessionId)).toEqual([]);
    await engine.transition(task.sessionId, "end");
    await age(storage, run.sessionId, STALE_AFTER_DEFAULTS.prompt + 1);
    expect(engine.staleLines(run.sessionId)).toHaveLength(1);
    expect(engine.staleLines(run.sessionId, true)).toEqual([]);
  });
});

// ENG-PARENT-ANSWER-ACK: a driver that got the parent's answer writes `parent_answer_ack`; the question's
// `unanswered` mark ends there, and what is left idle afterwards is the worker's silence.
describe("parent_answer_ack: answered and acked versus unanswered", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) cleanupDir(dir);
    dir = undefined;
  });
  const MIN30 = 30 * 60 * 1000;

  async function mount() {
    const storage = new InMemoryStorage();
    const result = createTestLoader({
      run: {
        initial: "collect",
        states: { collect: { prompt: "c", transitions: { end: "end" } }, end: { terminal: true } },
      },
      task: {
        initial: "work",
        states: { work: { prompt: "work", transitions: { end: "end" } }, end: { terminal: true } },
      },
    });
    dir = result.dir;
    const engine = new Engine(storage, result.loader, new Executor());
    const handlers = new Map<
      string,
      (args: object) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
    >();
    registerTools(
      { registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h) } as never,
      engine,
      {} as never,
      result.loader,
      storage,
    );
    const call = async (name: string, args: object) =>
      (await handlers.get(name)!(args)).content[0].text;
    const run = await engine.start("run");
    const task = await engine.start("task", undefined, run.sessionId);
    await engine.setContext(task.sessionId, "task", "T1");
    await engine.setContext(task.sessionId, "ask_parent", "which design?");
    return { storage, engine, call, run: run.sessionId, task: task.sessionId };
  }

  it("answered and acked: no UNANSWERED line at +30 min; answered and not acked: still marked", async () => {
    const { engine, run, task } = await mount();
    const later = Date.now() + MIN30;
    // the parent's answer was relayed and cleared by the dispatcher: the engine holds nothing, the driver said nothing
    expect(engine.unansweredAskLines(run, later)).toHaveLength(1);
    await engine.setContext(task, ANSWER_ACK_KEY, "route=work: use the second design");
    expect(engine.unansweredAskLines(run, later)).toEqual([]);
  });

  it("an ack older than the question does not answer it, and an empty ack answers nothing", async () => {
    const { engine, run, task } = await mount();
    await engine.setContext(task, ANSWER_ACK_KEY, "first answer");
    await engine.setContext(task, "ask_parent", "and the name?");
    expect(engine.unansweredAskLines(run, Date.now() + MIN30)).toHaveLength(1);
    await engine.setContext(task, ANSWER_ACK_KEY, "");
    expect(engine.unansweredAskLines(run, Date.now() + MIN30)).toHaveLength(1);
    await engine.setContext(task, ANSWER_ACK_KEY, "second answer");
    expect(engine.unansweredAskLines(run, Date.now() + MIN30)).toEqual([]);
  });

  it("askStanding reads `unanswered <age>` before the ack and `answered, acked <time>` after it", async () => {
    const { storage, engine, task } = await mount();
    const asked = storage.read(task)!;
    const before = askStanding(asked, Date.parse(asked.updated_at) + 12 * 60 * 1000);
    expect(before).toMatchObject({ kind: "unanswered", age_s: 720 });
    await engine.setContext(task, ANSWER_ACK_KEY, "route=work");
    expect(askStanding(storage.read(task)!, Date.now())).toMatchObject({
      kind: "acked",
      ack: "route=work",
    });
  });

  it("an engine-held parent_answer is `answered, not relayed yet`, not unanswered; the ack still wins over it", async () => {
    const { storage, engine, call, task } = await mount();
    await engine.setContext(task, "parent_answer", "route=work: second design");
    expect(askStanding(storage.read(task)!, Date.now())).toMatchObject({ kind: "held" });
    expect(await call("status", { session_id: task })).toMatch(
      /^PARENT ASK: asked \S+, answered, not relayed to the driver yet\n/mu,
    );
    expect(await call("sessions", { all: true })).toContain(
      "[asks the parent: answered, not relayed to the driver yet]",
    );
    await engine.setContext(task, ANSWER_ACK_KEY, "route=work");
    expect(askStanding(storage.read(task)!, Date.now())).toMatchObject({ kind: "acked" });
  });

  it("the ack outlives the driver's clear of ask_parent until a move or a new question", async () => {
    const { storage, engine, call, run, task } = await mount();
    await engine.setContext(task, ANSWER_ACK_KEY, "route=work: use the second design");
    await engine.setContext(task, "ask_parent", "");
    const status = await call("status", { session_id: task });
    expect(status).toMatch(/^PARENT ASK: asked \S+, answered, acked \S+: "route=work: use/mu);
    expect(await call("sessions", { all: true })).toMatch(
      new RegExp(`${task}: [^\\n]*\\[asks the parent: answered, acked `),
    );
    // the clear leaves no open question, so no UNANSWERED line either
    expect(engine.unansweredAskLines(run, Date.now() + MIN30)).toEqual([]);
    const cur = storage.read(task)!;
    await storage.write(task, {
      ...cur,
      updated_at: new Date(Date.parse(cur.updated_at) - 2 * MIN30).toISOString(),
    });
    expect(engine.staleLines(run, true)[0]).toContain("the parent's answer reached the driver");
    // a new question is unanswered again
    await engine.setContext(task, "ask_parent", "and the name?");
    expect(askStanding(storage.read(task)!, Date.now())).toMatchObject({ kind: "unanswered" });
    expect(engine.unansweredAskLines(run, Date.now() + MIN30)).toHaveLength(1);
    // a clear of the new question leaves no standing: the ack belongs to the old one
    await engine.setContext(task, "ask_parent", "");
    expect(await call("status", { session_id: task })).not.toContain("PARENT ASK:");
  });

  it("status and sessions show the standing of the question", async () => {
    const { engine, call, task } = await mount();
    const open = await call("status", { session_id: task });
    expect(open).toMatch(/^PARENT ASK: asked \S+, unanswered \d+s\n/mu);
    expect(await call("sessions", { all: true })).toMatch(
      new RegExp(`${task}: [^\\n]*\\[asks the parent: unanswered \\d+s\\]`),
    );
    await engine.setContext(task, ANSWER_ACK_KEY, "route=work: use the second design");
    const acked = await call("status", { session_id: task });
    expect(acked).toMatch(
      /^PARENT ASK: asked \S+, answered, acked \S+: "route=work: use the second design"/mu,
    );
    expect(acked).not.toContain("unanswered");
    expect(await call("sessions", { all: true })).toMatch(
      new RegExp(`${task}: [^\\n]*\\[asks the parent: answered, acked `),
    );
  });

  it("a STALE line after the ack says the silence is the worker's; without the ack it says nothing of it", async () => {
    const { storage, engine, run, task } = await mount();
    const idle = async (): Promise<string> => {
      const cur = storage.read(task)!;
      await storage.write(task, {
        ...cur,
        updated_at: new Date(Date.parse(cur.updated_at) - 2 * MIN30).toISOString(),
      });
      return engine.staleLines(run, true)[0];
    };
    expect(await idle()).not.toContain("acked");
    await engine.setContext(task, ANSWER_ACK_KEY, "route=work");
    expect(await idle()).toContain("the parent's answer reached the driver (acked ");
  });

  it("the three driver instruction files name the ack as the first call on an answer", () => {
    const root = path.resolve(import.meta.dirname, "..");
    for (const f of ["agents/driver.md", "templates/drivers/task-driver.md"]) {
      const md = fs.readFileSync(path.join(root, f), "utf8");
      expect(md).toContain('key: "parent_answer_ack"');
      expect(md.indexOf('key: "parent_answer_ack"')).toBeLessThan(
        md.indexOf('key: "ask_parent", value: ""'),
      );
    }
    const dispatch = fs.readFileSync(
      path.join(root, "templates/drivers/dispatch-driver.md"),
      "utf8",
    );
    expect(dispatch).toContain("`parent_answer_ack`");
  });
});
