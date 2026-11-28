import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { registerTools } from "./tools.js";
import { HOLD_DEADLINE_MAX_S, holdOf, parseHold } from "./parent-hold.js";
import { InMemoryStorage, cleanupDir } from "./test-helpers.js";

// ENG-PARENT-HOLD-UNTIL-CONDITION: a parent's `hold` on a blocked task carries a condition the engine checks. A hold
// with none is refused; a met condition is one NEEDS-PARENT line, once; while unmet it silences the stale and
// unanswered reminders of its task only up to its deadline.
const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const H = 3600 * 1000;

async function setup(state = "blocked", idleH = 17) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-hold-"));
  dirs.push(d);
  const storage = new InMemoryStorage();
  const engine = new Engine(storage, new Loader(TEMPLATES, d, null), new Executor());
  const disp = await engine.start("batch");
  const dcur = storage.read(disp.sessionId)!;
  dcur.stack[dcur.active_frame].current_state = "collect";
  const queue = path.join(d, "queue.yaml");
  const setQueue = (dep: string): void =>
    fs.writeFileSync(
      queue,
      `batch_size: 2\ntasks:\n  - id: T1\n    status: running\n  - id: DEP\n    status: ${dep}\n`,
    );
  setQueue("running");
  dcur.context.queue_file = queue;
  await storage.write(disp.sessionId, dcur);
  const task = await engine.start("batch-task", undefined, disp.sessionId, d, undefined, {
    task: "T1",
  });
  const tcur = storage.read(task.sessionId)!;
  tcur.stack[tcur.active_frame].current_state = state;
  await storage.write(task.sessionId, {
    ...tcur,
    agent_id: "driver1",
    updated_at: new Date(Date.now() - idleH * H).toISOString(),
  });
  const lines = (now = Date.now()): string[] => engine.staleLines(disp.sessionId, true, now);
  return { engine, storage, d, dsid: disp.sessionId, tsid: task.sessionId, setQueue, lines };
}

describe("parent hold: the answer", () => {
  it("a hold without a condition is refused, and records nothing", async () => {
    const { engine, storage, tsid } = await setup();
    for (const bad of ["hold", "hold until 5pm", "hold until_done:", "hold until_cmd:   "])
      await expect(engine.setContext(tsid, "parent_answer", bad)).rejects.toThrow(/hold refused/);
    expect(storage.read(tsid)!.context.parent_answer).toBeUndefined();
    expect(holdOf(storage.read(tsid)!.context)).toBeUndefined();
  });

  it("a hold off `blocked` is refused", async () => {
    const { engine, tsid } = await setup("work");
    await expect(engine.setContext(tsid, "parent_answer", "hold until_done: DEP")).rejects.toThrow(
      /standing at "blocked"/,
    );
  });

  it("a hold with a condition is stored beside the answer; any other answer ends it", async () => {
    const { engine, storage, tsid } = await setup();
    await engine.setContext(tsid, "parent_answer", "hold until_done: DEP");
    const ctx = storage.read(tsid)!.context;
    expect(ctx.parent_answer).toBe("hold until_done: DEP");
    expect(holdOf(ctx)).toMatchObject({ kind: "until_done", value: "DEP", deadline_s: 3600 });
    // the dispatcher's clear after relaying leaves the hold standing
    await engine.setContext(tsid, "parent_answer", "");
    expect(holdOf(storage.read(tsid)!.context)).toBeDefined();
    await engine.setContext(tsid, "parent_answer", "close");
    expect(holdOf(storage.read(tsid)!.context)).toBeUndefined();
  });

  it("the deadline is settable and capped", () => {
    const now = new Date();
    expect(parseHold("hold deadline=30m until_cmd: true", now)).toMatchObject({
      hold: { deadline_s: 1800 },
    });
    expect(parseHold("hold deadline=2h until_cmd: true", now)).toMatchObject({
      hold: { deadline_s: 7200 },
    });
    const over = parseHold(`hold deadline=${HOLD_DEADLINE_MAX_S / 3600 + 1}h until_cmd: true`, now);
    expect("error" in over && over.error).toContain("never silenced for longer");
  });
});

