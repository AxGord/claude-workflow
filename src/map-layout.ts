// The live workflow map's geometry: `layout(fold(events))` places every band, lane, branch, loop,
// stop and question in layout units, and `scene(layout)` turns it into keyed SVG primitives the page
// (dashboard/map.js) reconciles with ~300 ms transitions. Pure and import-free (types only), so the
// compiled file runs in the page unchanged (served as /map-layout.js). Design: the dashboard-map SPEC.

import type { FoldedAgent, FoldedSession } from "./event-fold.js";

export interface MapStation {
  readonly name: string;
  readonly script: boolean;
  readonly terminal: boolean;
}

/** What the map reads of a workflow (`/api/workflows`). */
export interface MapWorkflow {
  readonly stations?: readonly MapStation[];
  readonly driver?: { readonly model?: string; readonly effort?: string } | null;
}

export interface MapOptions {
  /** ms since the epoch: ages and the landed fold are measured against it */
  readonly now: number;
  /** the room the map has: columns shrink to fit it, never below `G.minCol` */
  readonly width?: number;
  /** a lane to highlight (`/map/<session id>`) */
  readonly highlight?: string;
  /** the queue's ready lines, for the `next:` row */
  readonly next?: readonly { readonly id: string; readonly difficulty?: unknown }[];
  /** sessions whose exec waits for a pool lease (`pool_starved`) */
  readonly pool?: readonly string[];
  /** ended lanes older than this fold into `landed earlier:` (default one hour) */
  readonly foldAfterMs?: number;
  /** a clock label for a timestamp (default: local HH:MM) */
  readonly clock?: (ms: number) => string;
}

/** Layout units (px at scale 1). */
export const G = {
  left: 70,
  col: 230,
  minCol: 120,
  plaqueGap: 80,
  plaqueMax: 340,
  plaqueH: 22,
  /** average glyph widths: a plaque's 12 px semibold id, its 12 px state text, a 10 px chip */
  titleW: 8.2,
  charW: 6.6,
  chipW: 5.9,
  bandTop: 70,
  bandBottom: 18,
  bandGap: 20,
  sectionLabel: 22,
  strip: 30,
  rail: 44,
  laneGap: 22,
  mainTop: 22,
  mainBottom: 18,
  branchDrop: 56,
  branchRow: 46,
  stepLabels: 30,
  branchInset: 16,
  stepPad: 20,
  stepMin: 40,
  loopGap: 30,
  manyRunning: 4,
  nextShown: 6,
  earlierShown: 6,
} as const;

export type Kind = "done" | "live" | "ahead" | "stop";

export interface MapChip {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  /** a model token (`--model-sonnet`, …) */
  readonly c: string;
}

export interface MapStop {
  readonly key: string;
  readonly station: string;
  readonly x: number;
  readonly script: boolean;
  readonly kind: Kind;
  /** an exec's verdict over the square: `✓ 14m`, `✗ exit 1` */
  readonly label?: string;
}

export interface MapPass {
  /** the main line's y, relative to the lane */
  readonly y: number;
  readonly stops: readonly MapStop[];
  /** consecutive visited stations, each drawn as its own segment */
  readonly segments: readonly { readonly key: string; readonly x1: number; readonly x2: number }[];
}

export interface MapStep {
  readonly key: string;
  readonly name: string;
  readonly x: number;
  readonly kind: Kind;
  readonly detail?: string;
}

export interface MapBranch {
  readonly key: string;
  readonly session: string;
  readonly pass: number;
  readonly station: string;
  readonly x1: number;
  readonly x2: number;
  /** the main line it hangs from and its own row, relative to the lane */
  readonly y: number;
  readonly stepY: number;
  readonly c: string;
  readonly chip: MapChip;
  readonly steps: readonly MapStep[];
  /** finished: the branch joins back up at x2; else a faint tail goes back */
  readonly joined: boolean;
}

export interface MapLoop {
  readonly key: string;
  readonly x1: number;
  readonly y1: number;
  readonly yBack: number;
  readonly x2: number;
  readonly y2: number;
  readonly label: string;
}

export interface MapPlaque {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly title: string;
  readonly sub: string;
  /** a state class (st-done / st-stop / st-pool / st-wait) or '' for the difficulty colour */
  readonly cls: string;
  readonly c: string;
}

export interface MapLane {
  readonly key: string;
  readonly session: string;
  readonly workflow: string;
  readonly status: "running" | "landed" | "stopped";
  readonly y: number;
  readonly height: number;
  /** the main line's colour: the difficulty token */
  readonly c: string;
  readonly start: { readonly x: number; readonly y: number };
  readonly passes: readonly MapPass[];
  readonly loops: readonly MapLoop[];
  readonly branches: readonly MapBranch[];
  /** a landed lane's line into its plaque; a running lane's faint tail over the stations ahead */
  readonly end: {
    readonly x1: number;
    readonly x2: number;
    readonly y: number;
    readonly faint: boolean;
  };
  readonly ahead: readonly { readonly key: string; readonly x: number; readonly script: boolean }[];
  readonly plaque: MapPlaque;
  readonly driver: MapChip | null;
  readonly labels: boolean;
  readonly highlight: boolean;
}

export interface MapStrip {
  readonly y: number;
  readonly lead: string;
  /** `key` is unique in the row (a session id, a queue line id); two items may show one id */
  readonly items: readonly { readonly key: string; readonly id: string; readonly c: string }[];
  readonly more: number;
}

export interface MapAsk {
  readonly key: string;
  readonly x: number;
  /** the rail's y and the asking line's y, relative to the band */
  readonly y1: number;
  readonly y2: number;
  readonly label: string;
  readonly answer: string | null;
}

