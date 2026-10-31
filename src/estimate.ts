// Run-time estimates of leased steps, read from the ledger (`ledger.jsonl`):
// what the pool's backfill trusts to say "this run ends before the head's
// threads are free". Read OUTSIDE the pool lock, by the requester.
import fs from "node:fs";
import type { LedgerEntry } from "./ledger.js";

/** Fewer successful runs than this: no estimate. */
export const MIN_SAMPLES = 3;
/** Only the latest this many runs of a step count. */
export const MAX_SAMPLES = 30;
/** A run older than this does not count. */
export const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

interface Sample {
  readonly at: number;
  readonly ms: number;
}

/** The 90th percentile (nearest rank) of `values`, or undefined below MIN_SAMPLES. */
export function p90(values: readonly number[]): number | undefined {
  if (values.length < MIN_SAMPLES) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1];
}

/**
 * Per `step_key` and threads granted, the latest successful runs of a ledger;
 * re-reads only the appended tail (a file that shrank or was replaced is read
 * again from the start). Keyed by threads: a run on other threads says nothing
 * about this one's time, and no speed-up curve is guessed.
 */
export class Estimates {
  private readonly _path: string;
  private readonly _samples = new Map<string, Sample[]>();
  private _offset = 0;
  private _ino: number | undefined;
  private _partial = "";

  constructor(ledgerPath: string) {
    this._path = ledgerPath;
  }

  /** The p90 run time (ms) of `stepKey` on `threads` threads, or undefined: too few recent successful runs. */
  lookup(stepKey: string, threads: number, now: number = Date.now()): number | undefined {
    this._refresh();
    const recent = (this._samples.get(`${stepKey}#${threads}`) ?? []).filter(
      s => now - s.at < MAX_AGE_MS,
    );
    return p90(recent.map(s => s.ms));
  }

  private _refresh(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this._path);
    } catch {
      return;
    }
    if (stat.ino !== this._ino || stat.size < this._offset) {
      this._samples.clear();
      this._offset = 0;
      this._partial = "";
      this._ino = stat.ino;
    }
    if (stat.size === this._offset) return;
    const fd = fs.openSync(this._path, "r");
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(stat.size - this._offset);
      fs.readSync(fd, chunk, 0, chunk.length, this._offset);
    } finally {
      fs.closeSync(fd);
    }
    this._offset = stat.size;
    const lines = (this._partial + chunk.toString("utf8")).split("\n");
    this._partial = lines.pop() ?? "";
    for (const line of lines) this._add(line);
  }

  private _add(line: string): void {
    let entry: LedgerEntry;
    try {
      entry = JSON.parse(line) as LedgerEntry;
    } catch {
      return;
    }
    const at = Date.parse(entry.ended_at);
    if (!Number.isFinite(at) || !Array.isArray(entry.execs)) return;
    for (const e of entry.execs) {
      // a fanout's time is its shards', not one lease's
      if (!e.step_key || e.shards || e.exit_code !== 0 || !e.threads_granted) continue;
      const key = `${e.step_key}#${e.threads_granted}`;
      let list = this._samples.get(key);
      if (!list) this._samples.set(key, (list = []));
      list.push({ at, ms: e.duration_ms });
      if (list.length > MAX_SAMPLES) list.shift();
    }
  }
}
