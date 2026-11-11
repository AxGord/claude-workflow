import type { SessionState, ShardResult } from "./types.js";
import { projectRoot } from "./pool.js";
import { sessionSegments } from "./timeline.js";
import { MODEL_KEYS, parseDifficulty, stageKeys, stageOfKey } from "./model-table.js";

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

/** A history entry that moves a frame between states: a `push` carries the state it enters in `to` (the timeline reads it), but is not a move. */
function isMove<T extends { readonly to?: string; readonly event?: string }>(
  h: T,
): h is T & { readonly to: string } {
  return h.to !== undefined && h.event !== "push";
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

/** One stretch of a state in a ledger line (epoch ms): the Timeline tab draws a pruned session from them. */
export interface LedgerSegment {
  /** The state. */
  readonly s: string;
  readonly a: number;
  readonly b: number;
  /** Pool-lease waits inside it, flat `[start, end, start, end, ...]`. */
  readonly w?: readonly number[];
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
  /** The session's state stretches; absent on a line from before the record (drawn as one bar). */
  readonly segs?: readonly LedgerSegment[];
  /** The queue line the session runs: its context's `slice`, else `task` (the plan pane matches landed lines by it). */
  readonly task?: string;
  /** The task's `difficulty` (1..10), as its context held it at the end. */
  readonly difficulty?: number;
  /** The difficulty the task first ran under (before any rescore): what a calibration report bands by. */
  readonly claim_difficulty?: number;
  /** The model and effort the task ended on (a `model_table` writes them; an agent may set them itself). */
  readonly model?: string;
  readonly effort?: string;
  /** Rows the `model_table` moved the task up past its difficulty's own. */
  readonly escalations?: number;
  readonly review_model?: string;
  readonly review_effort?: string;
  /** The model and effort each stage RAN on: its row when a state spawning on it was entered (a rescore afterwards does not replace it); a stage no state read is absent. Without the record every context pair stands. */
  readonly stages?: Readonly<Record<string, { readonly model: string; readonly effort: string }>>;
  /** The git root of the session's cwd: what a calibration report groups by. */
  readonly project?: string;
  /** Entries into each state (the history's `to`), so review rounds are countable. */
  readonly visits?: Readonly<Record<string, number>>;
  /** The context's `review_verdict` (else `verdict`), when text. */
  readonly verdict?: string;
  /** The context's `agent_id_<stage>`: the agent that ran each stage (join key for transcript cost). */
  readonly agent_ids?: Readonly<Record<string, string>>;
  /** The context's `plan_handoff` when set: a plan stage handed off to a separate executor. */
  readonly plan_handoff?: boolean;
  /** Length of each context list (array value), by key: what `--findings-key` of a report sums. */
  readonly counts?: Readonly<Record<string, number>>;
  /** The context's `tokens` (→ `total`) and `tokens_<role>` (→ `<role>`) that read as whole numbers. */
  readonly tokens?: Readonly<Record<string, number>>;
  /** The real spend of the task's agents; absent when the task named none (or the line predates the record). */
  readonly spend?: LedgerSpend;
  /** The top-level conversation's own spend over the stretch no earlier line recorded: a task's line carries it (see `LedgerParentSpend`). */
  readonly parent_spend?: LedgerParentSpend;
}

/**
 * What the PARENT (the top-level Claude Code session that dispatches, not a sub-agent) spent in its own turns
 * between `from` and `to`, read from `<projects>/<project>/<conversation>.jsonl` and priced by the same table as
 * `spend` (`measureParentSpend`). A conversation's lines tile its time: each starts just after the latest `to` the
 * ledger already holds for the conversation (the first at the session's start), so the sum over any set of lines
 * counts a turn once. A conversation whose transcript cannot be read or whose model has no price records no line
 * of this kind, so the next one covers that stretch.
 */
export interface LedgerParentSpend {
  readonly conversation: string;
  /** The transcript's project directory name under `<projects>` (the parent's own project: the plan pane keeps the stretches of its queue's repo). */
  readonly project: string;
  readonly from: string;
  readonly to: string;
  /** The byte offset of the transcript up to which its turns are accounted (a complete-line boundary): the next line of the conversation reads from here, not from the top. */
  readonly offset: number;
  readonly usd: number;
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
}

/** What the task's agents really spent, summed from their transcripts (`measureSpend`). `usd` is absent when any agent could not be read: the task is unmeasured, never $0. */
export interface LedgerSpend {
  readonly agents: number;
  readonly usd?: number;
  /** Agent ids whose transcript was missing, unreadable or of an unpriced model. */
  readonly unmeasured?: readonly string[];
  /** Agents of the task's conversations active in its window that nothing names: the figure may be incomplete. */
  readonly unnamed?: number;
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
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
  // A stage ran when a state read it: `stages_first` holds those rows, so when it exists it is the
  // whole list and a stage absent from it did not run. Without it (a session that read none, or a
  // context from before the record) every `model_<x>` / `effort_<x>` pair stands.
  const first = context[K.stagesFirst];
  if (first && typeof first === "object") {
    for (const [name, v] of Object.entries(first)) {
      const row = v as { model?: unknown; effort?: unknown };
      const model = text(row?.model);
      const effort = text(row?.effort);
      if (model && effort) stages[name] = { model, effort };
    }
  } else {
    for (const key of Object.keys(context)) {
      const name = stageOfKey(key, "model");
      if (name === undefined) continue;
      const k = stageKeys(name);
      const model = text(context[k.model]);
      const effort = text(context[k.effort]);
      if (model && effort) stages[name] = { model, effort };
    }
  }
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(context)) {
    if (Array.isArray(v) && /^[a-z0-9_]{1,40}$/.test(k)) counts[k] = v.length;
  }
  const agentIds: Record<string, string> = {};
  for (const [k, v] of Object.entries(context)) {
    const m = /^agent_id_([a-z0-9_]+)$/.exec(k);
    const id = m ? text(v) : undefined;
    if (m && id) agentIds[m[1]] = id;
  }
  const handoff = context.plan_handoff;
  const fields = {
    agent_ids: Object.keys(agentIds).length > 0 ? agentIds : undefined,
    plan_handoff: handoff === true || handoff === "true" || handoff === "yes" ? true : undefined,
    verdict: text(context.review_verdict) ?? text(context.verdict),
    counts: Object.keys(counts).length > 0 ? counts : undefined,
    difficulty: parseDifficulty(context[K.difficulty]) ?? undefined,
    claim_difficulty: parseDifficulty(context[K.claimDifficulty]) ?? undefined,
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

/** The queue line a session runs, when its context names one. */
function taskField(context: Readonly<Record<string, unknown>>): {
  task?: string;
} {
  const t = typeof context.slice === "string" ? context.slice : context.task;
  return typeof t === "string" && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(t) ? { task: t } : {};
}

/** The state stretches of an ended session, for the Timeline tab. */
function segsField(session: SessionState): { segs?: LedgerSegment[] } {
  const segs = sessionSegments(session, Date.parse(session.updated_at)).map(g => ({
    s: g.state,
    a: g.start,
    b: g.end,
    ...(g.waits.length > 0 ? { w: g.waits.flatMap(w => [w.start, w.end]) } : {}),
  }));
  return segs.length > 0 ? { segs } : {};
}

/**
 * Build the ledger line for a session that has just ended (empty stack). The
 * root workflow comes from the `start` history event, since the stack is gone.
 */
export function ledgerEntry(session: SessionState, spend?: LedgerSpend): LedgerEntry {
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
  const visits: Record<string, number> = {};
  for (const h of session.history) if (isMove(h)) visits[h.to] = (visits[h.to] ?? 0) + 1;
  return {
    session_id: session.session_id,
    parent_session_id: session.parent_session_id ?? null,
    root_session_id: rootSessionIdOf(session),
    workflow: session.history.find(h => h.event === "start")?.workflow ?? null,
    outcome: session.outcome ?? "completed",
    started_at: session.started_at,
    ended_at: session.updated_at,
    transitions: session.history.filter(isMove).length,
    exec_ms_total: execs.reduce((sum, e) => sum + e.duration_ms, 0),
    wait_ms_total: execs.reduce((sum, e) => sum + (e.wait_ms ?? 0), 0),
    execs,
    ...segsField(session),
    ...taskField(session.context),
    ...(typeof session.context.cwd === "string" && session.context.cwd !== ""
      ? { project: projectRoot(session.context.cwd) }
      : {}),
    ...(Object.keys(visits).length > 0 ? { visits } : {}),
    ...agentFields(session.context),
    ...(spend ? { spend } : {}),
  };
}

/** Parse the lines of a ledger file; a damaged line is skipped. */
export function parseLedger(content: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // a half-written line
    }
  }
  return out;
}
