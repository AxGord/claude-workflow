import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPAWN_DEPTH_ENV } from "./driver.js";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { decideRefresh } from "./refresh.js";
import { InMemoryStorage, cleanupDir, createFixtureDir } from "./test-helpers.js";
import { registerTools } from "./tools.js";
import { DispatcherObjectSchema } from "./types.js";

// ENG-DISPATCHER-CONTEXT-REFRESH: the engine, not the dispatcher agent, decides when a long-lived dispatcher is
// replaced by a fresh one, renders the one hand-back to main, and lists the drivers the fresh one rebinds.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), "utf8");
const MIN = 60_000;
const OLD = "a1000000000000001";
const FRESH = "a2000000000000002";
const DRIVER = "a3000000000000003";

describe("decideRefresh", () => {
  const at = (
    idleMin: number | undefined,
    context: number | undefined,
    safePoint = true,
    spec = {},
  ) =>
    decideRefresh(spec, {
      agent: OLD,
      idleMs: idleMin === undefined ? undefined : idleMin * MIN,
      context,
      safePoint,
    });

  it("a context at or below the bound is never due, however cold", () => {
    expect(at(600, 200_000).due).toBe(false);
    expect(at(0, 10).due).toBe(false);
  });
  it("above the bound after the cache's life (a cold wake) is due, even with a relay of its own pending", () => {
    const d = at(61, 200_001, false);
    expect(d.due).toBe(true);
    expect(d.reason).toContain("cold wake: idle 61 min >= 60");
  });
  it("above the bound while warm is due only at a safe point", () => {
    expect(at(5, 300_000, true)).toMatchObject({ due: true });
    expect(at(5, 300_000, true).reason).toContain("safe point");
    expect(at(5, 300_000, false).due).toBe(false);
  });
  it("an unknown agent or context is not a reason to replace anyone", () => {
    expect(at(600, undefined).due).toBe(false);
    expect(
      decideRefresh({}, { agent: "", context: 900_000, idleMs: 600 * MIN, safePoint: true }).due,
    ).toBe(false);
  });
  it("the thresholds are the declared ones, the idle default is the resume's 60", () => {
    expect(at(11, 1001, false, { context_tokens: 1000, idle_minutes: 10 }).due).toBe(true);
    expect(at(9, 1001, false, { context_tokens: 1000, idle_minutes: 10 }).due).toBe(false);
    expect(at(59, 900_000, false).due).toBe(false);
    expect(at(60, 900_000, false).due).toBe(true);
  });
});

describe("the dispatcher: block's refresh key", () => {
  const base = { model: "haiku", effort: "low", prompt_ref: "dispatch-driver" };
  it("takes false or the two thresholds and refuses another key", () => {
    expect(DispatcherObjectSchema.safeParse({ ...base, refresh: false }).success).toBe(true);
    expect(
      DispatcherObjectSchema.safeParse({
        ...base,
        refresh: { idle_minutes: 30, context_tokens: 100000 },
      }).success,
    ).toBe(true);
    expect(DispatcherObjectSchema.safeParse({ ...base, refresh: true }).success).toBe(false);
    expect(DispatcherObjectSchema.safeParse({ ...base, refresh: { bound: 1 } }).success).toBe(
      false,
    );
  });
  it("bundled batch declares it and renders it in collect", () => {
    const empty = createFixtureDir({});
    try {
      const batch = new Loader(path.join(ROOT, "templates"), empty, null).get("batch");
      expect(batch?.dispatcher?.refresh).toEqual({ idle_minutes: 60, context_tokens: 200000 });
      expect(batch?.states.collect.prompt).toContain("{{refresh}}");
    } finally {
      cleanupDir(empty);
    }
  });
});

