import type { SessionState, ShardResult } from "./types.js";
import { MODEL_KEYS, STAGE_NAMES, parseDifficulty, stageKeys } from "./model-table.js";

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
  /** A `fanout:` exec's instances: exit code, run and wait per shard. */
  readonly shards?: readonly ShardResult[];
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
  /** The task's `difficulty` (1..10), as its context held it at the end. */
  readonly difficulty?: number;
  /** The model and effort the task ended on (a `model_table` writes them; an agent may set them itself). */
  readonly model?: string;
  readonly effort?: string;
  /** Rows the `model_table` moved the task up past its difficulty's own. */
  readonly escalations?: number;
  readonly review_model?: string;
  readonly review_effort?: string;
  /** The model and effort of each stage the task's table wrote (`model_<stage>` / `effort_<stage>`, the five stage names). */
  readonly stages?: Readonly<Record<string, { readonly model: string; readonly effort: string }>>;
  /** The context's `tokens` (→ `total`) and `tokens_<role>` (→ `<role>`) that read as whole numbers. */
  readonly tokens?: Readonly<Record<string, number>>;
}

const TOKENS_KEY = /^tokens(?:_([a-z0-9_]+))?$/;

/** A whole number ≥ 0 given as a number or its decimal string; else undefined. */
function count(v: unknown): number | undefined {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return /^\d+$/.test(s) ? Number(s) : undefined;
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** What a task's context says about the agents that did it: what a `model_table` is tuned from. */
function agentFields(context: Readonly<Record<string, unknown>>): Partial<LedgerEntry> {
  const K = MODEL_KEYS;
  const tokens: Record<string, number> = {};
  for (const [k, v] of Object.entries(context)) {
    const m = TOKENS_KEY.exec(k);
    const n = m ? count(v) : undefined;
    if (m && n !== undefined) tokens[m[1] ?? "total"] = n;
  }
  const stages: Record<string, { model: string; effort: string }> = {};
  for (const name of STAGE_NAMES) {
    const k = stageKeys(name);
    const model = text(context[k.model]);
    const effort = text(context[k.effort]);
    if (model && effort) stages[name] = { model, effort };
  }
  const fields = {
    difficulty: parseDifficulty(context[K.difficulty]) ?? undefined,
    model: text(context[K.model]),
    effort: text(context[K.effort]),
    escalations: count(context[K.escalations]),
    review_model: text(context[K.reviewModel]),
    review_effort: text(context[K.reviewEffort]),
    stages: Object.keys(stages).length > 0 ? stages : undefined,
    tokens: Object.keys(tokens).length > 0 ? tokens : undefined,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
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
      ...(h.shards !== undefined ? { shards: h.shards } : {}),
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
    ...agentFields(session.context),
  };
}
