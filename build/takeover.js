import { isPidAlive } from "./process.js";
import { Executor } from "./executor.js";
import { currentStep, listedStanding } from "./agent-link.js";
import { DISPATCHER_AFTER_KEY, DISPATCHER_CALL_KEY, DRIVER_CALL_KEY } from "./driver.js";
export const RESUME_TOOL = "mcp__plugin_workflow_wf__resume";
export const STATUS_TOOL = "mcp__plugin_workflow_wf__status";
/** `workflow @ state` of an active session. */
export function where(s) {
    const f = s.stack[s.active_frame];
    return `${f.workflow} @ ${f.current_state}`;
}
/** The session and its active descendants, parents first. */
export function activeSubtree(storage, sessionId) {
    const children = new Map();
    for (const s of storage.readAll()) {
        if (!s.parent_session_id || !(s.stack?.length > 0))
            continue;
        const list = children.get(s.parent_session_id) ?? [];
        list.push(s.session_id);
        children.set(s.parent_session_id, list);
    }
    const ids = [sessionId];
    for (let i = 0; i < ids.length; i++)
        ids.push(...(children.get(ids[i]) ?? []));
    return ids;
}
/**
 * Hand `rootId` and its active descendants to `owner`, each under its own
 * file lock (`Storage.update`) — except a descendant another live process
 * runs unsuspended. `root`: only the root's suspension is cleared —
 * each descendant waits for its agent's `resume`. `tree`: every suspension in
 * the sub-tree is cleared, so the agents continue their sessions as they are.
 * Returns the ids written.
 */
export async function takeOver(storage, rootId, owner, at, scope) {
    const written = [];
    for (const id of activeSubtree(storage, rootId)) {
        const set = await storage.update(id, cur => {
            if (!cur || cur.stack.length === 0)
                return null;
            // a descendant another live process runs is that process's, not part of the handover
            const held = cur.context.claude_code_pid;
            if (id !== rootId &&
                !cur.suspended_at &&
                typeof held === "number" &&
                held !== owner.pid &&
                isPidAlive(held))
                return null;
            const wake = scope === "tree" || id === rootId;
            const restamp = wake && !!owner.claudeSessionId && cur.claude_session_id !== owner.claudeSessionId;
            if (cur.context.claude_code_pid === owner.pid && !(wake && cur.suspended_at) && !restamp)
                return null;
            return {
                ...cur,
                context: { ...cur.context, claude_code_pid: owner.pid },
                ...(wake && owner.claudeSessionId ? { claude_session_id: owner.claudeSessionId } : {}),
                ...(wake ? { suspended_at: undefined } : {}),
                updated_at: at,
                history: wake && cur.suspended_at
                    ? [...cur.history, { frame: cur.active_frame, event: "resume", at }]
                    : cur.history,
            };
        });
        if (set)
            written.push(id);
    }
    return written;
}
/**
 * A resumed conversation picks up its own sessions: those stamped with its id
 * and left suspended (SessionEnd) or owned by a dead process (a crash), with
 * their whole sub-trees. A session another live process runs is left alone.
 * Returns the picked-up roots as stored afterwards.
 */
export async function pickUpConversation(storage, claudeSessionId, pid, at) {
    const all = storage.readAll();
    const left = all.filter(s => {
        if (!(s.stack?.length > 0) || s.claude_session_id !== claudeSessionId)
            return false;
        if (s.suspended_at)
            return true;
        const owner = s.context.claude_code_pid;
        return typeof owner === "number" && owner !== pid && !isPidAlive(owner);
    });
    // a session with an active parent is that parent's to hand over — e.g. the
    // child an explicit resume() left suspended under a parent another process runs
    const activeIds = new Set(all.filter(s => s.stack?.length > 0).map(s => s.session_id));
    const roots = left.filter(s => !s.parent_session_id || !activeIds.has(s.parent_session_id));
    for (const root of roots)
        await takeOver(storage, root.session_id, { pid, claudeSessionId }, at, "tree");
    return roots
        .map(r => storage.read(r.session_id))
        .filter((s) => !!s && s.stack.length > 0);
}
export function stepNote(s) {
    const f = s.stack[s.active_frame];
    const here = (at) => at?.frame === s.active_frame && at.state === f?.current_state;
    if (s.running_exec && here(s.running_exec)) {
        const name = s.running_exec.state;
        const fate = Executor.fate(s.running_exec);
        const text = {
            running: `exec in flight: ${name}`,
            finished: `exec finished while no server ran: ${name} — the session's next call takes its result`,
            lost: `exec killed by the restart: ${name} — the session's next call runs the step again`,
        }[fate];
        return { fate, text };
    }
    if (s.pending_action && here(s.pending_action))
        return {
            fate: "unstarted",
            text: `step interrupted before its exec started: ${s.pending_action.state} — the session's next call runs it again`,
        };
    return undefined;
}
/**
 * No agent is linked to `s` nor to any session between it and `rootId`: the
 * conversation's own agent, which drives the root, drives it too. A session
 * whose chain to the root is not in `byId` is not known to be.
 */
