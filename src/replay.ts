// The recorded replay of the live map: a window of REAL sessions of one open-source project, cut from the
// event log (`buildReplay`, run by scripts/export-replay.mjs) and played back on the documentation site's
// landing page (`expandReplay` + the clock helpers, used by docs/.vitepress/theme/MapReplay.vue). The page
// feeds the expanded events to the same `fold` and `layout` the dashboard map uses. Pure and import-free
// (types only), so it runs in the browser and under vitest alike.

import type { EventKind, WfEvent } from "./event-fold.js";
import type { MapWorkflow } from "./map-layout.js";

/** One event: ms after `ReplayFile.start`, its kind, the index of its session in `ReplayFile.sessions`, its data. */
export type ReplayRow = readonly [number, EventKind, number, Readonly<Record<string, unknown>>?];

export interface ReplayFile {
  readonly version: 1;
  /** the one project the replay draws; no other project's session, path or id is in the file */
  readonly project: string;
  /** ISO time of offset 0 */
  readonly start: string;
  readonly durationMs: number;
  /** session ids; a row names its session by index */
  readonly sessions: readonly string[];
  /** the map's per-workflow data (`/api/workflows`: stations, driver, map) for the workflows of the sessions */
  readonly workflows: Readonly<Record<string, MapWorkflow>>;
  /** queue line kind by task id, for the lanes' marks */
  readonly taskKinds: Readonly<Record<string, string>>;
  readonly events: readonly ReplayRow[];
}

/** The speeds the player offers, in times real time. */
export const SPEEDS: readonly number[] = [1, 2, 5, 10, 30, 60];
export const DEFAULT_SPEED = 30;

/** The queue every exported session names: the real path (a home directory) never leaves the log. */
export const REPLAY_QUEUE = "/anyparse/.claude/batch/queue.yaml";

const KEEP: Readonly<Record<EventKind, readonly string[]>> = {
  session_start: ["workflow", "parent", "task", "difficulty", "project", "queue"],
  session_end: ["outcome"],
  transition: ["from", "to", "name", "workflow"],
  exec_start: ["state"],
  exec_end: ["state", "exit_code", "duration_ms"],
  agent_link: ["agent", "role", "model", "effort", "step"],
  agent_respawn: ["agent", "role", "model", "effort", "step"],
  agent_stop: [],
  rescore: ["from", "to"],
  queue: ["to"],
  // an ask's text is a free-form question: it stays in the log
  ask: ["state"],
  answer: ["state", "to"],
};

const STEP_KEYS = ["workflow", "state", "visit"] as const;

const present = (v: unknown): boolean => v !== null && v !== undefined && v !== "";

function scrubStep(step: unknown): unknown {
  if (typeof step !== "object" || step === null) return undefined;
  const from = step as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of STEP_KEYS) if (present(from[k])) out[k] = from[k];
  return out;
}

/** An event's data cut to the keys the map reads, the queue path rewritten, nothing null kept. */
function scrubData(e: WfEvent, keptSessions: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEEP[e.kind]) {
    let v = e.data[k];
    if (k === "step") v = scrubStep(v);
    else if (k === "queue" || (e.kind === "queue" && k === "to"))
      v = typeof v === "string" && v.endsWith(REPLAY_QUEUE) ? REPLAY_QUEUE : undefined;
    else if (k === "parent") v = typeof v === "string" && keptSessions.has(v) ? v : undefined;
    if (present(v)) out[k] = v;
  }
  return out;
}

interface Tree {
  readonly id: string;
  readonly start: number;
  readonly end: number | undefined;
  readonly outcome: unknown;
  readonly parent: string | null;
  readonly workflow: string | undefined;
  readonly task: unknown;
  readonly project: unknown;
  readonly moves: Set<string>;
}

export interface BuildOptions {
  /** the project whose sessions (and their children) are kept */
  readonly project: string;
  readonly workflows: Readonly<Record<string, MapWorkflow>>;
  /** queue line kind by task id; only the tasks of the kept sessions are written */
  readonly taskKinds?: Readonly<Record<string, string>>;
  /** the window starts at this ISO time; else the best window the log has */
  readonly from?: string;
  /** the window's length (default 4) */
  readonly hours?: number;
  /** the size limit, in bytes, of the text `renderReplay` writes (default 300000) */
  readonly maxBytes?: number;
}

