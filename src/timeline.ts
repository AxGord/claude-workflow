// The Timeline tab's data: one bar per task pipeline of a day, cut into segments by state. Pure: the
// route (src/dashboard.ts) feeds it the session files and the ledger.
import type { SessionState } from "./types.js";
import { rootSessionIdOf, type LedgerEntry } from "./ledger.js";

export const STAGE_GROUPS = ["recon", "plan", "work", "gate", "review", "land", "wait"] as const;
export type StageGroup = (typeof STAGE_GROUPS)[number];

/** First match wins; a state no row matches is `work`. The page colours a group; `STATE_DIR/timeline-groups.conf` (state -> group) overrides a state by name. */
const DEFAULT_GROUPS: readonly (readonly [RegExp, StageGroup])[] = [
  [/wait|blocked|park|ask|needs|hold|idle|queued/, "wait"],
  [/recon|research|explor|triage|claim|discover/, "recon"],
  [/plan|design|spec/, "plan"],
  [/review|verdict|audit|check_review/, "review"],
  [/land|merge|push|commit|publish|finali[sz]e|done|complete/, "land"],
  [/gate|test|build|lint|verify|battery|check|ci\b/, "gate"],
];

export function stageGroupOf(
  state: string,
  overrides: Readonly<Record<string, string>> = {},
): StageGroup {
  const own = overrides[state];
  if ((STAGE_GROUPS as readonly string[]).includes(own ?? "")) return own as StageGroup;
  const s = state.toLowerCase();
  return DEFAULT_GROUPS.find(([re]) => re.test(s))?.[1] ?? "work";
}

/** A stretch of one state, in epoch ms; `waits` = the pool-lease waits of its execs (drawn hatched). */
export interface TimelineSegment {
  readonly state: string;
  readonly group: StageGroup;
  readonly start: number;
  readonly end: number;
  readonly waits: readonly { readonly start: number; readonly end: number }[];
}

/** One session's states; `depth` 0 = the pipeline's own session, 1+ = a session it started. */
export interface TimelineRow {
  readonly session: string;
  readonly workflow: string | null;
  readonly depth: number;
  readonly segments: readonly TimelineSegment[];
}

export interface TimelineBar {
  readonly id: string;
  readonly root: string;
  readonly task: string | null;
  readonly workflow: string | null;
  readonly outcome: string;
  readonly start: number;
  readonly end: number;
  /** false = only the ledger knows it (the session file is pruned): one segment, no states. */
  readonly detailed: boolean;
  readonly rows: readonly TimelineRow[];
}

export interface Timeline {
  readonly day: string;
  readonly from: number;
  readonly to: number;
  readonly bars: readonly TimelineBar[];
}

const END_EVENTS = new Set(["complete", "fail", "abandon", "cascade_abandon", "abort", "suspend"]);

/** The segments a session's history cuts: every entry with a `to` (a transition or a `push`) opens a state; the initial state is read from the first move's `from`. */
export function sessionSegments(
  s: Pick<
    SessionState,
    "history" | "started_at" | "updated_at" | "stack" | "active_frame" | "suspended_at"
  >,
  now: number,
  groups: Readonly<Record<string, string>> = {},
): TimelineSegment[] {
  const out: TimelineSegment[] = [];
  type Open = { state: string; start: number; waits: { start: number; end: number }[] };
  const cur: { open: Open | null } = { open: null };
  const close = (end: number): void => {
    const open = cur.open;
    if (open && end > open.start)
      out.push({ ...open, group: stageGroupOf(open.state, groups), end });
    cur.open = null;
  };
  let began = false;
  let suspended: string | null = null;
  const begin = (state: string, start: number): void => {
    cur.open = { state, start, waits: [] };
    began = true;
  };
  for (const h of s.history) {
    const at = Date.parse(h.at);
    if (Number.isNaN(at)) continue;
    // a session's first move names the initial state it left: it ran since the session started
    if (!began && h.from !== undefined && h.to !== undefined)
      begin(h.from, Date.parse(s.started_at));
    const open = cur.open;
    if (open && h.event === "action" && h.from === open.state && (h.wait_ms ?? 0) > 0) {
      const end = at - (h.duration_ms ?? 0);
      open.waits.push({
        start: Math.max(open.start, end - (h.wait_ms ?? 0)),
        end,
      });
    }
    if (h.to !== undefined) {
      close(at);
      begin(h.to, at);
    } else if (h.event === "resume" && suspended !== null) {
      // a resume carries no `to`: the state the suspend closed runs again
      begin(suspended, at);
      suspended = null;
    } else if (h.event !== undefined && END_EVENTS.has(h.event)) {
      suspended = h.event === "suspend" && cur.open ? cur.open.state : null;
      close(at);
    }
  }
  // no move yet: the session has been on its initial state since it started
  const frame = s.stack[s.active_frame];
  if (!began && frame) begin(frame.current_state, Date.parse(s.started_at));
  // still on a state: a live session runs to now, a stopped one to its last write
  close(
    s.suspended_at
      ? Date.parse(s.suspended_at)
      : s.stack.length > 0
        ? now
        : Date.parse(s.updated_at),
  );
  return out;
}

