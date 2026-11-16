import { describe, it, expect, afterEach, vi } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { registerTools } from "./tools.js";
import { InMemoryStorage, createTestLoader, cleanupDir, SIMPLE_WORKFLOW } from "./test-helpers.js";

// ENG-ABORT-ROOT-GUARD: a sub-agent's stray start() got the campaign ROOT's id
// back, and its abort of that id cascade-abandoned the whole tree.
describe("ENG-ABORT-ROOT-GUARD", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) cleanupDir(dir);
    dir = undefined;
  });

  async function mountTree() {
    const storage = new InMemoryStorage();
    const result = createTestLoader({ noop: SIMPLE_WORKFLOW, slice: SIMPLE_WORKFLOW });
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
    const call = async (name: string, args: object) => {
      const r = await handlers.get(name)!(args);
      return { isError: r.isError, text: r.content[0].text };
    };
    // the parent's root session, its dispatcher child, and the dispatcher's slices
    const root = (await engine.start("slice")).sessionId;
    const dispatcher = (await engine.start("slice", undefined, root)).sessionId;
    const slices = [
      (await engine.start("slice", undefined, dispatcher)).sessionId,
      (await engine.start("slice", undefined, dispatcher)).sessionId,
    ];
    const active = (id: string) => (storage.read(id)?.stack.length ?? 0) > 0;
    return { call, root, dispatcher, slices, active, storage };
  }

  const SESSION_ID = /SESSION: (\w+)/;

  it("a stray start() with no parent_session_id is refused: no id handed back, nothing started", async () => {
    const { call, root, storage } = await mountTree();
    const before = storage.readAll().length;
    const stray = await call("start", { workflow: "noop", reply: "id" });
    expect(stray.isError).toBe(true);
    expect(stray.text).not.toContain(root);
    expect(stray.text).not.toMatch(SESSION_ID);
    expect(stray.text).toContain("parent_session_id");
    expect(storage.readAll()).toHaveLength(before);
  });

  it("a start with parent_session_id still works, and so does a forced second root", async () => {
    const { call, dispatcher, storage } = await mountTree();
    const child = await call("start", {
      workflow: "noop",
      reply: "id",
      parent_session_id: dispatcher,
    });
    expect(child.isError).toBeUndefined();
    expect(storage.read(SESSION_ID.exec(child.text)![1])!.parent_session_id).toBe(dispatcher);
    const second = await call("start", { workflow: "noop", reply: "id", force: "second campaign" });
    expect(second.isError).toBeUndefined();
    expect(storage.read(SESSION_ID.exec(second.text)![1])!.parent_session_id).toBeUndefined();
  });

  it("abort of the root by a caller that did not name itself is refused and ends nothing", async () => {
    const { call, root, dispatcher, slices, active } = await mountTree();
    const r = await call("abort", { session_id: root });
    expect(r.isError).toBe(true);
    expect([root, dispatcher, ...slices].map(active)).toEqual([true, true, true, true]);
  });

  it("the incident: a stray start, then an abort of the root it could not read, ends nothing", async () => {
    const { call, root, dispatcher, slices, active } = await mountTree();
    const stray = await call("start", { workflow: "noop", reply: "id" });
    expect(stray.isError).toBe(true);
    await call("abort", { session_id: root });
    await call("abort", { session_id: dispatcher });
    expect([root, dispatcher, ...slices].map(active)).toEqual([true, true, true, true]);
  });

  it("force without a reason does not override the scope; force with one does and ends the tree", async () => {
    const { call, root, dispatcher, slices, active } = await mountTree();
    expect((await call("abort", { session_id: root, force: true })).isError).toBe(true);
    expect(active(root)).toBe(true);
    const r = await call("abort", { session_id: root, force: true, reason: "campaign over" });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("4 sessions");
    expect([root, dispatcher, ...slices].map(active)).toEqual([false, false, false, false]);
  });

  it("caller_session_id: a session ends itself or its own subtree, never an ancestor or a sibling", async () => {
    const { call, root, dispatcher, slices, active } = await mountTree();
    const [a, b] = slices;
    for (const target of [root, dispatcher, b])
      expect((await call("abort", { session_id: target, caller_session_id: a })).isError).toBe(
        true,
      );
    expect(
      (await call("abort", { session_id: dispatcher, caller_session_id: root })).isError,
    ).toBeUndefined();
    expect([root, dispatcher, a, b].map(active)).toEqual([true, false, false, false]);
  });

  it("a lone leaf with a parent ends itself without naming a caller", async () => {
    const { call, slices, active } = await mountTree();
    expect((await call("abort", { session_id: slices[0] })).isError).toBeUndefined();
    expect(slices.map(active)).toEqual([false, true]);
  });

  it("every cascade is logged with the caller and the session count", async () => {
    const { call, root } = await mountTree();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await call("abort", { session_id: root, caller_session_id: root });
      expect(log.mock.calls.map(c => String(c[0])).join("\n")).toMatch(
        new RegExp(`abort: session ${root} by ${root} ends 4 session`),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("transition of a session outside the caller's subtree is refused", async () => {
    const { call, slices } = await mountTree();
    const r = await call("transition", {
      session_id: slices[0],
      transition: "next",
      caller_session_id: slices[1],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("transition refused");
  });
});