describe("the engine decides, records and renders the refresh", () => {
  let cfg: string;
  let savedCfg: string | undefined;
  const dirs: string[] = [];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), "wf-refresh-cfg-"));
    savedCfg = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    for (const k of ["WF_T_DISP", SPAWN_DEPTH_ENV]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.WF_T_DISP = "1";
  });
  afterEach(() => {
    if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedCfg;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanupDir(cfg);
    for (const d of dirs.splice(0)) cleanupDir(d);
  });

  /** The agent's transcript: one turn of `context` tokens. */
  const transcript = (agent: string, context: number): void => {
    const subs = path.join(cfg, "projects", "p", "conv", "subagents");
    fs.mkdirSync(subs, { recursive: true });
    fs.writeFileSync(
      path.join(subs, `agent-${agent}.jsonl`),
      JSON.stringify({
        type: "assistant",
        message: {
          id: `m-${agent}`,
          model: "claude-haiku-4-5",
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: context - 1 },
        },
      }) + "\n",
    );
  };

  const workflows = (refresh?: object | false) => ({
    disp: {
      initial: "plan",
      dispatcher: {
        model: "haiku",
        effort: "low",
        prompt_ref: "dispatch-driver",
        env: "WF_T_DISP",
        after: "plan",
        ...(refresh === undefined ? {} : { refresh }),
      },
      states: {
        plan: { prompt: "plan", transitions: { ready: "collect" } },
        collect: {
          prompt: "collect\n{{refresh}}",
          full_on_revisit: true,
          transitions: { slot_free: "collect", refill: "collect", end: "fin" },
        },
        fin: { terminal: true, outcome: "complete" },
      },
    },
    task: {
      initial: "claim",
      states: {
        claim: { prompt: "claim", transitions: { go: "done" } },
        done: { terminal: true, outcome: "complete" },
      },
    },
  });

  async function dispatcher(o: { refresh?: object | false; context: number }) {
    const dir = createFixtureDir(workflows(o.refresh ?? { context_tokens: 100_000 }));
    dirs.push(dir);
    const storage = new InMemoryStorage();
    const loader = new Loader(null, dir, null);
    const engine = new Engine(storage, loader, new Executor());
    const d = (await engine.start("disp")).sessionId;
    await engine.linkAgent(d, OLD, "driver");
    transcript(OLD, o.context);
    /** The wake: the session's previous engine call was `idleMin` minutes ago, then one move into collect. */
    const wake = async (idleMin: number) => {
      await storage.update(d, cur =>
        cur ? { ...cur, updated_at: new Date(Date.now() - idleMin * MIN).toISOString() } : cur,
      );
      const at = storage.read(d)!.stack[0].current_state;
      return engine.transition(d, at === "plan" ? "ready" : "refill");
    };
    return { engine, storage, loader, d, wake };
  }

  it("a small context renders none, whatever the idle", async () => {
    const { wake, engine, d, storage } = await dispatcher({ context: 99_000 });
    const status = await wake(600);
    expect(status.prompt).toContain("collect\nnone");
    expect(engine.refreshLines(d)).toEqual([]);
    expect(storage.read(d)!.dispatcher_refresh).toBeUndefined();
  });

  it("a large context after a cold wake renders the refresh at collect, recorded, with the hand-back text", async () => {
    const { wake, engine, d, storage } = await dispatcher({ context: 250_000 });
    const status = await wake(120);
    expect(status.prompt).toContain(`REFRESH-DUE: dispatcher ${OLD} is to be replaced`);
    expect(status.prompt).toContain("cold wake: idle 120 min >= 60, context 250000 > 100000");
    expect(status.prompt).toContain(
      `MESSAGE: REFRESH session=${d} old=${OLD} reason=cold wake: idle 120 min >= 60`,
    );
    expect(status.prompt).toContain(`key: "dispatcher_call"`);
    const rec = storage.read(d)!.dispatcher_refresh!;
    expect(rec).toMatchObject({ agent: OLD, context: 250_000, idle_minutes: 120 });
    // recorded once at entry: a later, warm status shows the same decision
    expect(engine.getStatus(d).prompt).toContain("REFRESH-DUE");
  });

  it("a large context while warm refreshes at a safe point only", async () => {
    const warm = await dispatcher({ context: 250_000 });
    expect((await warm.wake(5)).prompt).toContain("REFRESH-DUE");
    expect(warm.storage.read(warm.d)!.dispatcher_refresh?.reason).toContain("safe point");
  });

  it("a warm dispatcher holding a parent answer to relay is not refreshed; a cold one is", async () => {
    for (const [idle, due] of [
      [5, false],
      [120, true],
    ] as const) {
      const { engine, storage, d, wake } = await dispatcher({ context: 250_000 });
      const task = await engine.start("task", undefined, d, undefined, undefined, { task: "T1" });
      await engine.setContext(d, "tasks", `T1=${task.sessionId} driver=${DRIVER}`);
      await engine.setContext(task.sessionId, "parent_answer", "route=go");
      const status = await wake(idle);
      expect(status.prompt.includes("REFRESH-DUE")).toBe(due);
      expect(storage.read(d)!.dispatcher_refresh !== undefined).toBe(due);
    }
  });

  it("`refresh: false` never refreshes, and an unlinked agent has nothing to replace", async () => {
    const off = await dispatcher({ refresh: false, context: 900_000 });
    expect((await off.wake(600)).prompt).toContain("collect\nnone");
    expect(off.storage.read(off.d)!.dispatcher_refresh).toBeUndefined();
  });

  it("an unreadable transcript is no reason to refresh", async () => {
    const { wake, storage, d } = await dispatcher({ context: 250_000 });
    fs.rmSync(path.join(cfg, "projects"), { recursive: true });
    expect((await wake(600)).prompt).toContain("collect\nnone");
    expect(storage.read(d)!.dispatcher_refresh).toBeUndefined();
  });

  it("main-handed: refresh_handed stops the line, so it is handed once", async () => {
    const { wake, engine, d } = await dispatcher({ context: 250_000 });
    await wake(120);
    expect(engine.refreshLines(d)).toHaveLength(2);
    await engine.setContext(d, "refresh_handed", OLD);
    expect(engine.refreshLines(d)).toEqual([]);
    expect(engine.getStatus(d).prompt).toContain("collect\nnone");
  });

  it("after main links the fresh dispatcher the REBIND list names each live driver, until it records the rebind", async () => {
    const { wake, engine, storage, d } = await dispatcher({ context: 250_000 });
    const task = await engine.start("task", undefined, d, undefined, undefined, { task: "T1" });
    await engine.setContext(
      d,
      "tasks",
      `T1=${task.sessionId} driver=${DRIVER} T2=${"0".repeat(8)} driver=-`,
    );
    await wake(120);
    await engine.setContext(d, "refresh_handed", OLD);
    await engine.linkAgent(d, FRESH, "driver");
    const lines = engine.refreshLines(d);
    expect(lines[0]).toContain(`REBIND: you (${FRESH}) replace dispatcher ${OLD}`);
    expect(lines[0]).toContain(
      `DISPATCHER CHANGED: your dispatcher is now ${FRESH}; nothing to do.`,
    );
    expect(lines.slice(1)).toEqual([
      `REBIND-TASK: task=T1 session=${task.sessionId} driver=${DRIVER}`,
    ]);
    expect(engine.getStatus(d).prompt).toContain("REBIND-TASK");
    await engine.setContext(d, "dispatcher_rebound", FRESH);
    expect(engine.refreshLines(d)).toEqual([]);
    // the fresh one has a small context: the next collect entry decides nothing, the old record stays only as history
    transcript(FRESH, 20_000);
    const again = await wake(1);
    expect(again.prompt).toContain("collect\nnone");
    expect(storage.read(d)!.dispatcher_refresh?.agent).toBe(OLD);
  });

  it("after a refresh a task's answer still names the right driver: it rides the `tasks` key, not the agent", async () => {
    const { wake, engine, storage, d } = await dispatcher({ context: 250_000 });
    const task = await engine.start("task", undefined, d, undefined, undefined, { task: "T1" });
    await engine.setContext(d, "tasks", `T1=${task.sessionId} driver=${DRIVER}`);
    await wake(120);
    await engine.linkAgent(d, FRESH, "driver");
    await engine.setContext(task.sessionId, "parent_answer", "route=go");
    expect(engine.parentAnswerLines(d)).toEqual([
      `PARENT-ANSWER: task=T1 session=${task.sessionId} driver=${DRIVER}: route=go`,
    ]);
    // the task session now names the fresh dispatcher, which its driver checks a relayed decision against
    expect(storage.read(task.sessionId)!.context.dispatcher_agent).toBe(FRESH);
  });

  /** The real call order of a wake: a `context_set` of the bookkeeping key first, then the `transition`, `idleMin` after the last write. */
  const realWake = async (m: Awaited<ReturnType<typeof dispatcher>>, idleMin: number) => {
    await m.storage.update(m.d, cur =>
      cur ? { ...cur, updated_at: new Date(Date.now() - idleMin * MIN).toISOString() } : cur,
    );
    await m.engine.setContext(m.d, "tasks", "");
    const at = m.storage.read(m.d)!.stack[0].current_state;
    return m.engine.transition(m.d, at === "plan" ? "ready" : "refill");
  };

  it("the idle is the silence before the wake's first write: a context_set always precedes the transition", async () => {
    const m = await dispatcher({ context: 250_000 });
    const status = await realWake(m, 120);
    expect(status.prompt).toContain("cold wake: idle 120 min >= 60");
    expect(m.storage.read(m.d)!.dispatcher_refresh?.idle_minutes).toBe(120);
  });

  it("a warm wake after a cold one is warm: the next wake's own silence is measured, not the earlier one's", async () => {
    const m = await dispatcher({ context: 250_000 });
    await m.engine.setContext(m.d, "refresh_handed", OLD);
    await realWake(m, 180);
    expect(m.storage.read(m.d)!.wake?.idle_ms).toBeGreaterThanOrEqual(180 * MIN);
    // the old record would hide the new reading: drop it, a fresh wake 5 minutes later decides again
    await m.storage.update(m.d, cur => (cur ? { ...cur, dispatcher_refresh: undefined } : cur));
    await m.engine.setContext(m.d, "refresh_handed", "");
    const status = await realWake(m, 5);
    expect(status.prompt).toContain("at a safe point");
    expect(status.prompt).not.toContain("cold wake");
    expect(m.storage.read(m.d)!.wake?.idle_ms).toBeLessThan(10 * MIN);
  });

  it("writes under 3 minutes apart are one wake: the transition keeps the idle the context_set saw", async () => {
    const m = await dispatcher({ context: 250_000 });
    const status = await realWake(m, 90);
    expect(status.prompt).toContain("idle 90 min");
    // a status a minute later is the same wake
    await m.storage.update(m.d, cur =>
      cur ? { ...cur, updated_at: new Date(Date.now() - MIN).toISOString() } : cur,
    );
    expect(m.engine.getStatus(m.d).prompt).toContain("idle 90 min");
  });

  it("a refresh first seen on a status reply (no record at collect entry) is rebound the same way", async () => {
    const { engine, storage, d, wake } = await dispatcher({ context: 20_000 });
    const task = await engine.start("task", undefined, d, undefined, undefined, { task: "T1" });
    await engine.setContext(d, "tasks", `T1=${task.sessionId} driver=${DRIVER}`);
    await wake(1);
    expect(storage.read(d)!.dispatcher_refresh).toBeUndefined();
    // the transcript grew past the bound while the agent was at collect: only the status path sees it
    transcript(OLD, 250_000);
    expect(engine.refreshLines(d)[0]).toContain(`REFRESH-DUE: dispatcher ${OLD}`);
    expect(storage.read(d)!.dispatcher_refresh).toBeUndefined();
    await engine.setContext(d, "refresh_handed", OLD);
    await engine.linkAgent(d, FRESH, "driver");
    const lines = engine.refreshLines(d);
    expect(lines[0]).toContain(`REBIND: you (${FRESH}) replace dispatcher ${OLD}`);
    expect(lines.slice(1)).toEqual([
      `REBIND-TASK: task=T1 session=${task.sessionId} driver=${DRIVER}`,
    ]);
  });

  it("a reply whose prompt lacks {{refresh}} (a heir's own collect) still carries the lines", async () => {
    const dir = createFixtureDir({
      ...workflows({ context_tokens: 100_000 }),
      disp: {
        ...workflows({ context_tokens: 100_000 }).disp,
        states: {
          plan: { prompt: "plan", transitions: { ready: "collect" } },
          collect: {
            prompt: "an heir's collect",
            transitions: { slot_free: "collect", refill: "collect", end: "fin" },
          },
          fin: { terminal: true, outcome: "complete" },
        },
      },
    });
    dirs.push(dir);
    const storage = new InMemoryStorage();
    const loader = new Loader(null, dir, null);
    const engine = new Engine(storage, loader, new Executor());
    const handlers = new Map<
      string,
      (a: object) => Promise<{ content: Array<{ text: string }> }>
    >();
    const server = { registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h) };
    registerTools(server as never, engine, {} as never, loader, storage);
    const call = async (n: string, a: object) => (await handlers.get(n)!(a)).content[0].text;
    const d = /SESSION: (\w+)/.exec(await call("start", { workflow: "disp", reply: "id" }))![1];
    await engine.linkAgent(d, OLD, "driver");
    transcript(OLD, 250_000);
    await storage.update(d, cur =>
      cur ? { ...cur, updated_at: new Date(Date.now() - 120 * MIN).toISOString() } : cur,
    );
    const reply = await call("transition", { session_id: d, transition: "ready" });
    expect(reply).toContain("an heir's collect");
    expect(reply).toContain(`REFRESH-DUE: dispatcher ${OLD}`);
    expect(await call("status", { session_id: d })).toContain("REFRESH-DUE");
  });
});

