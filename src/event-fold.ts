// The per-session picture the event log adds up to, and the events a session file stands for. Pure and
// import-free (types only), so the compiled file runs in the dashboard page unchanged (served as
// /event-fold.js): the live map is `layout(fold(events))` (src/map-layout.ts).

export type EventKind =
  | "session_start"
  | "session_end"
  | "transition"
  | "exec_start"
  | "exec_end"
  | "agent_link"
  | "agent_respawn"
  | "agent_stop"
  | "rescore"
  | "ask"
  | "answer";

export interface WfEvent {
  /** Global sequence of the run, from 1 (0 for an event seeded from a session file). */
  readonly seq: number;
  /** The server run that wrote it: a restart starts a new sequence. */
  readonly run: string;
  readonly ts: string;
  readonly kind: EventKind;
  readonly session: string;
  readonly data: Record<string, unknown>;
}

export interface FoldedAgent {
  agent: unknown;
  role: unknown;
  model: unknown;
  effort: unknown;
  status: "running" | "respawned" | "stopped";
  /** when it was linked */
  at?: string;
  /** the session's state when it was linked */
  state?: string;
  /** the parent's step it was linked at (`agent_step`) */
  step?: unknown;
  /** where the session stood when this agent was replaced or stopped */
  endedAt?: { state?: string; ts: string };
}

export interface FoldedSession {
  readonly id: string;
  workflow?: string;
  parent: string | null;
  task: unknown;
  difficulty: unknown;
  state?: string;
  started?: string;
  ended?: string;
  transitions: { from: string; to: string; name: unknown; ts: string; workflow?: string }[];
  execs: {
    state: unknown;
    start?: string;
    end?: string;
    exit_code?: unknown;
    duration_ms?: unknown;
  }[];
  agents: FoldedAgent[];
  /** `to` = the state the answer moved to; `text` = the question a driver passed (`ask_parent`) */
  asks: { state: unknown; at: string; answered?: string; to?: string; text?: string }[];
  outcome?: unknown;
}

function emptySession(id: string): FoldedSession {
  return {
    id,
    parent: null,
    task: null,
    difficulty: null,
    transitions: [],
    execs: [],
    agents: [],
    asks: [],
  };
}

/** The context key a driver sets at a hand-back to ask its parent, and clears when the parent has answered. */
export const ASK_KEY = "ask_parent";

/**
 * A driver's open question to its parent: the key holds text AND no move or end came after the
 * `context_set` that wrote it (that write is the history line whose `detail` is the key). Read off the
 * session alone, so a stale copy of it, a restart or the parent's own `transition` on the child
 * (a regate, a close) cannot leave a question open or ask it twice.
 */
export function openAsk(s: {
  readonly stack: readonly unknown[];
  readonly context: Record<string, unknown>;
  readonly history: readonly {
    readonly at: string;
    readonly from?: string;
    readonly to?: string;
    readonly event?: string;
    readonly detail?: string;
  }[];
}): { text: string; at: string } | null {
  const text = s.context[ASK_KEY];
  if (typeof text !== "string" || text.trim() === "" || s.stack.length === 0) return null;
  for (let i = s.history.length - 1; i >= 0; i--) {
    const h = s.history[i];
    if (h.from !== undefined && h.to !== undefined) return null;
    if (h.event === "context_set" && h.detail === ASK_KEY) return { text, at: h.at };
  }
  return null;
}

const known = (v: unknown): boolean => v !== null && v !== undefined && v !== "";

/**
 * The per-session picture the events add up to. A transition seen twice (seeded from a session file,
 * then logged) counts once; a second `session_start` only fills what the first left empty.
 */
