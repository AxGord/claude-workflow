// Which visit a linked agent belongs to. Under a parent of a `driver:` workflow (one agent per state
// visit) `link_agent` records the parent's step beside the agent id (`agent_step`), so a later visit of
// that state — a fix round — tells this visit's agent from an earlier visit's without any key a prompt
// has to render. Any other parent records no step: nothing here applies to its agents. Pure.

import type { AgentStep, SessionState } from "./types.js";

/** The step a session stands at: its active frame's workflow, state and that state's visit. */
export function currentStep(s: SessionState): AgentStep | undefined {
  const f = s.stack[s.active_frame];
  if (!f) return undefined;
  return {
    workflow: f.workflow,
    state: f.current_state,
    visit: f.state_visits[f.current_state] ?? 0,
  };
}

/**
 * A child's link against its parent's step now: `current` — linked at this visit of this state;
 * `stale` — at an earlier visit and its session ended; `running` — at an earlier visit, its session
 * still runs. Undefined: no link, or one made at another state.
 */
export type LinkStanding = "current" | "stale" | "running";

export function linkStanding(child: SessionState, now: AgentStep): LinkStanding | undefined {
  const at = child.agent_step;
  if (!child.agent_id || !at || at.workflow !== now.workflow || at.state !== now.state)
    return undefined;
  if (at.visit >= now.visit) return "current";
  return child.stack.length > 0 ? "running" : "stale";
}

const MAX_LINES = 20;

/**
 * status()'s LINKED AGENTS block: the agents linked to `parent`'s children at its current state, this
 * visit's first. Empty when there are none.
 */
export function linkedAgentLines(
  parent: SessionState,
  children: readonly SessionState[],
): string[] {
  const now = currentStep(parent);
  if (!now) return [];
  const rows = children
    .filter(c => c.parent_session_id === parent.session_id)
    .map(c => ({ c, standing: linkStanding(c, now) }))
    .filter((r): r is { c: SessionState; standing: LinkStanding } => r.standing !== undefined)
    .sort((a, b) => b.c.agent_step!.visit - a.c.agent_step!.visit);
  if (rows.length === 0) return [];
  const lines = [
    `LINKED AGENTS at ${now.state} (visit ${now.visit}) — only a current one is this visit's agent:`,
  ];
  for (const { c, standing } of rows.slice(0, MAX_LINES)) {
    const visit = c.agent_step!.visit;
    const head = `  agent ${c.agent_id} → session ${c.session_id}: linked at visit ${visit}`;
    lines.push(
      standing === "current"
        ? `${head} → current`
        : `${head}, now visit ${now.visit} → ${standing === "stale" ? "stale (its session ended)" : "an earlier visit's (its session still runs)"}`,
    );
  }
  if (rows.length > MAX_LINES) lines.push(`  … ${rows.length - MAX_LINES} more`);
  return lines;
}
