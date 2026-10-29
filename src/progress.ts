import { AsyncLocalStorage } from "node:async_hooks";

/** Sends one short progress message to the client that is waiting on a tool call. */
export type ProgressSink = (message: string) => void;

/** How often a waiting tool call tells its client it is still alive. */
export const PROGRESS_INTERVAL_MS = 60_000;

/** What an exec is doing now: queued for a pool lease, or running. */
export type ExecPhase = "lease" | "run";

// Scoped to the async chain of ONE tool call (not process state), so concurrent
// calls of different sessions never see each other's sink.
const scope = new AsyncLocalStorage<ProgressSink>();

export function withProgress<T>(
  sink: ProgressSink | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return sink ? scope.run(sink, work) : work();
}

export function currentProgress(): ProgressSink | undefined {
  return scope.getStore();
}

/**
 * Report `<phase message> (Ns)` through `sink` every PROGRESS_INTERVAL_MS until
 * the returned stop function runs. Without a sink nothing is scheduled.
 */
export function startHeartbeat(
  sink: ProgressSink | undefined,
  state: string,
): { setPhase: (phase: ExecPhase) => void; stop: () => void } {
  if (!sink) return { setPhase: () => undefined, stop: () => undefined };
  let phase: ExecPhase = "run";
  const t0 = Date.now();
  const timer = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    try {
      sink(phase === "lease" ? `waiting for pool lease (${s}s)` : `running ${state} (${s}s)`);
    } catch {
      // a dead transport must not fail the exec
    }
  }, PROGRESS_INTERVAL_MS);
  timer.unref();
  return {
    setPhase: p => {
      phase = p;
    },
    stop: () => clearInterval(timer),
  };
}
