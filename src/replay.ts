// The recorded replay of the live map: a window of REAL sessions of one open-source project, cut from the
// event log (`buildReplay`, run by scripts/export-replay.mjs) and played back on the documentation site's
// landing page (`expandReplay` + the clock helpers, used by docs/.vitepress/theme/MapReplay.vue). The page
// feeds the expanded events to the same `fold` and `layout` the dashboard map uses, and the plan pane's
// Snapshot built from them (`snapshotAt`) to the mod's own pane code. Pure (its one import, map-layout.ts, is
// pure and import-free too), so it runs in the browser and under vitest alike.

import type {
  DaySpend,
  Land,
  PoolLine,
  PoolState,
  QueueLine,
  QueueView,
  SessionRow,
  Snapshot,
} from "../types/index.js";
import type { EventKind, WfEvent } from "./event-fold.js";
import { kindMark, type MapLayout, type MapWorkflow } from "./map-layout.js";

/** One event: ms after `ReplayFile.start`, its kind, the index of its session in `ReplayFile.sessions`, its data. */
export type ReplayRow = readonly [number, EventKind, number, Readonly<Record<string, unknown>>?];

export interface ReplayFile {
  readonly version: 1;
  /** the project the replay is of (it names the file and its land lock); no session, path or id of a project outside `projects` is in the file */
  readonly project: string;
  /** every open-source project the replay draws, `project` first (absent: `project` alone, a file from before the engine's own sessions were kept) */
  readonly projects?: readonly string[];
  /** ISO time of offset 0 */
  readonly start: string;
  readonly durationMs: number;
  /** session ids; a row names its session by index */
  readonly sessions: readonly string[];
  /** the map's per-workflow data (`/api/workflows`: stations, driver, map) for the workflows of the sessions */
  readonly workflows: Readonly<Record<string, MapWorkflow>>;
  /** queue line kind by task id, for the lanes' marks */
  readonly taskKinds: Readonly<Record<string, string>>;
  /**
   * the ledger's real `spend.usd` per task id, summed over every run of the line, for the tasks of the replay only; a
   * task with no measured spend (a run that recorded none, or no ledger row) is absent and the pane draws `—`
   */
  readonly spend?: Readonly<Record<string, number>>;
  /** the machine's thread pool over the same window, as `pool.log` sampled it; absent when no log covered the window */
  readonly pool?: ReplayPool;
  /** the queue as the engine's own pick saw it at the window's start (absent: a file from before the queue was kept) */
  readonly queue?: ReplayQueue;
  readonly events: readonly ReplayRow[];
}

/** Why a queue line is never admitted whatever ends (`ReplayQueueLine.hold`): the only texts the file may carry there. */
export const QUEUE_HOLDS: readonly string[] = [
  "parked",
  "parent-run (model —)",
  "overlaps a line outside the replay",
];

/** How a line may not run beside another (`ReplayQueueLine.against`), as the pick words it. */
export type QueueAgainst = "overlap" | "hold" | "runs-alone" | "window-not-empty";

/**
 * One pending line of the queue at the window's start, cut to what the pane draws and what clears its wait: the ids and
 * enums of an allowlisted project's lines, never a line's text, notes, paths or free-form reason. `after` and `against`
 * name lines of `ReplayQueue.lines`; the replay clears them as those lines' sessions end.
 */
export interface ReplayQueueLine {
  readonly id: string;
  readonly difficulty: string;
  /** `urgent`, `high`, `low`; `""` normal */
  readonly priority: string;
  readonly kind: string;
  /** one of `QUEUE_HOLDS`: the pick never admits it, whatever ends */
  readonly hold?: string;
  /** the queue lines whose end (landed) its `after:` waits for */
  readonly after?: readonly string[];
  /** the parts of its `after:` no line's end clears: `X (failed)`, `manual condition` */
  readonly fixed?: readonly string[];
  /** the line it may not run beside, and how: the wait ends when that line's session ends */
  readonly against?: readonly [how: QueueAgainst, id: string];
}

/**
 * The queue the replay plays: the pending lines of the engine's own pick, in the order it visits them (priority, then
 * file order), computed with the window ignored over the queue rolled back to the window's start (the lines that ran
 * in the window set back to pending). `note` says what cannot be rebuilt.
 */
export interface ReplayQueue {
  readonly note: string;
  readonly lines: readonly ReplayQueueLine[];
}

/** What a pool-log line names: a lease that was backfilled ahead of the head, one that over-runs its threads, a waiter that starved. */
export type PoolMarkKind = "backfill" | "overrun" | "starved";

/** A lease or waiter the log named by its label (kept only when the label names a session or slice of the replay): kind, threads, label, and the busy cpus an over-running lease's tree ran (0 otherwise). */
export type PoolMark = readonly [kind: PoolMarkKind, threads: number, label: string, runs: number];

/**
 * One load sample of the pool: ms after `ReplayFile.start`, threads held, the budget, the machine load, the load
 * not taken through the pool, how many leases and waiters there were, the waiters' asks (`4-8`, `2 + lock x`,
 * `+3` for the ones the sample did not list: thread counts only, no label), and the marks logged since the sample before.
 */
export type PoolFrame = readonly [
  at: number,
  held: number,
  budget: number,
  load: number,
  external: number,
  leases: number,
  waiting: number,
  asks: readonly string[],
  seen: readonly PoolMark[],
];

export interface ReplayPool {
  /** the load above which the pool counts other work as external (`threshold` of the Pool tab) */
  readonly threshold: number;
  readonly frames: readonly PoolFrame[];
}

/** The speeds the player offers, in times real time. */
export const SPEEDS: readonly number[] = [1, 2, 5, 10, 30, 60];
export const DEFAULT_SPEED = 30;

