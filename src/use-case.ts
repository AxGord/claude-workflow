// The numbers and the workflow facts of the site's use-case page (docs/use-case-anyparse.md): how the open-source
// anyparse project is run on this engine. `foldUseCase` reads the ledger's lines of ONE project's task pipeline into
// counts and sums (lands, $ per land, the cost by stage and by review rounds, what the recon did, how many pipelines
// were open at once); `workflowFacts` reads the thresholds and the model table out of the project's own workflow
// files, so the page's diagrams take them from the files and not from memory. Pure: scripts/export-use-case.mjs
// reads the files and writes the snapshot (docs/use-case-anyparse.json), a dated cut that names no task, no
// session and no path. The path a line takes over those facts is `slicePath` (src/use-case-path.ts).
import path from "node:path";
import { bandOf } from "./calibration.js";
import type { LedgerEntry } from "./ledger.js";
import type { ModelTable } from "./types.js";
import type { PathFacts } from "./use-case-path.js";

export interface UseCaseOptions {
  /** The project's directory name (the basename of its git root): the only project read. */
  readonly project: string;
  /** The task workflow whose finished sessions are the runs. */
  readonly workflow: string;
  /** Lands between two curator runs (default 20): the size of the windows the lands are cut into. */
  readonly every?: number;
}

/** A count of landed lines with what they cost. `median` and `mean` are over the `measured` ones. */
export interface CostGroup {
  readonly lands: number;
  /** Lands whose agents' spend was read from their transcripts. */
  readonly measured: number;
  readonly median: number | null;
  readonly mean: number | null;
}

export interface UseCaseStats {
  /** The first run's start and the last run's end (ISO): the snapshot's window. */
  readonly from: string;
  readonly to: string;
  /** Finished runs of the pipeline, by how they ended. */
  readonly runs: {
    readonly total: number;
    readonly landed: number;
    /** Closed with its smaller lines queued in its place. */
    readonly split: number;
    /** Closed without landing: a refuted premise, a blocked worker, a rejected review. */
    readonly closed: number;
    readonly other: number;
  };
  /** Lands per UTC day, every day of the window. */
  readonly days: readonly { readonly day: string; readonly lands: number }[];
  /** Every landed line: what one cost. */
  readonly cost: CostGroup & { readonly usd: number };
  /** Landed lines by their review rounds. */
  readonly rounds: readonly (CostGroup & { readonly rounds: number })[];
  /** Landed lines by the difficulty their stages ran on. */
  readonly difficulty: readonly (CostGroup & { readonly difficulty: number })[];
  /** Where a landed line's $ went, over the lands that carry a per-agent record. */
  readonly stages: {
    readonly lands: number;
    readonly usd: number;
    readonly rows: readonly { readonly stage: string; readonly usd: number }[];
  };
  /** What the read-only recon did with the lines it read. */
  readonly recon: {
    readonly ran: number;
    /** Its score was the line's own. */
    readonly kept: number;
    readonly up: number;
    readonly down: number;
    /** It scored the line too big and its pieces were queued. */
    readonly split: number;
    /** It refuted a premise and the line was closed. */
    readonly closed: number;
    /** The parent overrode its stop. */
    readonly overridden: number;
    /** What a run cost that the recon stopped before any worker. */
    readonly stopped: { readonly measured: number; readonly median: number | null };
  };
  /** What the plan stage did beyond planning. */
  readonly plan: {
    /** It scored the work past its own row and handed its plan to an executor. */
    readonly handoffs: number;
    /** A worker split the line. */
    readonly splits: number;
  };
  /** Hours of the window by the number of pipelines open at once. */
  readonly slots: readonly { readonly open: number; readonly hours: number }[];
  /** Landed lines by difficulty band (the band of the difficulty the stages ran on): what a calibration reads. */
  readonly bands: readonly (CostGroup & {
    readonly band: string;
    /** Mean review rounds of the band's lands. */
    readonly rounds: number;
    /** Lands whose difficulty was moved from the line's. */
    readonly moved: number;
    /** Per stage, over the band's lands with a per-agent record: $ per such land and the model families that ran it, the costliest first. */
    readonly stages: readonly {
      readonly stage: string;
      readonly usd: number;
      readonly models: readonly string[];
    }[];
  })[];
  /** The lands in the order they ended, cut into windows of `every`: what each curator run had in front of it. */
  readonly windows: {
    readonly every: number;
    readonly rows: readonly {
      readonly measured: number;
      readonly median: number | null;
      readonly rounds: number;
    }[];
    /** Lands after the last full window. */
    readonly rest: number;
  };
}

