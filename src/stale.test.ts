import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import {
  STALE_AFTER_DEFAULTS,
  STALE_EXEC_GRACE_S,
  activeParents,
  formatSeconds,
  staleAfter,
  staleness,
} from "./stale.js";
import { registerTools } from "./tools.js";
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
      7200 + STALE_EXEC_GRACE_S,
    );
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