export function fold(events: readonly WfEvent[]): Map<string, FoldedSession> {
  const out = new Map<string, FoldedSession>();
  const seen = new Map<string, Set<string>>();
  const get = (id: string): FoldedSession => {
    let s = out.get(id);
    if (!s) {
      s = emptySession(id);
      out.set(id, s);
      seen.set(id, new Set());
    }
    return s;
  };
  for (const e of events) {
    const s = get(e.session);
    const d = e.data;
    switch (e.kind) {
      case "session_start":
        if (!known(s.workflow) && known(d.workflow)) s.workflow = d.workflow as string;
        if (s.parent === null && known(d.parent)) s.parent = d.parent as string;
        if (!known(s.task)) s.task = d.task;
        if (!known(s.difficulty)) s.difficulty = d.difficulty;
        s.started ??= e.ts;
        break;
      case "transition": {
        const key = `${String(d.from)}\u0000${String(d.to)}\u0000${e.ts}`;
        const keys = seen.get(e.session) as Set<string>;
        if (keys.has(key)) break;
        keys.add(key);
        s.transitions.push({
          from: d.from as string,
          to: d.to as string,
          name: d.name,
          ts: e.ts,
          ...(known(d.workflow) ? { workflow: d.workflow as string } : {}),
        });
        s.state = d.to as string;
        break;
      }
      case "exec_start":
        s.execs.push({ state: d.state, start: e.ts });
        break;
      case "exec_end": {
        const open = [...s.execs].reverse().find(x => x.end === undefined && x.start !== undefined);
        const end = { end: e.ts, exit_code: d.exit_code, duration_ms: d.duration_ms ?? null };
        const key = `exec\u0000${String(d.state)}\u0000${e.ts}`;
        const keys = seen.get(e.session) as Set<string>;
        if (keys.has(key)) {
          // seeded already: a logged start of the same run takes the end, the seeded copy goes
          if (open) {
            Object.assign(open, end);
            const copy = s.execs.findIndex(
              x => x.start === undefined && x.end === e.ts && x.state === d.state,
            );
            if (copy >= 0) s.execs.splice(copy, 1);
          }
          break;
        }
        keys.add(key);
        if (open) Object.assign(open, end);
        else s.execs.push({ state: d.state, ...end });
        break;
      }
      case "agent_link":
      case "agent_respawn": {
        // a respawn replaces every other running agent — also when the new one is already known
        // (a seed links the session's current agent before the logged links of its predecessors)
        if (e.kind === "agent_respawn")
          for (const a of s.agents)
            if (a.status === "running" && a.agent !== d.agent) {
              a.status = "respawned";
              a.endedAt = { state: s.state, ts: e.ts };
            }
        // the same agent linked again (a new step of its parent, or seeded): the record moves to the
        // end, so the last agent is always the current one
        const same = s.agents.findIndex(a => a.agent === d.agent && a.status === "running");
        if (same >= 0) {
          const [rec] = s.agents.splice(same, 1) as [FoldedAgent];
          Object.assign(rec, { model: d.model ?? rec.model, effort: d.effort ?? rec.effort });
          if (d.step !== undefined && d.step !== null) rec.step = d.step;
          s.agents.push(rec);
          break;
        }
        s.agents.push({
          agent: d.agent,
          role: d.role,
          model: d.model,
          effort: d.effort,
          status: "running",
          at: e.ts,
          state: s.state,
          step: d.step ?? null,
        });
        break;
      }
      case "agent_stop":
        for (const a of s.agents)
          if (a.status === "running") {
            a.status = "stopped";
            a.endedAt = { state: s.state, ts: e.ts };
          }
        break;
      case "rescore":
        s.difficulty = d.to;
        break;
      case "ask": {
        const text = typeof d.text === "string" && d.text !== "" ? d.text : undefined;
        // a driver's `ask_parent` made in an `ask: parent` state is the question the state's entry
        // logged (the text joins it), and a seeded question logged again is one question
        const open = s.asks.find(a => a.answered === undefined && a.state === d.state);
        if (
          open &&
          ((text === undefined) !== (open.text === undefined) ||
            (text !== undefined && text === open.text))
        ) {
          open.text ??= text;
          break;
        }
        s.asks.push({ state: d.state, at: e.ts, ...(text !== undefined ? { text } : {}) });
        break;
      }
      case "answer": {
        const open = [...s.asks].reverse().find(a => a.answered === undefined);
        if (open) {
          open.answered = e.ts;
          // where the answer moved to: the event says it; an older log's answer is the move out of
          // the asking state at that instant (never the session's state now — seeds run ahead)
          const out = s.transitions.find(t => t.ts === e.ts && t.from === d.state)?.to;
          const to = typeof d.to === "string" ? d.to : out;
          if (to !== undefined) open.to = to;
        }
        break;
      }
      case "session_end":
        s.outcome = d.outcome;
        s.ended ??= e.ts;
        break;
    }
  }
  // seeded and logged moves interleave by time; a stable sort keeps same-instant moves in log order
  for (const s of out.values()) {
    s.transitions.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const last = s.transitions.at(-1);
    if (last) s.state = last.to;
  }
  return out;
}