const cents = (n: number): number => Math.round(n * 100) / 100;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return cents(s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

function costGroup(entries: readonly LedgerEntry[]): CostGroup {
  const usd = entries.flatMap(e => (e.spend?.usd === undefined ? [] : [e.spend.usd]));
  return {
    lands: entries.length,
    measured: usd.length,
    median: median(usd),
    mean: usd.length === 0 ? null : cents(usd.reduce((a, b) => a + b, 0) / usd.length),
  };
}

const visited = (e: LedgerEntry, state: string): number => e.visits?.[state] ?? 0;

/** A run that went through the land and its bookkeeping. */
const landed = (e: LedgerEntry): boolean =>
  e.outcome === "completed" && (visited(e, "mark_landed") > 0 || visited(e, "bookkeeping") > 0);

/** The stages a landed line's $ is shown by; an agent no stage names is the driver (linked by the dispatcher) or `other`. */
const STAGE_ORDER = ["recon", "plan", "execute", "fix", "review", "driver", "other"] as const;

function stageOf(row: { readonly stage?: string; readonly state?: string }): string {
  if (row.stage === "review_verify") return "review";
  if (row.stage !== undefined)
    return (STAGE_ORDER as readonly string[]).includes(row.stage) ? row.stage : "other";
  return row.state === "dispatch" || row.state === "collect" ? "driver" : "other";
}

const FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;

/** A model id's family (`claude-opus-5-5` is `opus`); an id of no known family stays as it is. */
const family = (model: string): string => FAMILIES.find(name => model.includes(name)) ?? model;

const meanRounds = (entries: readonly LedgerEntry[]): number =>
  entries.length === 0
    ? 0
    : cents(entries.reduce((sum, e) => sum + visited(e, "review"), 0) / entries.length);

/** Per stage over `entries`' per-agent rows: $ per entry, and the model families by what they cost. */
function stageRows(
  entries: readonly LedgerEntry[],
): { stage: string; usd: number; models: string[] }[] {
  const usd = new Map<string, number>();
  const models = new Map<string, Map<string, number>>();
  for (const e of entries)
    for (const row of e.spend?.by_agent ?? []) {
      const stage = stageOf(row);
      usd.set(stage, (usd.get(stage) ?? 0) + (row.usd ?? 0));
      if (row.model === undefined) continue;
      const of = models.get(stage) ?? new Map<string, number>();
      of.set(family(row.model), (of.get(family(row.model)) ?? 0) + (row.usd ?? 0));
      models.set(stage, of);
    }
  return STAGE_ORDER.filter(stage => (usd.get(stage) ?? 0) > 0).map(stage => ({
    stage,
    usd: cents((usd.get(stage) ?? 0) / entries.length),
    models: [...(models.get(stage) ?? [])]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => name),
  }));
}

function groupBy<K extends number>(
  entries: readonly LedgerEntry[],
  key: (e: LedgerEntry) => K | undefined,
): Map<K, LedgerEntry[]> {
  const out = new Map<K, LedgerEntry[]>();
  for (const e of entries) {
    const k = key(e);
    if (k === undefined) continue;
    out.set(k, [...(out.get(k) ?? []), e]);
  }
  return new Map([...out].sort((a, b) => a[0] - b[0]));
}

