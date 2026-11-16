// The recorded replay of the live map: a window of REAL sessions of one open-source project, cut from the
// event log (`buildReplay`, run by scripts/export-replay.mjs) and played back on the documentation site's
// landing page (`expandReplay` + the clock helpers, used by docs/.vitepress/theme/MapReplay.vue). The page
// feeds the expanded events to the same `fold` and `layout` the dashboard map uses, and the plan pane's
// Snapshot built from them (`snapshotAt`) to the mod's own pane code. Pure (its one import, map-layout.ts, is
// pure and import-free too), so it runs in the browser and under vitest alike.

import type { Land, QueueLine, QueueView, SessionRow, Snapshot } from "../types/index.js";
import type { EventKind, WfEvent } from "./event-fold.js";
import { kindMark, type MapLayout, type MapWorkflow } from "./map-layout.js";

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

/**
 * The part of the map a frame of `frameW` x `frameH` shows, in map units: the map's whole width (never wider
 * than drawn 1:1, so a narrow map is not blown up) and the height that keeps the frame's proportions. Drawn as
 * the SVG's viewBox, the map is scaled down to the frame and never scrolls.
 */
export function fitView(
  mapW: number,
  mapH: number,
  frameW: number,
  frameH: number,
): { width: number; height: number } {
  const width = Math.max(mapW, frameW, 1);
  return { width, height: (width * Math.max(frameH, 1)) / Math.max(frameW, 1) };
}

/**
 * Where the camera's top sits when the map is taller than the view: on the running lanes (centred when they fit,
 * their newest end when they do not), on the bottom when nothing runs; 0 when the map fits. Kept inside the map.
 */