const ms = (ts: string): number => Date.parse(ts);

/** What a window shows: the more of these, the better a replay it is. */
interface Showing {
  landed: number;
  splits: number;
  rounds: number;
  peak: number;
}

function showing(roots: readonly Tree[], kids: ReadonlyMap<string, Tree[]>): Showing {
  let landed = 0;
  let splits = 0;
  let rounds = 0;
  for (const r of roots) {
    if (r.outcome === "completed" && r.moves.has("land")) landed++;
    if (r.moves.has("mark_split")) splits++;
    if ((kids.get(r.id) ?? []).filter(k => k.workflow === "slice-review").length >= 2) rounds++;
  }
  const edges: (readonly [number, number])[] = roots.flatMap(r => [
    [r.start, 1] as const,
    [r.end ?? r.start, -1] as const,
  ]);
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0;
  let peak = 0;
  for (const [, d] of edges) {
    open += d;
    peak = Math.max(peak, open);
  }
  return { landed, splits, rounds, peak };
}

const score = (s: Showing): number =>
  (s.landed > 0 ? 100 : 0) +
  (s.splits > 0 ? 100 : 0) +
  (s.rounds > 0 ? 100 : 0) +
  Math.min(s.peak, 5) * 20 +
  Math.min(s.landed, 8) * 3;

/**
 * The replay of one project from a recorded event log. Sessions of `project` count, and the children of a
 * session that counts; every other session is dropped with its ids, paths and text. A window keeps whole
 * pipelines only: a root session that started inside it and ended inside it, with its children.
 * Throws when no window holds a session.
 */
export function buildReplay(events: readonly WfEvent[], opts: BuildOptions): ReplayFile {
  const hours = opts.hours ?? 4;
  const maxBytes = opts.maxBytes ?? 300_000;
  const sorted = [...events].sort((a, b) => ms(a.ts) - ms(b.ts));
  const trees = new Map<string, Tree>();
  for (const e of sorted) {
    if (e.kind !== "session_start") continue;
    const parent = typeof e.data.parent === "string" ? e.data.parent : null;
    const parentTree = parent === null ? undefined : trees.get(parent);
    const mine = e.data.project === opts.project;
    if (!mine && parentTree === undefined) continue;
    trees.set(e.session, {
      id: e.session,
      start: ms(e.ts),
      end: undefined,
      outcome: undefined,
      parent: parentTree === undefined ? null : parent,
      workflow: typeof e.data.workflow === "string" ? e.data.workflow : undefined,
      task: e.data.task,
      project: e.data.project,
      moves: new Set(),
    });
  }
  const ends = new Map<string, { at: number; outcome: unknown }>();
  for (const e of sorted) {
    const t = trees.get(e.session);
    if (t === undefined) continue;
    if (e.kind === "transition" && typeof e.data.to === "string") t.moves.add(e.data.to);
    if (e.kind === "session_end") ends.set(e.session, { at: ms(e.ts), outcome: e.data.outcome });
  }
  const all: Tree[] = [...trees.values()].map(t => ({
    ...t,
    end: ends.get(t.id)?.at,
    outcome: ends.get(t.id)?.outcome,
  }));
  const byId = new Map(all.map(t => [t.id, t]));
  const kids = new Map<string, Tree[]>();
  for (const t of all) {
    if (t.parent === null) continue;
    kids.set(t.parent, [...(kids.get(t.parent) ?? []), t]);
  }
  const rootOf = (t: Tree): Tree => {
    let c = t;
    for (let p = byId.get(c.parent ?? ""); p !== undefined; p = byId.get(c.parent ?? "")) c = p;
    return c;
  };
  const roots = all.filter(t => t.parent === null && t.end !== undefined);
  // a root that has children is a pipeline; a conversation of the project with none is left off
  const pipelines = roots.filter(r => (kids.get(r.id) ?? []).length > 0);

  const build = (from: number, to: number): ReplayFile | null => {
    const inside = pipelines.filter(r => r.start >= from && (r.end as number) <= to);
    if (inside.length === 0) return null;
    const keep = new Set(all.filter(t => inside.includes(rootOf(t))).map(t => t.id));
    const rows = sorted.filter(e => keep.has(e.session));
    const first = ms(rows[0].ts);
    const last = ms((rows.at(-1) as WfEvent).ts);
    const ids = [...keep];
    const index = new Map(ids.map((id, i) => [id, i]));
    const tasks = new Set<string>();
    for (const id of ids) {
      const task = byId.get(id)?.task;
      if (typeof task === "string") tasks.add(task);
    }
    const taskKinds: Record<string, string> = {};
    for (const t of [...tasks].sort()) {
      const k = opts.taskKinds?.[t];
      if (k !== undefined) taskKinds[t] = k;
    }
    const names = new Set<string>();
    for (const id of ids) {
      const w = byId.get(id)?.workflow;
      if (w !== undefined) names.add(w);
    }
    const workflows: Record<string, MapWorkflow> = {};
    for (const n of [...names].sort()) {
      const w = opts.workflows[n];
      if (w !== undefined) workflows[n] = w;
    }
    return {
      version: 1,
      project: opts.project,
      start: new Date(first).toISOString(),
      durationMs: last - first,
      sessions: ids,
      workflows,
      taskKinds,
      events: rows.map(e => {
        const data = scrubData(e, keep);
        const base = [ms(e.ts) - first, e.kind, index.get(e.session) as number] as const;
        return Object.keys(data).length === 0 ? base : ([...base, data] as const);
      }),
    };
  };
  const size = (f: ReplayFile): number => new TextEncoder().encode(renderReplay(f)).length;

  if (opts.from !== undefined) {
    const from = Date.parse(opts.from);
    const file = build(from, from + hours * 3600_000);
    if (file === null) throw new Error(`no finished session of ${opts.project} in the window`);
    if (size(file) > maxBytes)
      throw new Error(`the window of ${hours} h is ${size(file)} bytes, over ${maxBytes}`);
    return file;
  }
  const windows = pipelines
    .map(r => {
      const from = r.start;
      const to = from + hours * 3600_000;
      const inside = pipelines.filter(p => p.start >= from && (p.end as number) <= to);
      return { from, to, n: score(showing(inside, kids)) };
    })
    .sort((a, b) => b.n - a.n || a.from - b.from);
  for (const w of windows) {
    const file = build(w.from, w.to);
    if (file !== null && size(file) <= maxBytes) return file;
  }
  throw new Error(
    `no window of ${hours} h with a session of ${opts.project} fits ${maxBytes} bytes`,
  );
}