/** The ledger's finished runs of one project's task pipeline, counted. Throws when there is none. */
export function foldUseCase(entries: readonly LedgerEntry[], o: UseCaseOptions): UseCaseStats {
  const runs = entries.filter(
    e =>
      e.workflow === o.workflow &&
      e.project !== undefined &&
      path.basename(e.project) === o.project &&
      !Number.isNaN(Date.parse(e.started_at)) &&
      !Number.isNaN(Date.parse(e.ended_at)),
  );
  if (runs.length === 0)
    throw new Error(`the ledger holds no finished ${o.workflow} run of ${o.project}`);
  const lands = runs.filter(landed);
  const split = runs.filter(e => !landed(e) && visited(e, "mark_split") > 0);
  const closed = runs.filter(
    e =>
      !landed(e) &&
      visited(e, "mark_split") === 0 &&
      (visited(e, "mark_closed") > 0 || visited(e, "closed") > 0),
  );

  const start = Math.min(...runs.map(e => Date.parse(e.started_at)));
  const end = Math.max(...runs.map(e => Date.parse(e.ended_at)));
  const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const perDay = new Map<string, number>();
  for (let t = Date.parse(`${dayOf(start)}T00:00:00Z`); t <= end; t += 86_400_000)
    perDay.set(dayOf(t), 0);
  for (const e of lands) {
    const day = dayOf(Date.parse(e.ended_at));
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }

  const withAgents = lands.filter(
    e => e.spend?.usd !== undefined && (e.spend.by_agent?.length ?? 0) > 0,
  );
  const byStage = new Map<string, number>(STAGE_ORDER.map(s => [s, 0]));
  for (const e of withAgents)
    for (const row of e.spend?.by_agent ?? []) {
      const stage = stageOf(row);
      byStage.set(stage, (byStage.get(stage) ?? 0) + (row.usd ?? 0));
    }

  const read = runs.filter(e => visited(e, "recon_end") > 0);
  const scored = read.filter(e => visited(e, "recon_scored") > 0);
  const moved = (e: LedgerEntry): number =>
    e.difficulty === undefined || e.claim_difficulty === undefined
      ? 0
      : Math.sign(e.difficulty - e.claim_difficulty);
  const stops = read.filter(e => visited(e, "recon_blocked") > 0);
  const stoppedCold = stops.filter(e => visited(e, "work") === 0);

  // every start opens a slot and every end frees one: the time between two changes is spent at one count
  const changes = runs
    .flatMap(e => [
      [Date.parse(e.started_at), 1],
      [Date.parse(e.ended_at), -1],
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const open = new Map<number, number>();
  let count = 0;
  let last = start;
  for (const [at, step] of changes) {
    open.set(count, (open.get(count) ?? 0) + (at - last));
    last = at;
    count += step;
  }

  const BANDS = ["1-3", "4-6", "7-10"];
  const every = o.every ?? 20;
  const inOrder = [...lands].sort(
    (a, b) =>
      Date.parse(a.ended_at) - Date.parse(b.ended_at) || a.session_id.localeCompare(b.session_id),
  );
  const full = Math.floor(inOrder.length / every);

  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    runs: {
      total: runs.length,
      landed: lands.length,
      split: split.length,
      closed: closed.length,
      other: runs.length - lands.length - split.length - closed.length,
    },
    days: [...perDay].map(([day, n]) => ({ day, lands: n })),
    cost: {
      ...costGroup(lands),
      usd: cents(lands.reduce((sum, e) => sum + (e.spend?.usd ?? 0), 0)),
    },
    rounds: [...groupBy(lands, e => visited(e, "review"))].map(([rounds, es]) => ({
      rounds,
      ...costGroup(es),
    })),
    difficulty: [...groupBy(lands, e => e.difficulty)].map(([difficulty, es]) => ({
      difficulty,
      ...costGroup(es),
    })),
    stages: {
      lands: withAgents.length,
      usd: cents([...byStage.values()].reduce((a, b) => a + b, 0)),
      rows: [...byStage].map(([stage, usd]) => ({ stage, usd: cents(usd) })),
    },
    recon: {
      ran: read.length,
      kept: scored.filter(e => moved(e) === 0).length,
      up: scored.filter(e => moved(e) > 0).length,
      down: scored.filter(e => moved(e) < 0).length,
      split: stops.filter(e => visited(e, "work") === 0 && visited(e, "mark_split") > 0).length,
      closed: stops.filter(e => visited(e, "work") === 0 && visited(e, "mark_closed") > 0).length,
      overridden: stops.filter(e => visited(e, "work") > 0).length,
      stopped: {
        measured: stoppedCold.filter(e => e.spend?.usd !== undefined).length,
        median: median(stoppedCold.flatMap(e => (e.spend?.usd === undefined ? [] : [e.spend.usd]))),
      },
    },
    plan: {
      handoffs: runs.filter(e => visited(e, "rescored") > 0).length,
      splits: runs.filter(e => visited(e, "mark_split") > 0 && visited(e, "recon_blocked") === 0)
        .length,
    },
    slots: [...open]
      .sort((a, b) => a[0] - b[0])
      .map(([n, ms]) => ({ open: n, hours: Math.round(ms / 360_000) / 10 }))
      .filter(s => s.hours > 0),
    bands: BANDS.map(band => {
      const of = lands.filter(e => bandOf(e.difficulty) === band);
      return {
        band,
        ...costGroup(of),
        rounds: meanRounds(of),
        moved: of.filter(e => moved(e) !== 0).length,
        stages: stageRows(of.filter(e => withAgents.includes(e))),
      };
    }),
    windows: {
      every,
      rows: Array.from({ length: full }, (_, i) => {
        const of = inOrder.slice(i * every, (i + 1) * every);
        const group = costGroup(of);
        return { measured: group.measured, median: group.median, rounds: meanRounds(of) };
      }),
      rest: inOrder.length - full * every,
    },
  };
}

/** What the page's diagrams take from the project's workflow files. */
export interface WorkflowFacts extends PathFacts {
  /** Fix rounds a worker's own red gate may take before the worker is blocked (the gate's `FIX_ROUNDS` bound). */
  readonly gate_fix_rounds: number;
  /** The machine-wide lock a land holds (`land`'s `resource.locks`). */
  readonly land_lock: string;
  /** Review rounds a line may take before it is rejected (`fixes.max_visits`). */
  readonly fix_rounds: number;
}

type Doc = Readonly<Record<string, unknown>>;

const isDoc = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);

