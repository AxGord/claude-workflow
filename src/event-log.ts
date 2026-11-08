// The engine's event log: an append-only, global-sequence record of what sessions do, for the
// dashboard's live map. Events are DERIVED from session writes (`observe(prev, next)` — the history
// lines the write added, agent link changes, difficulty and exec changes), so every writer is covered
// at the one place all of them pass. One log per server run: a file `events/run-<stamp>-<pid>.jsonl`
// under the state dir (older runs' files are pruned, never one whose server pid lives), plus a bounded in-memory tail for readers.
// `fold` (src/event-fold.ts) rebuilds a per-session picture from events. No module state.

import fs from "node:fs";
import path from "node:path";
import { stagesRead } from "./model-table.js";
import { isPidAlive } from "./process.js";
import type { HistoryEntry, SessionState } from "./types.js";
import { openAsk } from "./event-fold.js";
import { projectNameOf } from "./pool.js";
import type { EventKind, WfEvent } from "./event-fold.js";

export { ASK_KEY, fold, openAsk, seedEvents } from "./event-fold.js";
export type { EventKind, FoldedSession, WfEvent } from "./event-fold.js";

export const MEMORY_TAIL = 5000;
export const KEEP_RUN_FILES = 20;
const EVENTS_DIR = "events";

/** Whether a state is tagged `ask: parent` — the question/answer states. */
/** A state's definition as the session sees it (undefined when gone). */
export type StateResolver = (session: SessionState, workflow: string, state: string) => unknown;

type Listener = (e: WfEvent) => void;

export class EventLog {
  public readonly run: string;
  private readonly _file: string | null;
  private readonly _tail: WfEvent[] = [];
  private readonly _listeners = new Set<Listener>();
  private _seq = 0;
  private _state: StateResolver = () => undefined;
  private _parent: SessionState | null = null;

  /** `stateDir` absent = memory only. */
  constructor(stateDir?: string) {
    this.run = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
    this._file = stateDir ? path.join(stateDir, EVENTS_DIR, `run-${this.run}.jsonl`) : null;
    if (stateDir) pruneRuns(path.join(stateDir, EVENTS_DIR), KEEP_RUN_FILES - 1, isPidAlive);
  }

  /**
   * A reader's resume point as a seq of THIS run: `<run>:<seq>` of another run (a server restart) or
   * anything unreadable is 0 — everything; a bare `<seq>` is taken for this run's.
   */
  public resumeFrom(v: unknown): number {
    const raw = String(Array.isArray(v) ? v[0] : (v ?? "")).trim();
    const m = /^(?:(.+):)?(\d+)$/.exec(raw);
    if (!m || (m[1] !== undefined && m[1] !== this.run)) return 0;
    const n = Number(m[2]);
    return n > this._seq ? 0 : n; // a position this run never reached is another run's
  }

  public setStateResolver(r: StateResolver): void {
    this._state = r;
  }

  private _isAsk(session: SessionState, workflow: string, state: string): boolean {
    return (
      (this._state(session, workflow, state) as { ask?: string } | undefined)?.ask === "parent"
    );
  }

  public subscribe(l: Listener): () => void {
    this._listeners.add(l);
    return () => this._listeners.delete(l);
  }

  /** Events after `since` (0 = all), oldest first; older than the memory tail are read from the run's file. */
  public since(since: number): WfEvent[] {
    const first = this._tail[0]?.seq ?? this._seq + 1;
    if (since + 1 >= first) return this._tail.filter(e => e.seq > since);
    return this._readFile().filter(e => e.seq > since);
  }

