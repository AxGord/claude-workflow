import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Pool, formatStatus, type PoolProbes } from "./pool.js";
import {
  advanceMeter,
  appendUsage,
  formatUsage,
  parseSince,
  readUsage,
  summarizeUsage,
  type UsageRecord,
} from "./pool-usage.js";
import { isGroupAlive, isPidAlive } from "./process.js";
import { cleanupDir } from "./test-helpers.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) cleanupDir(d);
});
afterEach(() => {
  vi.useRealTimers();
});

function poolDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-pool-usage-"));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "config.yaml"),
    JSON.stringify({ budget: 10, load_threshold: 0 }),
  );
  return dir;
}

// a group no real process has: only the injected process table knows its members
const PGID = 2_000_000_002;
function probesRunning(cpus: () => number): PoolProbes {
  return {
    perfCores: () => 12,
    loadavg: () => 0,
    cpuTicks: () => ({ busy: 0, total: 0, cpus: 1 }),
    isAlive: isPidAlive,
    isGroupAlive,
    processes: () => [
      { pid: PGID, ppid: 1, pgid: PGID, cpu: 0 },
      { pid: PGID + 1, ppid: PGID, pgid: PGID, cpu: cpus() },
    ],
  };
}

const rec = (extra: Partial<UsageRecord> = {}): UsageRecord => ({
  at: 1_000_000,
  label: "slice-gate infra*",
  threads: 4,
  ms: 60_000,
  measured_ms: 60_000,
  used: 0,
  idle: 240_000,
  over: 0,
  ...extra,
});

describe("what a lease uses against what it holds", () => {
  it("a lease that runs its threads is never UNDERUSE; a measured lease shows its runs, unflagged", async () => {
    const dir = poolDir();
    const pool = new Pool(
      dir,
      probesRunning(() => 3.5),
    );
    const holder = await pool.acquire({ threads: 4, label: "busy row" });
    if (holder.status !== "granted") throw new Error("not granted");
    await holder.lease.attach(PGID);
    await pool.status();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60 * 60 * 1000 });
    const view = await pool.status();
    const text = formatStatus(view, dir);
    await holder.lease.release();
    expect(text).toMatch(/holds 4 threads, runs ~4 {2}prio/);
    expect(text).not.toMatch(/UNDERUSE/);
    const log = fs.existsSync(path.join(dir, "pool.log"))
      ? fs.readFileSync(path.join(dir, "pool.log"), "utf8")
      : "";
    expect(log).not.toMatch(/underuse/);
  });

  it("an idle lease is flagged only after the grace period, and logged once", async () => {
    const dir = poolDir();
    const pool = new Pool(
      dir,
      probesRunning(() => 0),
    );
    const holder = await pool.acquire({ threads: 4, label: "idle row" });
    if (holder.status !== "granted") throw new Error("not granted");
    await holder.lease.attach(PGID);
    const fresh = formatStatus(await pool.status(), dir);
    expect(fresh).toMatch(/holds 4 threads, runs ~0 {2}prio/);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60 * 60 * 1000 });
    const late = formatStatus(await pool.status(), dir);
    await pool.status();
    await holder.lease.release();
    expect(late).toMatch(/holds 4 threads, runs ~0 \(UNDERUSE\) {2}prio/);
    const lines = fs
      .readFileSync(path.join(dir, "pool.log"), "utf8")
      .split("\n")
      .filter(l => l.includes("underuse:"));
    expect(lines).toHaveLength(1);
  });

  it("a lease that runs its threads again restarts the grace period", async () => {
    const dir = poolDir();
    let cpus = 0;
    const pool = new Pool(
      dir,
      probesRunning(() => cpus),
    );
    const holder = await pool.acquire({ threads: 4, label: "phased row" });
    if (holder.status !== "granted") throw new Error("not granted");
    await holder.lease.attach(PGID);
    const t0 = Date.now();
    const at = async (ms: number, busy: number): Promise<string> => {
      cpus = busy;
      vi.useFakeTimers({ toFake: ["Date"], now: t0 + ms });
      return formatStatus(await pool.status(), dir);
    };
    await at(0, 0);
    await at(40_000, 4);
    // idle again, 50 s after the first idle sample but only just now since it last ran its threads
    const text = await at(50_000, 0);
    await holder.lease.release();
    expect(text).toMatch(/holds 4 threads, runs ~0 {2}prio/);
    expect(text).not.toMatch(/UNDERUSE/);
  });

  it("a finished lease leaves a usage record under its label key", async () => {
    const dir = poolDir();
    const pool = new Pool(
      dir,
      probesRunning(() => 1),
    );
    const holder = await pool.acquire({ threads: 4, label: "slice-gate ENG-ONE infra4" });
    if (holder.status !== "granted") throw new Error("not granted");
    await holder.lease.attach(PGID);
    await pool.status();
    const t0 = Date.now();
    // two sampled stretches of 12 s on a lease that runs 1 of its 4 threads
    for (const step of [12_000, 24_000]) {
      vi.useFakeTimers({ toFake: ["Date"], now: t0 + step });
      await pool.status();
    }
    await holder.lease.release();
    const [only] = readUsage(dir);
    expect(readUsage(dir)).toHaveLength(1);
    expect(only.label).toBe("slice-gate * infra4");
    expect(only.threads).toBe(4);
    expect(only.measured_ms).toBeGreaterThanOrEqual(24_000);
    expect(only.used).toBeGreaterThan(0);
    expect(only.idle).toBeCloseTo(only.used * 3, -3);
  });
});