/** The file as written: one header field per line, then one event row per line (a diff of two exports reads). */
export function renderReplay(file: ReplayFile): string {
  const { events, ...head } = file;
  const fields = Object.entries(head).map(
    ([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`,
  );
  const rows = events.map(e => `  ${JSON.stringify(e)}`);
  return `{\n${fields.join(",\n")},\n "events": [\n${rows.join(",\n")}\n ]\n}\n`;
}

/** Whether a scroll position is at the bottom (within `slack` px): a reader who is not has left follow mode. */
export function followsBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  slack = 8,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= slack;
}

/** The events a file stands for, as the log would have them (the fold and the layout read these). */
export function expandReplay(file: ReplayFile): WfEvent[] {
  const t0 = Date.parse(file.start);
  return file.events.map(([at, kind, session, data], i) => ({
    seq: i + 1,
    run: "replay",
    ts: new Date(t0 + at).toISOString(),
    kind,
    session: file.sessions[session],
    data: data ?? {},
  }));
}

/** How many rows are at or before `at` ms (rows are in time order). */
export function rowsUntil(file: ReplayFile, at: number): number {
  let lo = 0;
  let hi = file.events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (file.events[mid][0] <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface Clock {
  /** ms into the replay */
  readonly at: number;
  readonly ended: boolean;
}

/** The replay clock `dt` ms of real time later at `speed` times real time, held at the end. */
export function advance(at: number, dt: number, speed: number, durationMs: number): Clock {
  const next = at + dt * speed;
  return next >= durationMs
    ? { at: durationMs, ended: true }
    : { at: Math.max(0, next), ended: false };
}

/** A replay position as `h:mm:ss` (the time since the replay began). */
export function elapsed(at: number): string {
  const s = Math.floor(at / 1000);
  const h = Math.floor(s / 3600);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
