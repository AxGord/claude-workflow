// A dispatching workflow's `dispatcher.refresh` — when the engine, not the dispatcher agent, decides that a
// long-lived agent is handed over to a fresh one. Pure: the engine reads the agent's transcript and the session;
// this file decides and words the lines a prompt shows.
import { DEFAULT_IDLE_MINUTES } from "./resume.js";
import type { DispatcherRefreshSpec } from "./types.js";

/** A dispatcher above this context is replaced (a cold wake re-writes the whole of it into the prompt cache). */
export const DEFAULT_REFRESH_CONTEXT_TOKENS = 200_000;

/** Writes of a dispatching session less than this apart belong to one wake of its agent; a longer silence starts the next. */
export const WAKE_GAP_MS = 3 * 60_000;

/** The session context key the dispatcher records the hand-back to the main conversation in: the old agent's id. */
export const REFRESH_HANDED_KEY = "refresh_handed";

/** The session context key the fresh dispatcher records its rebind in: its own id. */
export const REBOUND_KEY = "dispatcher_rebound";

/** What the decision reads. */
export interface RefreshInputs {
  /** The dispatcher agent's id; empty when none is linked. */
  readonly agent: string;
  /** Milliseconds since the session's previous engine call; undefined when unknown. */
  readonly idleMs?: number;
  /** The agent's context, its last turn's size; undefined when its transcript cannot be read. */
  readonly context?: number;
  /** The agent has nothing of its own to finish: no parent answer to relay, no owed step to hand over. */
  readonly safePoint: boolean;
}

export interface RefreshDecision {
  readonly due: boolean;
  readonly reason: string;
  /** Whole minutes of idle, when known. */
  readonly idle?: number;
}

/**
 * Due when the agent's context is above the bound and either its wake came after the cache's life (a cold
 * wake: whatever it holds, the fresh agent relays it) or it stands at a safe point. Never due on an unknown
 * agent or context: a reading the engine cannot make is not a reason to replace anyone.
 */
export function decideRefresh(spec: DispatcherRefreshSpec, inputs: RefreshInputs): RefreshDecision {
  const idleLimit = spec.idle_minutes ?? DEFAULT_IDLE_MINUTES;
  const bound = spec.context_tokens ?? DEFAULT_REFRESH_CONTEXT_TOKENS;
  const idle = inputs.idleMs === undefined ? undefined : Math.floor(inputs.idleMs / 60_000);
  const no = (reason: string): RefreshDecision => ({ due: false, reason, idle });
  if (inputs.agent === "") return no("no dispatcher agent linked");
  if (inputs.context === undefined) return no("context unknown");
  if (inputs.context <= bound) return no(`context ${inputs.context} <= ${bound}`);
  if (idle !== undefined && idle >= idleLimit)
    return {
      due: true,
      idle,
      reason: `cold wake: idle ${idle} min >= ${idleLimit}, context ${inputs.context} > ${bound}`,
    };
  if (inputs.safePoint)
    return { due: true, idle, reason: `context ${inputs.context} > ${bound} at a safe point` };
  return no(`context ${inputs.context} > ${bound} but a relay of its own stands`);
}

/** The lines a prompt shows while the old dispatcher is due: what to hand main, and what main then does. */
export function refreshDueLines(i: {
  readonly session: string;
  readonly agent: string;
  readonly reason: string;
  readonly running: number;
}): string[] {
  const { session: d, agent: a } = i;
  return [
    `REFRESH-DUE: dispatcher ${a} is to be replaced (${i.reason}). The engine decides, not you: finish the pass you are on, then SendMessage \`main\` EXACTLY the MESSAGE line below, then \`context_set({session_id: "${d}", key: "${REFRESH_HANDED_KEY}", value: "${a}"})\`, then end the turn with \`DISPATCHING session=${d} running=${i.running}\`. Drive as before until main sends you \`RETIRE new=<agent id>\`.`,
    `MESSAGE: REFRESH session=${d} old=${a} reason=${i.reason}: spawn the dispatcher from status({session_id: "${d}", key: "dispatcher_call"}) exactly, link_agent({session_id: "${d}", agent_id: <its id>, role: "driver"}), then SendMessage ${a} "RETIRE new=<its id>". The fresh dispatcher wakes each task driver once itself; nothing to answer.`,
  ];
}

/** The lines a prompt shows the fresh dispatcher: each live task driver is told its dispatcher once. */
export function rebindLines(i: {
  readonly session: string;
  readonly old: string;
  readonly fresh: string;
  readonly drivers: ReadonlyArray<{ task: string; session: string; driver: string }>;
}): string[] {
  const { session: d, fresh } = i;
  return [
    `REBIND: you (${fresh}) replace dispatcher ${i.old}. For each REBIND-TASK line, SendMessage that driver EXACTLY \`DISPATCHER CHANGED: your dispatcher is now ${fresh}; nothing to do.\` (once: the driver's later report then reaches you), then \`context_set({session_id: "${d}", key: "${REBOUND_KEY}", value: "${fresh}"})\`; none listed → only the context_set.`,
    ...i.drivers.map(t => `REBIND-TASK: task=${t.task} session=${t.session} driver=${t.driver}`),
  ];
}