describe("a lease larger than the budget", () => {
  it("is recorded at the threads the meter counted (the budget), not at the threads it asked for", async () => {
    const dir = poolDir();
    const pool = new Pool(
      dir,
      probesRunning(() => 1),
    );
    const holder = await pool.acquire({ threads: 20, label: "huge" });
    if (holder.status !== "granted") throw new Error("not granted");
    await holder.lease.attach(PGID);
    await pool.status();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 12_000 });
    await pool.status();
    await holder.lease.release();
    const [only] = readUsage(dir);
    expect(only.threads).toBe(10);
    expect(only.idle).toBeCloseTo(only.used * 9, -3);
  });
});

describe("the meter", () => {
  it("a lease nobody polls is sampled by its holder while the command runs, and not after the release", async () => {
    const dir = poolDir();
    const pool = new Pool(
      dir,
      probesRunning(() => 1),
    );
    const holder = await pool.acquire({ threads: 4, label: "unpolled" });
    if (holder.status !== "granted") throw new Error("not granted");
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: Date.now() });
    await holder.lease.attach(PGID);
    await vi.advanceTimersByTimeAsync(16_000);
    // the ticks' passes do real file I/O: wait for the event (the meter written), not a fixed delay
    const readMeter = (): { leases: { meter?: { ms: number } }[] } =>
      JSON.parse(fs.readFileSync(path.join(dir, "pool.json"), "utf8")) as {
        leases: { meter?: { ms: number } }[];
      };
    // Date is faked here, so the hang guard counts polls
    for (let i = 0; i < 1500 && !((readMeter().leases[0].meter?.ms ?? 0) > 0); i++)
      await new Promise(res => setTimeout(res, 20));
    const metered = readMeter();
    expect(metered.leases[0].meter?.ms).toBeGreaterThan(0);
    await holder.lease.release();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not advance within a step, credits a gap up to the cap, and credits nothing past it or while unmeasured", () => {
    expect(advanceMeter(undefined, 0, 4, 1, 5_000)).toBeUndefined();
    expect(advanceMeter(undefined, 0, 0, 1, 60_000)).toBeUndefined();
    // an unmeasured stretch moves the clock and credits nothing, not even to the next measured advance
    const blind = advanceMeter(undefined, 0, 4, undefined, 20_000);
    expect(blind).toEqual({ at: 20_000, ms: 0, used: 0, idle: 0, over: 0 });
    expect(advanceMeter(blind, 0, 4, 1, 32_000)).toEqual({
      at: 32_000,
      ms: 12_000,
      used: 12_000,
      idle: 36_000,
      over: 0,
    });
    const first = advanceMeter(undefined, 0, 4, 1, 12_000);
    expect(first).toEqual({ at: 12_000, ms: 12_000, used: 12_000, idle: 36_000, over: 0 });
    const over = advanceMeter(first, 0, 4, 6, 24_000);
    expect(over).toMatchObject({ ms: 24_000, used: 12_000 + 72_000, over: 24_000 });
    // 5 minutes unsampled: the clock moves, nobody is credited
    expect(advanceMeter(over, 0, 4, 0, 24_000 + 300_000)).toMatchObject({
      at: 324_000,
      ms: 24_000,
      used: 84_000,
    });
  });
});

