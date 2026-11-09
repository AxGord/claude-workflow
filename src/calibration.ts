// The calibration report: the ledger (`ledger.jsonl`) folded per project × workflow × difficulty band × stage,
// the figures a `model_table` is tuned from. Pure; src/calibration-cli.ts reads the file and prints.
import path from "node:path";
import type { LedgerEntry } from "./ledger.js";

export interface CalibrationOptions {
  /** Keep lines that ended at or after this date (ISO date or timestamp). */
  readonly since?: string;
  /** Keep lines of this project (git root). */
  readonly project?: string;
  /** A context list key whose lengths are summed as `findings`. */
  readonly findingsKey?: string;
}

export interface CalibrationRow {
  readonly project: string;
  readonly workflow: string;
  readonly band: string;
  readonly stage: string;
  readonly model: string;
  readonly effort: string;
  /** Tasks (ledger lines) that used this model and effort at this stage. */
  tasks: number;
  /** Task-level figures below count once per task, on its first row. */
  review_rounds: number;
  escalations: number;
  tokens: number;
  findings: number;
  outcomes: Record<string, number>;
  verdicts: Record<string, number>;
}

/** Difficulty bands; a line without a difficulty is `-`. */
export function bandOf(difficulty: number | undefined): string {
  if (difficulty === undefined) return "-";
  return difficulty <= 3 ? "1-3" : difficulty <= 6 ? "4-6" : "7-10";
}

/** Entries into review states (`review*`, routing states `*_route` aside). */
export function reviewRounds(visits: LedgerEntry["visits"]): number {
  return Object.entries(visits ?? {})
    .filter(([name]) => name.startsWith("review") && !name.endsWith("_route"))
    .reduce((sum, [, n]) => sum + n, 0);
}

function tokensOf(t: LedgerEntry["tokens"]): number {
  if (t === undefined) return 0;
  return t.total ?? Object.values(t).reduce((a, b) => a + b, 0);
}

const bump = (m: Record<string, number>, k: string): void => {
  m[k] = (m[k] ?? 0) + 1;
};

export function calibrate(
  entries: readonly LedgerEntry[],
  opts: CalibrationOptions = {},
): CalibrationRow[] {
  const rows = new Map<string, CalibrationRow>();
  const since = opts.since === undefined ? undefined : Date.parse(opts.since);
  for (const e of entries) {
    if (since !== undefined && !(Date.parse(e.ended_at) >= since)) continue;
    const project = e.project ?? "-";
    if (opts.project !== undefined && project !== path.resolve(opts.project)) continue;
    const staged = Object.keys(e.stages ?? {});
    const picks: Array<[string, string, string]> =
      staged.length > 0
        ? staged.map(n => [n, e.stages![n].model, e.stages![n].effort])
        : [["-", e.model ?? "-", e.effort ?? "-"]];
    const band = bandOf(e.claim_difficulty ?? e.difficulty);
    picks.forEach(([stage, model, effort], i) => {
      const key = JSON.stringify([project, e.workflow, band, stage, model, effort]);
      let row = rows.get(key);
      if (row === undefined) {
        row = {
          project,
          workflow: e.workflow ?? "-",
          band,
          stage,
          model,
          effort,
          tasks: 0,
          review_rounds: 0,
          escalations: 0,
          tokens: 0,
          findings: 0,
          outcomes: {},
          verdicts: {},
        };
        rows.set(key, row);
      }
      row.tasks += 1;
      bump(row.outcomes, e.outcome ?? "-");
      if (e.verdict !== undefined) bump(row.verdicts, e.verdict);
      if (i === 0) {
        row.review_rounds += reviewRounds(e.visits);
        row.escalations += e.escalations ?? 0;
        row.tokens += tokensOf(e.tokens);
        if (opts.findingsKey !== undefined) row.findings += e.counts?.[opts.findingsKey] ?? 0;
      }
    });
  }
  return [...rows.values()].sort((a, b) =>
    JSON.stringify([a.project, a.workflow, a.band, a.stage, a.model, a.effort]).localeCompare(
      JSON.stringify([b.project, b.workflow, b.band, b.stage, b.model, b.effort]),
    ),
  );
}

