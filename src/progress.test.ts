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
  /** Reported as the starved pool wait right after the exec queues. */
  starve?: string;
  override async execute(
    _state: StateDefinition,
    _vars: Record<string, unknown>,
    ctx?: ExecContext,
  ): Promise<ActionResult> {
    ctx?.onPhase?.("lease");
    if (this.starve) ctx?.onStarved?.(this.starve);
    await new Promise<void>(r => (this.grant = r));
    if (this.starve) ctx?.onStarved?.(undefined);
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

  async function mount(starve?: string) {
    const storage = new InMemoryStorage();
    const result = createTestLoader({ wf: WORKFLOW });
    dir = result.dir;
    const executor = new StagedExecutor();
    executor.starve = starve;
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
    return {
      executor,
      sent,
      extra,
      sessionId,
      call: handlers.get("transition")!,
      engine,
      storage,
      handlers,
    };
  }

  it("a starved mark a crashed server left on the session is cleared when its next step starts", async () => {
    const { executor, extra, sessionId, storage, handlers } = await mount();
    const cur = storage.read(sessionId)!;
    await storage.write(sessionId, {
      ...cur,
      pool_starved: { since: "2026-01-01T00:00:00.000Z", note: "stale" },
    });
    const done = handlers.get("transition")!(
      { session_id: sessionId, transition: "next" },
      extra(undefined),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(storage.read(sessionId)?.pool_starved).toBeUndefined();
    executor.grant();
    await vi.advanceTimersByTimeAsync(10);
    executor.finish();
    await done;
  });

  it("a starved lease wait is in the heartbeat and in the status of the session's ancestors until the grant", async () => {
    const { executor, sent, extra, sessionId, engine, storage, handlers } = await mount(
      "queued 16m for 4 threads",
    );
    const child = await engine.start("wf", undefined, sessionId);
    const done = handlers.get("transition")!(
      { session_id: child.sessionId, transition: "next" },
      extra("t1"),
    );
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS);
    expect(sent.map(p => p.message)).toEqual([
      "waiting for pool lease (60s) — STARVED: queued 16m for 4 threads",
    ]);
    const text = async (tool: string, args: object) =>
      ((await handlers.get(tool)!(args, extra(undefined))) as { content: Array<{ text: string }> })
        .content[0].text;
    expect(await text("status", { session_id: sessionId })).toMatch(
      new RegExp(
        `^POOL STARVED: session ${child.sessionId} \\(wf @ land\\) waits for a pool lease since .* — queued 16m for 4 threads\\.`,
      ),
    );
    expect(await text("sessions", {})).toMatch(
      /\[POOL STARVED since .*: queued 16m for 4 threads\]/,
    );
    executor.grant();
    await vi.advanceTimersByTimeAsync(10);
    expect(storage.read(child.sessionId)?.pool_starved).toBeUndefined();
    expect(await text("status", { session_id: sessionId })).not.toMatch(/POOL STARVED/);
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS);
    expect(sent.at(-1)?.message).toBe("running land (120s)");
    executor.finish();
    await done;
  });

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