/** Local midnight of YYYY-MM-DD, or null for a malformed day. */
export function dayStart(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) || d.getDate() !== Number(m[3]) ? null : d.getTime();
}

export function localDay(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function clip(seg: TimelineSegment, from: number, to: number): TimelineSegment | null {
  const start = Math.max(seg.start, from);
  const end = Math.min(seg.end, to);
  if (end <= start) return null;
  const waits = seg.waits
    .map(w => ({
      start: Math.max(w.start, start),
      end: Math.min(w.end, end),
    }))
    .filter(w => w.end > w.start);
  return { ...seg, start, end, waits };
}

export interface TimelineInput {
  readonly sessions: readonly SessionState[];
  readonly ledger: readonly LedgerEntry[];
  readonly day: string;
  /** Only the pipelines of this root session; omitted = of every root. */
  readonly root?: string;
  readonly now: number;
  readonly groups?: Readonly<Record<string, string>>;
}

/**
 * The pipelines of a day: a root session's children, or the root itself when it has none; a
 * pipeline is in the day when its span overlaps it. A session the ledger has and the store does
 * not (pruned) is one undivided bar.
 */
export function buildTimeline(input: TimelineInput): Timeline | null {
  const from = dayStart(input.day);
  if (from === null) return null;
  const to = new Date(from).setDate(new Date(from).getDate() + 1);
  const groups = input.groups ?? {};
  // the store can hold a placeholder a new session is being created from: not a session yet
  const sessions = input.sessions.filter(x => x.session_id && Array.isArray(x.history));
  const byId = new Map(sessions.map(s => [s.session_id, s]));
  const kids = new Map<string, string[]>();
  const known = new Map<string, { parent: string | null; root: string }>();
  for (const s of sessions)
    known.set(s.session_id, {
      parent: s.parent_session_id ?? null,
      root: rootSessionIdOf(s),
    });
  for (const e of input.ledger)
    if (!known.has(e.session_id))
      known.set(e.session_id, {
        parent: e.parent_session_id,
        root: e.root_session_id,
      });
  for (const [id, k] of known)
    if (k.parent) kids.set(k.parent, [...(kids.get(k.parent) ?? []), id]);

  // a pipeline head: a child of a root that has children (a dispatcher), else a childless root
  const heads: string[] = [];
  for (const [id, k] of known) {
    const isRoot = !k.parent;
    if (isRoot ? !kids.has(id) : !known.get(k.parent!)?.parent) heads.push(id);
  }
  const descendants = (id: string): string[] =>
    (kids.get(id) ?? []).flatMap(c => [c, ...descendants(c)]);
  const ledgerOf = new Map(input.ledger.map(e => [e.session_id, e]));

  const bars: TimelineBar[] = [];
  for (const id of heads) {
    const k = known.get(id)!;
    const root = k.parent ?? id;
    if (input.root !== undefined && root !== input.root && id !== input.root) continue;
    const s = byId.get(id);
    const led = ledgerOf.get(id);
    const rows: TimelineRow[] = [];
    if (s) {
      for (const [i, sid] of [id, ...descendants(id)].entries()) {
        const x = byId.get(sid);
        if (!x) continue;
        const segs = sessionSegments(x, input.now, groups)
          .map(g => clip(g, from, to))
          .filter((g): g is TimelineSegment => g !== null);
        rows.push({
          session: sid,
          workflow: x.history.find(h => h.event === "start")?.workflow ?? null,
          depth: i === 0 ? 0 : 1,
          segments: segs,
        });
      }
    } else if (led) {
      const g = clip(
        {
          state: led.workflow ?? "session",
          group: "work",
          start: Date.parse(led.started_at),
          end: Date.parse(led.ended_at),
          waits: [],
        },
        from,
        to,
      );
      rows.push({
        session: id,
        workflow: led.workflow,
        depth: 0,
        segments: g ? [g] : [],
      });
    }
    const all = rows.flatMap(r => r.segments);
    if (all.length === 0) continue;
    const ctx = s?.context ?? {};
    const task = [ctx.slice, ctx.task, led?.task].find((v): v is string => typeof v === "string");
    bars.push({
      id,
      root,
      task: task ?? null,
      workflow: rows[0]?.workflow ?? null,
      outcome: s
        ? s.stack.length > 0
          ? "running"
          : (s.outcome ?? "completed")
        : (led?.outcome ?? "completed"),
      start: Math.min(...all.map(g => g.start)),
      end: Math.max(...all.map(g => g.end)),
      detailed: s !== undefined,
      rows,
    });
  }
  bars.sort((a, b) => a.start - b.start);
  return { day: input.day, from, to, bars };
}