/** An exec's wait for a pool lease shorter than this is not drawn: a lane that waits is a lane that stands still. */
export const POOL_MIN_WAIT_MS = 3000;

/** The queue every exported session names: the real path (a home directory) never leaves the log. */
export const REPLAY_QUEUE = "/anyparse/.claude/batch/queue.yaml";

const KEEP: Readonly<Record<EventKind, readonly string[]>> = {
  session_start: ["workflow", "parent", "task", "difficulty", "project", "queue"],
  session_end: ["outcome"],
  transition: ["from", "to", "name", "workflow"],
  exec_start: ["state"],
  exec_end: ["state", "exit_code", "duration_ms", "wait_ms"],
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
    if (k === "wait_ms") v = typeof v === "number" && v >= POOL_MIN_WAIT_MS ? v : undefined;
    else if (k === "step") v = scrubStep(v);
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
  /** the project whose sessions (and their children) are kept; it names the file and its land lock */
  readonly project: string;
  /** more open-source projects whose sessions are kept the same way (the engine's own: its tasks run under the same dispatcher) */
  readonly also?: readonly string[];
  /** the ledger's text (`ledger.jsonl`): the tasks of the replay get their `spend.usd` (`ledgerSpend`); absent: no spend */
  readonly ledger?: string;
  readonly workflows: Readonly<Record<string, MapWorkflow>>;
  /** queue line kind by task id; only the tasks of the kept sessions are written */
  readonly taskKinds?: Readonly<Record<string, string>>;
  /** the window starts at this ISO time; else the best window the log has */
  readonly from?: string;
  /** the window's length (default 4) */
  readonly hours?: number;
  /** the size limit, in bytes, of the text `renderReplay` writes (default 300000) */
  readonly maxBytes?: number;
  /**
   * the pool's log (`pool.log`, older file first) and its load threshold: the replay then carries the pool over its
   * window (`buildPool`) and only a window the log covers is chosen
   */
  readonly pool?: { readonly lines: readonly string[]; readonly threshold: number };
  /**
   * the queue at the window's start (`captureReplayQueue`, src/replay-queue.ts): called with the task ids of EVERY root session of
   * the kept projects that started at or after the window's start (the window's own and those that ran after it, which were
   * pending at the start too); undefined writes none
   */
  readonly queue?: (ranSince: ReadonlySet<string>) => ReplayQueue | undefined;
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
  const projects = [opts.project, ...(opts.also ?? []).filter(p => p !== opts.project)];
  const kept = new Set(projects);
  for (const e of sorted) {
    if (e.kind !== "session_start") continue;
    const parent = typeof e.data.parent === "string" ? e.data.parent : null;
    const parentTree = parent === null ? undefined : trees.get(parent);
    const mine = typeof e.data.project === "string" && kept.has(e.data.project);
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
  const poolSpan = opts.pool === undefined ? undefined : poolLogSpan(opts.pool.lines);
  const busy = opts.pool === undefined ? [] : poolWaitingSamples(opts.pool.lines);
  const roots = all.filter(t => t.parent === null && t.end !== undefined);
  // a root that has children is a pipeline, and so is a finished task run that spawned none (an engine-task works alone);
  // a conversation of the project with neither is left off
  const pipelines = roots.filter(
    r =>
      (kids.get(r.id) ?? []).length > 0 ||
      (typeof r.task === "string" && r.workflow !== undefined && TASK_WORKFLOWS.has(r.workflow)),
  );

  const build = (from: number, to: number): ReplayFile | null => {
    const inside = pipelines.filter(r => r.start >= from && (r.end as number) <= to);
    if (inside.length === 0) return null;
    const keep = new Set(all.filter(t => inside.includes(rootOf(t))).map(t => t.id));
    const rows = sorted.filter(e => keep.has(e.session));
    const first = ms(rows[0].ts);
    const last = ms((rows.at(-1) as WfEvent).ts);
    if (poolSpan !== undefined && (first < poolSpan.from || last > poolSpan.to)) return null;
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
    const pool =
      opts.pool === undefined
        ? undefined
        : buildPool(opts.pool.lines, {
            project: opts.project,
            ...(projects.length > 1 ? { also: projects.slice(1) } : {}),
            from: first,
            to: last,
            tasks,
            sessions: new Set(ids),
            threshold: opts.pool.threshold,
          });
    const spend = opts.ledger === undefined ? {} : ledgerSpend(opts.ledger, tasks);
    const ranSince = new Set<string>();
    for (const t of all)
      if (t.parent === null && typeof t.task === "string" && t.start >= first) ranSince.add(t.task);
    const queue = opts.queue?.(ranSince);
    return {
      version: 1,
      project: opts.project,
      ...(projects.length > 1 ? { projects } : {}),
      start: new Date(first).toISOString(),
      durationMs: last - first,
      sessions: ids,
      workflows,
      taskKinds,
      ...(Object.keys(spend).length === 0 ? {} : { spend }),
      ...(pool === undefined ? {} : { pool }),
      ...(queue === undefined ? {} : { queue }),
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
    if (file === null)
      throw new Error(
        poolSpan === undefined
          ? `no finished session of ${opts.project} in the window`
          : `no finished session of ${opts.project} in the window, or the pool log does not cover it`,
      );
    if (size(file) > maxBytes)
      throw new Error(`the window of ${hours} h is ${size(file)} bytes, over ${maxBytes}`);
    return file;
  }
  const windows = pipelines
    .map(r => {
      const from = r.start;
      const to = from + hours * 3600_000;
      const inside = pipelines.filter(p => p.start >= from && (p.end as number) <= to);
      return { from, to, n: score(showing(inside, kids)) + poolBusy(busy, from, to) };
    })
    .sort((a, b) => b.n - a.n || a.from - b.from);
  for (const w of windows) {
    const file = build(w.from, w.to);
    if (file !== null && size(file) <= maxBytes) return file;
  }
  throw new Error(
    `no window of ${hours} h with a session of ${opts.project} fits ${maxBytes} bytes${poolSpan === undefined ? "" : " and lies inside the pool log"}`,
  );
}

/** The workflows whose ledger rows are a task's own run: the plan pane's `TASK_WORKFLOWS` (a review or recon child with the same `task` adds nothing). */
const TASK_WORKFLOWS: ReadonlySet<string> = new Set(["slice-pipeline", "engine-task"]);

/**
 * The real spend of `tasks` from the ledger's text, as the plan pane reads it (`ledgerSpendOf` of hooks/plan-pane.tsx): a
 * row of a task workflow with an end counts, `spend.usd` is summed over every run of the line, and a line any of whose
 * runs recorded none is left out whole (never `$0`). An ALLOWLIST: a row whose `task` is not one of `tasks` is never
 * read into the result, so no other project's task id, name or sum can reach the file. Keys in order, sums to 1e-4 $.
 */
export function ledgerSpend(text: string, tasks: ReadonlySet<string>): Record<string, number> {
  const acc = new Map<string, { usd: number; measured: boolean }>();
  for (const line of text.split("\n")) {
    if (!line.includes('"task"')) continue;
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof j.task !== "string" ||
        !tasks.has(j.task) ||
        typeof j.workflow !== "string" ||
        !TASK_WORKFLOWS.has(j.workflow) ||
        typeof j.ended_at !== "string" ||
        !Number.isFinite(Date.parse(j.ended_at))
      )
        continue;
      const usd = (j.spend as { usd?: unknown } | undefined)?.usd;
      const cur = acc.get(j.task) ?? { usd: 0, measured: true };
      if (typeof usd === "number" && Number.isFinite(usd)) cur.usd += usd;
      else cur.measured = false;
      acc.set(j.task, cur);
    } catch {
      // a torn or foreign line is not a run
    }
  }
  const out: Record<string, number> = {};
  for (const task of [...acc.keys()].sort()) {
    const a = acc.get(task);
    if (a?.measured) out[task] = Math.round(a.usd * 1e4) / 1e4;
  }
  return out;
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
 * queue (hooks/plan-pane.tsx): the live sessions, the queue (a root session with a task is a queue line: pending
 * before it starts, Running until it ends, then done — Landed when it moved through `land` — or failed when it
 * did not complete; the pending ones are the file's `queue` read at the moment, `queueAt`: Next when the pick would admit
 * them, Waiting with its reason while a line it waits for is still going, else the lines that start later) and the lands, newest first. A task the ledger measured (`ReplayFile.spend`) carries its `usd` on
 * its Landed and Failed row and in the day sums (`days`, `landedUsd`) as the live pane's do; one with none stays
 * unmeasured (the pane draws `—`). The replay carries no commit, so no `sha`. Pure; the site's scene draws it with the mod's own pane code (hooks/pane-view.ts).
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
  const pendingNow = queueAt(file, lines, at);
  const ended = lines.filter(r => r.end !== undefined).sort((a, b) => (b.end ?? 0) - (a.end ?? 0));
  const failed = ended.filter(r => r.outcome !== "completed");
  const landed = ended.filter(r => r.outcome === "completed" && r.landed);
  const marks: Record<string, string> = {};
  for (const r of lines)
    marks[r.task] = kindMark(
      Object.hasOwn(file.taskKinds, r.task) ? { kind: file.taskKinds[r.task] } : {},
    );
  for (const q of file.queue?.lines ?? []) marks[q.id] ??= kindMark({ kind: q.kind });
  let window = windows.get(file);
  if (window === undefined) {
    window = windowOf(file);
    windows.set(file, window);
  }
  const usdOf = (task: string): { usd: number } | Record<string, never> => {
    const usd = Object.hasOwn(file.spend ?? {}, task) ? file.spend?.[task] : undefined;
    return typeof usd === "number" ? { usd } : {};
  };
  const lands: Land[] = landed.map(r => {
    const end = t0 + (r.end as number);
    const start = t0 + r.start;
    return {
      ...usdOf(r.task),
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
    pending: pendingNow.pending,
    running: running.map(r => line(r, "running")),
    ready: pendingNow.ready,
    unblocked: pendingNow.unblocked,
    waiting: pendingNow.waiting,
    failedLines: failed.map(r => {
      const d = new Date(t0 + (r.end as number));
      return {
        id: r.task,
        difficulty: r.difficulty,
        ...usdOf(r.task),
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
    days: daySpends(lands, ended, usdOf, t0),
    ...landedSum(lands),
    error: "",
  };
}

/** The pending part of the pane's queue at `at`: what `snapshotAt` fills `ready`, `unblocked`, `waiting` and `pending` with. */
interface PendingView {
  readonly pending: number;
  readonly ready: QueueLine[];
  readonly unblocked: QueueLine[];
  readonly waiting: QueueView["waiting"];
}

const AGAINST_TEXT: Readonly<Record<QueueAgainst, (id: string) => string>> = {
  overlap: id => `overlaps ${id}`,
  hold: id => `held for exclusive ${id}`,
  "runs-alone": id => `breaking ${id} runs alone`,
  "window-not-empty": id => `breaking: window not empty (${id})`,
};

/**
 * The queue's pending lines at `at`, as the live pane's `queueView` splits them. With the file's `queue`: a line that
 * has not started waits for the lines its `after:` names to land (`after`) and for the line it may not run beside to end
 * (`against`); with neither left it is Next, in the pick's visiting order, and the lines whose only wait is a running
 * line are `unblocked` while Next is empty. A line of the replay the queue does not list (a file with no `queue`, or a
 * line archived since) is Next from the start of the window, in the order it starts.
 */
function queueAt(file: ReplayFile, lines: readonly Seen[], at: number): PendingView {
  const run = new Map<string, Seen>();
  for (const r of lines)
    if (!run.has(r.task) || (run.get(r.task) as Seen).start < r.start) run.set(r.task, r);
  const started = (id: string): boolean => (run.get(id)?.start ?? Infinity) <= at;
  const landed = (id: string): boolean =>
    run.get(id)?.end !== undefined && run.get(id)?.outcome === "completed";
  const ended = (id: string): boolean => run.get(id)?.end !== undefined;
  const state = (id: string): string =>
    !started(id) ? "pending" : ended(id) ? (landed(id) ? "done" : "failed") : "running";
  const plain = (r: Seen): QueueLine => ({
    id: r.task,
    status: "pending",
    difficulty: r.difficulty,
    isParked: false,
    isExclusive: false,
    isParentRun: false,
    after: [],
  });
  const listed = new Set((file.queue?.lines ?? []).map(l => l.id));
  const unlisted = lines
    .filter(r => r.start > at && !listed.has(r.task))
    .sort((a, b) => a.start - b.start)
    .map(plain);
  const ready: QueueLine[] = [];
  const waiting: { id: string; why: string; difficulty: string; priority: string }[] = [];
  const unblocked: QueueLine[] = [];
  let pending = unlisted.length;
  for (const q of file.queue?.lines ?? []) {
    if (started(q.id)) continue;
    pending++;
    const row: QueueLine = {
      id: q.id,
      status: "pending",
      difficulty: q.difficulty,
      isParked: q.hold === "parked",
      isExclusive: false,
      isParentRun: q.hold === "parent-run (model —)",
      after: [...(q.after ?? [])],
      priority: q.priority,
    };
    if (q.hold === "parked") continue;
    const left = (q.after ?? []).filter(id => !landed(id));
    const against = q.against !== undefined && !ended(q.against[1]) ? q.against : undefined;
    const parts = [...left.map(id => `${id} (${state(id)})`), ...(q.fixed ?? [])];
    const why =
      q.hold ??
      (parts.length > 0
        ? `after: ${parts.join(", ")}`
        : against === undefined
          ? ""
          : AGAINST_TEXT[against[0]](against[1]));
    if (why === "") {
      ready.push(row);
      continue;
    }
    waiting.push({ id: q.id, why, difficulty: q.difficulty, priority: q.priority });
    const running = (id: string): boolean => started(id) && !ended(id);
    if (
      q.hold === undefined &&
      (q.fixed ?? []).length === 0 &&
      left.every(running) &&
      (against === undefined || running(against[1]))
    )
      unblocked.push(row);
  }
  return {
    pending,
    ready: [...ready, ...unlisted],
    unblocked: ready.length + unlisted.length > 0 ? [] : unblocked,
    waiting,
  };
}

/** The $ sum of the landed lines, each line once, a line with no spend adding nothing; absent when none is measured (the pane's `landedUsd`). */
function landedSum(lands: readonly Land[]): { landedUsd?: number } {
  const seen = new Set<string>();
  let sum = 0;
  let measured = false;
  for (const l of lands) {
    if (seen.has(l.slice)) continue;
    seen.add(l.slice);
    if (l.usd === undefined) continue;
    sum += l.usd;
    measured = true;
  }
  return measured ? { landedUsd: sum } : {};
}

/**
 * Each day of the Landed tree as the pane's `daySpends` sums it: the landed lines plus the failed and closed lines
 * whose run ended that day and that the ledger measured (a line once), only on a day that has a landed line. The
 * replay spans hours, so a `DD.MM` is one date and needs no year check.
 */
function daySpends(
  lands: readonly Land[],
  ended: readonly Seen[],
  usdOf: (task: string) => { usd?: number },
  t0: number,
): Record<string, DaySpend> {
  const days: Record<string, DaySpend> = {};
  const counted = new Set<string>();
  const add = (day: string, task: string, usd: number | undefined, kind?: "failed" | "closed") => {
    const d = (days[day] ??= { usd: 0, lines: 0, measured: 0, failed: 0, closed: 0 });
    counted.add(task);
    d.lines++;
    if (usd !== undefined) {
      d.measured++;
      d.usd += usd;
    }
    if (kind !== undefined) d[kind]++;
  };
  for (const l of lands) if (!counted.has(l.slice)) add(l.at.slice(0, 5), l.slice, l.usd);
  for (const r of ended) {
    const usd = usdOf(r.task).usd;
    const day = dayMonth(t0 + (r.end as number));
    if (
      counted.has(r.task) ||
      usd === undefined ||
      days[day] === undefined ||
      (r.outcome === "completed" && r.landed)
    )
      continue;
    add(day, r.task, usd, r.outcome === "completed" ? "closed" : "failed");
  }
  return days;
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
  const roots = new Map<
    number,
    { task: string; workflow: string; start: number; state: string; landed: boolean }
  >();
  const ids = new Set(file.sessions);
  for (const [ts, kind, s, data] of file.events) {
    if (ts > at) break;
    if (kind === "session_start") {
      const isRoot = !(typeof data?.parent === "string" && ids.has(data.parent));
      if (!isRoot || typeof data?.task !== "string") continue;
      const workflow = typeof data.workflow === "string" ? data.workflow : "";
      const first = file.workflows[workflow]?.stations?.[0]?.name ?? "";
      roots.set(s, { task: data.task, workflow, start: ts, state: first, landed: false });
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
    } else if (kind === "agent_link" && typeof data?.model === "string") {
      // the root's agent is the driver of a `driver:` workflow: an event from before the engine recorded the driver's
      // model carries the task's execute model, so the workflow's own driver spec wins
      const model = file.workflows[r.workflow]?.driver?.model ?? data.model;
      out.push({ at: ts, kind: "spawn", label: r.task, role: "driver", model });
    } else if (kind === "ask" && typeof data?.state === "string")
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

// ---------------------------------------------------------------------------------------------------------------
// The pool: the machine's thread pool over the replay's window, cut from `pool.log` (`buildPool`), checked before
// anything is written (`assertReplayClean`) and read back at a moment (`poolStateAt`, `poolWaiting`, `poolStrip`).
// The log is shared by every project on the machine, so the cut is an ALLOWLIST: a lease or waiter keeps its label
// only when the label names a session or a slice of the replay; everything else is a thread count and nothing more.
// ---------------------------------------------------------------------------------------------------------------

/** The pool logs a sample this often while it holds a lease or has a waiter, and not at all while it is empty. */
export const POOL_SAMPLE_MS = 60_000;
/** A sample older than this means the pool was empty since (a sample every minute, and some slack). */
const POOL_IDLE_AFTER_MS = 2.5 * POOL_SAMPLE_MS;
/**
 * What the leases the log does not name are called: one row, no label, no project. A sample lists no holders; the
 * log names a lease only on an `overrun:` or `backfill:` line, so the rest may be this project's or another's.
 */
export const POOL_UNNAMED = "leases the log does not name (this project or another)";

const LOG_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/;
const SAMPLE_LINE =
  /^sample: load ([\d.]+) external ([\d.]+) held (\d+)\/(\d+) runs \S+ leases (\d+) waiting (\d+)(?: \[(.*)\])?$/;
const BACKFILL_LINE =
  /^backfill: pid \d+ takes (\d+) threads ahead of \S+(?: \(est [^)]*\))? — (.*)$/;
const OVERRUN_LINE = /^overrun: pid \d+ holds (\d+) threads, runs ~(\d+) — (.*)$/;
const STARVED_LINE = /^starved: pid \d+ queued \S+ for (\d+)(?:-\d+)? threads.* — (.*)$/;
/** A word of a label the replay may carry: letters, digits and a few separators, no path, no shell. */
const SAFE_WORD = /^[A-Za-z0-9][A-Za-z0-9_.,=-]*$/;
const ASK_PART = /^(?:\d+(?:-\d+)?|lock(?: \S+)?|\+\d+)$/;
const MAX_LABEL = 120;

/** The first and last moment (ms since the epoch) a pool log covers; undefined for a log with no line. */
export function poolLogSpan(
  lines: readonly string[],
): { readonly from: number; readonly to: number } | undefined {
  let from = Infinity;
  let to = -Infinity;
  for (const line of lines) {
    const m = LOG_LINE.exec(line);
    if (m === null) continue;
    const t = Date.parse(m[1]);
    from = Math.min(from, t);
    to = Math.max(to, t);
  }
  return from === Infinity ? undefined : { from, to };
}

/** The moments (ms since the epoch) the log sampled the pool with a waiter in it, in time order. */
export function poolWaitingSamples(lines: readonly string[]): number[] {
  const out: number[] = [];
  for (const line of lines) {
    const m = LOG_LINE.exec(line);
    const s = m === null ? null : SAMPLE_LINE.exec(m[2]);
    if (m !== null && s !== null && Number(s[6]) > 0) out.push(Date.parse(m[1]));
  }
  return out.sort((a, b) => a - b);
}

/** What a window shows of the pool: the more samples with a waiter in it, the more there is to see (at most 100). */
function poolBusy(sampled: readonly number[], from: number, to: number): number {
  return Math.min(100, sampled.filter(t => t >= from && t <= to).length);
}

/** Whether a label names something of the replay: every word is plain, and one is a slice or a session of it. */
export function poolLabelAllowed(label: string, names: ReadonlySet<string>): boolean {
  if (label.length === 0 || label.length > MAX_LABEL) return false;
  const words = label.split(" ");
  return words.every(w => SAFE_WORD.test(w)) && words.some(w => names.has(w));
}

/** A waiter's ask with every lock but a replay project's own land lock made anonymous: `4-8 + lock a` is `4-8 + lock`. */
function poolAsk(raw: string, own: ReadonlySet<string>): string {
  return raw
    .split(" + ")
    .map(p => {
      const m = /^lock (\S+)$/.exec(p);
      if (m !== null) return own.has(m[1]) ? p : "lock";
      return /^(?:\d+(?:-\d+)?|\+\d+)$/.test(p) ? p : "?";
    })
    .join(" + ");
}

interface LogSample {
  readonly ts: number;
  readonly held: number;
  readonly budget: number;
  readonly load: number;
  readonly external: number;
  readonly leases: number;
  readonly waiting: number;
  readonly asks: readonly string[];
}

interface LogMark {
  readonly ts: number;
  readonly mark: PoolMark;
}

/**
 * The pool's frames over `[from, to]` (ms since the epoch) from a log's lines. A sample is a frame; a lease or
 * waiter the log named is a mark on the first sample after it, and only when its label is on the allowlist
 * (`poolLabelAllowed` over `tasks` and `sessions`). The log's pids, paths and every other label stay in the log.
 */
export function buildPool(
  lines: readonly string[],
  opts: {
    readonly project: string;
    /** the replay's other projects: their land locks keep their names too */
    readonly also?: readonly string[];
    readonly from: number;
    readonly to: number;
    readonly tasks: ReadonlySet<string>;
    readonly sessions: ReadonlySet<string>;
    readonly threshold: number;
  },
): ReplayPool {
  const names = new Set([...opts.tasks, ...opts.sessions]);
  const own = new Set([opts.project, ...(opts.also ?? [])].map(p => `${p}-land`));
  const samples: LogSample[] = [];
  const marks: LogMark[] = [];
  for (const line of lines) {
    const head = LOG_LINE.exec(line);
    if (head === null) continue;
    const ts = Date.parse(head[1]);
    const text = head[2];
    const sample = SAMPLE_LINE.exec(text);
    if (sample !== null) {
      samples.push({
        ts,
        load: Number(sample[1]),
        external: Number(sample[2]),
        held: Number(sample[3]),
        budget: Number(sample[4]),
        leases: Number(sample[5]),
        waiting: Number(sample[6]),
        asks: sample[7] === undefined ? [] : sample[7].split(", ").map(a => poolAsk(a, own)),
      });
      continue;
    }
    const back = BACKFILL_LINE.exec(text);
    const over = OVERRUN_LINE.exec(text);
    const starved = STARVED_LINE.exec(text);
    const mark: PoolMark | undefined =
      back !== null
        ? ["backfill", Number(back[1]), back[2], 0]
        : over !== null
          ? ["overrun", Number(over[1]), over[3], Number(over[2])]
          : starved !== null
            ? ["starved", Number(starved[1]), starved[2], 0]
            : undefined;
    if (mark !== undefined && poolLabelAllowed(mark[2], names)) marks.push({ ts, mark });
  }
  samples.sort((a, b) => a.ts - b.ts);
  const frames: PoolFrame[] = [];
  samples.forEach((s, i) => {
    if (s.ts < opts.from || s.ts > opts.to) return;
    // the marks logged since the sample before (at most two sample periods back: a pool that sat empty has none)
    const lo = Math.max(i > 0 ? samples[i - 1].ts : -Infinity, s.ts - 2 * POOL_SAMPLE_MS);
    const seen = new Map<string, PoolMark>();
    for (const m of marks)
      if (m.ts > lo && m.ts <= s.ts) seen.set(`${m.mark[0]} ${m.mark[2]}`, m.mark);
    frames.push([
      s.ts - opts.from,
      s.held,
      s.budget,
      s.load,
      s.external,
      s.leases,
      s.waiting,
      s.asks,
      [...seen.values()],
    ]);
  });
  return { threshold: opts.threshold, frames };
}

const namesOf = new WeakMap<ReplayFile, Map<string, string>>();

/** What a replay may name: its slices and its sessions, each with the session it stands for. */
function replayNames(file: ReplayFile): Map<string, string> {
  let names = namesOf.get(file);
  if (names === undefined) {
    names = new Map<string, string>(file.sessions.map(id => [id, id]));
    for (const [, kind, s, data] of file.events)
      if (kind === "session_start" && typeof data?.task === "string")
        names.set(data.task, file.sessions[s]);
    namesOf.set(file, names);
  }
  return names;
}

const ownLocks = (file: ReplayFile): ReadonlySet<string> =>
  new Set((file.projects ?? [file.project]).map(p => `${p}-land`));

const QUEUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const QUEUE_FIXED =
  /^(?:manual condition|[A-Za-z0-9][A-Za-z0-9_.-]{0,79} \((?:pending|running|failed|backlog|done)(?:, archived)?\))$/;
const QUEUE_KINDS: readonly string[] = ["bug", "feature", "research"];
const QUEUE_PRIORITIES: readonly string[] = ["", "urgent", "high", "low"];
/** The note a replay's queue carries: what the engine's pick saw cannot be rebuilt for a line added after the window. */
export const REPLAY_QUEUE_NOTE =
  "the queue is the one at export, rolled back to the window's start by the lines that ran in it; a line added to it after the window cannot be rebuilt";
const QUEUE_KEYS: readonly string[] = [
  "id",
  "difficulty",
  "priority",
  "kind",
  "hold",
  "after",
  "fixed",
  "against",
];

/** What the queue section may carry: line ids and enums, a fixed set of reason texts, nothing a line wrote (its text, a note, a path). */
function queueLeaks(queue: ReplayQueue): string[] {
  const bad: string[] = [];
  const ids = new Set(queue.lines.map(l => l.id));
  if (queue.note !== REPLAY_QUEUE_NOTE)
    bad.push("the queue's note is not the one the export writes");
  for (const l of queue.lines) {
    const named = (id: unknown): boolean => typeof id === "string" && QUEUE_ID.test(id);
    const extra = Object.keys(l).filter(k => !QUEUE_KEYS.includes(k));
    if (extra.length > 0)
      bad.push(`a queue line has a field the export does not write: ${JSON.stringify(extra)}`);
    if (!named(l.id)) bad.push(`a queue line id is not a plain id: ${JSON.stringify(l.id)}`);
    if (!/^\d{0,2}$/.test(l.difficulty))
      bad.push(`a queue line's difficulty is not a number: ${JSON.stringify(l.difficulty)}`);
    if (!QUEUE_PRIORITIES.includes(l.priority))
      bad.push(`a queue line's priority is not one of the pick's: ${JSON.stringify(l.priority)}`);
    if (!QUEUE_KINDS.includes(l.kind))
      bad.push(`a queue line's kind is not one of the pick's: ${JSON.stringify(l.kind)}`);
    if (l.hold !== undefined && !QUEUE_HOLDS.includes(l.hold))
      bad.push(`a queue line's hold is not a known one: ${JSON.stringify(l.hold)}`);
    for (const a of l.after ?? [])
      if (!ids.has(a))
        bad.push(`a queue line waits on a line the queue does not list: ${JSON.stringify(a)}`);
    for (const f of l.fixed ?? [])
      if (!QUEUE_FIXED.test(f))
        bad.push(`a queue line's fixed wait is not a known one: ${JSON.stringify(f)}`);
    if (
      l.against !== undefined &&
      (!Object.hasOwn(AGAINST_TEXT, l.against[0]) || !ids.has(l.against[1]))
    )
      bad.push(
        `a queue line runs against a line the queue does not list: ${JSON.stringify(l.against)}`,
      );
  }
  return bad;
}

/** Every way the file could leak what the replay must not carry; throws naming each one. */
export function assertReplayClean(file: ReplayFile, forbid: readonly string[] = []): void {
  const bad: string[] = [];
  const raw = JSON.stringify(file);
  for (const word of ["/Users/", "/home/", "/private/", ...forbid.filter(f => f !== "")])
    if (raw.includes(word)) bad.push(`the file holds ${JSON.stringify(word)}`);
  if (/"pid"\s*:/.test(raw)) bad.push("the file has a pid field");
  const pool = file.pool;
  if (pool !== undefined) {
    const names = new Set(replayNames(file).keys());
    const own = ownLocks(file);
    for (const f of pool.frames) {
      for (const m of f[8])
        if (!poolLabelAllowed(m[2], names))
          bad.push(`a lease label is not on the allowlist: ${JSON.stringify(m[2])}`);
      for (const ask of f[7])
        for (const part of ask.split(" + ")) {
          const lock = /^lock (\S+)$/.exec(part);
          if (!ASK_PART.test(part) || (lock !== null && !own.has(lock[1])))
            bad.push(`an ask is not a thread count: ${JSON.stringify(ask)}`);
        }
    }
  }
  const tasks = new Set<string>();
  for (const [, kind, , data] of file.events)
    if (kind === "session_start" && typeof data?.task === "string") tasks.add(data.task);
  for (const [task, usd] of Object.entries(file.spend ?? {}))
    if (!tasks.has(task) || typeof usd !== "number" || !Number.isFinite(usd) || usd < 0)
      bad.push(`a spend is not a task of the replay: ${JSON.stringify(task)}`);
  if (file.queue !== undefined) bad.push(...queueLeaks(file.queue));
  if (bad.length > 0)
    throw new Error(`the replay is not clean:\n  ${[...new Set(bad)].join("\n  ")}`);
}

/** The pool's frame at `at` ms, or undefined when the pool was empty (no sample yet, or none for a while). */
function frameAt(pool: ReplayPool, at: number): PoolFrame | undefined {
  let lo = 0;
  let hi = pool.frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pool.frames[mid][0] <= at) lo = mid + 1;
    else hi = mid;
  }
  const f = pool.frames[lo - 1];
  return f !== undefined && at - f[0] < POOL_IDLE_AFTER_MS ? f : undefined;
}

/** The pool's threads held of its budget at `at` ms (what the tab's label shows) and how many commands waited. */
export function poolCountsAt(
  file: ReplayFile,
  at: number,
): { held: number; budget: number; waiting: number } | null {
  const pool = file.pool;
  if (pool === undefined || pool.frames.length === 0) return null;
  const f = frameAt(pool, at);
  return { held: f?.[1] ?? 0, budget: (f ?? pool.frames[0])[2], waiting: f?.[6] ?? 0 };
}

const askRequest = (ask: string): string =>
  ask
    .split(" + ")
    .map(p => (/^[\d-]+$/.test(p) ? `${p} threads` : p))
    .join(" + ");

/**
 * The Pool tab's read at `at` ms, as the mod's tab reads `/api/pool`: the latest sample's budget, threads held and
 * load, the leases the log named (a backfilled or over-running one) and one row for the rest, the waiters' asks in
 * admission order, the project's land lock when a waiter wants it. The log carries no priority or age, so a row has
 * none. A moment the pool was empty reads as such.
 */
export function poolStateAt(file: ReplayFile, at: number): PoolState {
  const now = Date.parse(file.start) + at;
  const pool = file.pool;
  if (pool === undefined) return { at: now, pool: null, error: "the replay carries no pool log" };
  const f = frameAt(pool, at);
  if (f === undefined)
    return {
      at: now,
      pool: null,
      error: "idle: no lease and no waiter (the pool logs a sample only while it has one)",
    };
  const [, held, budget, load, external, leaseCount, waitingCount, asks, seen] = f;
  const names = replayNames(file);
  const row = (request: string, label: string, session: string, project = ""): PoolLine => ({
    pid: 0,
    request,
    ageMs: -1,
    priority: "",
    project,
    session: session.slice(0, 8),
    step: "",
    label,
    overrun: null,
    isStarved: false,
  });
  const named = seen.filter(m => m[0] !== "starved");
  const leases = named.map(m => ({
    ...row(
      `${m[1]} threads`,
      m[2],
      names.get(m[2].split(" ").find(w => names.has(w)) ?? "") ?? "",
      file.project,
    ),
    overrun: m[0] === "overrun" ? m[3] : null,
  }));
  const rest = leaseCount - named.length;
  if (rest > 0)
    leases.push(
      row(
        `${Math.max(0, held - named.reduce((n, m) => n + m[1], 0))} threads`,
        `${POOL_UNNAMED}: ${rest}`,
        "",
      ),
    );
  const listed = asks.filter(a => !a.startsWith("+"));
  const waiting = listed.map(a => row(askRequest(a), "", ""));
  // the sample lists four waiters; the rest are one row that says how many (the log has no ask for them)
  if (waitingCount > listed.length)
    waiting.push(row(`+${waitingCount - listed.length} more waiting`, "", ""));
  const starved = seen.filter(m => m[0] === "starved").map(m => m[2]);
  return {
    at: now,
    error: "",
    pool: {
      budget,
      held,
      load,
      external,
      threshold: pool.threshold,
      starvedNote: starved.length > 0 ? `STARVED: ${starved.join(" · ")}` : "",
      locks: [
        ...new Set(
          asks
            .flatMap(a => a.split(" + "))
            .filter(p => p.startsWith("lock ") && ownLocks(file).has(p.slice(5))),
        ),
      ].map(p => p.slice(5)),
      leases,
      waiting,
    },
  };
}

interface Wait {
  readonly session: string;
  readonly from: number;
  readonly to: number;
}

const waitsOf = new WeakMap<ReplayFile, readonly Wait[]>();

/** The stretches an exec of the replay waited for a pool lease: from its start for `wait_ms`, one per exec that waited. */
function waits(file: ReplayFile): readonly Wait[] {
  let out = waitsOf.get(file);
  if (out !== undefined) return out;
  const started = new Map<number, number>();
  const list: Wait[] = [];
  for (const [ts, kind, s, data] of file.events) {
    if (kind === "exec_start") started.set(s, ts);
    else if (kind === "exec_end") {
      const from = started.get(s);
      started.delete(s);
      const wait = data?.wait_ms;
      if (from !== undefined && typeof wait === "number" && wait >= POOL_MIN_WAIT_MS)
        list.push({ session: file.sessions[s], from, to: Math.min(ts, from + wait) });
    }
  }
  out = list;
  waitsOf.set(file, out);
  return out;
}

const parentsOf = new WeakMap<ReplayFile, ReadonlyMap<string, string>>();

/** The session each session of the file was started under (a root has none). */
function parents(file: ReplayFile): ReadonlyMap<string, string> {
  let out = parentsOf.get(file);
  if (out === undefined) {
    const m = new Map<string, string>();
    for (const [, kind, s, data] of file.events)
      if (kind === "session_start" && typeof data?.parent === "string")
        m.set(file.sessions[s], data.parent);
    out = m;
    parentsOf.set(file, out);
  }
  return out;
}

/**
 * The sessions that wait for a pool lease at `at` ms, each with the sessions it runs under: a worker's exec that
 * waits holds up the pipeline's lane the worker hangs from, so that lane carries the "waiting for the pool" mark
 * the map draws for `MapOptions.pool`.
 */
export function poolWaiting(file: ReplayFile, at: number): string[] {
  const up = parents(file);
  const out = new Set<string>();
  for (const w of waits(file))
    if (w.from <= at && at < w.to)
      for (
        let id: string | undefined = w.session;
        id !== undefined && !out.has(id);
        id = up.get(id)
      )
        out.add(id);
  return [...out];
}

export interface PoolStrip {
  /** the budget's height in the strip */
  readonly budgetY: number;
  /** threads held by leases the log does not name (`POOL_UNNAMED`) and by the ones it names, stacked; closed paths */
  readonly other: string;
  readonly named: string;
  /** how many waiters there were, as a band along the top */
  readonly waiting: string;
}

/**
 * The pool's occupancy over the whole replay as paths in a `width` x `height` box: threads held (the work the
 * replay does not name under the work it names) against the budget, and the waiters as a band along the top. A
 * sample holds until the next one; a pool that logged nothing for a while was empty.
 */
export function poolStrip(file: ReplayFile, width: number, height: number): PoolStrip | null {
  const pool = file.pool;
  if (pool === undefined || pool.frames.length === 0) return null;
  const top = Math.max(...pool.frames.map(f => Math.max(f[1], f[2])));
  const x = (t: number): number => +((t / Math.max(1, file.durationMs)) * width).toFixed(1);
  const y = (n: number): number => +(height - (n / top) * height).toFixed(1);
  const band = 0.22 * height;
  const wy = (n: number): number => +(band - (Math.min(n, 6) / 6) * band).toFixed(1);
  const steps: { x0: number; x1: number; other: number; named: number; waiting: number }[] = [];
  pool.frames.forEach((f, i) => {
    const next = pool.frames[i + 1]?.[0] ?? file.durationMs;
    const end = Math.min(next, f[0] + POOL_IDLE_AFTER_MS);
    const named = Math.min(
      f[1],
      f[8].filter(m => m[0] !== "starved").reduce((n, m) => n + m[1], 0),
    );
    steps.push({ x0: x(f[0]), x1: x(end), other: f[1] - named, named, waiting: f[6] });
  });
  const area = (
    low: (s: (typeof steps)[number]) => number,
    high: (s: (typeof steps)[number]) => number,
    base: (n: number) => number,
  ): string => {
    const parts: string[] = [];
    for (const s of steps) {
      const hi = high(s);
      const lo = low(s);
      if (hi <= lo) continue;
      parts.push(`M${s.x0},${base(hi)}H${s.x1}V${base(lo)}H${s.x0}Z`);
    }
    return parts.join("");
  };
  return {
    budgetY: y(Math.max(...pool.frames.map(f => f[2]))),
    other: area(
      () => 0,
      s => s.other,
      y,
    ),
    named: area(
      s => s.other,
      s => s.other + s.named,
      y,
    ),
    waiting: area(
      () => 0,
      s => s.waiting,
      wy,
    ),
  };
}
