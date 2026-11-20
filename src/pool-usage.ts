// What each finished lease held against what its process tree ran, kept per label so a caller can
// right-size its own leases: `wf-run --usage`. A lease carries a running `LeaseMeter` in `pool.json`;
// its end appends one `UsageRecord` line to `usage.jsonl`. Pure apart from the file functions.
import fs from "node:fs";
import path from "node:path";

export const USAGE_FILE = "usage.jsonl";
const USAGE_MAX_BYTES = 1 << 20;
// A meter advances at most this often (every advance rewrites pool.json and wakes every waiter) ...
export const METER_STEP_MS = 10_000;
// ... and credits a gap longer than this to nobody: the lease was not sampled over it.
export const METER_MAX_GAP_MS = 30_000;
const MS_PER_MIN = 60_000;
export const DEFAULT_USAGE_WINDOW_MS = 24 * 60 * MS_PER_MIN;

/** Thread-milliseconds a lease held and ran over the time it was sampled (`ms`). */
export interface LeaseMeter {
  /** The last advance (ms since epoch). */
  readonly at: number;
  /** Wall ms the lease was sampled over. */
  readonly ms: number;
  /** Busy cpus x ms: what its tree ran. */
  readonly used: number;
  /** Threads held above what the tree ran, x ms. */
  readonly idle: number;
  /** What the tree ran above the threads held, x ms. */
  readonly over: number;
}

/** One finished lease: its label key, threads, wall ms, and its meter without the clock. */
export interface UsageRecord {
  readonly at: number;
  readonly label: string;
  readonly threads: number;
  readonly ms: number;
  readonly measured_ms: number;
  readonly used: number;
  readonly idle: number;
  readonly over: number;
}

export interface UsageRow {
  readonly label: string;
  readonly n: number;
  /** Threads held, weighted by the sampled time. */
  readonly held: number;
  /** Busy cpus the trees ran, weighted by the sampled time. */
  readonly used: number;
  readonly idleThreadMin: number;
  readonly overThreadMin: number;
  /** Share of the leases' wall time that was sampled. */
  readonly coverage: number;
}

/**
 * `meter` moved to `now` with what the tree runs (`runs`, busy cpus; undefined: unmeasured) against
 * the threads held. Undefined while the last advance is under METER_STEP_MS old, so a pass does not
 * rewrite the pool. An unmeasured stretch moves the clock and credits nothing.
 */
export function advanceMeter(
  meter: LeaseMeter | undefined,
  started: number,
  threads: number,
  runs: number | undefined,
  now: number,
): LeaseMeter | undefined {
  const at = meter?.at ?? started;
  const dt = now - at;
  if (threads <= 0 || dt < METER_STEP_MS) return undefined;
  const credit = runs !== undefined && dt <= METER_MAX_GAP_MS ? dt : 0;
  runs ??= 0;
  return {
    at: now,
    ms: (meter?.ms ?? 0) + credit,
    used: (meter?.used ?? 0) + runs * credit,
    idle: (meter?.idle ?? 0) + Math.max(0, threads - runs) * credit,
    over: (meter?.over ?? 0) + Math.max(0, runs - threads) * credit,
  };
}

/** The record of a lease that ended, or undefined when nothing was sampled. */
export function usageRecord(
  label: string,
  threads: number,
  started: number,
  now: number,
  meter: LeaseMeter | undefined,
): UsageRecord | undefined {
  if (meter === undefined || meter.ms <= 0 || threads <= 0) return undefined;
  return {
    at: now,
    label,
    threads,
    ms: Math.max(0, now - started),
    measured_ms: meter.ms,
    used: Math.round(meter.used),
    idle: Math.round(meter.idle),
    over: Math.round(meter.over),
  };
}

/** One line to `usage.jsonl`; a file that cannot be written is not the pool's failure. */
export function appendUsage(dir: string, rec: UsageRecord): void {
  const fp = path.join(dir, USAGE_FILE);
  try {
    if (fs.existsSync(fp) && fs.statSync(fp).size > USAGE_MAX_BYTES) fs.renameSync(fp, `${fp}.1`);
    fs.appendFileSync(fp, `${JSON.stringify(rec)}\n`);
  } catch {
    /* best effort */
  }
}

