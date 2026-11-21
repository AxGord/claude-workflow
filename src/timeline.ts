// The Timeline tab's data: one bar per task pipeline of a day, cut into segments by state. Pure: the
// route (src/dashboard.ts) feeds it the session files and the ledger.
import type { SessionState } from "./types.js";
import { rootSessionIdOf, wholeUsd, type LedgerEntry } from "./ledger.js";
import { projectNameOf } from "./pool.js";
import { reviewRounds } from "./calibration.js";

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

/**
 * One session's states; `depth` 0 = the bar's own session, 1+ = a session it started. A sub-row is
 * named by what it did: `role` = its workflow without the pipeline's prefix (`slice-worker` -> `worker`),
 * `model` the family it ran on (`opus`), `round` its ordinal among the bar's rows of that role;
 * `name` joins them (`worker r2 · opus`; the round only when the role ran more than once).
 */
export interface TimelineRow {
  readonly session: string;
  readonly workflow: string | null;
  readonly depth: number;
  readonly role: string | null;
  readonly model: string | null;
  readonly round: number | null;
  readonly name: string;
  readonly segments: readonly TimelineSegment[];
}

/** How a task bar ended: landed = completed through a `land` state, closed = ended without landing, failed, or still running. */
export type TimelineResult = "landed" | "closed" | "failed" | "running";

