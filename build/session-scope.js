import { activeSubtree, where } from "./takeover.js";
/** `id` is `ancestor` or sits below it in the parent chain (ended sessions included). */
export function isWithin(all, ancestor, id) {
    const byId = new Map(all.map(s => [s.session_id, s]));
    for (let cur = byId.get(id), hops = 0; cur && hops <= all.length; hops++) {
        if (cur.session_id === ancestor)
            return true;
        cur = cur.parent_session_id ? byId.get(cur.parent_session_id) : undefined;
    }
    return false;
}
function override(call) {
    const reason = call.reason?.trim();
    return call.force === true && reason ? reason : undefined;
}
/**
 * Whether `call` may touch its target. Without `caller_session_id` only a
 * target that is a lone leaf passes: a root, or a session with active
 * descendants, is the one whose end takes others with it.
 */
export function scopeVerdict(storage, call) {
    // open on purpose: a step ends no session, and the engine's own prompts transition other sessions without a caller
    if (call.tool === "transition" && call.caller === undefined)
        return {};
    const all = storage.readAll();
    const target = all.find(s => s.session_id === call.target);
    if (!target)
        return {};
    const forced = override(call);
    const reach = activeSubtree(storage, call.target).length;
    let why;
    if (call.caller !== undefined) {
        if (!isWithin(all, call.caller, call.target))
            why = `session "${call.target}" (${scopeName(target)}) is not "${call.caller}" or one it started`;
    }
    else if (call.tool === "abort" && (!target.parent_session_id || reach > 1)) {
        why = target.parent_session_id
            ? `session "${call.target}" (${scopeName(target)}) has ${reach - 1} active session(s) under it that an abort would end with it; its caller is not named`
            : `session "${call.target}" (${scopeName(target)}) is a ROOT session${reach > 1 ? ` with ${reach - 1} active session(s) under it` : ""}; its caller is not named`;
    }
    if (!why)
        return {};
    if (forced)
        return { overridden: forced };
    return {
        refusal: `${call.tool} refused: ${why}. Pass caller_session_id (your own session id; only yourself and sessions you started may be ${call.tool === "abort" ? "aborted" : "stepped"}), ` +
            `or force: true with a reason: "<why this session must end>" when ending it is deliberate.`,
    };
}
function scopeName(s) {
    return s.stack.length > 0 ? where(s) : `ended, ${s.outcome ?? "completed"}`;
}
/**
 * A parentless `start` while this process already has an active root. Names
 * the root by workflow and state, never by id: the id handed to a stray
 * caller is what it then aborts.
 */
export function secondRootRefusal(storage, pid, force) {
    if (force?.trim())
        return undefined;
    const root = storage
        .readAll()
        .find(s => s.context.claude_code_pid === pid && !s.parent_session_id && s.stack.length > 0);
    if (!root)
        return undefined;
    return (`start refused: this process already has an active root session (${where(root)}, started ${root.started_at}). ` +
        `A sub-agent never gets a root: start with parent_session_id set to the session that spawned you. ` +
        `If you are that session, call status() to read yours. ` +
        `A second root on purpose: start({ force: "<reason>" }).`);
}
