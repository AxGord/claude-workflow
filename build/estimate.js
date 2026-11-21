// Run-time estimates of leased steps, read from the ledger (`ledger.jsonl`):
// what the pool's backfill trusts first (else the pool's own history of the label) to say "this run ends
// before the head's threads are free", and which size of a flexible request ends earliest. Read OUTSIDE
// the pool lock, by the requester.
import fs from "node:fs";
/** Fewer successful runs than this: no estimate. */
export const MIN_SAMPLES = 3;
/** Only the latest this many runs of a step count. */
export const MAX_SAMPLES = 30;
/** A run older than this does not count. */
export const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
/** The 90th percentile (nearest rank) of `values`, or undefined below MIN_SAMPLES. */
export function p90(values) {
    if (values.length < MIN_SAMPLES)
        return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.ceil(0.9 * sorted.length) - 1];
}
/**
 * The run time (ms) on each of `min..max` threads from the `known` estimates by threads: a
 * size with an estimate keeps it, the others come from `t(k) = a + b / k` (`a`, `b` ≥ 0:
 * a serial part and a parallel one) fitted by least squares through every known size,
 * also those outside the range. Fewer than two known sizes cannot fit a curve: a range
 * they do not fully cover has none (undefined).
 */
export function curveOf(known, min, max) {
    const out = {};
    let missing = false;
    for (let k = min; k <= max; k++) {
        const t = known.get(k);
        if (t === undefined)
            missing = true;
        else
            out[k] = t;
    }
    if (!missing)
        return out;
    if (known.size < 2)
        return undefined;
    const pts = [...known].map(([k, t]) => ({ x: 1 / k, t }));
    const n = pts.length;
    const sx = pts.reduce((s, p) => s + p.x, 0);
    const st = pts.reduce((s, p) => s + p.t, 0);
    const sxx = pts.reduce((s, p) => s + p.x * p.x, 0);
    const sxt = pts.reduce((s, p) => s + p.x * p.t, 0);
    const det = n * sxx - sx * sx;
    let b = det === 0 ? 0 : (n * sxt - sx * st) / det;
    let a = (st - b * sx) / n;
    // a time that grows with the threads, or a negative serial part, is noise: refit one term
    if (b < 0) {
        b = 0;
        a = st / n;
    }
    else if (a < 0) {
        a = 0;
        b = sxt / sxx;
    }
    for (let k = min; k <= max; k++)
        out[k] ??= a + b / k;
    return out;
}
/**
 * Per `step_key` and threads granted, the latest successful runs of a ledger;
 * re-reads only the appended tail (a file that shrank or was replaced is read
 * again from the start). Keyed by threads: a run on other threads says nothing
 * about this one's time; `curve` fits one over the sizes the history has.
 */
export class Estimates {
    _path;
    _samples = new Map();
    _offset = 0;
    _ino;
    _partial = "";
    constructor(ledgerPath) {
        this._path = ledgerPath;
    }
    /** The p90 run time (ms) of `stepKey` on `threads` threads, or undefined: too few recent successful runs. */
    lookup(stepKey, threads, now = Date.now()) {
        this._refresh();
        const recent = (this._samples.get(`${stepKey}#${threads}`) ?? []).filter(s => now - s.at < MAX_AGE_MS);
        return p90(recent.map(s => s.ms));
    }
    /**
     * The p90 run time (ms) of `stepKey` on each of `min..max` threads (`curveOf` over the
     * sizes with an estimate), or undefined: the history cannot tell every size.
     */
    curve(stepKey, min, max, now = Date.now()) {
        this._refresh();
        const known = new Map();
        const prefix = `${stepKey}#`;
        for (const key of this._samples.keys()) {
            if (!key.startsWith(prefix))
                continue;
            const k = Number(key.slice(prefix.length));
            const t = this.lookup(stepKey, k, now);
            if (t !== undefined)
                known.set(k, t);
        }
        return curveOf(known, min, max);
    }
    /**
     * The p90 run time (ms) of `stepKey` on every size the history has an estimate for (any
     * size, in or out of `min..max`), or undefined when it has none. What `curve` cannot cover
     * (fewer than two sizes) still tells a lease its end.
     */
    known(stepKey, now = Date.now()) {
        this._refresh();
        const out = {};
        const prefix = `${stepKey}#`;
        for (const key of this._samples.keys()) {
            if (!key.startsWith(prefix))
                continue;
            const k = Number(key.slice(prefix.length));
            const t = this.lookup(stepKey, k, now);
            if (t !== undefined)
                out[k] = t;
        }
        return Object.keys(out).length > 0 ? out : undefined;
    }
    _refresh() {
        let stat;
        try {
            stat = fs.statSync(this._path);
        }
        catch {
            return;
        }
        if (stat.ino !== this._ino || stat.size < this._offset) {
            this._samples.clear();
            this._offset = 0;
            this._partial = "";
            this._ino = stat.ino;
        }
        if (stat.size === this._offset)
            return;
        const fd = fs.openSync(this._path, "r");
        let chunk;
        try {
            chunk = Buffer.alloc(stat.size - this._offset);
            fs.readSync(fd, chunk, 0, chunk.length, this._offset);
        }
        finally {
            fs.closeSync(fd);
        }
        this._offset = stat.size;
        const lines = (this._partial + chunk.toString("utf8")).split("\n");
        this._partial = lines.pop() ?? "";
        for (const line of lines)
            this._add(line);
    }
    _add(line) {
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            return;
        }
        const at = Date.parse(entry.ended_at);
        if (!Number.isFinite(at) || !Array.isArray(entry.execs))
            return;
        for (const e of entry.execs) {
            // a fanout's time is its shards', not one lease's
            if (!e.step_key || e.shards || e.exit_code !== 0 || !e.threads_granted)
                continue;
            const key = `${e.step_key}#${e.threads_granted}`;
            let list = this._samples.get(key);
            if (!list)
                this._samples.set(key, (list = []));
            list.push({ at, ms: e.duration_ms });
            if (list.length > MAX_SAMPLES)
                list.shift();
        }
    }
}
