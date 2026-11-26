import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Pool,
  formatStatus,
  leaseEta,
  poolSnapshot,
  recordWork,
  type PoolEntry,
  type PoolState,
  type PoolView,
} from "./pool.js";
import { isGroupAlive, isPidAlive } from "./process.js";
import { cleanupDir } from "./test-helpers.js";

const MIN = 60_000;
const NOW = 1_000_000_000_000;
const KEY = "arm-sweep *";
let seq = 0;
const lease = (threads: number, ageMs: number, extra: Partial<PoolEntry> = {}): PoolEntry => ({
  id: `e${++seq}`,
  pid: 100,
  threads,
  priority: 0,
  label: "arm-sweep 3c9a1f0b2d",
  cwd: "/",
  session_id: "",
  arrived: NOW - ageMs,
  started: NOW - ageMs,
  ...extra,
});
// five earlier runs of 2 threads x 100 min each: 200 thread-min
const work = { [KEY]: Array.from({ length: 5 }, () => 200 * MIN) };

describe("leaseEta: the time left of a running lease, from the thread-time of earlier runs", () => {
  it("(typical thread-time - used thread-time) / threads held", () => {
    const e = lease(2, 55 * MIN);
    const eta = leaseEta({ work }, e, 6, NOW);
    expect(eta).toMatchObject({ typicalMs: 100 * MIN, runs: 5, leftMs: 45 * MIN });
    expect(eta?.overMs).toBeUndefined();
    expect(eta?.text).toBe("~45m left (typ. 1h40m, 5 runs)");
  });

  it("a lease granted fewer threads has proportionally more left", () => {
    const two = leaseEta({ work }, lease(2, 10 * MIN), 6, NOW);
    const one = leaseEta({ work }, lease(1, 10 * MIN), 6, NOW);
    expect(two?.typicalMs).toBe(100 * MIN);
    expect(one?.typicalMs).toBe(200 * MIN);
    // equal thread-time used by the same age would be half as far along on one thread
    expect(one?.leftMs).toBe(190 * MIN);
    expect(two?.leftMs).toBe(90 * MIN);
  });

  it("past its typical time the lease is over it, never a negative time left", () => {
    const eta = leaseEta({ work }, lease(2, 112 * MIN), 6, NOW);
    expect(eta?.leftMs).toBeUndefined();
    expect(eta?.overMs).toBe(12 * MIN);
    expect(eta?.text).toBe("over typical by 12m (typ. 1h40m, 5 runs)");
    expect(leaseEta({ work }, lease(2, 100 * MIN), 6, NOW)?.leftMs).toBeUndefined();
  });

  it("no ETA below MIN_SAMPLES runs, for a waiter, a lock-only lease or an empty label", () => {
    const few = { [KEY]: [200 * MIN, 200 * MIN] };
    expect(leaseEta({ work: few }, lease(2, MIN), 6, NOW)).toBeUndefined();
    expect(leaseEta({}, lease(2, MIN), 6, NOW)).toBeUndefined();
    expect(leaseEta({ work }, lease(2, MIN, { started: undefined }), 6, NOW)).toBeUndefined();
    expect(leaseEta({ work }, lease(0, MIN, { locks: ["db"] }), 6, NOW)).toBeUndefined();
    expect(leaseEta({ work }, lease(2, MIN, { label: "" }), 6, NOW)).toBeUndefined();
    expect(leaseEta({ work }, lease(2, MIN, { label: "other job" }), 6, NOW)).toBeUndefined();
  });

  it("a request above the budget counts as the whole budget", () => {
    const eta = leaseEta({ work }, lease(12, MIN), 4, NOW);
    expect(eta?.typicalMs).toBe(50 * MIN);
  });

  it("recordWork keeps thread-ms under the label key and skips what is no run", () => {
    let state: Pick<PoolState, "work"> = {};
    state = { work: recordWork(state, "arm-sweep 3c9a1f0b2d", 4 * MIN) };
    state = { work: recordWork(state, "arm-sweep aaaaaaa1", 6 * MIN) };
    state = { work: recordWork(state, "arm-sweep aaaaaaa1", 0) };
    state = { work: recordWork(state, "", 5 * MIN) };
    expect(state.work).toEqual({ [KEY]: [4 * MIN, 6 * MIN] });
  });
});

