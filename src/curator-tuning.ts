// The calibration evidence of a model-table change, like for like: which rows a commit changed, and for each changed
// (stage, band) the lands of that band split into process-shape cells, each judged on THAT STAGE's own spend. Pure;
// curator-counts.ts reads git and the ledger and calls it.
import { bandOf, reviewRounds, stageSpend } from "./calibration.js";
import type { LedgerEntry } from "./ledger.js";
import { DIFFICULTY_MAX, DIFFICULTY_MIN } from "./types.js";

/** A cell with fewer lands than this on either side is thin: its figures are noise, not evidence. */
export const THIN_BELOW = 5;

/** A stage's pick by difficulty (1..10): `model/effort`. */
export type StagePicks = ReadonlyMap<number, string>;

/**
 * The `model_table:` of a parsed workflow as picks per stage: each `stages.<name>` list, and `rows` as the
 * `execute` stage when `stages.execute` does not replace it. Rows are read as written (`upto`, `model`, `effort`);
 * a malformed row ends its stage's list. `escalate` and `review` (by review class) are not stage rows.
 */
export function stagePicks(doc: unknown): Map<string, StagePicks> {
  const out = new Map<string, StagePicks>();
  const table = (doc as { model_table?: unknown } | null | undefined)?.model_table;
  if (typeof table !== "object" || table === null) return out;
  const t = table as { rows?: unknown; stages?: unknown };
  const lists: [string, unknown][] = [];
  if (typeof t.stages === "object" && t.stages !== null)
    for (const [name, rows] of Object.entries(t.stages)) lists.push([name, rows]);
  if (!lists.some(([name]) => name === "execute")) lists.push(["execute", t.rows]);
  for (const [name, rows] of lists) {
    if (!Array.isArray(rows)) continue;
    const picks = new Map<number, string>();
    let from = DIFFICULTY_MIN;
    for (const r of rows) {
      const row = r as { upto?: unknown; model?: unknown; effort?: unknown } | null;
      if (typeof row?.upto !== "number" || typeof row.model !== "string") break;
      const effort = typeof row.effort === "string" ? row.effort : "-";
      for (let d = from; d <= Math.min(row.upto, DIFFICULTY_MAX); d++)
        picks.set(d, `${row.model}/${effort}`);
      from = Math.max(from, row.upto + 1);
    }
    out.set(name, picks);
  }
  return out;
}

export interface RowChange {
  /** The difficulties the change covers, `4-6`. */
  readonly difficulties: string;
  readonly from: string;
  readonly to: string;
}

export interface ChangedStageBand {
  readonly stage: string;
  readonly band: string;
  readonly rows: readonly RowChange[];
}

const BANDS = ["1-3", "4-6", "7-10"];

/** The (stage, band) pairs whose pick differs between two tables, with the changed rows. A stage new on one side counts. */
export function changedRows(
  before: ReadonlyMap<string, StagePicks>,
  after: ReadonlyMap<string, StagePicks>,
): ChangedStageBand[] {
  const out: ChangedStageBand[] = [];
  for (const stage of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    for (const band of BANDS) {
      const rows: RowChange[] = [];
      let run: { lo: number; hi: number; from: string; to: string } | undefined;
      const flush = (): void => {
        if (run)
          rows.push({
            difficulties: run.lo === run.hi ? String(run.lo) : `${run.lo}-${run.hi}`,
            from: run.from,
            to: run.to,
          });
        run = undefined;
      };
      for (let d = DIFFICULTY_MIN; d <= DIFFICULTY_MAX; d++) {
        if (bandOf(d) !== band) continue;
        const from = before.get(stage)?.get(d) ?? "-";
        const to = after.get(stage)?.get(d) ?? "-";
        if (from === to) flush();
        else if (run && run.from === from && run.to === to) run.hi = d;
        else {
          flush();
          run = { lo: d, hi: d, from, to };
        }
      }
      flush();
      if (rows.length > 0) out.push({ stage, band, rows });
    }
  }
  return out;
}

export interface SideFigures {
  readonly n: number;
  /** The changed stage's own spend per land, USD. */
  readonly stage_usd_median: number | null;
  readonly stage_usd_mean: number | null;
  readonly review_rounds_mean: number | null;
  readonly escalations: number;
  readonly verdicts: Readonly<Record<string, number>>;
  /** Summed `counts.<findings_key>` over the lands that record it, when the job names the key. */
  readonly findings: number | null;
}

export interface Cell {
  /** The process shape: the stages that spent, and the review rounds (none, one, or more). */
  readonly shape: string;
  readonly before: SideFigures;
  readonly after: SideFigures;
  /** n below `THIN_BELOW` on either side: not evidence. */
  readonly thin: boolean;
}