export interface MapRail {
  readonly session: string;
  readonly y: number;
  readonly x1: number;
  readonly x2: number;
  readonly label: string;
  readonly asks: readonly MapAsk[];
  /** a question the parent passed to the user: a glowing mark on the rail */
  readonly user: { readonly x: number; readonly label: string } | null;
}

export interface MapBand {
  readonly key: string;
  readonly workflow: string;
  readonly y: number;
  readonly height: number;
  readonly width: number;
  readonly stations: readonly (MapStation & { readonly x: number })[];
  readonly plaqueX: number;
  readonly landedY: number | null;
  readonly runningY: number | null;
  readonly earlier: MapStrip | null;
  readonly rail: MapRail | null;
  readonly lanes: readonly MapLane[];
}

export interface MapLayout {
  readonly width: number;
  readonly height: number;
  readonly bands: readonly MapBand[];
  readonly next: MapStrip | null;
}

const EFFORT_BARS: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };

/** A recorded value as text: a string or a number, else '' (event data is untyped). */
function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/** haiku / sonnet / opus, or '' */
export function modelName(model: unknown): string {
  const m = str(model).toLowerCase();
  for (const name of ["haiku", "sonnet", "opus"]) if (m.includes(name)) return name;
  return "";
}

function modelToken(model: unknown): string {
  const m = modelName(model);
  return m ? `--model-${m}` : "--model-script";
}

/** `model ▮▮▮▯ effort · role` */
export function chipText(model: unknown, effort: unknown, role: string): string {
  const parts: string[] = [];
  if (typeof model === "string" && model) parts.push(model);
  const e = str(effort);
  const n = EFFORT_BARS[e.toLowerCase()];
  if (n) parts.push(`${"▮".repeat(n)}${"▯".repeat(4 - n)} ${e}`);
  return parts.length ? `${parts.join(" ")} · ${role}` : role;
}

export function difficultyToken(d: unknown): string {
  const n = Number(d);
  return Number.isFinite(n) && n >= 1 ? `--diff-${Math.min(10, Math.round(n))}` : "--text-4";
}

/** `slice-worker` → `worker` */
export function roleOf(workflow: string | undefined): string {
  const w = workflow ?? "";
  const i = w.lastIndexOf("-");
  return i >= 0 && i < w.length - 1 ? w.slice(i + 1) : w;
}

