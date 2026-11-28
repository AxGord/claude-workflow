// Stall detection: a session whose state saw no engine call for longer than the state's
// `stale_after` is STALE — its agent may be dead or stuck. Pure: the engine resolves the state,
// `sessions` / `status` / the `{{stale_sessions}}` template var print what this decides.
import { ASK_KEY, openAsk } from "./event-fold.js";
import { POOL_WAIT_CEILING_FACTOR } from "./types.js";
import type { SessionState, StateDefinition } from "./types.js";

/**
 * Seconds a state may go with no engine call when it declares no `stale_after:` — by state type.
 * A prompt state's agent calls the engine as it works; an exec runs inside one call, and a heavy
 * one (`resource:` / `fanout:`) runs long.
 */
export const STALE_AFTER_DEFAULTS = { prompt: 1800, exec: 3600, heavy_exec: 14400 } as const;

/**
 * An exec's default never fires before its own `timeout` stretched by a pool wait to its ceiling
 * (`POOL_WAIT_CEILING_FACTOR` times) plus this: until then the timeout bounds it.
 */
export const STALE_EXEC_GRACE_S = 300;

/** The state's `stale_after` in seconds, 0 = never stale (a terminal state always). */
export function staleAfter(state: StateDefinition | undefined): number {
  if (state?.terminal) return 0;
  if (state?.stale_after !== undefined) return state.stale_after;
  if (state?.type === "exec" || state?.type === "fetch") {
    const heavy = state.resource !== undefined || state.fanout !== undefined;
    const base = heavy ? STALE_AFTER_DEFAULTS.heavy_exec : STALE_AFTER_DEFAULTS.exec;
    const own =
      state.timeout === undefined
        ? 0
        : Math.ceil((state.timeout * POOL_WAIT_CEILING_FACTOR) / 1000) + STALE_EXEC_GRACE_S;
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
  /** A human wait's queue line is still `awaiting` (answered or not): no slot is held, nobody is due to act. */
  lineAwaiting = false,
): Staleness | undefined {
  if (session.stack.length === 0 || session.suspended_at || parents.has(session.session_id))
    return undefined;
  // a human wait waits for a person, then for a slot: no engine call is due until the answer is resumed
  if (state?.human !== undefined && (session.human_wait?.answer === undefined || lineAwaiting))
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

/** Seconds a driver's open question (`ask_parent`) goes unanswered before a `collect` pass lists it again. */
export const ASK_UNANSWERED_AFTER_S = 600;

/**
 * One line for a driver's question that no move of its session has answered for longer than
 * `ASK_UNANSWERED_AFTER_S`: the session, its task and agent, when it asked, the question. Keyed by
 * `asked=<time>` so a reader that reminded the parent once can tell an ask it has seen.
 */
export function unansweredAskLine(
  s: SessionState,
  ask: { readonly text: string; readonly at: string },
  now: number,
): string | undefined {
  const at = Date.parse(ask.at);
  if (Number.isNaN(at) || (now - at) / 1000 <= ASK_UNANSWERED_AFTER_S) return undefined;
  const task = typeof s.context.task === "string" ? ` task=${s.context.task}` : "";
  const agent = s.agent_id ? ` driver=${s.agent_id}` : "";
  return `UNANSWERED:${task} session=${s.session_id}${agent} asked=${ask.at} (${formatSeconds(Math.floor((now - at) / 1000))} ago): ${ask.text.trim().slice(0, 300)}`;
}

/**
 * The context key a task driver writes, first thing, when the parent's answer to its NEEDS-PARENT reached it
 * (value: the first words of the answer). It tells a lost answer from a busy worker.
 */
export const ANSWER_ACK_KEY = "parent_answer_ack";

/** The context key the parent's answer to a NEEDS-PARENT is recorded in on the task session. */
export const PARENT_ANSWER_KEY = "parent_answer";

/** Where a driver's question stands: nobody answered it, the parent's answer is held by the engine, or the driver confirmed it has one. */
export type AskStanding =
  | { readonly kind: "unanswered"; readonly asked_at: string; readonly age_s: number }
  | { readonly kind: "held"; readonly asked_at: string }
  | {
      readonly kind: "acked";
      readonly asked_at: string;
      readonly acked_at: string;
      readonly ack: string;
    };

/**
 * The standing of `s`'s question to the parent at `now`, or null without one. Acked = the ack key holds text and
 * its `context_set` came after the last move and after a question write: it outlives the driver's clear of
 * `ask_parent` (its documented next call) until the session moves or asks again (the engine drops the ack key
 * when a non-empty `ask_parent` is written). Held = no ack, but the engine
 * holds a non-empty `parent_answer` the dispatcher has not relayed yet. Otherwise an open question is unanswered.
 */
export function askStanding(s: Parameters<typeof openAsk>[0], now: number): AskStanding | null {
  if (s.stack.length === 0) return null;
  const open = openAsk(s);
  const ack = s.context[ANSWER_ACK_KEY];
  // since the last move: the latest ack write, and the question write before it (a new question drops the ack key)
  let ackIdx = -1;
  let askedAt: string | undefined;
  if (typeof ack === "string" && ack.trim() !== "")
    for (let i = s.history.length - 1; i >= 0; i--) {
      const h = s.history[i];
      if (h.from !== undefined && h.to !== undefined) break;
      if (h.event !== "context_set") continue;
      if (h.detail === ANSWER_ACK_KEY && ackIdx < 0) ackIdx = i;
      else if (h.detail === ASK_KEY && ackIdx >= 0) {
        askedAt = h.at;
        break;
      }
    }
  if (ackIdx >= 0 && askedAt !== undefined && typeof ack === "string")
    return {
      kind: "acked",
      asked_at: askedAt,
      acked_at: s.history[ackIdx].at,
      ack: ack.trim(),
    };
  if (!open) return null;
  const held = s.context[PARENT_ANSWER_KEY];
  if (typeof held === "string" && held.trim() !== "") return { kind: "held", asked_at: open.at };
  const at = Date.parse(open.at);
  return {
    kind: "unanswered",
    asked_at: open.at,
    age_s: Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now - at) / 1000)),
  };
}

/** `unanswered 12m` or `answered, acked <time>` — what a status or a session list says of a driver's question. */
export function askStandingNote(st: AskStanding): string {
  if (st.kind === "acked") return `answered, acked ${st.acked_at}: "${st.ack.slice(0, 80)}"`;
  return st.kind === "held"
    ? "answered, not relayed to the driver yet"
    : `unanswered ${formatSeconds(st.age_s)}`;
}