const fmt = (m: Record<string, number>): string =>
  Object.entries(m)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k}:${n}`)
    .join(",") || "-";

export function formatCalibration(rows: readonly CalibrationRow[], findings: boolean): string {
  const head = [
    "project",
    "workflow",
    "band",
    "stage",
    "model/effort",
    "tasks",
    "rounds",
    "esc",
    "tokens",
    ...(findings ? ["findings"] : []),
    "outcomes",
    "verdicts",
  ];
  const body = rows.map(r => [
    r.project,
    r.workflow,
    r.band,
    r.stage,
    `${r.model}/${r.effort}`,
    String(r.tasks),
    String(r.review_rounds),
    String(r.escalations),
    String(r.tokens),
    ...(findings ? [String(r.findings)] : []),
    fmt(r.outcomes),
    fmt(r.verdicts),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map(b => b[i].length)));
  return [head, ...body]
    .map(l =>
      l
        .map((c, i) => c.padEnd(w[i]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/**
 * The price table: blended USD per million tokens by model family (the ledger holds a token count per task or role,
 * not an input/output split, so a price is one estimate over the usual mix). The one owner of a price: the Cost tab
 * reads it here. Edit a price and `PRICES_UPDATED` together.
 */
export const PRICES_USD_PER_MTOK: Readonly<Record<string, number>> = {
  opus: 30,
  sonnet: 6,
  haiku: 2,
};
export const PRICES_UPDATED = "2026-11-09";

/** USD per million tokens, by model family, for each kind of usage a transcript turn reports. */
export interface TurnRates {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  /** a 5-minute cache write; a 1-hour write costs twice the input rate. */
  readonly cache_write: number;
}
export const TURN_RATES_USD_PER_MTOK: Readonly<Record<string, TurnRates>> = {
  opus: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
  sonnet: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  haiku: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
};

/** The USD of one transcript turn priced by its own model; undefined when the model has no rate. */
export function turnUsd(
  model: string,
  u: {
    readonly input: number;
    readonly output: number;
    readonly cache_read: number;
    readonly cache_write_5m: number;
    readonly cache_write_1h: number;
  },
): number | undefined {
  const m = model.toLowerCase();
  const family = Object.keys(TURN_RATES_USD_PER_MTOK).find(k => m.includes(k));
  if (family === undefined) return undefined;
  const r = TURN_RATES_USD_PER_MTOK[family];
  return (
    (u.input * r.input +
      u.output * r.output +
      u.cache_read * r.cache_read +
      u.cache_write_5m * r.cache_write +
      u.cache_write_1h * r.input * 2) /
    1e6
  );
}

/** The price of a model name (`claude-opus-4`, `sonnet`): the first family its name contains; undefined when none. */
export function priceOf(model: string): number | undefined {
  const m = model.toLowerCase();
  const family = Object.keys(PRICES_USD_PER_MTOK).find(k => m.includes(k));
  return family === undefined ? undefined : PRICES_USD_PER_MTOK[family];
}

export interface CostStage {
  readonly stage: string;
  readonly model: string;
  readonly effort: string;
  readonly tokens: number;
  /** undefined when the model has no price. */
  readonly usd: number | undefined;
}

export type CostOutcome = "landed" | "failed" | "closed" | "unknown";

export interface CostTask {
  readonly session_id: string;
  readonly task: string;
  readonly workflow: string;
  readonly day: string;
  readonly ended_at: string;
  readonly outcome: CostOutcome;
  readonly rounds: number;
  /** false when the line recorded no tokens: its cost is unknown, not $0. */
  readonly measured: boolean;
  readonly tokens: number;
  readonly usd: number;
  readonly stages: CostStage[];
}

export interface CostDay {
  readonly day: string;
  readonly tasks: number;
  readonly landed: number;
  /** landed tasks that recorded tokens: the $/landed denominator. */
  readonly measured_landed: number;
  readonly tokens: number;
  readonly usd: number;
  /** usd / landed; null when nothing landed that day. */
  readonly usd_per_landed: number | null;
}

export interface CostReport {
  readonly from: string;
  readonly to: string;
  readonly prices: {
    readonly usd_per_mtok: Readonly<Record<string, number>>;
    readonly updated: string;
    readonly source: string;
  };
  readonly tasks: CostTask[];
  readonly totals: {
    readonly tasks: number;
    readonly landed: number;
    readonly measured_landed: number;
    readonly tokens: number;
    readonly usd: number;
    readonly usd_per_landed: number | null;
  };
  /** The last 14 days up to `to`, oldest first. */
  readonly trend: CostDay[];
}

/**
 * Landed = completed through a `land` state (`project_land`; `land_failed` is not one); failed = any other ending than
 * completed; closed = completed without landing; unknown = completed on a line that recorded no visits.
 */
export function costOutcome(e: LedgerEntry): CostOutcome {
  if (e.outcome !== "completed") return "failed";
  if (e.visits === undefined) return "unknown";
  const landed = Object.entries(e.visits).some(([n, v]) => v > 0 && /(^|_)land$/.test(n));
  return landed ? "landed" : "closed";
}

/**
 * A task's tokens as run, one row per token key: `tokens_<stage>` is that stage at its model; `tokens_worker` is one
 * unsplit `worker` row at the task's model (else the execute stage's); any other role at the task's model; whatever
 * the total holds beyond the roles is a `-` row at the task's model. No tokens, no rows.
 */
export function costStages(e: LedgerEntry): CostStage[] {
  const t = e.tokens ?? {};
  const roles = Object.entries(t).filter(([k, n]) => k !== "total" && n > 0);
  const total = tokensOf(e.tokens);
  const rest = total - roles.reduce((sum, [, n]) => sum + n, 0);
  const rows: Array<[string, number]> = [...roles];
  if (rest > 0) rows.push(["-", rest]);
  return rows.map(([stage, tokens]) => {
    const own = e.stages?.[stage];
    const model = own?.model ?? e.model ?? e.stages?.execute?.model ?? "-";
    const effort = own?.effort ?? e.effort ?? e.stages?.execute?.effort ?? "-";
    const price = priceOf(model);
    return {
      stage,
      model,
      effort,
      tokens,
      usd: price === undefined ? undefined : (tokens * price) / 1e6,
    };
  });
}

function localDayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const perLanded = (usd: number, landed: number): number | null =>
  landed === 0 ? null : usd / landed;

/** The cost report over a day range (`from`..`to` inclusive, YYYY-MM-DD, local days) plus the 14-day $/landed trend ending at `to`. */
export function buildCost(entries: readonly LedgerEntry[], from: string, to: string): CostReport {
  const tasks: CostTask[] = [];
  for (const e of entries) {
    if (e.task === undefined) continue;
    if (
      e.spend === undefined &&
      Object.keys(e.tokens ?? {}).length === 0 &&
      Object.keys(e.stages ?? {}).length === 0
    )
      continue;
    const ended = Date.parse(e.ended_at);
    if (Number.isNaN(ended)) continue;
    const stages = costStages(e);
    const spend = e.spend?.usd !== undefined ? e.spend : undefined;
    const spendTokens = spend
      ? spend.input + spend.output + spend.cache_read + spend.cache_write
      : 0;
    tasks.push({
      session_id: e.session_id,
      task: e.task,
      workflow: e.workflow ?? "-",
      day: localDayOf(ended),
      ended_at: e.ended_at,
      outcome: costOutcome(e),
      rounds: reviewRounds(e.visits),
      measured: spend ? true : e.spend ? false : stages.length > 0,
      tokens: spend ? spendTokens : e.spend ? 0 : stages.reduce((s, x) => s + x.tokens, 0),
      usd: spend ? (spend.usd ?? 0) : e.spend ? 0 : stages.reduce((s, x) => s + (x.usd ?? 0), 0),
      stages: spend
        ? [
            {
              stage: "spend",
              model: "transcripts",
              effort: "-",
              tokens: spendTokens,
              usd: spend.usd,
            },
          ]
        : e.spend
          ? []
          : stages,
    });
  }
  tasks.sort((a, b) => a.ended_at.localeCompare(b.ended_at));
  const inRange = tasks.filter(t => t.day >= from && t.day <= to);
  const sum = (ts: readonly CostTask[]) => ({
    tasks: ts.length,
    landed: ts.filter(t => t.outcome === "landed").length,
    measured_landed: ts.filter(t => t.outcome === "landed" && t.measured).length,
    tokens: ts.reduce((s, t) => s + t.tokens, 0),
    usd: ts.reduce((s, t) => s + t.usd, 0),
  });
  const totals = sum(inRange);
  const [y, m, d] = to.split("-").map(Number);
  const trend: CostDay[] = [];
  for (let i = 13; i >= 0; i--) {
    const day = localDayOf(new Date(y, m - 1, d - i).getTime());
    const s = sum(tasks.filter(t => t.day === day));
    trend.push({ day, ...s, usd_per_landed: perLanded(s.usd, s.measured_landed) });
  }
  return {
    from,
    to,
    prices: {
      usd_per_mtok: PRICES_USD_PER_MTOK,
      updated: PRICES_UPDATED,
      source:
        "src/calibration.ts PRICES_USD_PER_MTOK: blended USD per million tokens by model family",
    },
    tasks: inRange,
    totals: { ...totals, usd_per_landed: perLanded(totals.usd, totals.measured_landed) },
    trend,
  };
}