describe("the instructions the refresh rests on", () => {
  const rules = read("templates/drivers/dispatch-driver.md");

  it("the dispatcher's instructions hand REFRESH to main once, rebind the drivers once, and keep no memory of their own", () => {
    expect(rules).toContain("the only five things main gets");
    expect(rules).toContain("`REFRESH session=<D> old=<agent id> reason=…`");
    expect(rules).toContain('key: "refresh_handed"');
    expect(rules).toContain('key: "dispatcher_rebound"');
    expect(rules).toContain("`REBIND-TASK: task=<ID> session=<P> driver=<id>`");
  });
  it("what the old dispatcher kept only in its transcript is in context keys now", () => {
    expect(rules).toContain('key: "stale_reminded"');
    expect(rules).toContain("(the context key, never your memory)");
    expect(rules).toContain("`drivers_respawned`");
    expect(rules).not.toContain("do not repeat it on later wakes unless the idle time doubled");
  });
  it("both driver files take the rebind message and answer with their last line", () => {
    for (const f of ["templates/drivers/task-driver.md", "agents/driver.md"]) {
      const md = read(f);
      expect(md).toContain("`DISPATCHER CHANGED: your dispatcher is now <id>; nothing to do.`");
      expect(md).toContain("`REBOUND task=<ID> session=<P> dispatcher=<id>`");
      expect(md).toContain("never repeat that earlier line");
    }
  });
  it("the DRIVER block tells main the fifth message and its three steps", () => {
    expect(read("src/driver.ts")).toContain("ONLY with these five");
    expect(read("src/driver.ts")).toContain("`REFRESH session=<D> old=<agent id> reason=…`");
  });
});