export interface TimelineBar {
  readonly id: string;
  readonly root: string;
  /** `task` = a pipeline (a session with a task id) or a session no task hangs under; `parent` = the session that started task pipelines (the dispatcher), one row, drawn last. */
  readonly kind: "task" | "parent";
  readonly task: string | null;
  /** What the left column shows: the task id, else `parent · <workflow>`, else the workflow. */
  readonly label: string;
  readonly workflow: string | null;
  readonly outcome: string;
  readonly result: TimelineResult;
  /** The project (the main checkout's directory name) of the session's cwd; null when unknown. */
  readonly project: string | null;
  /** The bar's own session from its start to its end (to now while it runs), whole, not clipped to the day. */
  readonly duration_ms: number;
  /** Review rounds: the bar's own entries into the state `review` (`visits.review`, else its review states), or the review sessions it started, the larger. */
  readonly rounds: number;
  /** The ledger's spend of the task's agents plus the parent's own turns (`parent_spend`); null until the ledger line exists or when it measured nothing. */
  readonly usd: number | null;
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
  type Open = {
    state: string;
    start: number;
    waits: { start: number; end: number }[];
  };
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
  if (!began && typeof frame?.current_state === "string")
    begin(frame.current_state, Date.parse(s.started_at));
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

/** Entries into the state named `review` (else into review states, routing states aside), as `wf-calibration` counts them: the ledger line's `visits`, or a live session's history moves. */
function reviewRoundsOf(s: SessionState | undefined, led: LedgerEntry | undefined): number {
  const visits: Record<string, number> = {};
  if (s)
    for (const h of s.history)
      if (h.to !== undefined && h.event !== "push") visits[h.to] = (visits[h.to] ?? 0) + 1;
  return (s ? visits : led?.visits)?.review ?? reviewRounds(s ? visits : led?.visits);
}

/** The segments a ledger line recorded, in the same shape a live history cuts. */
function ledgerSegments(
  e: LedgerEntry,
  groups: Readonly<Record<string, string>>,
): TimelineSegment[] {
  return (e.segs ?? []).map(g => ({
    state: g.s,
    group: stageGroupOf(g.s, groups),
    start: g.a,
    end: g.b,
    waits: Array.from({ length: Math.floor((g.w?.length ?? 0) / 2) }, (_, i) => ({
      start: g.w![2 * i],
      end: g.w![2 * i + 1],
    })),
  }));
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

const MODEL_FAMILY = /(opus|sonnet|haiku|fable)/i;

/** The family of a model id (`claude-opus-4-5` -> `opus`); an id of no known family stays as written. */
export function modelFamily(model: string): string {
  return MODEL_FAMILY.exec(model)?.[1]?.toLowerCase() ?? model.trim();
}

/** A workflow's role inside a pipeline: its name without the pipeline workflow's own prefix (`slice-worker` under `slice-pipeline` -> `worker`). */
function roleOf(workflow: string | null, head: string | null, session: string): string {
  if (workflow === null) return session.slice(0, 8);
  const prefix = head?.includes("-") ? head.slice(0, head.indexOf("-") + 1) : null;
  return prefix && workflow.startsWith(prefix) && workflow.length > prefix.length
    ? workflow.slice(prefix.length)
    : workflow;
}

/**
 * The bars of a day. A TASK PIPELINE (a session carrying a task id: `slice`, else `task`, in its context or
 * ledger line) is a bar of its own, however deep it sits and whether or not a dispatcher started it; its
 * rows are itself and the sessions beneath it that carry no task of their own. The session that started
 * pipelines (the dispatcher) is one `parent` bar, drawn last. A session no task hangs under keeps the
 * older rule: a child of a root with children, or a root without children, is a bar. A pipeline is in the
 * day when its span overlaps it; a row with no segment in the day is dropped. A session the ledger has and
 * the store does not (pruned) is drawn from the segments its line recorded, else as one undivided bar.
 */
export function buildTimeline(input: TimelineInput): Timeline | null {
  const from = dayStart(input.day);
  if (from === null) return null;
  const to = new Date(from).setDate(new Date(from).getDate() + 1);
  const groups = input.groups ?? {};
  // the store can hold a placeholder a new session is being created from: not a session yet
  const sessions = input.sessions.filter(x => x.session_id && Array.isArray(x.history));
  const byId = new Map(sessions.map(s => [s.session_id, s]));
  const ledgerOf = new Map(input.ledger.map(e => [e.session_id, e]));
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

  const taskOf = (id: string): string | null => {
    const ctx = byId.get(id)?.context ?? {};
    return (
      [ctx.slice, ctx.task, ledgerOf.get(id)?.task].find(
        (v): v is string => typeof v === "string" && v !== "",
      ) ?? null
    );
  };
  // a pipeline head: a session with a task none of its ancestors carries too (a helper that inherited the id is a row, not a bar)
  const ancestorsOf = (id: string): string[] => {
    const out: string[] = [];
    for (let p = known.get(id)?.parent; p && !out.includes(p); p = known.get(p)?.parent ?? null)
      out.push(p);
    return out;
  };
  const taskHeads = [...known.keys()].filter(id => {
    const t = taskOf(id);
    return t !== null && !ancestorsOf(id).some(a => taskOf(a) === t);
  });
  const isHead = new Set(taskHeads);
  const members = (id: string): string[] => {
    const walk = (x: string): string[] =>
      (kids.get(x) ?? []).flatMap(c => (isHead.has(c) ? [] : [c, ...walk(c)]));
    return [id, ...walk(id)];
  };
  const inTask = new Set(taskHeads.flatMap(members));
  // the sessions that started pipelines: their own row, not a bar of everything beneath them
  const parents = new Set<string>();
  const above = new Set<string>();
  for (const h of taskHeads) {
    const p = known.get(h)?.parent;
    if (p && !inTask.has(p)) parents.add(p);
    for (const a of ancestorsOf(h)) above.add(a);
  }
  // sessions no task hangs under: the older rule
  const looseHeads = [...known.entries()]
    .filter(([id, k]) => {
      if (inTask.has(id) || above.has(id)) return false;
      return !k.parent ? !kids.has(id) : !known.get(k.parent)?.parent;
    })
    .map(([id]) => id);

  const cwdProject = new Map<string, string | null>();
  const projectOf = (ids: readonly string[]): string | null => {
    for (const id of ids) {
      const led = ledgerOf.get(id)?.project;
      if (led) return projectNameOf(led);
      const cwd = byId.get(id)?.context.cwd;
      if (typeof cwd !== "string" || cwd === "") continue;
      if (!cwdProject.has(cwd)) cwdProject.set(cwd, projectNameOf(cwd));
      const name = cwdProject.get(cwd) ?? null;
      if (name !== null) return name;
    }
    return null;
  };
  const modelOf = (id: string): string | null => {
    const led = ledgerOf.get(id);
    const ctx = byId.get(id)?.context ?? {};
    const m = [led?.spend?.by_agent?.find(a => a.model)?.model, led?.model, ctx.model].find(
      (v): v is string => typeof v === "string" && v !== "",
    );
    return m === undefined ? null : modelFamily(m);
  };
  const ownSegments = (id: string): TimelineSegment[] | null => {
    const x = byId.get(id);
    const l = ledgerOf.get(id);
    return x ? sessionSegments(x, input.now, groups) : l?.segs ? ledgerSegments(l, groups) : null;
  };
  const inDay = (segs: readonly TimelineSegment[]): TimelineSegment[] =>
    segs.map(g => clip(g, from, to)).filter((g): g is TimelineSegment => g !== null);
  const workflowOf = (id: string): string | null => {
    const x = byId.get(id);
    return x
      ? (x.history.find(h => h.event === "start")?.workflow ?? null)
      : (ledgerOf.get(id)?.workflow ?? null);
  };
  const startOf = (id: string): number =>
    Date.parse(byId.get(id)?.started_at ?? ledgerOf.get(id)?.started_at ?? "") || 0;

  const bars: TimelineBar[] = [];
  const addBar = (id: string, kind: "task" | "parent"): void => {
    const k = known.get(id)!;
    const root = k.parent ? k.root : id;
    if (
      input.root !== undefined &&
      root !== input.root &&
      id !== input.root &&
      k.root !== input.root
    )
      return;
    const s = byId.get(id);
    const led = ledgerOf.get(id);
    const ids = kind === "parent" ? [id] : members(id);
    const headWorkflow = workflowOf(id);
    const rows: TimelineRow[] = [];
    if (s || led?.segs) {
      const subs = ids.slice(1).sort((a, b) => startOf(a) - startOf(b));
      const roles = new Map<string, number>();
      const roleOfId = new Map<string, string>();
      for (const sid of subs) {
        const role = roleOf(workflowOf(sid), headWorkflow, sid);
        roleOfId.set(sid, role);
        roles.set(role, (roles.get(role) ?? 0) + 1);
      }
      const seen = new Map<string, number>();
      for (const [i, sid] of [id, ...subs].entries()) {
        const own = ownSegments(sid);
        if (own === null) continue;
        const segs = inDay(own);
        if (i > 0 && segs.length === 0) continue;
        const wf = workflowOf(sid);
        const role = i === 0 ? null : (roleOfId.get(sid) ?? null);
        const round = role === null ? null : (seen.get(role) ?? 0) + 1;
        if (role !== null) seen.set(role, round!);
        const model = i === 0 ? null : modelOf(sid);
        const name =
          i === 0
            ? kind === "parent"
              ? `parent · ${wf ?? sid.slice(0, 8)}`
              : (taskOf(id) ?? wf ?? sid.slice(0, 8))
            : `${role}${(roles.get(role!) ?? 0) > 1 ? ` r${round}` : ""}${model ? ` · ${model}` : ""}`;
        rows.push({
          session: sid,
          workflow: wf,
          depth: i === 0 ? 0 : 1,
          role,
          model,
          round,
          name,
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
        role: null,
        model: null,
        round: null,
        name:
          kind === "parent"
            ? `parent · ${led.workflow ?? id.slice(0, 8)}`
            : (taskOf(id) ?? led.workflow ?? id.slice(0, 8)),
        segments: g ? [g] : [],
      });
    }
    const all = rows.flatMap(r => r.segments);
    if (all.length === 0) return;
    const task = kind === "task" ? taskOf(id) : null;
    const running = s ? s.stack.length > 0 : false;
    const outcome = s
      ? running
        ? "running"
        : (s.outcome ?? "completed")
      : (led?.outcome ?? "completed");
    // the Cost tab's rule (`costOutcome`): a state named `land` or `<x>_land`; `land_failed` is not one
    const landed = (ownSegments(id) ?? []).some(g => /(^|_)land$/.test(g.state));
    const result: TimelineResult =
      outcome === "running"
        ? "running"
        : outcome === "failed"
          ? "failed"
          : outcome === "completed" && landed
            ? "landed"
            : "closed";
    const spanStart = Date.parse(s?.started_at ?? led?.started_at ?? "");
    const spanEnd = running ? input.now : Date.parse(s?.updated_at ?? led?.ended_at ?? "");
    const spentUsd = wholeUsd(led?.spend);
    // the head's spend covers its subtree; a member line of the same task adds only the parent's own turns it carries
    const parentUsds = [
      led?.parent_spend?.usd,
      ...(task === null
        ? []
        : ids.slice(1).map(x => {
            const l = ledgerOf.get(x);
            return l?.task === task ? l.parent_spend?.usd : undefined;
          })),
    ].filter((u): u is number => u !== undefined);
    bars.push({
      id,
      root,
      kind,
      task,
      label: rows[0]?.name ?? id,
      workflow: rows[0]?.workflow ?? null,
      outcome,
      result,
      project: projectOf(ids),
      duration_ms: Number.isNaN(spanEnd - spanStart) ? 0 : Math.max(0, spanEnd - spanStart),
      rounds: Math.max(
        reviewRoundsOf(s, led),
        ids.slice(1).filter(x => /review/i.test(roleOf(workflowOf(x), headWorkflow, x))).length,
      ),
      usd:
        spentUsd === undefined && parentUsds.length === 0
          ? null
          : (spentUsd ?? 0) + parentUsds.reduce((a, b) => a + b, 0),
      start: Math.min(...all.map(g => g.start)),
      end: Math.max(...all.map(g => g.end)),
      detailed: s !== undefined,
      rows,
    });
  };
  for (const id of taskHeads) addBar(id, "task");
  for (const id of looseHeads) addBar(id, "task");
  const taskBars = bars.length;
  for (const id of parents) addBar(id, "parent");
  const byStart = (a: TimelineBar, b: TimelineBar): number => a.start - b.start;
  return {
    day: input.day,
    from,
    to,
    bars: [...bars.slice(0, taskBars).sort(byStart), ...bars.slice(taskBars).sort(byStart)],
  };
}