export function drivenByRootAgent(s, rootId, byId) {
    for (let cur = s; cur;) {
        if (cur.agent_id)
            return false;
        const parent = cur.parent_session_id;
        if (parent === rootId)
            return true;
        cur = parent ? byId.get(parent) : undefined;
    }
    return false;
}
/**
 * The abort call a note offers for `s`: it names its parent as the caller, so the abort guard
 * passes even when `s` has active descendants (the one reading the note is the parent's agent).
 */
function abortHint(s, parent) {
    return `abort({ session_id: '${s.session_id}', caller_session_id: '${parent.session_id}' })`;
}
/**
 * The agent of `s` was linked at an earlier visit of the state its parent stands at now (a fix
 * round re-entered it): the note that says so, else undefined (also when the parent's state is
 * not at hand: the note compares against it and names it as the abort's caller). Such an agent is not this visit's.
 */
export function earlierVisitNote(s, parent, isRoute = () => false) {
    if (!parent || parent.stack.length === 0)
        return undefined;
    const now = currentStep(parent);
    const standing = now && listedStanding(s, now, parent, isRoute);
    if (!now || !s.agent_id || !s.agent_step)
        return undefined;
    if (!standing) {
        const at = s.agent_step;
        return `linked at its parent's ${at.state} visit ${at.visit}, the parent is now at ${now.state}: an earlier step's agent — not woken; ${abortHint(s, parent)} once it is not needed`;
    }
    if (standing === "current" || standing === "spawned")
        return undefined;
    return `linked at its parent's ${now.state} visit ${s.agent_step.visit}, the parent is now at visit ${now.visit}: an earlier visit's agent — not woken; ${abortHint(s, parent)} once it is not needed`;
}
/**
 * Whether a dispatcher agent has the root: `dispatcher_call` in its context AND an agent linked to it or
 * the root past the state the conversation drives itself (`dispatcher_after`; none = from the start).
 * Before that the conversation still drives the root, and nothing here applies.
 */
export function dispatcherHolds(root) {
    const block = root.context[DISPATCHER_CALL_KEY];
    if (typeof block !== "string" || block === "")
        return false;
    if (root.agent_id)
        return true;
    const after = root.context[DISPATCHER_AFTER_KEY];
    if (typeof after !== "string" || after === "")
        return true;
    return root.history.some(h => h.frame === 0 && h.from === after);
}
/** The task sessions a dispatcher's `tasks` key names (`ID=P driver=<agent>` entries): the P ids. */
export function dispatcherTaskSessions(root) {
    const tasks = root.context.tasks;
    const ids = new Set();
    if (typeof tasks !== "string")
        return ids;
    for (const m of tasks.matchAll(/(?:^|\s)[^\s=]+=([0-9a-f]{8})(?=\s|$)/g))
        ids.add(m[1]);
    return ids;
}
/**
 * A picked-up root a dispatcher agent holds (`dispatcherHolds`): the lines that tell the conversation
 * to wake that agent only — it wakes the `below` task sessions of its `tasks` key. Empty for any other root.
 */