function stateOf(workflow: Doc, name: string, file: string): Doc {
  const states = workflow.states;
  const state = isDoc(states) ? states[name] : undefined;
  if (!isDoc(state)) throw new Error(`${file}: no state ${name}`);
  return state;
}

/** The first capture of `pattern` in a state's text field, or a refusal naming what the file no longer says. */
function captured(state: Doc, field: string, pattern: RegExp, what: string): string {
  const text = state[field];
  const found = typeof text === "string" ? pattern.exec(text) : null;
  if (!found) throw new Error(`${what}: ${field} no longer matches ${pattern}`);
  return found[1];
}

/**
 * The thresholds and rows of anyparse's slice pipeline, read from its parsed workflow files: `pipeline` is
 * slice-pipeline.yaml (its `model_table`, `driver`, the recon threshold in `recon_route`, the split threshold in
 * `recon_end`, the scores `plan_route` sends straight to an executor, `fixes.max_visits`, the land's lock), `worker` is
 * slice-worker.yaml, whose plan stage must name the same scores and whose gate bounds its own fix rounds. A file that
 * no longer says one of them refuses. `tableFrom` is the pipeline file whose `model_table` is shown when that is
 * not today's (a dated copy: the table in force while the ledger's runs were made).
 */
export function workflowFacts(
  pipeline: unknown,
  worker: unknown,
  tableFrom: unknown = pipeline,
): WorkflowFacts {
  if (!isDoc(pipeline) || !isDoc(worker) || !isDoc(tableFrom))
    throw new Error("a workflow file is not a mapping");
  const table = tableFrom.model_table as ModelTable | undefined;
  if (!table?.stages) throw new Error("slice-pipeline: no model_table.stages");
  const driver = pipeline.driver;
  if (!isDoc(driver) || typeof driver.model !== "string" || typeof driver.effort !== "string")
    throw new Error("slice-pipeline: no driver block with a model and an effort");
  const state = (name: string): Doc => stateOf(pipeline, name, "slice-pipeline");
  const recon_from = Number(
    captured(state("recon_route"), "command", /\[ "\$D" -ge (\d+) \]/, "the recon threshold"),
  );
  const split_from = Number(
    captured(state("recon_end"), "command", /\[ "\$s" -ge (\d+) \]/, "the split threshold"),
  );
  const executor_scores = captured(
    state("plan_route"),
    "command",
    /case "\$SCORE" in ([\d|]+)\)/,
    "the executor's scores",
  )
    .split("|")
    .map(Number);
  const orient = stateOf(worker, "orient", "slice-worker");
  const planned = captured(
    orient,
    "prompt",
    /Score (\d+(?: or \d+)*) → the execution/,
    "the plan stage's hand-off scores",
  )
    .split(" or ")
    .map(Number);
  if (planned.join() !== executor_scores.join())
    throw new Error(
      `the plan stage hands off at ${planned.join()} but plan_route skips the plan at ${executor_scores.join()}`,
    );
  const fix_rounds = state("fixes").max_visits;
  if (typeof fix_rounds !== "number") throw new Error("slice-pipeline: fixes has no max_visits");
  const gate_fix_rounds = Number(
    captured(
      stateOf(worker, "gate", "slice-worker"),
      "command",
      /"\$\{FIX_ROUNDS:-0\}" -ge (\d+)/,
      "the gate's fix rounds",
    ),
  );
  const resource = state("land").resource;
  const locks: unknown = isDoc(resource) ? resource.locks : undefined;
  const land_lock: unknown = Array.isArray(locks) ? locks[0] : undefined;
  if (typeof land_lock !== "string") throw new Error("slice-pipeline: land holds no lock");
  return {
    table: Object.fromEntries(
      Object.entries(table.stages).map(([name, rows]) => [
        name,
        rows.map(r => ({ upto: r.upto, model: r.model, effort: r.effort })),
      ]),
    ),
    driver: { model: driver.model, effort: driver.effort },
    recon_from,
    executor_scores,
    split_from,
    gate_fix_rounds,
    land_lock,
    fix_rounds,
  };
}

/** The file the page reads: the workflow facts and the ledger's numbers of one project. */
export interface UseCaseSnapshot {
  readonly project: string;
  readonly task_workflow: string;
  /** Whose model table `workflow.table` is: the one in force during the stats' window (a dated copy), or today's file. */
  readonly table_of: "window" | "today";
  /** Whether a waiting exclusive line of the project's queue holds the lines behind it (its header's `exclusive_hold`). */
  readonly exclusive_hold: boolean;
  readonly workflow: WorkflowFacts;
  readonly stats: UseCaseStats;
}

/**
 * Refuses a snapshot that says more than the page shows: an absolute path, a home directory, a session or agent id.
 * The fold writes none of them; this is the check on its output before anything is written.
 */
export function assertUseCaseClean(text: string): void {
  const found = [
    [/\/Users\/|\/home\/|\/private\/|\/tmp\//, "an absolute path"],
    [/~\//, "a home path"],
    [/"(session_id|agent|conversation|task|cwd)"/, "a session, agent or task key"],
    [/\b[0-9a-f]{16,}\b/, "an id"],
  ].find(([pattern]) => (pattern as RegExp).test(text));
  if (found) throw new Error(`the snapshot holds ${found[1] as string}: nothing written`);
}