export function age(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h${String(m % 60).padStart(2, "0")}`;
}

function localClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const time = (ts: string | undefined): number => (ts ? Date.parse(ts) : NaN);

function textWidth(s: string, w: number = G.charW): number {
  return Math.ceil(s.length * w);
}

function lastAgent(s: FoldedSession): FoldedAgent | undefined {
  return s.agents.at(-1);
}

function laneTitle(s: FoldedSession): string {
  return typeof s.task === "string" && s.task !== "" ? s.task : s.id.slice(0, 8);
}

/** The moves of a session's own workflow (frame 0), not of a sub-workflow it pushed. */
function ownMoves(s: FoldedSession): FoldedSession["transitions"] {
  return s.transitions.filter(t => t.workflow === undefined || t.workflow === s.workflow);
}

/** A visit of a station on the main line: which pass, which column, when. */
interface Visit {
  pass: number;
  i: number;
  ts: string;
}

/** Walk a lane's moves over its stations: a move to a column left of (or at) the current one starts a new pass. */
function walk(
  s: FoldedSession,
  index: Map<string, number>,
): { visits: Visit[]; loops: { from: number; to: number; pass: number; name: string }[] } {
  const visits: Visit[] = [{ pass: 0, i: 0, ts: s.started ?? s.transitions[0]?.ts ?? "" }];
  const loops: { from: number; to: number; pass: number; name: string }[] = [];
  let cur = 0;
  let pass = 0;
  for (const t of ownMoves(s)) {
    const i = index.get(t.to);
    if (i === undefined || i === cur) continue;
    if (i < cur) {
      loops.push({ from: cur, to: i, pass, name: str(t.name) });
      pass++;
    }
    visits.push({ pass, i, ts: t.ts });
    cur = i;
  }
  return { visits, loops };
}

/** The visit current at `ts` (the last one not after it). */
function visitAt(visits: readonly Visit[], ts: string | undefined): Visit {
  let at = visits[0];
  for (const v of visits) if (ts === undefined || v.ts <= ts) at = v;
  return at;
}

/** A branch's steps: the child's visited states (its stations when its workflow has some), stops, the live one, the ones ahead. */
function branchSteps(
  c: FoldedSession,
  stations: readonly MapStation[] | undefined,
  now: number,
  clock: (ms: number) => string,
): { name: string; kind: Kind; detail?: string }[] {
  const moves = ownMoves(c);
  const kept = new Set((stations ?? []).filter(st => !st.terminal).map(st => st.name));
  const terminal = new Set((stations ?? []).filter(st => st.terminal).map(st => st.name));
  const keep = (n: string): boolean => (kept.size > 0 ? kept.has(n) : !terminal.has(n));
  const visited: { name: string; ts: string }[] = [];
  const first = moves[0]?.from ?? c.state;
  if (first !== undefined && keep(first)) visited.push({ name: first, ts: c.started ?? "" });
  for (const t of moves)
    if (keep(t.to) && visited.at(-1)?.name !== t.to) visited.push({ name: t.to, ts: t.ts });

  const steps: { name: string; kind: Kind; detail?: string; ts: string }[] = visited.map(v => ({
    ...v,
    kind: "done",
  }));
  // a replaced or stopped agent: a red step after the step it stopped at
  for (const a of c.agents) {
    if (!a.endedAt) continue;
    let at = -1;
    for (let k = 0; k < steps.length; k++) if ((steps[k]?.ts ?? "") <= a.endedAt.ts) at = k;
    steps.splice(at + 1, 0, {
      name: a.status === "stopped" ? "stopped" : "respawn",
      kind: "stop",
      detail: clock(time(a.endedAt.ts)),
      ts: a.endedAt.ts,
    });
  }
  const running = c.outcome === undefined;
  const lastReal = [...steps].reverse().find(st => st.kind !== "stop");
  if (running && lastReal) {
    lastReal.kind = "live";
    const since = time(moves.at(-1)?.ts ?? c.started);
    if (Number.isFinite(since)) lastReal.detail = age(now - since);
  } else if (!running && c.outcome !== "completed" && steps.at(-1)?.kind !== "stop" && lastReal) {
    lastReal.kind = "stop";
  }
  const out: { name: string; kind: Kind; detail?: string }[] = steps.map(st => ({
    name: st.name,
    kind: st.kind,
    ...(st.detail !== undefined ? { detail: st.detail } : {}),
  }));
  if (running && stations && stations.length > 0) {
    const order = stations.map(st => st.name);
    const reached = Math.max(-1, ...visited.map(v => order.indexOf(v.name)));
    for (const st of stations.slice(reached + 1))
      if (!st.terminal) out.push({ name: st.name, kind: "ahead" });
  }
  return out;
}

/** Steps placed between x1 and x2; too many keep the first and the latest, with `…` between. */
function placeSteps(
  key: string,
  steps: readonly { name: string; kind: Kind; detail?: string }[],
  x1: number,
  x2: number,
): MapStep[] {
  const room = Math.max(0, x2 - x1 - 2 * G.stepPad);
  const max = Math.max(2, Math.floor(room / G.stepMin) + 1);
  let shown = [...steps];
  if (shown.length > max) {
    const live = shown.filter(st => st.kind !== "ahead");
    shown = live.length > max ? live : shown.slice(0, max);
    if (shown.length > max)
      shown = [shown[0], { name: "…", kind: "done" }, ...shown.slice(shown.length - (max - 2))];
  }
  const gap = shown.length > 1 ? room / (shown.length - 1) : 0;
  const seen = new Map<string, number>();
  return shown.map((st, k) => {
    const n = (seen.get(st.name) ?? 0) + 1;
    seen.set(st.name, n);
    return {
      key: `${key}:${st.name}:${n}`,
      name: st.name,
      x: Math.round(x1 + G.stepPad + gap * k),
      kind: st.kind,
      ...(st.detail !== undefined ? { detail: st.detail } : {}),
    };
  });
}

interface LaneInput {
  s: FoldedSession;
  children: FoldedSession[];
}

function layLane(
  input: LaneInput,
  stations: readonly MapStation[],
  xs: readonly number[],
  plaqueX: number,
  workflows: Readonly<Record<string, MapWorkflow>>,
  opts: MapOptions,
  labels: boolean,
): Omit<MapLane, "y"> {
  const { s, children } = input;
  const now = opts.now;
  const clock = opts.clock ?? localClock;
  const index = new Map(stations.map((st, i) => [st.name, i]));
  const { visits, loops } = walk(s, index);
  const passCount = Math.max(1, ...visits.map(v => v.pass + 1));
  const status: MapLane["status"] =
    s.outcome === undefined ? "running" : s.outcome === "completed" ? "landed" : "stopped";
  const c = difficultyToken(s.difficulty);
  const n = stations.length;

  // branches: each child under the station its parent stood at when it started (its agent's step when that is a station)
  const branchRows = new Map<string, number>();
  const placed = children
    .slice()
    .sort((a, b) => (a.started ?? "").localeCompare(b.started ?? ""))
    .map(child => {
      const at = visitAt(visits, child.started);
      const stepState = (child.agents[0]?.step as { state?: unknown } | null | undefined)?.state;
      const stepI = typeof stepState === "string" ? index.get(stepState) : undefined;
      const i =
        stepI !== undefined && visits.some(v => v.pass === at.pass && v.i === stepI) ? stepI : at.i;
      const slot = `${at.pass}:${i}`;
      const row = branchRows.get(slot) ?? 0;
      branchRows.set(slot, row + 1);
      return { child, pass: at.pass, i, row };
    });
  const rowsInPass = (p: number): number =>
    Math.max(0, ...placed.filter(b => b.pass === p).map(b => b.row + 1));

  // pass rows, top to bottom
  const passY: number[] = [];
  const passBottom: number[] = [];
  let y = 0;
  for (let p = 0; p < passCount; p++) {
    const main = y + G.mainTop;
    passY.push(main);
    const rows = rowsInPass(p);
    const bottom =
      rows > 0
        ? main + G.branchDrop + (rows - 1) * G.branchRow + G.stepLabels
        : main + G.mainBottom;
    passBottom.push(bottom);
    y = bottom + (p < passCount - 1 ? G.loopGap : 0);
  }

  const branches: MapBranch[] = placed.map(({ child, pass, i, row }) => {
    const x1 = xs[i];
    const x2 = (i + 1 < n ? xs[i + 1] : plaqueX) - G.branchInset;
    const agent = lastAgent(child);
    const role = roleOf(child.workflow);
    const bc = agent ? modelToken(agent.model) : "--model-script";
    const mainY = passY[pass];
    const stepY = mainY + G.branchDrop + row * G.branchRow;
    const key = `${s.id}:b:${child.id}`;
    return {
      key,
      session: child.id,
      pass,
      station: stations[i]?.name ?? "",
      x1,
      x2,
      y: mainY,
      stepY,
      c: bc,
      chip: {
        x: x1 + 10,
        y: mainY + 18 + row * G.branchRow,
        text: agent ? chipText(agent.model, agent.effort, role) : `script · ${role}`,
        c: bc,
      },
      steps: placeSteps(
        key,
        branchSteps(child, workflows[child.workflow ?? ""]?.stations, now, clock),
        x1,
        x2,
      ),
      joined: child.outcome !== undefined,
    };
  });

  // the main line: one segment per pair of consecutive visits in a pass
  const visitCount = new Map<string, number>();
  const execsOf = (name: string): FoldedSession["execs"] =>
    s.execs.filter(x => x.state === name && x.end !== undefined);
  const passes: MapPass[] = [];
  const last = visits.at(-1) as Visit;
  for (let p = 0; p < passCount; p++) {
    const vs = visits.filter(v => v.pass === p);
    const stops: MapStop[] = vs.map(v => {
      const st = stations[v.i];
      const k = (visitCount.get(st.name) ?? 0) + 1;
      visitCount.set(st.name, k);
      let kind: Kind = "done";
      let label: string | undefined;
      if (st.script) {
        const x = execsOf(st.name)[k - 1];
        if (x) {
          const ok = x.exit_code === 0;
          const ms = Number(x.duration_ms);
          label = ok
            ? `${st.name} ✓${Number.isFinite(ms) && ms > 0 ? " " + age(ms) : ""}`
            : `${st.name} ✗ ${x.exit_code === null || x.exit_code === undefined ? "aborted" : "exit " + str(x.exit_code)}`;
          if (!ok) kind = "stop";
        }
      }
      if (v === last && status === "running") kind = "live";
      if (v === last && status === "stopped") kind = "stop";
      return {
        key: `${s.id}:p${p}:${st.name}`,
        station: st.name,
        x: xs[v.i],
        script: st.script,
        kind,
        ...(label !== undefined ? { label } : {}),
      };
    });
    const segments = vs.slice(1).map((v, k) => ({
      key: `${s.id}:p${p}:s${k}`,
      x1: xs[vs[k].i],
      x2: xs[v.i],
    }));
    passes.push({ y: passY[p], stops, segments });
  }

  const mapLoops: MapLoop[] = loops.map((l, k) => {
    const hanging = branches.filter(b => b.pass === l.pass && stations[l.from]?.name === b.station);
    const from = hanging.at(-1);
    return {
      key: `${s.id}:loop${k}`,
      x1: from ? from.x2 : xs[l.from],
      y1: from ? from.stepY : passY[l.pass],
      yBack: passBottom[l.pass] + G.loopGap / 2,
      x2: xs[l.to],
      y2: passY[l.pass + 1],
      label: `↺ ${l.name || "back"}`,
    };
  });

  // the end: landed = a solid line into the plaque; running = a faint tail over the stations ahead
  const endY = passY[passCount - 1];
  const lastX = xs[last.i];
  const ahead =
    status === "running"
      ? stations
          .map((st, i) => ({ st, i }))
          .filter(({ i }) => i > last.i)
          .map(({ st, i }) => ({
            key: `${s.id}:ahead:${st.name}`,
            x: xs[i],
            script: st.script,
          }))
      : [];

  // the plaque: id + state + age, the id cut to fit
  const lastMove = time(s.transitions.at(-1)?.ts ?? s.started);
  const pool = (opts.pool ?? []).includes(s.id);
  const openAsk = s.asks.some(a => a.answered === undefined);
  let sub: string;
  let cls: string;
  if (status === "running") {
    sub = `${s.state ?? stations[last.i]?.name ?? ""}${Number.isFinite(lastMove) ? " " + age(now - lastMove) : ""}`;
    if (pool) sub += " · waiting for the pool";
    else if (openAsk) sub += " · asks the parent";
    cls = pool ? "st-pool" : openAsk ? "st-wait" : "";
  } else {
    const ended = time(s.ended);
    const at = Number.isFinite(ended) ? " " + clock(ended) : "";
    sub = status === "landed" ? `✓${at}` : `✗ ${String(s.outcome)}${at}`;
    cls = status === "landed" ? "st-done" : "st-stop";
  }
  const room = G.plaqueMax - textWidth(sub) - 3 * 10;
  let title = laneTitle(s);
  if (textWidth(title, G.titleW) > room) {
    const chars = Math.max(4, Math.floor(room / G.titleW) - 1);
    title = title.slice(0, chars) + "…";
  }
  const width = Math.min(
    G.plaqueMax,
    textWidth(title, G.titleW) + G.charW * 2 + textWidth(sub) + 3 * 10,
  );

  // the driver chip: the lane's own agent, on the workflow's driver model when it declares one
  const agent = lastAgent(s);
  let driver: MapChip | null = null;
  if (agent && status === "running") {
    const declared = workflows[s.workflow ?? ""]?.driver;
    const model = declared?.model ?? agent.model;
    const effort = declared?.effort ?? agent.effort;
    const runningChild = children.filter(ch => ch.outcome === undefined).at(-1);
    const who = pool
      ? "the pool"
      : runningChild
        ? `the ${roleOf(runningChild.workflow)}`
        : openAsk
          ? "the parent"
          : (s.state ?? "");
    driver = {
      x: plaqueX,
      y: endY + G.plaqueH / 2 + 14,
      text: `driver · ${chipText(model, effort, `waits on ${who}`)}`,
      c: modelToken(model),
    };
  }

  const height = Math.max(
    passBottom[passCount - 1] + 4,
    driver ? driver.y + 12 : endY + G.plaqueH / 2 + 4,
  );

  return {
    key: s.id,
    session: s.id,
    workflow: s.workflow ?? "",
    status,
    height,
    c,
    start: { x: xs[0], y: passY[0] },
    passes,
    loops: mapLoops,
    branches,
    end: { x1: lastX, x2: plaqueX, y: endY, faint: status === "running" },
    ahead,
    plaque: { x: plaqueX, y: endY, width, title, sub, cls, c: cls === "" ? c : "" },
    driver,
    labels,
    highlight: opts.highlight === s.id,
  };
}

/** Which sessions are lanes: a root with no children, or a child of a root with children (a dispatcher); their children hang as branches. */
function classify(folded: ReadonlyMap<string, FoldedSession>): {
  lanes: LaneInput[];
  dispatchers: Set<string>;
} {
  const childrenOf = new Map<string, FoldedSession[]>();
  for (const s of folded.values())
    if (s.parent !== null && folded.has(s.parent)) {
      const list = childrenOf.get(s.parent) ?? [];
      list.push(s);
      childrenOf.set(s.parent, list);
    }
  const isRoot = (s: FoldedSession): boolean => s.parent === null || !folded.has(s.parent);
  const dispatchers = new Set<string>();
  const lanes: LaneInput[] = [];
  for (const s of folded.values()) {
    if (!s.workflow) continue;
    const kids = childrenOf.get(s.id) ?? [];
    if (isRoot(s)) {
      if (kids.length > 0) dispatchers.add(s.id);
      else lanes.push({ s, children: [] });
    }
  }
  for (const d of dispatchers)
    for (const s of childrenOf.get(d) ?? [])
      if (s.workflow)
        lanes.push({ s, children: (childrenOf.get(s.id) ?? []).filter(c => c.workflow) });
  return { lanes, dispatchers };
}

/** The columns of a band: the workflow's stations, else the states its lanes visited, in first-visit order. */
function bandStations(
  workflow: string,
  lanes: readonly LaneInput[],
  workflows: Readonly<Record<string, MapWorkflow>>,
): MapStation[] {
  const declared = workflows[workflow]?.stations ?? [];
  if (declared.length > 0) return [...declared];
  const seen: string[] = [];
  for (const { s } of lanes) {
    const moves = ownMoves(s);
    for (const name of [moves[0]?.from, ...moves.map(t => t.to)])
      if (name !== undefined && !seen.includes(name)) seen.push(name);
  }
  return seen.map(name => ({ name, script: false, terminal: false }));
}

/**
 * The whole map. Bands by workflow (alphabetical); in a band landed lanes on top (oldest first; older
 * than an hour folded into `landed earlier:`), then the parent rail and the running lanes (oldest
 * first); the queue's `next:` row under the last band.
 */
export function layout(
  folded: ReadonlyMap<string, FoldedSession>,
  workflows: Readonly<Record<string, MapWorkflow>>,
  opts: MapOptions,
): MapLayout {
  const { lanes, dispatchers } = classify(folded);
  const foldAfter = opts.foldAfterMs ?? 3600_000;
  const byWorkflow = new Map<string, LaneInput[]>();
  for (const l of lanes) {
    const list = byWorkflow.get(l.s.workflow as string) ?? [];
    list.push(l);
    byWorkflow.set(l.s.workflow as string, list);
  }
  const running = lanes.filter(l => l.s.outcome === undefined).length;
  const labels = running < G.manyRunning;

  const bands: MapBand[] = [];
  let y = 0;
  let width = 0;
  for (const workflow of [...byWorkflow.keys()].sort()) {
    const group = byWorkflow.get(workflow) as LaneInput[];
    const stations = bandStations(workflow, group, workflows);
    if (stations.length === 0) continue;
    const n = stations.length;
    const fit =
      opts.width !== undefined
        ? Math.floor((opts.width - G.left - G.plaqueGap - G.plaqueMax) / Math.max(1, n - 1))
        : G.col;
    const col = Math.max(G.minCol, Math.min(G.col, fit));
    const xs = stations.map((_, i) => G.left + i * col);
    const plaqueX = xs[n - 1] + G.plaqueGap;
    const bandWidth = plaqueX + G.plaqueMax + 20;
    width = Math.max(width, bandWidth);

    const ended = group
      .filter(l => l.s.outcome !== undefined)
      .sort((a, b) => (a.s.ended ?? "").localeCompare(b.s.ended ?? ""));
    const earlierLanes = ended.filter(l => opts.now - time(l.s.ended) > foldAfter);
    const recent = ended.filter(l => !earlierLanes.includes(l));
    const live = group
      .filter(l => l.s.outcome === undefined)
      .sort((a, b) => (a.s.started ?? "").localeCompare(b.s.started ?? ""));

    let by = G.bandTop;
    let landedY: number | null = null;
    let earlier: MapStrip | null = null;
    const laid: MapLane[] = [];
    if (ended.length > 0) {
      landedY = by;
      by += G.sectionLabel;
      if (earlierLanes.length > 0) {
        const newest = [...earlierLanes].reverse();
        earlier = {
          y: by,
          lead: "landed earlier:",
          items: newest.slice(0, G.earlierShown).map(l => ({
            key: l.s.id,
            id: laneTitle(l.s),
            c: l.s.outcome === "completed" ? "--ok" : "--bad",
          })),
          more: Math.max(0, newest.length - G.earlierShown),
        };
        by += G.strip;
      }
      for (const l of recent) {
        const lane = layLane(l, stations, xs, plaqueX, workflows, opts, labels);
        laid.push({ ...lane, y: by });
        by += lane.height + G.laneGap;
      }
    }
    let runningY: number | null = null;
    let rail: MapRail | null = null;
    if (live.length > 0) {
      runningY = by;
      by += G.sectionLabel;
      // the parent rail: the dispatcher most running lanes of the band answer to
      const parents = new Map<string, number>();
      for (const l of live)
        if (l.s.parent !== null && dispatchers.has(l.s.parent))
          parents.set(l.s.parent, (parents.get(l.s.parent) ?? 0) + 1);
      const parent = [...parents].sort((a, b) => b[1] - a[1])[0]?.[0];
      let railY = 0;
      if (parent !== undefined) {
        railY = by + G.rail / 2;
        by += G.rail;
      }
      const runningLanes: MapLane[] = [];
      for (const l of live) {
        const lane = layLane(l, stations, xs, plaqueX, workflows, opts, true);
        runningLanes.push({ ...lane, y: by });
        by += lane.height + G.laneGap;
      }
      laid.push(...runningLanes);
      if (parent !== undefined) {
        const p = folded.get(parent) as FoldedSession;
        const asks: MapAsk[] = [];
        for (const lane of runningLanes) {
          const input = live.find(l => l.s.id === lane.session) as LaneInput;
          const index = new Map(stations.map((st, i) => [st.name, i]));
          const { visits } = walk(input.s, index);
          for (const [k, a] of input.s.asks.entries()) {
            const v = visitAt(visits, a.at);
            const i = index.get(String(a.state)) ?? v.i;
            const pass = lane.passes[v.pass] ?? lane.passes.at(-1);
            const wait = a.answered !== undefined ? age(time(a.answered) - time(a.at)) : "";
            asks.push({
              key: `${lane.session}:ask${k}`,
              x: xs[i],
              y1: railY,
              y2: lane.y + (pass?.y ?? 0),
              label: `? ${String(a.state)}`,
              answer: a.answered !== undefined ? `→ ${a.to ?? ""} · ${wait}` : null,
            });
          }
          for (const b of lane.branches) {
            const child = folded.get(b.session) as FoldedSession;
            for (const [k, a] of child.asks.entries()) {
              const step = b.steps.find(st => st.name === a.state);
              const wait = a.answered !== undefined ? age(time(a.answered) - time(a.at)) : "";
              asks.push({
                key: `${b.session}:ask${k}`,
                x: step?.x ?? b.x1,
                y1: railY,
                y2: lane.y + b.stepY,
                label: `? ${String(a.state)}`,
                answer: a.answered !== undefined ? `→ ${a.to ?? ""} · ${wait}` : null,
              });
            }
          }
        }
        const userAsk = p.asks.filter(a => a.answered === undefined).at(-1);
        rail = {
          session: parent,
          y: railY,
          x1: G.left - 50,
          x2: plaqueX,
          label: `parent agent · ${p.workflow ?? ""} · ${parent.slice(0, 8)}`,
          asks,
          user: userAsk
            ? {
                x: xs[n - 1] - Math.round(col / 2),
                label: `⏸ ${String(userAsk.state)} · asked the user · open ${age(opts.now - time(userAsk.at))}`,
              }
            : null,
        };
      }
    }
    const height = by - G.laneGap + G.bandBottom;
    bands.push({
      key: workflow,
      workflow,
      y,
      height,
      width: bandWidth,
      stations: stations.map((st, i) => ({ ...st, x: xs[i] })),
      plaqueX,
      landedY,
      runningY,
      earlier,
      rail,
      lanes: laid,
    });
    y += height + G.bandGap;
  }

  const ready = opts.next ?? [];
  const next: MapStrip | null =
    ready.length > 0
      ? {
          y,
          lead: "next:",
          items: ready
            .slice(0, G.nextShown)
            .map((l, i) => ({ key: `${i}:${l.id}`, id: l.id, c: difficultyToken(l.difficulty) })),
          more: Math.max(0, ready.length - G.nextShown),
        }
      : null;
  return {
    width: Math.max(width, opts.width ?? 0),
    height: y + (next ? G.strip : 0),
    bands,
    next,
  };
}

// --- the scene: keyed SVG primitives ---

export interface SceneEl {
  readonly key: string;
  readonly tag: "path" | "circle" | "rect" | "text";
  readonly cls: string;
  readonly attrs: Readonly<Record<string, string | number>>;
  readonly text?: string;
  /** a token the element's `--c` names */
  readonly c?: string;
  /** a new path draws itself (stroke-dashoffset) instead of fading in */
  readonly draw?: boolean;
}

export interface SceneGroup {
  readonly key: string;
  readonly cls: string;
  /** translation from the parent group */
  readonly y: number;
  readonly els: readonly SceneEl[];
  readonly groups: readonly SceneGroup[];
}

const r = (n: number): number => Math.round(n * 10) / 10;

function plaqueEls(
  key: string,
  x: number,
  y: number,
  title: string,
  sub: string,
  cls: string,
  c: string,
  width: number,
): SceneEl[] {
  return [
    {
      key: `${key}:box`,
      tag: "rect",
      cls: `m-plaque${cls ? " " + cls : ""}`,
      attrs: { x, y: y - G.plaqueH / 2, width, height: G.plaqueH, rx: G.plaqueH / 2 },
      ...(c ? { c } : {}),
    },
    {
      key: `${key}:text`,
      tag: "text",
      cls: "m-plaque-text",
      attrs: { x: x + 10, y: y + 4 },
      text: title,
    },
    {
      key: `${key}:sub`,
      tag: "text",
      cls: "m-plaque-sub",
      attrs: { x: x + 10 + textWidth(title, G.titleW) + 10, y: y + 4 },
      text: sub,
    },
  ];
}

function chipEls(key: string, chip: MapChip, extra = ""): SceneEl[] {
  const w = textWidth(chip.text, G.chipW) + 16;
  return [
    {
      key: `${key}:box`,
      tag: "rect",
      cls: `m-chip${extra}`,
      attrs: { x: chip.x, y: chip.y - 8, width: w, height: 16, rx: 8 },
      c: chip.c,
    },
    {
      key: `${key}:text`,
      tag: "text",
      cls: "m-chip-text",
      attrs: { x: chip.x + 8, y: chip.y + 3.5 },
      text: chip.text,
      c: chip.c,
    },
  ];
}

function stripEls(key: string, s: MapStrip, x: number): SceneEl[] {
  const els: SceneEl[] = [
    { key: `${key}:lead`, tag: "text", cls: "m-lead", attrs: { x, y: s.y + 15 }, text: s.lead },
  ];
  let at = x + textWidth(s.lead) + 10;
  for (const it of s.items) {
    const w = textWidth(it.id, G.titleW) + 20;
    els.push(
      {
        key: `${key}:${it.key}:box`,
        tag: "rect",
        cls: "m-plaque",
        attrs: { x: at, y: s.y + 4, width: w, height: 18, rx: 9 },
        c: it.c,
      },
      {
        key: `${key}:${it.key}:text`,
        tag: "text",
        cls: "m-plaque-text",
        attrs: { x: at + 10, y: s.y + 17 },
        text: it.id,
      },
    );
    at += w + 8;
  }
  if (s.more > 0)
    els.push({
      key: `${key}:more`,
      tag: "text",
      cls: "m-lead",
      attrs: { x: at, y: s.y + 17 },
      text: `+${s.more}`,
    });
  return els;
}

function nodeEl(
  key: string,
  x: number,
  y: number,
  script: boolean,
  kind: Kind,
  c: string,
  size: number,
): SceneEl {
  const cls = `m-node ${kind}`;
  return script
    ? {
        key,
        tag: "rect",
        cls: cls + " m-script",
        attrs: { x: x - size, y: y - size, width: 2 * size, height: 2 * size, rx: 2 },
        c,
      }
    : { key, tag: "circle", cls, attrs: { cx: x, cy: y, r: size }, c };
}

function laneScene(lane: MapLane): SceneGroup {
  const els: SceneEl[] = [];
  const k = lane.key;
  // the main line: segments per pass, loops between passes, the end into the plaque
  for (const p of lane.passes)
    for (const seg of p.segments)
      els.push({
        key: seg.key,
        tag: "path",
        cls: "m-main",
        attrs: { d: `M${seg.x1},${p.y}H${seg.x2}` },
        c: lane.c,
        draw: true,
      });
  for (const l of lane.loops)
    els.push(
      {
        key: l.key,
        tag: "path",
        cls: "m-loop",
        attrs: { d: `M${l.x1},${l.y1}V${l.yBack}H${l.x2}V${l.y2}` },
        c: lane.c,
        draw: true,
      },
      {
        key: `${l.key}:label`,
        tag: "text",
        cls: "m-label m-mid",
        attrs: { x: r((l.x1 + l.x2) / 2), y: l.yBack - 5 },
        text: l.label,
      },
    );
  els.push({
    key: `${k}:end`,
    tag: "path",
    cls: lane.end.faint ? "m-tail" : "m-main",
    attrs: { d: `M${lane.end.x1},${lane.end.y}H${lane.end.x2}` },
    c: lane.c,
    draw: !lane.end.faint,
  });
  for (const a of lane.ahead)
    els.push(nodeEl(a.key, a.x, lane.end.y, a.script, "ahead", lane.c, 4));
  // branches: down from the station, sideways step by step, back up (or a faint tail back)
  for (const b of lane.branches) {
    const real = b.steps.filter(st => st.kind !== "ahead");
    const lastX = real.at(-1)?.x ?? b.x1;
    els.push({
      key: `${b.key}:line`,
      tag: "path",
      cls: "m-branch",
      attrs: {
        d: b.joined
          ? `M${b.x1},${b.y}V${b.stepY}H${b.x2}V${b.y}`
          : `M${b.x1},${b.y}V${b.stepY}H${lastX}`,
      },
      c: b.c,
      draw: true,
    });
    if (!b.joined)
      els.push({
        key: `${b.key}:tail`,
        tag: "path",
        cls: "m-tail",
        attrs: { d: `M${lastX},${b.stepY}H${b.x2}V${b.y}` },
        c: b.c,
      });
    els.push(...chipEls(`${b.key}:chip`, b.chip));
    for (const st of b.steps) {
      els.push({
        key: st.key,
        tag: "circle",
        cls: `m-step ${st.kind}`,
        attrs: { cx: st.x, cy: b.stepY, r: st.kind === "live" ? 6 : 4 },
        c: st.kind === "stop" ? "--bad" : b.c,
      });
      if (lane.labels || st.kind === "live")
        els.push({
          key: `${st.key}:label`,
          tag: "text",
          cls: `m-label m-mid${st.kind === "ahead" ? " ahead" : st.kind === "stop" ? " stop" : ""}`,
          attrs: { x: st.x, y: b.stepY + 17 },
          text: st.name,
        });
      if (st.detail !== undefined && (lane.labels || st.kind === "live"))
        els.push({
          key: `${st.key}:detail`,
          tag: "text",
          cls: `m-detail m-mid${st.kind === "stop" ? " stop" : ""}`,
          attrs: { x: st.x, y: b.stepY + 29 },
          text: st.detail,
          c: b.c,
        });
    }
  }
  // stations on the line, the start dot, exec verdicts
  els.push({
    key: `${k}:start`,
    tag: "circle",
    cls: "m-start",
    attrs: { cx: lane.start.x, cy: lane.start.y, r: 6 },
    c: lane.c,
  });
  for (const p of lane.passes)
    for (const st of p.stops) {
      if (st.x === lane.start.x && p === lane.passes[0] && st.kind === "done") continue;
      els.push(nodeEl(st.key, st.x, p.y, st.script, st.kind, lane.c, 5));
      if (st.label !== undefined && lane.labels)
        els.push({
          key: `${st.key}:label`,
          tag: "text",
          cls: `m-label m-mid${st.kind === "stop" ? " stop" : ""}`,
          attrs: { x: st.x, y: p.y - 11 },
          text: st.label,
        });
    }
  els.push(
    ...plaqueEls(
      `${k}:plaque`,
      lane.plaque.x,
      lane.plaque.y,
      lane.plaque.title,
      lane.plaque.sub,
      lane.plaque.cls,
      lane.plaque.c,
      lane.plaque.width,
    ),
  );
  if (lane.driver) els.push(...chipEls(`${k}:driver`, lane.driver, " m-driver"));
  return {
    key: `lane:${k}`,
    cls: `m-lane ${lane.status}${lane.highlight ? " m-hl" : ""}`,
    y: lane.y,
    els,
    groups: [],
  };
}

function bandScene(band: MapBand): SceneGroup {
  const k = `band:${band.key}`;
  const els: SceneEl[] = [
    {
      key: `${k}:panel`,
      tag: "rect",
      cls: "m-panel",
      attrs: { x: 0, y: 0, width: band.width, height: band.height, rx: 16 },
    },
    {
      key: `${k}:title`,
      tag: "text",
      cls: "m-title",
      attrs: { x: 20, y: 26 },
      text: band.workflow,
    },
  ];
  for (const st of band.stations)
    els.push(
      {
        key: `${k}:grid:${st.name}`,
        tag: "path",
        cls: "m-grid",
        attrs: { d: `M${st.x},${58}V${band.height - 12}` },
      },
      {
        key: `${k}:station:${st.name}`,
        tag: "text",
        cls: `m-station m-mid${st.terminal ? " end" : ""}`,
        attrs: { x: st.x, y: 50 },
        text: st.name,
      },
    );
  const section = (y: number | null, text: string): void => {
    if (y === null) return;
    els.push(
      {
        key: `${k}:sep:${text}`,
        tag: "path",
        cls: "m-sep",
        attrs: { d: `M20,${y}H${band.width - 20}` },
      },
      {
        key: `${k}:sec:${text}`,
        tag: "text",
        cls: "m-section",
        attrs: { x: band.width - 24, y: y + 14 },
        text,
      },
    );
  };
  section(band.landedY, "LANDED");
  section(band.runningY, "RUNNING");
  if (band.earlier) els.push(...stripEls(`${k}:earlier`, band.earlier, 20));
  const rail = band.rail;
  if (rail) {
    els.push(
      {
        key: `${k}:rail`,
        tag: "path",
        cls: "m-rail",
        attrs: { d: `M${rail.x1},${rail.y}H${rail.x2}` },
        draw: true,
      },
      {
        key: `${k}:rail:label`,
        tag: "text",
        cls: "m-rail-label",
        attrs: { x: rail.x1, y: rail.y - 7 },
        text: rail.label,
      },
    );
    for (const a of rail.asks) {
      els.push(
        {
          key: `${a.key}:up`,
          tag: "path",
          cls: "m-ask",
          attrs: { d: `M${a.x},${a.y2}V${a.y1}` },
        },
        {
          key: `${a.key}:q`,
          tag: "text",
          cls: "m-ask-label m-end",
          attrs: { x: a.x - 6, y: a.y1 - 7 },
          text: a.label,
        },
      );
      if (a.answer !== null)
        els.push(
          {
            key: `${a.key}:down`,
            tag: "path",
            cls: "m-answer",
            attrs: { d: `M${a.x + 6},${a.y1}V${a.y2}` },
            draw: true,
          },
          {
            key: `${a.key}:a`,
            tag: "text",
            cls: "m-answer-label",
            attrs: { x: a.x + 12, y: a.y1 - 7 },
            text: a.answer,
          },
        );
    }
    if (rail.user)
      els.push(
        {
          key: `${k}:user`,
          tag: "rect",
          cls: "m-user",
          attrs: { x: rail.user.x - 6, y: rail.y - 6, width: 12, height: 12, rx: 2 },
        },
        {
          key: `${k}:user:label`,
          tag: "text",
          cls: "m-ask-label",
          attrs: { x: rail.user.x + 12, y: rail.y - 9 },
          text: rail.user.label,
        },
      );
  }
  return { key: k, cls: "m-band", y: band.y, els, groups: band.lanes.map(laneScene) };
}

/** The keyed primitives of a layout: one group per band, one per lane inside it. */
export function scene(map: MapLayout): SceneGroup {
  const els: SceneEl[] = map.next ? stripEls("next", map.next, 20) : [];
  return { key: "map", cls: "m-root", y: 0, els, groups: map.bands.map(bandScene) };
}
