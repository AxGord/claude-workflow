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
