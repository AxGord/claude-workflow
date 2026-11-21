// Stall detection: a session whose state saw no engine call for longer than the state's
// `stale_after` is STALE — its agent may be dead or stuck. Pure: the engine resolves the state,
// `sessions` / `status` / the `{{stale_sessions}}` template var print what this decides.
import { POOL_WAIT_CEILING_FACTOR } from "./types.js";
/**
 * Seconds a state may go with no engine call when it declares no `stale_after:` — by state type.
 * A prompt state's agent calls the engine as it works; an exec runs inside one call, and a heavy
 * one (`resource:` / `fanout:`) runs long.
 */
export const STALE_AFTER_DEFAULTS = { prompt: 1800, exec: 3600, heavy_exec: 14400 };
/**
 * An exec's default never fires before its own `timeout` stretched by a pool wait to its ceiling
 * (`POOL_WAIT_CEILING_FACTOR` times) plus this: until then the timeout bounds it.
 */
export const STALE_EXEC_GRACE_S = 300;
/** The state's `stale_after` in seconds, 0 = never stale (a terminal state always). */
export function staleAfter(state) {
    if (state?.terminal)
        return 0;
    if (state?.stale_after !== undefined)
        return state.stale_after;
    if (state?.type === "exec" || state?.type === "fetch") {
        const heavy = state.resource !== undefined || state.fanout !== undefined;
        const base = heavy ? STALE_AFTER_DEFAULTS.heavy_exec : STALE_AFTER_DEFAULTS.exec;
        const own = state.timeout === undefined
            ? 0
            : Math.ceil((state.timeout * POOL_WAIT_CEILING_FACTOR) / 1000) + STALE_EXEC_GRACE_S;
        return Math.max(base, own);
    }
    return STALE_AFTER_DEFAULTS.prompt;
}
/** The ids of the sessions with at least one active child. */
export function activeParents(sessions) {
    const parents = new Set();
    for (const s of sessions)
        if (s.parent_session_id && s.stack?.length > 0)
            parents.add(s.parent_session_id);
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
export function staleness(session, state, parents, now, ownerAlive) {
    if (session.stack.length === 0 || session.suspended_at || parents.has(session.session_id))
        return undefined;
    const after = staleAfter(state);
    if (after <= 0)
        return undefined;
    const frame = session.stack[session.active_frame];
    const here = (at) => at?.frame === session.active_frame && at.state === frame.current_state ? at : undefined;
    const run = here(session.running_exec)?.started_at ?? here(session.pending_action)?.run_at;
    const leased = state?.resource !== undefined || state?.fanout !== undefined;
    const waits = (run === undefined && here(session.pending_action) !== undefined) || !!session.pool_starved;
    if (leased && waits && ownerAlive)
        return undefined;
    const since = run !== undefined && Date.parse(run) > Date.parse(session.updated_at)
        ? run
        : session.updated_at;
    const at = Date.parse(since);
    if (Number.isNaN(at))
        return undefined;
    const idle = Math.floor((now - at) / 1000);
    return idle > after ? { since, idle_s: idle, after_s: after } : undefined;
}
/** `45s`, `47m`, `2h05m`. */
export function formatSeconds(s) {
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
/** What a STALE mark says after the session's name. */
export function staleNote(st) {
    return `no engine call for ${formatSeconds(st.idle_s)} (since ${st.since}), past its state's stale_after ${formatSeconds(st.after_s)}`;
}
/** Seconds a driver's open question (`ask_parent`) goes unanswered before a `collect` pass lists it again. */
export const ASK_UNANSWERED_AFTER_S = 600;
/**
 * One line for a driver's question that no move of its session has answered for longer than
 * `ASK_UNANSWERED_AFTER_S`: the session, its task and agent, when it asked, the question. Keyed by
 * `asked=<time>` so a reader that reminded the parent once can tell an ask it has seen.
 */
export function unansweredAskLine(s, ask, now) {
    const at = Date.parse(ask.at);
    if (Number.isNaN(at) || (now - at) / 1000 <= ASK_UNANSWERED_AFTER_S)
        return undefined;
    const task = typeof s.context.task === "string" ? ` task=${s.context.task}` : "";
    const agent = s.agent_id ? ` driver=${s.agent_id}` : "";
    return `UNANSWERED:${task} session=${s.session_id}${agent} asked=${ask.at} (${formatSeconds(Math.floor((now - at) / 1000))} ago): ${ask.text.trim().slice(0, 300)}`;
}
