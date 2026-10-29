import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { registerTools } from "./tools.js";
import { Engine } from "./engine.js";
import { Executor, type ExecContext } from "./executor.js";
import { PROGRESS_INTERVAL_MS } from "./progress.js";
import { InMemoryStorage, createTestLoader, cleanupDir } from "./test-helpers.js";
import type { ActionResult, StateDefinition } from "./types.js";

/** An executor whose exec first queues for a lease, then runs, each until the test lets it go. */
class StagedExecutor extends Executor {
  grant!: () => void;
  finish!: () => void;
  override async execute(
    _state: StateDefinition,
    _vars: Record<string, unknown>,
    ctx?: ExecContext,
  ): Promise<ActionResult> {
    ctx?.onPhase?.("lease");
    await new Promise<void>(r => (this.grant = r));
    ctx?.onPhase?.("run");
    await new Promise<void>(r => (this.finish = r));
    return { type: "exec", success: true, stdout: "", exit_code: 0 };
  }
}

const WORKFLOW = {
  initial: "start",
  states: {
    start: { prompt: "go", transitions: { next: "land" } },
    land: { type: "exec", command: "true", on_success: "end", on_error: "end" },
    end: { prompt: "done", terminal: true },
  },
};

type Extra = {
  _meta?: { progressToken?: string };
  sendNotification: (n: { params: { message?: string; progress: number } }) => Promise<void>;
};

describe("progress heartbeat of a waiting tool call", () => {
  let dir: string | undefined;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    if (dir) cleanupDir(dir);
  });

  async function mount() {
    const storage = new InMemoryStorage();
    const result = createTestLoader({ wf: WORKFLOW });
    dir = result.dir;
    const executor = new StagedExecutor();
    const engine = new Engine(storage, result.loader, executor);
    const handlers = new Map<string, (args: object, extra: Extra) => Promise<unknown>>();
    registerTools(
      { registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h) } as never,
      engine,
      {} as never,
      result.loader,
      storage,
    );
    const { sessionId } = await engine.start("wf");
    const sent: Array<{ message?: string; progress: number }> = [];
    const extra = (token: string | undefined): Extra => ({
      _meta: token === undefined ? undefined : { progressToken: token },
      sendNotification: n => {
        sent.push(n.params);
        return Promise.resolve();
      },
    });
    return { executor, sent, extra, sessionId, call: handlers.get("transition")! };
  }

  it("beats through the lease and the run phase, then stops", async () => {
    const { executor, sent, extra, sessionId, call } = await mount();
    const done = call({ session_id: sessionId, transition: "next" }, extra("t1"));
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS);
    expect(sent.map(p => p.message)).toEqual(["waiting for pool lease (60s)"]);
    executor.grant();
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS);
    expect(sent.map(p => p.message)).toEqual([
      "waiting for pool lease (60s)",
      "running land (120s)",
    ]);
    expect(sent.map(p => p.progress)).toEqual([1, 2]);
    executor.finish();
    await done;
    const count = sent.length;
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 5);
    expect(sent.length).toBe(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing without a progressToken", async () => {
    const { executor, sent, extra, sessionId, call } = await mount();
    const done = call({ session_id: sessionId, transition: "next" }, extra(undefined));
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 3);
    executor.grant();
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 3);
    executor.finish();
    await done;
    expect(sent).toEqual([]);
  });
});