describe("parent hold: the condition", () => {
  it("an `until_cmd` that starts passing yields one condition-met line", async () => {
    const { engine, tsid, d, lines } = await setup();
    const flag = path.join(d, "flag");
    await engine.setContext(tsid, "parent_answer", `hold until_cmd: test -e ${flag}`);
    const t0 = Date.now();
    expect(lines(t0)).toEqual([]);
    fs.writeFileSync(flag, "");
    const met = lines(t0 + 60_000);
    expect(met).toHaveLength(1);
    expect(met[0]).toBe(
      `NEEDS-PARENT task=T1 session=${tsid} reason=hold condition met: \`test -e ${flag}\` exits 0`,
    );
  });

  it("an `until_done` line landing yields it", async () => {
    const { engine, tsid, setQueue, lines } = await setup();
    await engine.setContext(tsid, "parent_answer", "hold until_done: DEP");
    const t0 = Date.now();
    expect(lines(t0)).toEqual([]);
    setQueue("done");
    expect(lines(t0 + 60_000)).toEqual([
      `NEEDS-PARENT task=T1 session=${tsid} reason=hold condition met: DEP is done`,
    ]);
  });

  it("a met hold repeats until a reply carrying its line is returned, then does not", async () => {
    const { engine, storage, dsid, tsid, setQueue, lines } = await setup();
    await engine.setContext(tsid, "parent_answer", "hold until_done: DEP");
    setQueue("done");
    const t0 = Date.now();
    const met = (ls: string[]) => ls.filter(l => l.includes("hold condition met"));
    // computing the lines hands nothing: a prompt rendered for nobody must not eat the line
    expect(met(lines(t0))).toHaveLength(1);
    expect(met(lines(t0 + 1000))).toHaveLength(1);
    engine.markHoldsHanded(dsid, "a reply without the line", t0 + 2000);
    expect(met(lines(t0 + 3000))).toHaveLength(1);
    engine.markHoldsHanded(dsid, `a reply with\n${met(lines(t0))[0]}\nin it`, t0 + 4000);
    expect(met(lines(t0 + 60_000))).toHaveLength(0);
    // the record outlives the process: the session carries `met_handed`
    await new Promise(r => setTimeout(r, 10));
    expect(holdOf(storage.read(tsid)!.context)?.met_handed).toBeDefined();
  });

  it("a prompt thrown away (status with a key, the read before a transition) does not eat the met line: the next full reply carries it once", async () => {
    const { engine, storage, dsid, tsid, setQueue } = await setup();
    const handlers = new Map<string, (a: object) => Promise<{ content: { text: string }[] }>>();
    const server = { registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h) };
    registerTools(
      server as never,
      engine,
      {} as never,
      new Loader(TEMPLATES, os.tmpdir(), null),
      storage,
    );
    const call = async (name: string, args: object) =>
      (await handlers.get(name)!(args)).content[0].text;
    const count = (t: string) =>
      t.split(`task=T1 session=${tsid} reason=hold condition met`).length - 1;
    await engine.setContext(tsid, "parent_answer", "hold until_done: DEP");
    setQueue("done");

    engine.getStatus(dsid); // the leaving read of a transition renders the prompt and drops it
    expect(await call("status", { session_id: dsid, key: "tasks" })).not.toContain(
      "hold condition",
    );
    expect(count(await call("status", { session_id: dsid }))).toBe(1);
    expect(count(await call("status", { session_id: dsid }))).toBe(0);
  });

  it("a transition that leaves the prompt without the line hands it in its notices, once", async () => {
    const { engine, storage, dsid, tsid, setQueue } = await setup();
    const handlers = new Map<string, (a: object) => Promise<{ content: { text: string }[] }>>();
    const server = { registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h) };
    registerTools(
      server as never,
      engine,
      {} as never,
      new Loader(TEMPLATES, os.tmpdir(), null),
      storage,
    );
    const call = async (name: string, args: object) =>
      (await handlers.get(name)!(args)).content[0].text;
    const count = (t: string) =>
      t.split(`task=T1 session=${tsid} reason=hold condition met`).length - 1;
    await engine.setContext(tsid, "parent_answer", "hold until_done: DEP");
    setQueue("done");
    // `stop` leads to `report`, whose prompt does not render {{stale_sessions}}
    expect(count(await call("transition", { session_id: dsid, transition: "stop" }))).toBe(1);
    expect(count(await call("status", { session_id: dsid }))).toBe(0);
  });

  it("a command that fails or times out is not met", async () => {
    const { engine, tsid, lines } = await setup();
    await engine.setContext(tsid, "parent_answer", "hold until_cmd: exit 3");
    expect(lines()).toEqual([]);
  });
});