export interface StageEvidence extends ChangedStageBand {
  readonly cells: readonly Cell[];
  /** Lands left out because the changed stage's spend is only a lower bound (an agent unmeasured). */
  readonly unmeasured_lands: number;
  /** Lands that recorded a row for the stage that is neither side's row for their difficulty. */
  readonly off_row_lands: number;
  /** False when every cell is thin: the answer is "not enough lands yet", not a verdict. */
  readonly enough: boolean;
  readonly note?: string;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return round2(s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2);
}

const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : round2(xs.reduce((a, b) => a + b, 0) / xs.length);

/** The process shape of a land: the stages that spent (a hand-on to execute shows as an `execute` agent), and its review rounds. */
export function processShape(e: LedgerEntry): string {
  const stages = new Set<string>();
  for (const a of e.spend?.by_agent ?? []) if (a.stage !== undefined) stages.add(a.stage);
  const rounds = reviewRounds(e.visits);
  const r = rounds === 0 ? "no review round" : rounds === 1 ? "one review round" : "fix rounds";
  return `${[...stages].sort().join("+") || "-"}; ${r}`;
}

function figures(
  lands: readonly LedgerEntry[],
  stage: string,
  findingsKey: string | undefined,
): SideFigures {
  const usd = lands.map(e => stageSpend(e, stage).usd);
  const verdicts: Record<string, number> = {};
  for (const e of lands)
    if (e.verdict !== undefined) verdicts[e.verdict] = (verdicts[e.verdict] ?? 0) + 1;
  const recorded =
    findingsKey === undefined
      ? []
      : lands.flatMap(e => (e.counts?.[findingsKey] === undefined ? [] : [e.counts[findingsKey]]));
  return {
    n: lands.length,
    stage_usd_median: median(usd),
    stage_usd_mean: mean(usd),
    review_rounds_mean: mean(lands.map(e => reviewRounds(e.visits))),
    escalations: lands.reduce((a, e) => a + (e.escalations ?? 0), 0),
    verdicts,
    findings:
      findingsKey === undefined || recorded.length === 0
        ? null
        : recorded.reduce((a, b) => a + b, 0),
  };
}

/** The picks of the changed stage on each side of the commit (`stagePicks`), by difficulty. */
export interface SidePicks {
  readonly before: StagePicks;
  readonly after: StagePicks;
}

/**
 * The evidence of one changed (stage, band): `before` and `after` are the workflow's lands on each side of the
 * change by time. Only lands of the band at a difficulty whose row changed, whose changed stage spent and was fully
 * measured, are compared, grouped by process shape; a cell is judged on the stage's own spend, never the task's.
 * A land that recorded the model and effort its stage ran on (`stages.<stage>`) goes to the side whose row for its
 * difficulty it ran on, whatever its end time (a land that ran across the commit), and to neither when it ran on
 * another row (`off_row_lands`); a land without the record keeps its time side.
 */
export function stageEvidence(
  change: ChangedStageBand,
  before: readonly LedgerEntry[],
  after: readonly LedgerEntry[],
  picks: SidePicks,
  findingsKey?: string,
): StageEvidence {
  let unmeasured = 0;
  let offRow = 0;
  const b: LedgerEntry[] = [];
  const a: LedgerEntry[] = [];
  const place = (e: LedgerEntry, timeSide: LedgerEntry[]): void => {
    if (bandOf(e.difficulty) !== change.band || e.difficulty === undefined) return;
    const was = picks.before.get(e.difficulty);
    const now = picks.after.get(e.difficulty);
    if (was === now) return; // this difficulty's row did not change: the land is in neither side
    const s = stageSpend(e, change.stage);
    if (s.unmeasured > 0) {
      unmeasured++;
      return;
    }
    if (!s.measured) return;
    const ran = e.stages?.[change.stage];
    if (ran === undefined) {
      timeSide.push(e);
      return;
    }
    const row = `${ran.model}/${ran.effort}`;
    if (row === was) b.push(e);
    else if (row === now) a.push(e);
    else offRow++;
  };
  for (const e of before) place(e, b);
  for (const e of after) place(e, a);
  const shapes = [...new Set([...b, ...a].map(processShape))].sort();
  const cells: Cell[] = shapes.map(shape => {
    const bs = b.filter(e => processShape(e) === shape);
    const as = a.filter(e => processShape(e) === shape);
    return {
      shape,
      before: figures(bs, change.stage, findingsKey),
      after: figures(as, change.stage, findingsKey),
      thin: bs.length < THIN_BELOW || as.length < THIN_BELOW,
    };
  });
  const enough = cells.some(c => !c.thin);
  return {
    ...change,
    cells,
    unmeasured_lands: unmeasured,
    off_row_lands: offRow,
    enough,
    ...(enough
      ? {}
      : { note: "not enough lands yet: every cell has fewer than 5 lands on a side" }),
  };
}