describe("the per-label usage", () => {
  it("sums per label over the window: held and used weighted by the sampled time, idle and overrun in thread-minutes", () => {
    const now = 10_000_000;
    const rows = summarizeUsage(
      [
        rec({ at: now - 1000 }),
        rec({ at: now - 2000, threads: 2, measured_ms: 60_000, used: 120_000, idle: 0 }),
        rec({ at: now - 3000, label: "other", threads: 3, used: 360_000, idle: 0, over: 60_000 }),
        // out of the window
        rec({ at: now - 3 * 3_600_000 }),
      ],
      now,
      3_600_000,
    );
    expect(rows.map(r => r.label)).toEqual(["slice-gate infra*", "other"]);
    expect(rows[0]).toMatchObject({ n: 2, held: 3, used: 1, idleThreadMin: 4, overThreadMin: 0 });
    expect(rows[1]).toMatchObject({ n: 1, held: 3, used: 6, idleThreadMin: 0, overThreadMin: 1 });
    const text = formatUsage(rows, 3_600_000, "/pool");
    expect(text).toMatch(/idle thr-min/);
    expect(text).toMatch(/2 +3\.0 +1\.0 +4\.0 +0\.0 +100% +slice-gate infra\*/);
    expect(formatUsage([], 3_600_000, "/pool")).toMatch(/none: no measured lease/);
  });

  it("reads both files, skips a damaged line, and parses a window", () => {
    const dir = poolDir();
    appendUsage(dir, rec({ label: "a" }));
    fs.appendFileSync(path.join(dir, "usage.jsonl"), "{not json\n");
    appendUsage(dir, rec({ label: "b" }));
    expect(readUsage(dir).map(r => r.label)).toEqual(["a", "b"]);
    expect(parseSince("90m")).toBe(90 * 60_000);
    expect(parseSince("2d")).toBe(2 * 24 * 3_600_000);
    expect(parseSince("soon")).toBeUndefined();
    expect(parseSince("0h")).toBeUndefined();
  });

  it("wf-run --usage prints the table; --since needs --usage and a window", async () => {
    const dir = poolDir();
    const out = path.join(dir, "bin", "wf-run.cjs");
    await build({
      entryPoints: [path.join(SRC, "wf-run.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node18",
      outfile: out,
      logLevel: "silent",
    });
    appendUsage(dir, rec({ at: Date.now() - 1000, label: "land phase" }));
    const run = (args: string[]) =>
      spawnSync(process.execPath, [out, ...args], {
        env: { ...process.env, WF_POOL_DIR: dir },
        encoding: "utf8",
      });
    const ok = run(["--usage", "--since", "2h"]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/land phase/);
    expect(ok.stdout).toMatch(/idle thr-min/);
    expect(run(["--since", "2h", "--", "true"]).status).toBe(64);
    expect(run(["--usage", "--since", "yesterday"]).status).toBe(64);
  });
});
