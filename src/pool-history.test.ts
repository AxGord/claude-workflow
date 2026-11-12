import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HISTORY_SAMPLES,
  Pool,
  historyEstimate,
  labelKey,
  recordRun,
  schedule,
  type PoolEntry,
  type PoolState,
} from "./pool.js";
import { Executor } from "./executor.js";
import { isGroupAlive, isPidAlive } from "./process.js";
import { cleanupDir } from "./test-helpers.js";
import type { StateDefinition } from "./types.js";

const MIN = 60_000;
let seq = 0;
const entry = (threads: number, extra: Partial<PoolEntry> = {}): PoolEntry => ({
  id: `h${++seq}`,
  pid: 100,
  threads,
  priority: 0,
  label: "",
  cwd: "/",
  session_id: "",
  arrived: seq,
  ...extra,
});
const alive = () => true;
const cfg = { budget: 6, load_threshold: 0, starve_after: 900 };
const ids = (es: readonly PoolEntry[]) => es.map(e => e.id);

const BUILD = "haxe build.hxml ENG-ONE";
const BUILD_KEY = "haxe build.hxml *";
// three 1-minute builds of the key, and three 10-minute runs of the big job
const history = { [BUILD_KEY]: [MIN, MIN, MIN], "big job": [10 * MIN, 10 * MIN, 10 * MIN] };

// TM: a 4-thread lease runs, the 4-thread head is blocked by threads with 2 free, a 1-thread
// build waits behind it.
const blocked = (waiter: Partial<PoolEntry>, lease: Partial<PoolEntry> = {}, hist = history) => {
  const big = entry(4, { started: 0, label: "big job", ...lease });
  const head = entry(4, { label: "head" });
  const w = entry(1, { label: BUILD, ...waiter });
  const state: PoolState = { leases: [big], waiting: [head, w], history: hist };
  return { state, big, head, w };
};

describe("the label key", () => {
  it("drops a slice id, a task id and a commit hash; one command is one key across slices", () => {
    expect(labelKey("haxe build.hxml ENG-ONE")).toBe(BUILD_KEY);
    expect(labelKey("haxe build.hxml LINT-FIX-CHANGED-LINES")).toBe(BUILD_KEY);
    expect(labelKey("slice-gate /tmp/wf-CANON-5 --base 91f985194d")).toBe(
      "slice-gate /tmp/wf-* --base *",
    );
    expect(labelKey("node bin/dev.js shard -n 4")).toBe("node bin/dev.js shard -n 4");
    expect(labelKey("")).toBe("");
    expect(labelKey("   ")).toBe("");
  });
});

describe("history: run times by label key", () => {
  it("keeps the last HISTORY_SAMPLES runs, newest last; the p90 is of those", () => {
    let state: PoolState = { leases: [], waiting: [] };
    // two slow runs first, then ten fast ones: the slow ones fall out of the window
    for (const ms of [60 * MIN, 60 * MIN, ...Array.from({ length: HISTORY_SAMPLES }, () => MIN)])
      state = { ...state, history: recordRun(state, BUILD, ms) };
    expect(state.history?.[BUILD_KEY]).toHaveLength(HISTORY_SAMPLES);
    expect(historyEstimate(state, "haxe build.hxml ENG-OTHER")).toBe(MIN);
  });

  it("fewer than 3 samples: no estimate", () => {
    expect(historyEstimate({ history: { [BUILD_KEY]: [MIN, MIN] } }, BUILD)).toBeUndefined();
    expect(historyEstimate({ history: { [BUILD_KEY]: [MIN, MIN, MIN] } }, BUILD)).toBe(MIN);
    expect(historyEstimate({}, BUILD)).toBeUndefined();
    expect(historyEstimate({ history: { "": [MIN, MIN, MIN] } }, "")).toBeUndefined();
  });

  it("a run is not recorded for an empty label or a zero time; old keys go past the cap", () => {
    expect(recordRun({}, "", MIN)).toEqual({});
    expect(recordRun({}, BUILD, 0)).toEqual({});
    let hist: NonNullable<PoolState["history"]> = {};
    for (let i = 0; i < 250; i++) hist = recordRun({ history: hist }, `cmd ${i}x`, MIN);
    expect(Object.keys(hist)).toHaveLength(200);
    expect(hist["cmd 249x"]).toBeDefined();
    expect(hist["cmd 0x"]).toBeUndefined();
  });
});

