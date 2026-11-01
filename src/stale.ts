// Stall detection: a session whose state saw no engine call for longer than the state's
// `stale_after` is STALE — its agent may be dead or stuck. Pure: the engine resolves the state,
// `sessions` / `status` / the `{{stale_sessions}}` template var print what this decides.
import type { SessionState, StateDefinition } from "./types.js";

/**
 * Seconds a state may go with no engine call when it declares no `stale_after:` — by state type.
 * A prompt state's agent calls the engine as it works; an exec runs inside one call, and a heavy
 * one (`resource:` / `fanout:`) runs long.
 */
export const STALE_AFTER_DEFAULTS = { prompt: 1800, exec: 3600, heavy_exec: 14400 } as const;

/** An exec's default never fires before its own `timeout` plus this: until then the timeout bounds it. */
export const STALE_EXEC_GRACE_S = 300;

/** The state's `stale_after` in seconds, 0 = never stale (a terminal state always). */
export function staleAfter(state: StateDefinition | undefined): number {
  if (state?.terminal) return 0;
  if (state?.stale_after !== undefined) return state.stale_after;
  if (state?.type === "exec" || state?.type === "fetch") {
    const heavy = state.resource !== undefined || state.fanout !== undefined;
    const base = heavy ? STALE_AFTER_DEFAULTS.heavy_exec : STALE_AFTER_DEFAULTS.exec;
    const own =
      state.timeout === undefined ? 0 : Math.ceil(state.timeout / 1000) + STALE_EXEC_GRACE_S;
    return Math.max(base, own);
  }
  return STALE_AFTER_DEFAULTS.prompt;
}

/** Why a session is STALE: since when nothing moved it, for how long, and its state's limit (seconds). */
export interface Staleness {
  readonly since: string;
  readonly idle_s: number;
  readonly after_s: number;
}

/** The ids of the sessions with at least one active child. */
export function activeParents(sessions: readonly SessionState[]): Set<string> {
  const parents = new Set<string>();
  for (const s of sessions)
    if (s.parent_session_id && s.stack?.length > 0) parents.add(s.parent_session_id);
  return parents;
}

/**
 * Whether `session`, sitting in `state`, is STALE at `now`. Never: an ended or suspended session
 * (suspension is its own mark), one with an active child (it waits for its children, each judged on
 * its own), a terminal state or `stale_after: 0`, and a `resource:` / `fanout:` exec waiting for its
 * pool lease (before its run began, or marked `pool_starved`) while the owning process is alive — the
 * wait is the pool's, reported as POOL STARVED. The clock runs from the session's last write, or from
 * the start of the state's run when that is later (`running_exec`, else `pending_action.run_at`).
 */
export function staleness(
  session: SessionState,
  state: StateDefinition | undefined,
  parents: ReadonlySet<string>,
  now: number,
  ownerAlive: boolean,
): Staleness | undefined {
  if (session.stack.length === 0 || session.suspended_at || parents.has(session.session_id))
    return undefined;
  const after = staleAfter(state);
  if (after <= 0) return undefined;
  const frame = session.stack[session.active_frame];
  const here = <T extends { frame: number; state: string }>(at?: T): T | undefined =>
    at?.frame === session.active_frame && at.state === frame.current_state ? at : undefined;
  const run = here(session.running_exec)?.started_at ?? here(session.pending_action)?.run_at;
  const leased = state?.resource !== undefined || state?.fanout !== undefined;
  const waits =
    (run === undefined && here(session.pending_action) !== undefined) || !!session.pool_starved;
  if (leased && waits && ownerAlive) return undefined;
  const since =
    run !== undefined && Date.parse(run) > Date.parse(session.updated_at)
      ? run
      : session.updated_at;
  const at = Date.parse(since);
  if (Number.isNaN(at)) return undefined;
  const idle = Math.floor((now - at) / 1000);
  return idle > after ? { since, idle_s: idle, after_s: after } : undefined;
}

/** `45s`, `47m`, `2h05m`. */
export function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** What a STALE mark says after the session's name. */
export function staleNote(st: Staleness): string {
  return `no engine call for ${formatSeconds(st.idle_s)} (since ${st.since}), past its state's stale_after ${formatSeconds(st.after_s)}`;
}
