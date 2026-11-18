import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { registerTools } from "./tools.js";
import { InMemoryStorage, cleanupDir, createTestLoader } from "./test-helpers.js";
import type { ModelTable } from "./types.js";

const TABLE: ModelTable = {
  rows: [
    { upto: 5, model: "sonnet", effort: "high" },
    { upto: 10, model: "opus", effort: "high" },
  ],
};

const WF = {
  initial: "claim",
  model_table: TABLE,
  states: {
    claim: { prompt: "claim", transitions: { prepare: "make", plain: "talk", loop: "claim" } },
    make: {
      type: "exec",
      command: 'printf %s "$TASK"',
      env: { TASK: "{{context.task}}" },
      context_set: { made: "{{stdout}}" },
      on_success: "talk",
      on_error: "talk",
    },
    talk: {
      prompt: "task={{context.task}} model={{context.model}} made={{context.made}}",
      transitions: { done: "end" },
    },
    end: { terminal: true, outcome: "complete" },
  },
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

function mount() {
  const storage = new InMemoryStorage();
  const { loader, dir } = createTestLoader({ wf: WF });
  dirs.push(dir);
  const engine = new Engine(storage, loader, new Executor());
  const handlers = new Map<string, (args: object) => Promise<{ isError?: boolean }>>();
  const server = {
    registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h),
  };
  registerTools(server as never, engine, {} as never, loader, storage);
  const call = async (name: string, args: object) => {
    const r = (await handlers.get(name)!(args)) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: r.isError === true, text: r.content[0].text };
  };
  return { engine, storage, call };
}

const shape = (storage: InMemoryStorage, sid: string) =>
  storage.read(sid)!.history.map(h => ({ ...h, at: "", frame: 0 }));

describe("transition `set`", () => {
  it("writes the keys before the move: the entered exec and prompt read them", async () => {
    const { engine, storage } = mount();
    const { sessionId } = await engine.start("wf");
    const r = await engine.transition(sessionId, "prepare", "me", { task: "T-1", difficulty: 7 });
    expect(r.prompt).toBe("task=T-1 model=opus made=T-1");
    expect(storage.read(sessionId)!.context).toMatchObject({
      task: "T-1",
      difficulty: 7,
      model: "opus",
      made: "T-1",
    });
  });

  it("history and the event log are what the same calls one by one leave", async () => {
    const a = mount();
    const b = mount();
    const sa = (await a.engine.start("wf")).sessionId;
    const sb = (await b.engine.start("wf")).sessionId;
    await a.engine.setContext(sa, "task", "T-1", "me");
    await a.engine.setContext(sa, "difficulty", 7, "me");
    await a.engine.transition(sa, "plain", "me");
    await b.engine.transition(sb, "plain", "me", { task: "T-1", difficulty: 7 });
    const strip = (s: string, h: { detail?: string }[]) => JSON.stringify(h).split(s).join("SID");
    expect(strip(sb, shape(b.storage, sb))).toBe(strip(sa, shape(a.storage, sa)));
    expect(shape(b.storage, sb).map(h => h.event ?? h.via)).toEqual([
      "start",
      "context_set",
      "context_set",
      "model",
      "plain",
    ]);
    const kinds = (x: ReturnType<typeof mount>, sid: string) =>
      x.storage.events
        .since(0)
        .filter(e => e.session === sid || (e as { sid?: string }).sid === sid)
        .map(e => `${e.kind}`);
    // the log derives `rescore` / `queue` from the context diff of ONE write, so in a single call they
    // follow the move's own event instead of preceding it: the same events, in the write's order
    expect(kinds(a, sa)).toEqual(["session_start", "rescore", "transition"]);
    expect(kinds(b, sb)).toEqual(["session_start", "transition", "rescore"]);
  });

  it("a refused key refuses the whole call: no key, no history line, no move", async () => {
    const { engine, storage } = mount();
    const { sessionId } = await engine.start("wf");
    const before = JSON.stringify(storage.read(sessionId));
    await expect(
      engine.transition(sessionId, "plain", "me", { task: "T-1", difficulty: "eleven" }),
    ).rejects.toThrow("difficulty");
    expect(JSON.stringify(storage.read(sessionId))).toBe(before);
  });

  it("a transition that is not available writes no key", async () => {
    const { engine, storage } = mount();
    const { sessionId } = await engine.start("wf");
    const before = JSON.stringify(storage.read(sessionId));
    await expect(engine.transition(sessionId, "nope", "me", { task: "T-1" })).rejects.toThrow(
      "not available",
    );
    expect(JSON.stringify(storage.read(sessionId))).toBe(before);
  });

  it("an empty set and no set both behave as a plain transition", async () => {
    const a = mount();
    const b = mount();
    const sa = (await a.engine.start("wf")).sessionId;
    const sb = (await b.engine.start("wf")).sessionId;
    await a.engine.transition(sa, "plain", "me");
    await b.engine.transition(sb, "plain", "me", {});
    expect(b.storage.read(sb)!.context).toEqual(a.storage.read(sa)!.context);
    expect(shape(b.storage, sb)).toEqual(shape(a.storage, sa));
  });

  it("keys apply in the given order: the later one wins", async () => {
    const { engine, storage } = mount();
    const { sessionId } = await engine.start("wf");
    await engine.transition(sessionId, "plain", "me", { k: "1", j: "x" });
    expect(
      storage
        .read(sessionId)!
        .history.filter(h => h.event === "context_set")
        .map(h => h.detail),
    ).toEqual(["k", "j"]);
  });
});

describe("transition `set` through the tool", () => {
  it("one call writes the keys and takes the move; the reply names the keys", async () => {
    const { engine, storage, call } = mount();
    const { sessionId } = await engine.start("wf");
    const r = await call("transition", {
      session_id: sessionId,
      transition: "prepare",
      set: { task: "T-2" },
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Context set: task.");
    expect(r.text).toContain("task=T-2");
    expect(storage.read(sessionId)!.context.task).toBe("T-2");
  });

  it("a refused call is an error and writes nothing", async () => {
    const { engine, storage, call } = mount();
    const { sessionId } = await engine.start("wf");
    const r = await call("transition", {
      session_id: sessionId,
      transition: "plain",
      set: { task: "T-2", difficulty: 99 },
    });
    expect(r.isError).toBe(true);
    expect(storage.read(sessionId)!.context.task).toBeUndefined();
    expect(storage.read(sessionId)!.stack[0].current_state).toBe("claim");
  });

  it("a call without `set` answers as before, and context_set is unchanged", async () => {
    const { engine, storage, call } = mount();
    const { sessionId } = await engine.start("wf");
    const set = await call("context_set", { session_id: sessionId, key: "task", value: "T-3" });
    expect(set.text).toBe('Context "task" set successfully.');
    const r = await call("transition", { session_id: sessionId, transition: "plain" });
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain("Context set:");
    expect(r.text).toContain("task=T-3");
    expect(storage.read(sessionId)!.context.task).toBe("T-3");
  });
});
