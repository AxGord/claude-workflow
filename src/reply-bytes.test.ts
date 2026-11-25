import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { InMemoryStorage, cleanupDir, createTestLoader } from "./test-helpers.js";
import { registerTools, resetDeliveredPrompts } from "./tools.js";

const LOOPING = {
  initial: "poll",
  states: {
    poll: {
      prompt: "Poll the job. A long set of instructions the agent needs once, not on every loop.",
      transitions: { again: "poll", ready: "work" },
    },
    work: { prompt: "Work.", transitions: { done: "end", back: "poll" } },
    end: { terminal: true, outcome: "complete" },
  },
};

describe("reply bytes: a reply repeats only what the same context has not seen", () => {
  let dir: string | undefined;
  beforeEach(() => resetDeliveredPrompts());
  afterEach(() => {
    if (dir) cleanupDir(dir);
    dir = undefined;
  });

  function mount() {
    const storage = new InMemoryStorage();
    const result = createTestLoader({ loop: LOOPING });
    dir = result.dir;
    const engine = new Engine(storage, result.loader, new Executor());
    const handlers = new Map<
      string,
      (args: object) => Promise<{ content: Array<{ text: string }> }>
    >();
    const server = {
      registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h),
    };
    registerTools(server as never, engine, {} as never, result.loader, storage);
    const call = async (name: string, args: object) =>
      (await handlers.get(name)!(args)).content[0].text;
    return { engine, call };
  }

  it("start prints the rules whole the first time and as one line after; full: true prints them whole", async () => {
    const { call } = mount();
    const first = await call("start", { workflow: "loop", parent_session_id: "p" });
    const second = await call("start", { workflow: "loop", parent_session_id: "p" });
    const forced = await call("start", { workflow: "loop", parent_session_id: "p", full: true });
    expect(first).toContain("- Complete each state fully before transitioning to the next.");
    expect(second).not.toContain("- Complete each state fully");
    expect(second).toContain("WORKFLOW RULES (as in your first start reply)");
    for (const piece of [
      "one transition at a time",
      "finish each state first",
      "stop and investigate",
      "transition({",
    ])
      expect(second).toContain(piece);
    expect(forced).toContain("- Complete each state fully before transitioning to the next.");
    // the state's own instructions are never shortened by a second start
    expect(second).toContain("Poll the job.");
  });

  it("a second status names the unchanged context keys and lists only the new history", async () => {
    const { engine, call } = mount();
    const s = await engine.start("loop");
    await engine.setContext(s.sessionId, "task", "T-1");
    await engine.setContext(s.sessionId, "note", "first");
    const one = await call("status", { session_id: s.sessionId });
    expect(one).toContain("  task: T-1");
    expect(one).toContain("  note: first");
    expect(one).toContain("RECENT HISTORY:");

    const idle = await call("status", { session_id: s.sessionId });
    expect(idle).not.toContain("T-1");
    expect(idle).toMatch(/CONTEXT: unchanged since your last status: .*\btask, note;/);
    expect(idle).toContain("RECENT HISTORY: nothing new since your last status");
    expect(idle).toContain("Poll the job.");

    await engine.setContext(s.sessionId, "note", "second");
    await engine.transition(s.sessionId, "ready");
    const moved = await call("status", { session_id: s.sessionId });
    expect(moved).toContain("  note: second");
    expect(moved).not.toContain("T-1");
    expect(moved).toMatch(/unchanged since your last status: .*\btask\b/);
    expect(moved).toContain("RECENT HISTORY (since your last status):");
    expect(moved).toContain("poll --ready--> work");

    const whole = await call("status", { session_id: s.sessionId, full: true });
    expect(whole).toContain("  task: T-1");
    expect(whole).toContain("RECENT HISTORY:\n");
    expect(whole).toContain("poll --ready--> work");
  });

  it("a status of another session starts whole, and a new context epoch repeats the whole listing", async () => {
    const { engine, call } = mount();
    const a = await engine.start("loop");
    const b = await engine.start("loop", undefined, a.sessionId);
    await engine.setContext(a.sessionId, "k", "va");
    await engine.setContext(b.sessionId, "k", "vb");
    await call("status", { session_id: a.sessionId });
    expect(await call("status", { session_id: b.sessionId })).toContain("  k: vb");
    resetDeliveredPrompts();
    expect(await call("status", { session_id: a.sessionId })).toContain("  k: va");
  });

  it("a transition back into a state with the same routes does not list them again; a first visit always does", async () => {
    const { call } = mount();
    const started = await call("start", { workflow: "loop", parent_session_id: "p" });
    const sid = /SESSION: (\S+)/.exec(started)![1];
    const looped = await call("transition", { session_id: sid, transition: "again" });
    expect(looped).toContain("Revisit #2");
    expect(looped).toContain("TRANSITIONS: unchanged");
    expect(looped).not.toContain("again, ready");
    const forward = await call("transition", { session_id: sid, transition: "ready" });
    expect(forward).toContain("Work.");
    expect(forward).toContain("TRANSITIONS: done, back");
    const back = await call("transition", { session_id: sid, transition: "back" });
    expect(back).toContain("Revisit #3");
    expect(back).toContain("TRANSITIONS: again, ready");
  });

  it("a recorded session replays in fewer reply bytes than the same calls with every full flag set", async () => {
    const script = async (full: boolean) => {
      resetDeliveredPrompts();
      const { engine, call } = mount();
      const opt = full ? { full: true } : {};
      let bytes = 0;
      const add = (t: string) => (bytes += Buffer.byteLength(t));
      const started = await call("start", { workflow: "loop", parent_session_id: "p", ...opt });
      add(started);
      add(await call("start", { workflow: "loop", parent_session_id: "p", ...opt }));
      const sid = /SESSION: (\S+)/.exec(started)![1];
      await engine.setContext(sid, "task", "T-1");
      await engine.setContext(sid, "brief", "b".repeat(190));
      for (let i = 0; i < 4; i++) {
        add(await call("status", { session_id: sid, ...opt }));
        add(await call("transition", { session_id: sid, transition: "again" }));
      }
      add(await call("transition", { session_id: sid, transition: "ready" }));
      for (let i = 0; i < 3; i++) add(await call("status", { session_id: sid, ...opt }));
      return bytes;
    };
    const before = await script(true);
    const after = await script(false);
    expect(after).toBeLessThan(before * 0.85);
  });
});
