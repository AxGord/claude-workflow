import type { SessionState } from "./types.js";

/**
 * The root of a session's parent chain. Sessions record `root_session_id` at
 * start; a legacy session without it falls back to its parent (one level
 * short for a legacy grandchild), else itself. A parent that cannot be read
 * at start counts as a root of its own. The only answer to "which root".
 */
export function rootSessionIdOf(
  session: Pick<SessionState, "session_id" | "parent_session_id" | "root_session_id">,
): string {
  return session.root_session_id ?? session.parent_session_id ?? session.session_id;
}

/** One exec/fetch run of an action state, as the ledger records it. */
export interface LedgerExec {
  readonly state: string;
  readonly duration_ms: number;
  readonly exit_code?: number;
  /** Wait for a pool lease before the run (`resource:` execs). */
  readonly wait_ms?: number;
  /** Threads the lease granted (`resource:` execs that got one). */
  readonly threads_granted?: number;
  /** `<project>|<workflow>|<state>` of a `resource:` exec: what a time model keys its runs by. */
  readonly step_key?: string;
}

/** One line of `$STATE_DIR/ledger.jsonl`: a finished session's accounting. */
export interface LedgerEntry {
  readonly session_id: string;
  readonly parent_session_id: string | null;
  readonly root_session_id: string;
  readonly workflow: string | null;
  readonly outcome: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly transitions: number;
  readonly exec_ms_total: number;
  readonly wait_ms_total: number;
  readonly execs: LedgerExec[];
}

/**
 * Build the ledger line for a session that has just ended (empty stack). The
 * root workflow comes from the `start` history event, since the stack is gone.
 */
export function ledgerEntry(session: SessionState): LedgerEntry {
  const execs: LedgerExec[] = session.history
    .filter(h => h.event === "action" && h.duration_ms !== undefined)
    .map(h => ({
      state: h.from ?? "?",
      duration_ms: h.duration_ms!,
      ...(h.exit_code !== undefined ? { exit_code: h.exit_code } : {}),
      ...(h.wait_ms !== undefined ? { wait_ms: h.wait_ms } : {}),
      ...(h.threads_granted !== undefined ? { threads_granted: h.threads_granted } : {}),
      ...(h.step_key !== undefined ? { step_key: h.step_key } : {}),
    }));
  return {
    session_id: session.session_id,
    parent_session_id: session.parent_session_id ?? null,
    root_session_id: rootSessionIdOf(session),
    workflow: session.history.find(h => h.event === "start")?.workflow ?? null,
    outcome: session.outcome ?? "completed",
    started_at: session.started_at,
    ended_at: session.updated_at,
    transitions: session.history.filter(h => h.to !== undefined).length,
    exec_ms_total: execs.reduce((sum, e) => sum + e.duration_ms, 0),
    wait_ms_total: execs.reduce((sum, e) => sum + (e.wait_ms ?? 0), 0),
    execs,
  };
}
