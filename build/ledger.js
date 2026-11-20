import { projectRoot } from "./pool.js";
import { sessionSegments } from "./timeline.js";
import { MODEL_KEYS, parseDifficulty, stageKeys, stageOfKey } from "./model-table.js";
/**
 * The root of a session's parent chain. Sessions record `root_session_id` at
 * start; a legacy session without it falls back to its parent (one level
 * short for a legacy grandchild), else itself. A parent that cannot be read
 * at start counts as a root of its own. The only answer to "which root".
 */
export function rootSessionIdOf(session) {
    return session.root_session_id ?? session.parent_session_id ?? session.session_id;
}
/** A history entry that moves a frame between states: a `push` carries the state it enters in `to` (the timeline reads it), but is not a move. */
function isMove(h) {
    return h.to !== undefined && h.event !== "push";
}
const TOKENS_KEY = /^tokens(?:_([a-z0-9_]+))?$/;
/** A whole number ≥ 0 given as a number or its decimal string; else undefined. */
function count(v) {
    const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
    return /^\d+$/.test(s) ? Number(s) : undefined;
}
const text = (v) => typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
/** What a task's context says about the agents that did it: what a `model_table` is tuned from. */
function agentFields(context) {
    const K = MODEL_KEYS;
    const tokens = {};
    for (const [k, v] of Object.entries(context)) {
        const m = TOKENS_KEY.exec(k);
        const n = m ? count(v) : undefined;
        if (m && n !== undefined)
            tokens[m[1] ?? "total"] = n;
    }
    const stages = {};
    // A stage ran when a state read it: `stages_first` holds those rows, so when it exists it is the
    // whole list and a stage absent from it did not run. Without it (a session that read none, or a
    // context from before the record) every `model_<x>` / `effort_<x>` pair stands.
    const first = context[K.stagesFirst];
    if (first && typeof first === "object") {
        for (const [name, v] of Object.entries(first)) {
            const row = v;
            const model = text(row?.model);
            const effort = text(row?.effort);
            if (model && effort)
                stages[name] = { model, effort };
        }
    }
    else {
        for (const key of Object.keys(context)) {
            const name = stageOfKey(key, "model");
            if (name === undefined)
                continue;
            const k = stageKeys(name);
            const model = text(context[k.model]);
            const effort = text(context[k.effort]);
            if (model && effort)
                stages[name] = { model, effort };
        }
    }
    const counts = {};
    for (const [k, v] of Object.entries(context)) {
        if (Array.isArray(v) && /^[a-z0-9_]{1,40}$/.test(k))
            counts[k] = v.length;
    }
    const agentIds = {};
    for (const [k, v] of Object.entries(context)) {
        const m = /^agent_id_([a-z0-9_]+)$/.exec(k);
        const id = m ? text(v) : undefined;
        if (m && id)
            agentIds[m[1]] = id;
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
function taskField(context) {
    const t = typeof context.slice === "string" ? context.slice : context.task;
    return typeof t === "string" && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(t) ? { task: t } : {};
}
/** The state stretches of an ended session, for the Timeline tab. */
function segsField(session) {
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
export function ledgerEntry(session, spend) {
    const execs = session.history
        .filter(h => h.event === "action" && h.duration_ms !== undefined)
        .map(h => ({
        state: h.from ?? "?",
        duration_ms: h.duration_ms,
        ...(h.exit_code !== undefined ? { exit_code: h.exit_code } : {}),
        ...(h.wait_ms !== undefined ? { wait_ms: h.wait_ms } : {}),
        ...(h.threads_granted !== undefined ? { threads_granted: h.threads_granted } : {}),
        ...(h.step_key !== undefined ? { step_key: h.step_key } : {}),
        ...(h.shards !== undefined ? { shards: h.shards } : {}),
    }));
    const visits = {};
    for (const h of session.history)
        if (isMove(h))
            visits[h.to] = (visits[h.to] ?? 0) + 1;
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
export function parseLedger(content) {
    const out = [];
    for (const line of content.split("\n")) {
        if (line.trim() === "")
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch {
            // a half-written line
        }
    }
    return out;
}
/** The ledger's task lines by queue line id, each cut to what a task's cost needs (`task`, `session_id`, `parent_session_id`, `spend.usd`, `parent_spend.usd`): the plan pane sums them. */
export function taskCostRows(content) {
    const out = new Map();
    for (const line of content.split("\n")) {
        if (!line.includes('"task"'))
            continue;
        try {
            const j = JSON.parse(line);
            if (typeof j.task !== "string" || j.task === "")
                continue;
            const row = JSON.stringify({
                task: j.task,
                ...(j.session_id !== undefined ? { session_id: j.session_id } : {}),
                ...(j.parent_session_id ? { parent_session_id: j.parent_session_id } : {}),
                ...(j.spend?.usd !== undefined ? { spend: { usd: j.spend.usd } } : {}),
                ...(j.parent_spend?.usd !== undefined ? { parent_spend: { usd: j.parent_spend.usd } } : {}),
            });
            const rows = out.get(j.task);
            if (rows)
                rows.push(row);
            else
                out.set(j.task, [row]);
        }
        catch {
            // a half-written line
        }
    }
    return out;
}