describe("schedule: backfill on the estimate of the label's history", () => {
  it("a waiter with no estimate of its own but history is granted ahead of the head, with that estimate", () => {
    const { state, head, w } = blocked({});
    const v = schedule(state, cfg, 0, alive, MIN);
    const lease = v.leases.find(e => e.id === w.id);
    expect(lease?.backfill_for).toBe(head.id);
    expect(lease?.est_ms).toBe(MIN);
    expect(ids(v.waiting)).toEqual([head.id]);
  });

  it("no history (or fewer than 3 samples): strict order, the head is not passed", () => {
    for (const hist of [{}, { [BUILD_KEY]: [MIN, MIN], "big job": history["big job"] }]) {
      const { state, w } = blocked({}, {}, hist);
      expect(ids(schedule(state, cfg, 0, alive, MIN).waiting)).toContain(w.id);
    }
  });

  it("a head whose leases have no estimate is never passed", () => {
    // the lease's own key has no history: it ends at an unknown time
    const { state, w } = blocked({}, { label: "unknown job" });
    expect(ids(schedule(state, cfg, 0, alive, MIN).waiting)).toContain(w.id);
    const { state: other, w: w2 } = blocked({}, { label: "" });
    expect(ids(schedule(other, cfg, 0, alive, MIN).waiting)).toContain(w2.id);
  });

  it("a waiter whose history ends after the head's threads free is not admitted", () => {
    const slow = { ...history, [BUILD_KEY]: [20 * MIN, 20 * MIN, 20 * MIN] };
    const { state, w } = blocked({}, {}, slow);
    expect(ids(schedule(state, cfg, 0, alive, MIN).waiting)).toContain(w.id);
  });

  it("its own estimate wins over the history", () => {
    const { state, w } = blocked({ est_ms: 20 * MIN });
    expect(ids(schedule(state, cfg, 0, alive, MIN).waiting)).toContain(w.id);
  });

  it("a lease with no estimate takes its label's history: the head's reservation sees its end", () => {
    // without history the 'big job' lease has no end; with it the head's start is 10 minutes
    const { state, big } = blocked({});
    const v = schedule(state, cfg, 0, alive, MIN);
    expect(v.leases.find(e => e.id === big.id)?.est_ms).toBe(10 * MIN);
  });

  it("backfill_off still trips at twice the estimate, an estimate taken from history", () => {
    const { state, head, w } = blocked({});
    const granted = schedule(state, cfg, 0, alive, MIN);
    expect(granted.backfill_off).toBeUndefined();
    const next = entry(1, { label: BUILD });
    const later = (now: number) =>
      schedule({ ...granted, waiting: [...granted.waiting, next] }, cfg, 0, alive, now);
    // inside 2x the estimate (1 minute, started at 1 minute): still backfills
    expect(later(MIN + 2 * MIN).backfill_off).toBeUndefined();
    const over = later(MIN + 2 * MIN + 1);
    expect(over.backfill_off).toBe(head.id);
    expect(ids(over.waiting)).toEqual([head.id, next.id]);
    expect(ids(over.leases)).toContain(w.id);
  });
});

