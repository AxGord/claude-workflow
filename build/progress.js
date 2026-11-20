import { AsyncLocalStorage } from "node:async_hooks";
/** How often a waiting tool call tells its client it is still alive. */
export const PROGRESS_INTERVAL_MS = 60_000;
// Scoped to the async chain of ONE tool call (not process state), so concurrent
// calls of different sessions never see each other's sink.
const scope = new AsyncLocalStorage();
export function withProgress(sink, work) {
    return sink ? scope.run(sink, work) : work();
}
export function currentProgress() {
    return scope.getStore();
}
/**
 * Report `<phase message> (Ns)` through `sink` every PROGRESS_INTERVAL_MS until
 * the returned stop function runs. Without a sink nothing is scheduled.
 */
export function startHeartbeat(sink, state) {
    if (!sink)
        return { setPhase: () => undefined, setNote: () => undefined, stop: () => undefined };
    let phase = "run";
    let note;
    const t0 = Date.now();
    const timer = setInterval(() => {
        const s = Math.round((Date.now() - t0) / 1000);
        try {
            sink(phase === "lease"
                ? `waiting for pool lease (${s}s)${note ? ` — STARVED: ${note}` : ""}`
                : `running ${state} (${s}s)`);
        }
        catch {
            // a dead transport must not fail the exec
        }
    }, PROGRESS_INTERVAL_MS);
    timer.unref();
    return {
        setPhase: p => {
            phase = p;
        },
        setNote: n => {
            note = n;
        },
        stop: () => clearInterval(timer),
    };
}
