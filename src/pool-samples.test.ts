import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool, sampleLine, schedule, type PoolEntry, type PoolProbes } from "./pool.js";
import { isGroupAlive, isPidAlive } from "./process.js";
import { cleanupDir } from "./test-helpers.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) cleanupDir(d);
});

let seq = 0;
const entry = (threads: number, extra: Partial<PoolEntry> = {}): PoolEntry => ({
  id: `s${++seq}`,
  pid: process.pid,
  threads,
  priority: 0,
  label: "",
  cwd: "/",
  session_id: "",
  arrived: seq,
  ...extra,
});

const probes = (load = 3): PoolProbes => ({
  perfCores: () => 12,
  loadavg: () => load,
  cpuTicks: () => ({ busy: 0, total: 0, cpus: 1 }),
  isAlive: isPidAlive,
  isGroupAlive,
});

function poolWith(pool: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-pool-sample-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "config.yaml"), JSON.stringify({ budget: 6, load_threshold: 0 }));
  fs.writeFileSync(path.join(dir, "pool.json"), JSON.stringify(pool));
  return dir;
}

const logOf = (dir: string): string[] => {
  const fp = path.join(dir, "pool.log");
  return fs.existsSync(fp) ? fs.readFileSync(fp, "utf8").trim().split("\n") : [];
};
const stateOf = (dir: string): { last_sample?: number } =>
  JSON.parse(fs.readFileSync(path.join(dir, "pool.json"), "utf8")) as { last_sample?: number };

const cfg = { budget: 6, load_threshold: 0, starve_after: 900 };

describe("pool.log load samples", () => {
  it("a sample line carries load, external load, threads held, the leases' running processes, and the waiters with what they ask", () => {
    const lease = entry(4, { started: 1, locks: ["a"] });
    const flex = entry(6, { min_threads: 3 });
    const view = schedule(
      { leases: [lease], waiting: [flex, entry(5), entry(0, { locks: ["a"] })] },
      cfg,
      7.5,
      () => true,
      2,
      { [lease.id]: 11.4 },
    );
    expect(sampleLine(view)).toBe(
      "sample: load 7.5 external 0.0 held 4/6 runs 11.4 leases 1 waiting 3 [3-6, 5, lock a]",
    );
  });

  it("a sample names at most four waiters and counts the rest; with no process measured runs is `-`", () => {
    const waiting = [1, 2, 3, 4, 5, 6].map(() => entry(6));
    const view = schedule({ leases: [entry(4, { started: 1 })], waiting }, cfg, 0, () => true, 2);
    expect(sampleLine(view)).toMatch(/ runs - leases 1 waiting 6 \[6, 6, 6, 6, \+2\]$/);
  });

  it("a pass with a lease or waiter and a sample older than a minute logs one line and moves the clock; the next pass logs nothing", async () => {
    const now = Date.now();
    const dir = poolWith({
      leases: [entry(4, { started: now })],
      waiting: [entry(6, { arrived: now })],
      last_sample: now - 61_000,
    });
    const pool = new Pool(dir, probes());
    await pool.status();
    const log = logOf(dir);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(
      /^\S+ sample: load 3\.0 external 0\.0 held 4\/6 runs - leases 1 waiting 1 \[6\]$/,
    );
    expect(stateOf(dir).last_sample).toBeGreaterThanOrEqual(now);
    await pool.status();
    expect(logOf(dir)).toHaveLength(1);
  });

  it("a sample younger than a minute logs nothing and leaves the clock alone", async () => {
    const at = Date.now() - 30_000;
    const dir = poolWith({ leases: [entry(4, { started: at })], waiting: [], last_sample: at });
    await new Pool(dir, probes()).status();
    expect(logOf(dir)).toEqual([]);
    expect(stateOf(dir).last_sample).toBe(at);
  });

  it("the first pass with an entry starts the clock without a line; an empty pool drops it", async () => {
    const dir = poolWith({ leases: [entry(4, { started: 1 })], waiting: [] });
    const pool = new Pool(dir, probes());
    await pool.status();
    expect(logOf(dir)).toEqual([]);
    expect(stateOf(dir).last_sample).toBeGreaterThan(0);
    fs.writeFileSync(
      path.join(dir, "pool.json"),
      JSON.stringify({ leases: [], waiting: [], last_sample: Date.now() - 120_000 }),
    );
    await pool.status();
    expect(logOf(dir)).toEqual([]);
    expect(stateOf(dir)).toEqual({ leases: [], waiting: [] });
  });

  it("a clock stamp from the future (the clock was set back) restarts the clock without a line", async () => {
    const now = Date.now();
    const dir = poolWith({
      leases: [entry(4, { started: now })],
      waiting: [],
      last_sample: now + 3_600_000,
    });
    await new Pool(dir, probes()).status();
    expect(logOf(dir)).toEqual([]);
    expect(stateOf(dir).last_sample).toBeLessThan(now + 60_000);
  });

  it("pool.log is bounded: a log past 1 MiB moves to pool.log.1 before the next line", async () => {
    const now = Date.now();
    const dir = poolWith({
      leases: [entry(4, { started: now })],
      waiting: [],
      last_sample: now - 61_000,
    });
    fs.writeFileSync(path.join(dir, "pool.log"), "x".repeat((1 << 20) + 1));
    await new Pool(dir, probes()).status();
    expect(fs.statSync(path.join(dir, "pool.log.1")).size).toBe((1 << 20) + 1);
    expect(logOf(dir)).toHaveLength(1);
    expect(logOf(dir)[0]).toMatch(/ sample: /);
  });
});