/** The part of a session file (`/api/sessions`) a seed reads. */
export interface SeedSession {
  readonly session_id: string;
  readonly parent_session_id?: string;
  readonly stack: readonly { readonly workflow: string; readonly current_state: string }[];
  readonly active_frame?: number;
  readonly started_at: string;
  readonly updated_at: string;
  readonly history: readonly {
    readonly frame: number;
    readonly at: string;
    readonly from?: string;
    readonly to?: string;
    readonly via?: string;
    readonly event?: string;
    readonly detail?: string;
    readonly workflow?: string;
    readonly exit_code?: number;
    readonly duration_ms?: number;
  }[];
  readonly context: Record<string, unknown>;
  readonly outcome?: string;
  readonly agent_id?: string;
  readonly agent_step?: unknown;
}

/**
 * The events a session file stands for: its start, its recorded moves, its agent and its end. The log
 * starts empty after a server restart, so the map folds these first and the logged events over them
 * (`fold` counts a move seen in both once).
 */
export function seedEvents(sessions: readonly SeedSession[]): WfEvent[] {
  const out: WfEvent[] = [];
  const add = (
    kind: EventKind,
    session: string,
    ts: string,
    data: Record<string, unknown>,
  ): void => {
    out.push({ seq: 0, run: "seed", ts, kind, session, data });
  };
  for (const s of sessions) {
    const ctx = s.context ?? {};
    const root =
      s.stack[0]?.workflow ??
      s.history.find(h => h.event === "start" && h.workflow !== undefined)?.workflow;
    add("session_start", s.session_id, s.started_at, {
      workflow: root ?? null,
      parent: s.parent_session_id ?? null,
      task: ctx.task ?? ctx.slice ?? ctx.task_id ?? null,
      difficulty: ctx.difficulty ?? null,
    });
    const frames: (string | undefined)[] = [root];
    for (const h of s.history) {
      if (h.event === "start" && h.workflow !== undefined) frames[h.frame] = h.workflow;
      if (h.event === "action")
        add("exec_end", s.session_id, h.at, {
          state: h.from ?? null,
          exit_code: h.exit_code ?? null,
          duration_ms: h.duration_ms ?? null,
        });
      if (h.from === undefined || h.to === undefined) continue;
      add("transition", s.session_id, h.at, {
        from: h.from,
        to: h.to,
        name: h.via ?? h.event ?? null,
        workflow: s.stack[h.frame]?.workflow ?? frames[h.frame] ?? root ?? null,
      });
    }
    if (s.agent_id)
      add("agent_link", s.session_id, s.started_at, {
        agent: s.agent_id,
        role: root ?? "",
        model: ctx.model ?? null,
        effort: ctx.effort ?? null,
        step: s.agent_step ?? null,
      });
    // a driver's open question to the parent (`ask_parent`)
    const asking = openAsk(s);
    const here = s.stack[Math.min(s.active_frame ?? 0, s.stack.length - 1)];
    if (asking && here)
      add("ask", s.session_id, asking.at, { state: here.current_state, text: asking.text });
    if (s.stack.length === 0)
      add("session_end", s.session_id, s.updated_at, { outcome: s.outcome ?? "completed" });
  }
  return out;
}