  public append(
    kind: EventKind,
    session: string,
    data: Record<string, unknown>,
    ts?: string,
  ): WfEvent {
    const e: WfEvent = {
      seq: ++this._seq,
      run: this.run,
      ts: ts ?? new Date().toISOString(),
      kind,
      session,
      data,
    };
    this._tail.push(e);
    if (this._tail.length > MEMORY_TAIL) this._tail.splice(0, this._tail.length - MEMORY_TAIL);
    if (this._file) {
      try {
        fs.mkdirSync(path.dirname(this._file), { recursive: true });
        fs.appendFileSync(this._file, JSON.stringify(e) + "\n");
      } catch (err) {
        console.error("Event log append failed:", (err as Error).message);
      }
    }
    for (const l of this._listeners) {
      try {
        l(e);
      } catch {
        /* a listener's failure never reaches the writer */
      }
    }
    return e;
  }

  private _readFile(): WfEvent[] {
    if (!this._file || !fs.existsSync(this._file)) return [];
    return fs
      .readFileSync(this._file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(l => JSON.parse(l) as WfEvent);
  }

  /** Record what the write of `next` over `prev` (null = a new session) changed. Never throws. */
  public observe(
    prev: SessionState | null,
    next: SessionState,
    parent?: SessionState | null,
  ): void {
    try {
      this._parent = parent ?? null;
      this._observe(prev, next);
    } catch (err) {
      console.error("Event log observe failed:", (err as Error).message);
    }
  }

  private _observe(prev: SessionState | null, next: SessionState): void {
    const id = next.session_id;
    if (!id) return;
    const ctx = next.context ?? {};
    if (!prev) {
      this.append(
        "session_start",
        id,
        {
          workflow: next.stack[0]?.workflow,
          parent: next.parent_session_id ?? null,
          task: ctx.task ?? ctx.slice ?? ctx.task_id ?? null,
          difficulty: ctx.difficulty ?? null,
          project: ctx.project ?? projectNameOf(ctx.cwd),
        },
        next.started_at,
      );
    }
    const before = prev?.history.length ?? 0;
    for (const h of next.history.slice(before)) this._history(prev, next, h);

    if (
      prev &&
      JSON.stringify(prev.context.difficulty ?? null) !== JSON.stringify(ctx.difficulty ?? null)
    ) {
      this.append("rescore", id, {
        from: prev.context.difficulty ?? null,
        to: ctx.difficulty ?? null,
      });
    }
    const was = openExec(prev);
    const now = openExec(next);
    if (!was && now) this.append("exec_start", id, { state: now.state }, now.at);
    if (was && !now && !next.history.slice(before).some(h => h.event === "action")) {
      // the run ended without a routed result (unroutable, cleared): close the pair
      this.append("exec_end", id, { state: was.state, exit_code: null, aborted: true });
    }
    this._parentAsk(prev, next, before);
    if (next.agent_id && (prev?.agent_id !== next.agent_id || sameStep(prev, next) === false)) {
      this._link(prev, next);
    }
    if (prev && prev.stack.length > 0 && next.stack.length === 0) {
      if (next.agent_id && next.outcome === "abandoned") {
        this.append("agent_stop", id, { agent: next.agent_id, role: roleOf(next) });
      }
      this.append("session_end", id, { outcome: next.outcome ?? "completed" }, next.updated_at);
    }
  }

  /**
   * A driver's open `ask_parent` (see `openAsk`): its appearance is an ask, its end — cleared by the
   * driver, or the session's next move or end, e.g. the parent's own `transition` — the answer.
   */
  private _parentAsk(prev: SessionState | null, next: SessionState, before: number): void {
    const was = prev ? openAsk(prev) : null;
    const now = openAsk(next);
    // the same question written again while it is open stays one question
    if (was?.text === now?.text) return;
    const id = next.session_id;
    if (was !== null && prev) {
      const last = next.history
        .slice(before)
        .filter(h => h.from !== undefined && h.to !== undefined)
        .at(-1);
      const to = last?.to ?? (next.stack.length === 0 ? (next.outcome ?? "ended") : stateOf(next));
      this.append("answer", id, { state: stateOf(prev), to }, last?.at ?? next.updated_at);
    }
    if (now !== null) this.append("ask", id, { state: stateOf(next), text: now.text }, now.at);
  }

  private _link(prev: SessionState | null, next: SessionState): void {
    const parent = next.parent_session_id;
    const base = {
      agent: next.agent_id,
      role: roleOf(next),
      ...this._modelInForce(next),
      step: next.agent_step ?? null,
      parent: parent ?? null,
    };
    // a second link for the same role: a different agent id replacing a recorded one
    if (prev?.agent_id && prev.agent_id !== next.agent_id) {
      this.append("agent_respawn", next.session_id, { ...base, previous: prev.agent_id });
    } else {
      this.append("agent_link", next.session_id, base);
    }
  }

  /** The model and effort the agent runs on: the parent's stage row of the step it was linked at, else the session's own. */
  private _modelInForce(next: SessionState): { model: unknown; effort: unknown } {
    const step = next.agent_step;
    const parent = this._parent;
    if (step && parent) {
      // the stage(s) the parent's state at the linked step reads, not the state's own name
      const def = this._state(parent, step.workflow, step.state);
      for (const stage of stagesRead(def)) {
        const model = parent.context[`model_${stage}`];
        const effort = parent.context[`effort_${stage}`];
        if (model !== undefined || effort !== undefined)
          return { model: model ?? null, effort: effort ?? null };
      }
    }
    return { model: next.context.model ?? null, effort: next.context.effort ?? null };
  }

  private _history(prev: SessionState | null, next: SessionState, h: HistoryEntry): void {
    const id = next.session_id;
    if (h.event === "action") {
      this.append(
        "exec_end",
        id,
        {
          state: h.from ?? null,
          exit_code: h.exit_code ?? null,
          duration_ms: h.duration_ms ?? null,
          wait_ms: h.wait_ms ?? null,
          shards: h.shards ?? null,
        },
        h.at,
      );
    }
    if (h.from === undefined || h.to === undefined) return;
    const workflow =
      next.stack[h.frame]?.workflow ??
      next.stack[0]?.workflow ??
      prev?.stack[h.frame]?.workflow ??
      "";
    this.append(
      "transition",
      id,
      { from: h.from, to: h.to, name: h.via ?? h.event ?? null, workflow },
      h.at,
    );
    const src = prev ?? next;
    if (this._isAsk(src, workflow, h.from))
      this.append("answer", id, { state: h.from, to: h.to }, h.at);
    if (this._isAsk(src, workflow, h.to)) {
      this.append("ask", id, { state: h.to }, h.at);
    }
  }
}

/** The state of the session's active frame ("" once it has ended). */
function stateOf(s: SessionState): string {
  return s.stack[Math.min(s.active_frame, s.stack.length - 1)]?.current_state ?? "";
}

/** A running exec of the session: a recorded detached run, or a fanout / leased run past its first lease. */
function openExec(s: SessionState | null): { state: string; at: string } | null {
  if (s?.running_exec) return { state: s.running_exec.state, at: s.running_exec.started_at };
  const p = s?.pending_action;
  return p?.run_at ? { state: p.state, at: p.run_at } : null;
}

function roleOf(s: SessionState): string {
  return s.stack[0]?.workflow ?? "";
}

function sameStep(prev: SessionState | null, next: SessionState): boolean {
  return JSON.stringify(prev?.agent_step ?? null) === JSON.stringify(next.agent_step ?? null);
}

/** Keep the `keep` newest run files; delete the rest. */
export function pruneRuns(
  dir: string,
  keep: number,
  alive: (pid: number) => boolean = () => false,
): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter(f => f.startsWith("run-") && f.endsWith(".jsonl"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      const pid = Number(/-(\d+)\.jsonl$/.exec(f)?.[1]);
      if (pid > 0 && alive(pid)) continue; // a live server is still writing it
      fs.rmSync(path.join(dir, f));
    }
  } catch {
    /* no directory yet */
  }
}