function isRecord(v: unknown): v is UsageRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.label === "string" &&
    ["at", "threads", "ms", "measured_ms", "used", "idle", "over"].every(
      k => typeof r[k] === "number" && Number.isFinite(r[k]),
    )
  );
}

/** The records of `usage.jsonl.1` and `usage.jsonl`, oldest first; a damaged line is skipped. */
export function readUsage(dir: string): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const name of [`${USAGE_FILE}.1`, USAGE_FILE]) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const rec: unknown = JSON.parse(line);
        if (isRecord(rec)) out.push(rec);
      } catch {
        /* a damaged line */
      }
    }
  }
  return out;
}

/** `90m`, `24h`, `2d` as ms; undefined for anything else. */
export function parseSince(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([mhd])$/.exec(text);
  if (!m) return undefined;
  const unit = { m: MS_PER_MIN, h: 60 * MS_PER_MIN, d: 24 * 60 * MS_PER_MIN }[
    m[2] as "m" | "h" | "d"
  ];
  const ms = Number(m[1]) * unit;
  return ms > 0 ? ms : undefined;
}

/** Per label: the leases that ended in the window, most idle thread-minutes first. */
export function summarizeUsage(
  records: readonly UsageRecord[],
  now: number,
  windowMs: number = DEFAULT_USAGE_WINDOW_MS,
): UsageRow[] {
  const by = new Map<string, UsageRecord[]>();
  for (const r of records) {
    if (r.at < now - windowMs) continue;
    by.set(r.label, [...(by.get(r.label) ?? []), r]);
  }
  const sum = (rs: readonly UsageRecord[], f: (r: UsageRecord) => number): number =>
    rs.reduce((a, r) => a + f(r), 0);
  return [...by]
    .map(([label, rs]): UsageRow => {
      const sampled = sum(rs, r => r.measured_ms);
      const wall = sum(rs, r => r.ms);
      return {
        label,
        n: rs.length,
        held: sampled > 0 ? sum(rs, r => r.threads * r.measured_ms) / sampled : 0,
        used: sampled > 0 ? sum(rs, r => r.used) / sampled : 0,
        idleThreadMin: sum(rs, r => r.idle) / MS_PER_MIN,
        overThreadMin: sum(rs, r => r.over) / MS_PER_MIN,
        coverage: wall > 0 ? Math.min(1, sampled / wall) : 0,
      };
    })
    .sort((a, b) => b.idleThreadMin - a.idleThreadMin || (a.label < b.label ? -1 : 1));
}

/** The table `wf-run --usage` prints. */
export function formatUsage(rows: readonly UsageRow[], windowMs: number, dir: string): string {
  const hours = windowMs / (60 * MS_PER_MIN);
  const head = `pool usage ${dir}: leases ended in the last ${hours >= 48 ? `${Math.round(hours / 24)}d` : `${Math.round(hours * 10) / 10}h`}, per label (slice ids and commit hashes shown as *)`;
  if (rows.length === 0) return `${head}\nnone: no measured lease ended in the window`;
  const cells = rows.map(r => [
    String(r.n),
    r.held.toFixed(1),
    r.used.toFixed(1),
    r.idleThreadMin.toFixed(1),
    r.overThreadMin.toFixed(1),
    `${Math.round(r.coverage * 100)}%`,
    r.label,
  ]);
  const titles = ["n", "held", "used", "idle thr-min", "over thr-min", "sampled", "label"];
  const width = titles.map((t, i) => Math.max(t.length, ...cells.map(c => c[i].length)));
  const line = (c: readonly string[]): string =>
    c.map((v, i) => (i === c.length - 1 ? v : v.padStart(width[i]))).join("  ");
  return [head, line(titles), ...cells.map(line)].join("\n");
}