export function cameraTop(map: MapLayout, viewH: number): number {
  const room = map.height - viewH;
  if (room <= 0) return 0;
  let a = Infinity;
  let b = -Infinity;
  for (const band of map.bands)
    for (const lane of band.lanes) {
      if (lane.status !== "running") continue;
      a = Math.min(a, band.y + lane.y);
      b = Math.max(b, band.y + lane.y + lane.height);
    }
  if (a === Infinity) return room;
  const want = b - a <= viewH ? (a + b) / 2 - viewH / 2 : b - viewH;
  return Math.max(0, Math.min(room, want));
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

/** One session of the replay as the events up to a moment leave it. */
interface Seen {
  readonly index: number;
  readonly id: string;
  readonly parent: string;
  readonly task: string;
  workflow: string;
  difficulty: string;
  state: string;
  since: number;
  start: number;
  end: number | undefined;
  outcome: unknown;
  landed: boolean;
  agent: string;
  model: string;
  execs: number;
  visits: Map<string, number>;
  moves: { from: string; to: string; at: number }[];
}

/** Every session of the replay as of `at` ms (started or not), in file order; times are epoch ms. */
function sessionsAt(file: ReplayFile, at: number): Seen[] {
  const t0 = Date.parse(file.start);
  const byIndex = new Map<number, Seen>();
  const ids = new Set(file.sessions);
  for (const [ts, kind, s, data] of file.events) {
    if (kind !== "session_start") continue;
    const workflow = typeof data?.workflow === "string" ? data.workflow : "";
    const parent = typeof data?.parent === "string" && ids.has(data.parent) ? data.parent : "";
    const first = file.workflows[workflow]?.stations?.[0]?.name ?? "";
    byIndex.set(s, {
      index: s,
      id: file.sessions[s],
      parent,
      task: parent === "" && typeof data?.task === "string" ? data.task : "",
      workflow,
      difficulty: typeof data?.difficulty === "string" ? data.difficulty : "",
      state: first,
      since: t0 + ts,
      start: ts,
      end: undefined,
      outcome: undefined,
      landed: false,
      agent: "",
      model: "",
      execs: 0,
      visits: new Map(first === "" ? [] : [[first, 1]]),
      moves: [],
    });
  }
  for (const [ts, kind, s, data] of file.events) {
    if (ts > at) break;
    const r = byIndex.get(s);
    if (r === undefined) continue;
    if (kind === "transition" && typeof data?.to === "string") {
      r.moves.push({
        from: typeof data.from === "string" ? data.from : r.state,
        to: data.to,
        at: t0 + ts,
      });
      r.state = data.to;
      r.since = t0 + ts;
      r.visits.set(data.to, (r.visits.get(data.to) ?? 0) + 1);
      if (typeof data.workflow === "string" && data.workflow !== "") r.workflow = data.workflow;
      if (data.to === "land") r.landed = true;
    } else if (kind === "agent_link" || kind === "agent_respawn") {
      if (typeof data?.agent === "string") r.agent = data.agent;
      if (typeof data?.model === "string") r.model = data.model;
    } else if (kind === "agent_stop") r.agent = "";
    else if (kind === "rescore" && (typeof data?.to === "string" || typeof data?.to === "number"))
      r.difficulty = String(data.to);
    else if (kind === "exec_start") r.execs++;
    else if (kind === "exec_end") r.execs = Math.max(0, r.execs - 1);
    else if (kind === "session_end") {
      r.end = ts;
      r.outcome = data?.outcome;
    }
  }
  return [...byIndex.values()];
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const dayMonth = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
};
const hourMinute = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** The most pipelines the replay runs at once: the queue's window as the pane's `Running n/window` shows it. */
function windowOf(file: ReplayFile): number {
  const all = sessionsAt(file, file.durationMs).filter(r => r.task !== "");
  const edges = all.flatMap(r => [[r.start, 1] as const, [r.end ?? file.durationMs, -1] as const]);
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0;
  let peak = 0;
  for (const [, d] of edges) {
    open += d;
    peak = Math.max(peak, open);
  }
  return Math.max(1, peak);
}

const windows = new WeakMap<ReplayFile, number>();

/**
 * The plan pane's Snapshot at `at` ms into the replay, as the mod builds it from the engine's state files and
 * queue (hooks/plan-pane.tsx): the live sessions, the queue (a root session with a task is a queue line: Next
 * before it starts, Running until it ends, then done — Landed when it moved through `land` — or failed when it
 * did not complete) and the lands, newest first. The replay carries no cost and no commit, so no `usd` and no
 * `sha`. Pure; the site's scene draws it with the mod's own pane code (hooks/pane-view.ts).
 */
export function snapshotAt(file: ReplayFile, at: number): Snapshot {
  const t0 = Date.parse(file.start);
  const now = t0 + at;
  const all = sessionsAt(file, at);
  const live = all.filter(r => r.start <= at && r.end === undefined);
  const lines = all.filter(r => r.task !== "");
  const line = (r: Seen, status: QueueLine["status"]): QueueLine => ({
    id: r.task,
    status,
    difficulty: r.difficulty,
    isParked: false,
    isExclusive: false,
    isParentRun: false,
    after: [],
  });
  const running = lines
    .filter(r => r.start <= at && r.end === undefined)
    .sort((a, b) => a.start - b.start);
  const ready = lines.filter(r => r.start > at).sort((a, b) => a.start - b.start);
  const ended = lines.filter(r => r.end !== undefined).sort((a, b) => (b.end ?? 0) - (a.end ?? 0));
  const failed = ended.filter(r => r.outcome !== "completed");
  const landed = ended.filter(r => r.outcome === "completed" && r.landed);
  const marks: Record<string, string> = {};
  for (const r of lines)
    marks[r.task] = kindMark(
      Object.hasOwn(file.taskKinds, r.task) ? { kind: file.taskKinds[r.task] } : {},
    );
  let window = windows.get(file);
  if (window === undefined) {
    window = windowOf(file);
    windows.set(file, window);
  }
  const lands: Land[] = landed.map(r => {
    const end = t0 + (r.end as number);
    const start = t0 + r.start;
    return {
      sha: "",
      slice: r.task,
      at: `${dayMonth(end)} ${hourMinute(end)}`,
      start:
        dayMonth(start) === dayMonth(end)
          ? hourMinute(start)
          : `${dayMonth(start)} ${hourMinute(start)}`,
      difficulty: r.difficulty,
    };
  });
  const sessions: SessionRow[] = live.map(r => ({
    id: r.id,
    parent: r.parent,
    workflow: r.workflow,
    state: r.state,
    tag: r.task,
    since: r.since,
    isWorking: r.agent !== "" || r.execs > 0,
    agent: r.agent,
    visit: r.visits.get(r.state) ?? 0,
    recent: r.moves.slice(-6),
    next: [],
  }));
  const queue: QueueView = {
    file: REPLAY_QUEUE,
    window,
    done: ended.length - failed.length,
    failed: failed.length,
    pending: ready.length,
    running: running.map(r => line(r, "running")),
    ready: ready.map(r => line(r, "pending")),
    unblocked: [],
    waiting: [],
    failedLines: failed.map(r => {
      const d = new Date(t0 + (r.end as number));
      return {
        id: r.task,
        difficulty: r.difficulty,
        date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
        reason: `ended at ${r.state}`,
        recent: true,
      };
    }),
    marks,
  };
  return {
    at: now,
    sessions,
    queue,
    lands,
    recent: landed.filter(r => at - (r.end as number) <= 24 * 3600_000).length,
    days: {},
    error: "",
  };
}

/** One line of the parent conversation, as the mod draws it (hooks/pane-view.ts's line builders). */
export type ConversationLine =
  | {
      readonly at: number;
      readonly kind: "spawn";
      readonly label: string;
      readonly role: string;
      readonly model: string;
    }
  | {
      readonly at: number;
      readonly kind: "move";
      readonly label: string;
      readonly name: string;
      readonly to: string;
    }
  | { readonly at: number; readonly kind: "needs"; readonly label: string; readonly reason: string }
  | { readonly at: number; readonly kind: "landed"; readonly label: string }
  | {
      readonly at: number;
      readonly kind: "ended";
      readonly label: string;
      readonly duration: number;
      readonly state: string;
      readonly failed: boolean;
    };

/**
 * The parent conversation's lines up to `at` ms, oldest first: it starts each pipeline (a `start` move), sees its
 * driver spawned (the model), gets a driver's question (an ask: needs the parent) and answers it (a move), and
 * reads the hand-back of a land or the end of a pipeline that did not land. Only what the replay recorded: no
 * user text, no other session's data. Pure.
 */
export function conversationAt(file: ReplayFile, at: number): ConversationLine[] {
  const out: ConversationLine[] = [];
  const roots = new Map<number, { task: string; start: number; state: string; landed: boolean }>();
  const ids = new Set(file.sessions);
  for (const [ts, kind, s, data] of file.events) {
    if (ts > at) break;
    if (kind === "session_start") {
      const isRoot = !(typeof data?.parent === "string" && ids.has(data.parent));
      if (!isRoot || typeof data?.task !== "string") continue;
      const workflow = typeof data.workflow === "string" ? data.workflow : "";
      const first = file.workflows[workflow]?.stations?.[0]?.name ?? "";
      roots.set(s, { task: data.task, start: ts, state: first, landed: false });
      out.push({
        at: ts,
        kind: "move",
        label: data.task,
        name: `start ${workflow}`,
        to: first === "" ? "?" : first,
      });
      continue;
    }
    const r = roots.get(s);
    if (r === undefined) continue;
    if (kind === "transition" && typeof data?.to === "string") {
      r.state = data.to;
      if (data.to === "land") r.landed = true;
    } else if (kind === "agent_link" && typeof data?.model === "string")
      out.push({ at: ts, kind: "spawn", label: r.task, role: "driver", model: data.model });
    else if (kind === "ask" && typeof data?.state === "string")
      out.push({ at: ts, kind: "needs", label: r.task, reason: data.state });
    else if (kind === "answer" && typeof data?.to === "string")
      out.push({ at: ts, kind: "move", label: r.task, name: "answer", to: data.to });
    else if (kind === "session_end")
      out.push(
        r.landed && data?.outcome === "completed"
          ? { at: ts, kind: "landed", label: r.task }
          : {
              at: ts,
              kind: "ended",
              label: r.task,
              duration: ts - r.start,
              state: r.state,
              failed: data?.outcome !== "completed",
            },
      );
  }
  return out;
}

/**
 * The last `n` lines of `conversationAt(file, at)`, each keyed by its index in the whole conversation. The list
 * only grows as `at` advances, so a line keeps its key while it scrolls; two events of one millisecond (a
 * session's paired answers) still get two keys, which a key built from the line's own fields would not.
 */
export function conversationTail(
  file: ReplayFile,
  at: number,
  n: number,
): { readonly key: number; readonly line: ConversationLine }[] {
  const all = conversationAt(file, at);
  const from = Math.max(0, all.length - n);
  return all.slice(from).map((line, i) => ({ key: from + i, line }));
}
