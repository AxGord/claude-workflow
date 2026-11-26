// A state's `delivers:` key: the agent a state waits on delivers by writing that context key, and the engine
// takes the write as the delivery — it does not wait for the end of the agent's turn, which a command the
// agent left running can hold open for good. Pure: the engine reads the state, the transcript and the pool.

import { currentStep } from "./agent-link.js";
import type { PoolEntry } from "./pool.js";
import { isAgentId } from "./spend.js";
import {
  DRIVER_ROLE,
  deliversOf,
  type Delivers,
  type Delivery,
  type SessionState,
  type StateDefinition,
} from "./types.js";

/** The state's `delivers:` in its object form; undefined when it declares none. */
export function deliveryDeclared(state: StateDefinition | undefined): Delivers | undefined {
  return deliversOf(state?.delivers);
}

/** The delivery the session holds for the step it stands at now; undefined once it has moved off that step. */
export function liveDelivery(session: SessionState): Delivery | undefined {
  const d = session.delivery;
  const now = currentStep(session);
  if (!d || !now) return undefined;
  return d.workflow === now.workflow && d.state === now.state && d.visit === now.visit
    ? d
    : undefined;
}

/**
 * The agent a delivery's tokens are read from: the context key `agent:` names, else the latest non-driver
 * agent linked to the session at this visit of the step. undefined: none that is an agent id.
 */
export function deliveryAgent(session: SessionState, declared: Delivers): string | undefined {
  if (declared.agent !== undefined) {
    const v = session.context[declared.agent];
    return typeof v === "string" && isAgentId(v.trim())
      ? v.trim().replace(/^agent-/, "")
      : undefined;
  }
  const now = currentStep(session);
  if (!now) return undefined;
  const link = [...(session.agent_links ?? [])]
    .reverse()
    .find(
      l =>
        l.role !== undefined &&
        l.role !== DRIVER_ROLE &&
        l.step?.workflow === now.workflow &&
        l.step.state === now.state &&
        l.step.visit === now.visit,
    );
  return link && isAgentId(link.agent_id) ? link.agent_id.replace(/^agent-/, "") : undefined;
}

/** A token count a context key holds as digits; anything else is 0. */
function digits(v: unknown): number {
  const n =
    typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * `session` with the delivery of `key` recorded, or the same object when `key` is not the deliverable of the step
 * it stands at (a write at another state, or after a move, is an ordinary write: no record, no tokens). The tokens
 * key is set to what it held at the step's first delivery plus the agent's context (`context`, its last turn's
 * size), so a second delivery of the same visit (a fix of the shape) does not count it twice.
 */
export function withDelivery(
  session: SessionState,
  state: StateDefinition | undefined,
  key: string,
  now: string,
  context: (agent: string) => number | undefined,
): SessionState {
  const declared = deliveryDeclared(state);
  const step = currentStep(session);
  if (!declared || declared.key !== key || !step) return session;
  const agent = deliveryAgent(session, declared);
  const prior = liveDelivery(session);
  const size = agent === undefined ? undefined : context(agent);
  let tokens: Delivery["tokens"];
  let ctx = session.context;
  if (declared.tokens !== undefined && size !== undefined) {
    const base =
      prior?.tokens?.key === declared.tokens ? prior.tokens.base : digits(ctx[declared.tokens]);
    tokens = { key: declared.tokens, base, value: base + size };
    ctx = { ...ctx, [declared.tokens]: String(tokens.value) };
  }
  const delivery: Delivery = {
    ...step,
    key,
    at: now,
    ...(agent !== undefined ? { agent } : {}),
    ...(tokens ? { tokens } : {}),
  };
  const detail = `${key}${tokens ? `; ${tokens.key}=${tokens.value}` : ""}`;
  return {
    ...session,
    context: ctx,
    delivery,
    history: [
      ...session.history,
      { frame: session.active_frame, event: "delivery", at: now, detail },
    ],
  };
}

const sinceOf = (ms: number, now: number): string => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
};

/**
 * The warning the AGENT gets with the answer of its delivering `context_set` while its session still owns a live
 * pool waiter or lease (`entries`: `Pool.heldBy`): a command it started and left running keeps its turn from ending,
 * and the end of the turn is the notification the driver otherwise waits for. undefined: nothing live.
 */
export function waiterWarning(
  key: string,
  entries: readonly PoolEntry[],
  now: number = Date.now(),
): string | undefined {
  if (entries.length === 0) return undefined;
  const rows = entries.map(e => {
    const what = e.started === undefined ? "waiter" : "lease";
    const since =
      e.started === undefined
        ? `queued ${sinceOf(e.arrived, now)}`
        : `running ${sinceOf(e.started, now)}`;
    return `${what} pid ${e.pid} "${e.label || "-"}" (${since})`;
  });
  return (
    `WARNING: "${key}" is delivered, but this session still owns ${entries.length === 1 ? "a live pool entry" : `${entries.length} live pool entries`}: ${rows.join("; ")}. ` +
    "A command left running keeps your turn from ending, and the end of your turn is what the driver may be waiting for: " +
    "wait for it (a foreground call) or stop it, and only then send your last message."
  );
}

/**
 * The `DELIVERY:` line a session at a delivered step holds, for the driver of that session and the dispatcher above
 * it: the deliverable is in, so the state's transition is taken without the agent's notification. `routes` = the
 * state's transitions.
 */
export function deliveryLine(session: SessionState, routes: readonly string[]): string | undefined {
  const d = liveDelivery(session);
  if (!d) return undefined;
  const route =
    routes.length === 1
      ? `transition \`${routes[0]}\``
      : "the transition the state's prompt names for a delivered report";
  const filled = d.tokens
    ? ` The engine set \`${d.tokens.key}\` = ${d.tokens.value} from the agent's transcript: set no tokens.`
    : "";
  return (
    `DELIVERY: session ${session.session_id} (${d.workflow}/${d.state}) — ${d.agent ? `agent ${d.agent}` : "the agent"} set \`${d.key}\` at ${d.at}.${filled} ` +
    `The deliverable is in: take ${route} now, without waiting for the agent's notification; ` +
    "that notification, when it comes after the move, is a no-op (set no tokens, transition nothing)."
  );
}
