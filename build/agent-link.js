// Which visit a linked agent belongs to. Under a parent of a `driver:` workflow (one agent per state
// visit) `link_agent` records the parent's step beside the agent id (`agent_step`), so a later visit of
// that state — a fix round — tells this visit's agent from an earlier visit's without any key a prompt
// has to render. Any other parent records no step: nothing here applies to its agents. Pure.
/** The step a session stands at: its active frame's workflow, state and that state's visit. */
export function currentStep(s) {
    const f = s.stack[s.active_frame];
    if (!f)
        return undefined;
    return {
        workflow: f.workflow,
        state: f.current_state,
        visit: f.state_visits[f.current_state] ?? 0,
    };
}
export function linkStanding(child, now) {
    const at = child.agent_step;
    if (!child.agent_id || !at || at.workflow !== now.workflow || at.state !== now.state)
        return undefined;
    if (at.visit >= now.visit)
        return "current";
    return child.stack.length > 0 ? "running" : "stale";
}
/**
 * A state that spawns an agent: its name ends `_spawn` (`work_spawn`, `plan_spawn`).
 */
export const SPAWN_STATE = /_spawn$/;
function precedingStep(parent, now, isRoute) {
    const moves = parent.history.filter(h => h.frame === parent.active_frame && h.from !== undefined && h.to !== undefined);
    let i = moves.length - 1;
    while (i >= 0 && moves[i].to !== now.state)
        i--;
    if (i < 0)
        return undefined;
    let state = moves[i].from;
    for (let hops = 0; isRoute(state) && hops < 8; hops++) {
        let j = i - 1;
        while (j >= 0 && moves[j].to !== state)
            j--;
        if (j < 0)
            return undefined;
        i = j;
        state = moves[j].from;
    }
    if (isRoute(state))
        return undefined;
    let enter = -1;
    for (let j = i - 1; j >= 0; j--) {
        if (moves[j].to === state) {
            enter = j;
            break;
        }
    }
    const left = moves.slice(enter + 1).find(h => h.from === state);
    return { state, from: enter >= 0 ? moves[enter].at : parent.started_at, to: left?.at };
}
/**
 * `linkStanding`, plus `spawned`: the child's agent is the one the spawn state the parent stands at
 * would start again — linked at the state the parent stood at just before it (routing steps such as
 * `plan_route` skipped), at that state's latest visit, and the child's session started there too —
 * and its session still runs. An agent linked at an earlier state, or one the parent's session
 * started elsewhere (a recon agent, a warm reviewer reused later), is not.
 */
export function listedStanding(child, now, parent, isRoute = () => false) {
    const own = linkStanding(child, now);
    if (own)
        return own;
    const at = child.agent_step;
    if (!child.agent_id || !at || at.workflow !== now.workflow)
        return undefined;
    if (!parent || !SPAWN_STATE.test(now.state) || child.stack.length === 0)
        return undefined;
    const before = precedingStep(parent, now, isRoute);
    const frame = parent.stack[parent.active_frame];
    if (!before || at.state !== before.state)
        return undefined;
    if (at.visit !== (frame?.state_visits[before.state] ?? 0))
        return undefined;
    const started = child.started_at;
    return started >= before.from && (before.to === undefined || started <= before.to)
        ? "spawned"
        : undefined;
}
const MAX_LINES = 20;
/**
 * status()'s LINKED AGENTS block: the agents linked to `parent`'s children at its current state, this
 * visit's first, and at a spawn state also the running agent linked at the state before it. Empty when there are none.
 */
export function linkedAgentLines(parent, children, isRoute = () => false) {
    const now = currentStep(parent);
    if (!now)
        return [];
    const rows = children
        .filter(c => c.parent_session_id === parent.session_id)
        .map(c => ({ c, standing: listedStanding(c, now, parent, isRoute) }))
        .filter((r) => r.standing !== undefined)
        .sort((a, b) => b.c.agent_step.visit - a.c.agent_step.visit);
    if (rows.length === 0)
        return [];
    const lines = [
        `LINKED AGENTS at ${now.state} (visit ${now.visit}) — only a current one is this visit's agent:`,
    ];
    for (const { c, standing } of rows.slice(0, MAX_LINES)) {
        const at = c.agent_step;
        if (standing === "spawned") {
            lines.push(`  agent ${c.agent_id} → session ${c.session_id}: linked at ${at.state} visit ${at.visit}, now at the spawn state ${now.state} → live (its session still runs): SendMessage it, spawn no second agent`);
            continue;
        }
        const head = `  agent ${c.agent_id} → session ${c.session_id}: linked at visit ${at.visit}`;
        lines.push(standing === "current"
            ? `${head} → current`
            : `${head}, now visit ${now.visit} → ${standing === "stale" ? "stale (its session ended)" : "an earlier visit's (its session still runs)"}`);
    }
    if (rows.length > MAX_LINES)
        lines.push(`  … ${rows.length - MAX_LINES} more`);
    return lines;
}