describe("the pool records the run times of finished leases", () => {
  const withPool = async (body: (pool: Pool, dir: string) => Promise<void>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-hist-"));
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
      await body(pool, dir);
    } finally {
      cleanupDir(dir);
    }
  };
  const poolFile = (dir: string) =>
    JSON.parse(fs.readFileSync(path.join(dir, "pool.json"), "utf8")) as PoolState;
  // pretend the lease has run for `ms`
  const aged = (dir: string, ms: number) => {
    const state = poolFile(dir);
    fs.writeFileSync(
      path.join(dir, "pool.json"),
      JSON.stringify({
        ...state,
        leases: state.leases.map(e => ({ ...e, started: e.started! - ms })),
      }),
    );
  };

  // the head is queued before the waiter asks: a waiter that came first would simply fit
  const queued = async (dir: string, label: string) => {
    for (let i = 0; i < 100; i++) {
      if (poolFile(dir).waiting.some(e => e.label === label)) return;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`${label} never queued`);
  };

  it("a released lease adds its run time under its label key; a failed run adds none", async () => {
    await withPool(async (pool, dir) => {
      for (const [slice, failed] of [
        ["ENG-A", false],
        ["ENG-B", false],
        ["ENG-C", true],
      ] as const) {
        const got = await pool.acquire({ threads: 2, label: `haxe build.hxml ${slice}` });
        if (got.status !== "granted") throw new Error("not granted");
        aged(dir, 5000);
        await got.lease.release({ failed });
      }
      const runs = poolFile(dir).history?.[BUILD_KEY];
      expect(runs).toHaveLength(2);
      for (const ms of runs ?? []) {
        expect(ms).toBeGreaterThanOrEqual(5000);
        expect(ms).toBeLessThan(15_000);
      }
    });
  });

  it("a lock-only lease and an aborted wait record nothing", async () => {
    await withPool(async (pool, dir) => {
      const got = await pool.acquire({ threads: 0, locks: ["db"], label: "lock job" });
      if (got.status !== "granted") throw new Error("not granted");
      aged(dir, 5000);
      await got.lease.release();
      expect(poolFile(dir).history).toBeUndefined();
    });
  });

  it("REPRODUCE: a 1-thread waiter with history passes a blocked 4-thread head and pool.log says backfill", async () => {
    await withPool(async (pool, dir) => {
      // A 4-thread lease runs (this process); history says both it and the build take a while.
      const first = await pool.acquire({ threads: 4, label: "big job" });
      if (first.status !== "granted") throw new Error("not granted");
      const state = poolFile(dir);
      fs.writeFileSync(
        path.join(dir, "pool.json"),
        JSON.stringify({
          ...state,
          history: { ...history, "big job": [20 * MIN, 20 * MIN, 20 * MIN] },
        }),
      );
      const ac = new AbortController();
      const headWait = pool.acquire({ threads: 4, label: "head" }, { signal: ac.signal });
      try {
        await queued(dir, "head");
        const got = await pool.acquire({ threads: 1, label: BUILD }, { waitTimeoutMs: 5000 });
        expect(got.status).toBe("granted");
        const log = fs.readFileSync(path.join(dir, "pool.log"), "utf8");
        expect(log).toMatch(/backfill: pid \d+ takes 1 threads ahead of .* \(est 1m/);
        if (got.status === "granted") await got.lease.release();
      } finally {
        ac.abort();
        await headWait;
        await first.lease.release();
      }
    });
  });

  it("without history the same waiter waits behind the head (strict order)", async () => {
    await withPool(async (pool, dir) => {
      const first = await pool.acquire({ threads: 4, label: "big job" });
      if (first.status !== "granted") throw new Error("not granted");
      const state = poolFile(dir);
      fs.writeFileSync(
        path.join(dir, "pool.json"),
        JSON.stringify({ ...state, history: { "big job": [20 * MIN, 20 * MIN, 20 * MIN] } }),
      );
      const ac = new AbortController();
      const headWait = pool.acquire({ threads: 4, label: "head" }, { signal: ac.signal });
      try {
        await queued(dir, "head");
        const got = await pool.acquire({ threads: 1, label: BUILD }, { waitTimeoutMs: 1500 });
        expect(got.status).toBe("timeout");
        expect(fs.existsSync(path.join(dir, "pool.log"))).toBe(false);
      } finally {
        ac.abort();
        await headWait;
        await first.lease.release();
      }
    });
  });

  it("an exec step records its run on release unless the command failed", async () => {
    await withPool(async (pool, dir) => {
      const ok: StateDefinition = { type: "exec", command: "true", resource: { threads: 1 } };
      const bad: StateDefinition = { type: "exec", command: "false", resource: { threads: 1 } };
      await new Executor(pool).execute({ ...ok, command: "sleep 0.05" }, {}, undefined);
      await new Executor(pool).execute(bad, {}, undefined);
      expect(Object.keys(poolFile(dir).history ?? {})).toEqual(["sleep 0.05"]);
    });
  });
});