export function dispatcherWakeLines(root, indent, below) {
    if (!dispatcherHolds(root))
        return [];
    const id = root.session_id;
    const head = `${indent}DISPATCHER — a dispatcher agent drives ${id}: wake ONLY it; the ${below} session(s) of its \`tasks\` key and below them are its to wake, never yours:`;
    if (!root.agent_id)
        return [
            head,
            `${indent}  no agent linked — spawn it from ${STATUS_TOOL}({ session_id: '${id}', key: '${DISPATCHER_CALL_KEY}' }), link_agent it, then SendMessage it "restarted: wake the task drivers"`,
        ];
    return [
        head,
        `${indent}  SendMessage({ to: "${root.agent_id}", message: "Continue — the run was restarted: call ${STATUS_TOOL}({ session_id: '${id}' }) — NOT start(), NOT resume() — then wake each task driver of its \`tasks\` key as your instructions' § After a restart say." })`,
        `${indent}  that SendMessage fails → spawn a fresh one from ${STATUS_TOOL}({ session_id: '${id}', key: '${DISPATCHER_CALL_KEY}' }), link_agent it, and send it the same message`,
    ];
}
/**
 * The sessions below a root `subs` split for the conversation that picked the root up: under a dispatcher
 * agent (`dispatcherHolds`) the task sessions of its `tasks` key and what runs below them are the agent's to
 * wake — and a child of the root that carries a `task` but is not in `tasks` yet (the dispatcher died between `start` and
 * `dispatched`) — (`lines` says so, `mine` leaves them out); any other root leaves `lines` empty and `mine` whole.
 * One owner of the split for the SessionStart pickup and the `resume` reply.
 */
export function dispatcherSplit(root, subs, byId, indent) {
    const taskIds = dispatcherTaskSessions(root);
    const underTask = (s) => {
        for (let cur = s; cur && cur.session_id !== root.session_id;) {
            if (taskIds.has(cur.session_id))
                return true;
            // a task session the dispatcher started and died before it wrote `tasks` is still its own: its repeated `dispatch` finds it
            // (only with a driver call: a task the main conversation drives itself stays listed to it)
            if (cur.parent_session_id === root.session_id &&
                typeof cur.context.task === "string" &&
                typeof cur.context[DRIVER_CALL_KEY] === "string")
                return true;
            cur = cur.parent_session_id ? byId.get(cur.parent_session_id) : undefined;
        }
        return false;
    };
    const its = subs.filter(underTask);
    const lines = dispatcherWakeLines(root, indent, its.length);
    return { lines, mine: lines.length > 0 ? subs.filter(s => !underTask(s)) : [...subs] };
}
/**
 * Per session below a root: one the root's own agent drives (`yours`) — one
 * line with the call to make on it; one whose agent is an earlier visit's of its
 * parent's current state (`parentOf` finds the parent) — one line, no wake; any
 * other — agent → session → state, and the `SendMessage` that wakes its agent to
 * call `call` on its OWN session.
 */
export function subAgentLines(sessions, call, indent, yours = () => false, parentOf = () => undefined, routeOf = () => () => false) {
    const lines = [];
    const how = call === RESUME_TOOL
        ? "your own session, NOT start()"
        : "your own session, picked up after a restart — NOT start(), NOT resume()";
    for (const c of sessions) {
        const note = stepNote(c);
        const step = note ? ` [${note.text}]` : "";
        if (yours(c)) {
            lines.push(`${indent}${c.session_id} → ${where(c)}${step} — no agent linked — yours, unless a sub-agent you spawned runs it (then link_agent + SendMessage) → ${call}({ session_id: '${c.session_id}' })`);
            continue;
        }
        const parent = parentOf(c);
        const earlier = earlierVisitNote(c, parent, parent ? routeOf(parent) : undefined);
        if (earlier) {
            lines.push(`${indent}${c.agent_id} → ${c.session_id} → ${where(c)}${step} — ${earlier}`);
            continue;
        }
        const agent = c.agent_id ?? "(not linked — find the agent by its task; link_agent records it)";
        lines.push(`${indent}${agent} → ${c.session_id} → ${where(c)}${step}`);
        lines.push(`${indent}  SendMessage({ to: "${c.agent_id ?? "<agent>"}", message: "Continue: call ${call}({ session_id: '${c.session_id}' }) — ${how} — then carry on from the state it returns." })`);
    }
    return lines;
}