describe("the ETA on the pool's rows", () => {
  const view = (leases: PoolEntry[]): PoolView => ({
    budget: 6,
    load_threshold: 0,
    starve_after: 900,
    load: 0,
    external: 0,
    held: 2,
    leases,
    waiting: [],
    work,
    runs: {},
  });

  it("the snapshot of /api/pool and `wf-run --status` carry it; a lease with no samples carries none", () => {
    const sweep = lease(2, 55 * MIN);
    const other = lease(1, 5 * MIN, { label: "other job" });
    const v = view([sweep, other]);
    const snap = poolSnapshot(v, NOW);
    expect(snap.leases[0]?.eta).toMatchObject({
      leftMs: 45 * MIN,
      text: "~45m left (typ. 1h40m, 5 runs)",
    });
    expect(snap.leases[1]?.eta).toBeUndefined();
    const text = formatStatus(v, "/tmp/pool", NOW).split("\n");
    expect(text.find(l => l.includes("arm-sweep"))).toContain("~45m left (typ. 1h40m, 5 runs)");
    expect(text.find(l => l.includes("other job"))).not.toContain("left");
  });
});

describe("a released lease records its thread-time", () => {
  it("threads held x time held, by label key, a failed run's too (its wall time stays out of history)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-eta-"));
    try {
      fs.writeFileSync(
        path.join(dir, "config.yaml"),
        JSON.stringify({ budget: 6, load_threshold: 0 }),
      );
      const pool = new Pool(dir, {
        perfCores: () => 12,
        loadavg: () => 0,
        cpuTicks: () => ({ busy: 0, total: 0, cpus: 1 }),
        isAlive: isPidAlive,
        isGroupAlive,
      });
      for (const [slice, failed] of [
        ["ENG-A", false],
        ["ENG-B", true],
      ] as const) {
        const got = await pool.acquire({ threads: 2, label: `arm-sweep ${slice}` });
        if (got.status !== "granted") throw new Error("not granted");
        const file = path.join(dir, "pool.json");
        const state = JSON.parse(fs.readFileSync(file, "utf8")) as PoolState;
        fs.writeFileSync(
          file,
          JSON.stringify({
            ...state,
            leases: state.leases.map(e => ({ ...e, started: e.started! - 5000 })),
          }),
        );
        await got.lease.release({ failed });
      }
      const state = JSON.parse(fs.readFileSync(path.join(dir, "pool.json"), "utf8")) as PoolState;
      // both runs of `arm-sweep *` (the second released failed, as the real sweep's lease is) count
      const runs = state.work?.[KEY];
      expect(runs).toHaveLength(2);
      for (const ms of runs ?? []) {
        expect(ms).toBeGreaterThanOrEqual(10_000);
        expect(ms).toBeLessThan(30_000);
      }
      expect(state.history?.[KEY]).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, "pool.log"), "utf8")).toMatch(
        /released failed: pid \d+ held 2 threads for \d+s, not in history — arm-sweep ENG-B/,
      );
    } finally {
      cleanupDir(dir);
    }
  });

  it("a label whose every run was released failed (the sweep of a real pool) still shows its time left", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-eta-"));
    try {
      fs.writeFileSync(
        path.join(dir, "config.yaml"),
        JSON.stringify({ budget: 6, load_threshold: 0 }),
      );
      const pool = new Pool(dir, {
        perfCores: () => 12,
        loadavg: () => 0,
        cpuTicks: () => ({ busy: 0, total: 0, cpus: 1 }),
        isAlive: isPidAlive,
        isGroupAlive,
      });
      const file = path.join(dir, "pool.json");
      const age = (ms: number) => {
        const state = JSON.parse(fs.readFileSync(file, "utf8")) as PoolState;
        fs.writeFileSync(
          file,
          JSON.stringify({
            ...state,
            leases: state.leases.map(e => ({ ...e, started: e.started! - ms })),
          }),
        );
      };
      for (const slice of ["aaaaaaa1", "bbbbbbb2", "ccccccc3"]) {
        const got = await pool.acquire({ threads: 2, label: `arm-sweep ${slice}` });
        if (got.status !== "granted") throw new Error("not granted");
        age(600_000);
        await got.lease.release({ failed: true });
      }
      const next = await pool.acquire({ threads: 2, label: "arm-sweep ddddddd4" });
      if (next.status !== "granted") throw new Error("not granted");
      age(60_000);
      const row = poolSnapshot(await pool.status()).leases[0];
      expect(row?.eta?.runs).toBe(3);
      // 3 runs of 2 threads x 600 s: typical 600 s, 60 s used
      expect(row?.eta?.typicalMs).toBeGreaterThanOrEqual(600_000);
      expect(row?.eta?.typicalMs).toBeLessThan(610_000);
      expect(row?.eta?.text).toMatch(/^~(9|10)m left \(typ\. 10m, 3 runs\)$/);
      await next.lease.release();
    } finally {
      cleanupDir(dir);
    }
  });
});