describe("parent hold: the reminders", () => {
  it("an unmet hold inside its deadline silences the stale lines of its task", async () => {
    const { engine, tsid, lines } = await setup();
    expect(lines().some(l => l.startsWith("NEEDS-PARENT task=T1 session=" + tsid))).toBe(true);
    await engine.setContext(tsid, "parent_answer", "hold until_done: DEP");
    expect(lines()).toEqual([]);
  });

  it("an unmet hold inside its deadline silences the UNANSWERED line of an old open question, past it the line is back", async () => {
    const { engine, storage, dsid, tsid } = await setup(undefined, 0.01);
    await engine.setContext(tsid, "ask_parent", "blocked: the gate is red");
    const cur = storage.read(tsid)!;
    const old = new Date(Date.now() - 2 * H).toISOString();
    await storage.write(tsid, {
      ...cur,
      history: cur.history.map(h => (h.detail === "ask_parent" ? { ...h, at: old } : h)),
    });
    expect(engine.unansweredAskLines(dsid)).toHaveLength(1);
    await engine.setContext(tsid, "parent_answer", "hold deadline=30m until_done: DEP");
    await engine.setContext(tsid, "parent_answer", ""); // the dispatcher's clear after its relay
    expect(engine.unansweredAskLines(dsid, Date.now())).toEqual([]);
    expect(engine.unansweredAskLines(dsid, Date.now() + H)).toHaveLength(1);
  });

  it("past its deadline the reminder returns, naming the condition", async () => {
    const { engine, tsid, lines } = await setup();
    await engine.setContext(tsid, "parent_answer", "hold deadline=30m until_done: DEP");
    expect(lines(Date.now() + 20 * 60_000)).toEqual([]);
    const late = lines(Date.now() + 2 * H);
    expect(late.some(l => l.startsWith("STALE: session"))).toBe(true);
    expect(late).toContain(
      `NEEDS-PARENT task=T1 session=${tsid} reason=hold 2h00m, condition not met: DEP is done; still hold?`,
    );
    // a fresh hold restarts the deadline
    await engine.setContext(tsid, "parent_answer", "hold deadline=30m until_done: DEP");
    expect(lines(Date.now() + 20 * 60_000)).toEqual([]);
  });

  it("the default deadline is one hour", async () => {
    const { engine, tsid, lines } = await setup(undefined, 0.01);
    await engine.setContext(tsid, "parent_answer", "hold until_done: DEP");
    expect(lines(Date.now() + 50 * 60_000)).toEqual([]);
    expect(lines(Date.now() + 70 * 60_000).some(l => l.includes("still hold?"))).toBe(true);
  });

  it("the dispatcher's collect prompt carries the met line", async () => {
    const { engine, dsid, tsid, setQueue } = await setup();
    await engine.setContext(tsid, "parent_answer", "hold until_done: DEP");
    setQueue("done");
    expect(engine.getStatus(dsid).prompt).toContain("reason=hold condition met: DEP is done");
  });
});
