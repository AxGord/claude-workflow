import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool, schedule, byQueueOrder, type PoolEntry, type PoolState } from "./pool.js";
import { Executor } from "./executor.js";
import { isGroupAlive, isPidAlive } from "./process.js";
import { cleanupDir } from "./test-helpers.js";
import type { StateDefinition } from "./types.js";

const MIN = 60_000;
let seq = 0;
const entry = (threads: number, extra: Partial<PoolEntry> = {}): PoolEntry => ({
  id: `b${++seq}`,
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
const cfg = { budget: 10, load_threshold: 0, starve_after: 900 };
const ids = (es: readonly PoolEntry[]) => es.map(e => e.id);

describe("schedule: backfill ahead of the head", () => {
  // TM: two anyparse leases of 4 (est 10m), a head of 4-10, a 2-thread waiter behind it.
  const tm = (waiter: Partial<PoolEntry>, lease: Partial<PoolEntry> = {}) => {
    const a = entry(4, { started: 0, est_ms: 10 * MIN, ...lease });
    const b = entry(4, { started: 0, est_ms: 10 * MIN, ...lease });
    const head = entry(10, { min_threads: 4, full_until: 0 });
    const w = entry(2, waiter);
    return { state: { leases: [a, b], waiting: [head, w] }, head, w };
  };

  it("TM: a 2-thread waiter whose estimate ends before the head's threads free is admitted", () => {
    const { state, w, head } = tm({ est_ms: 3 * MIN });
    const v = schedule(state, cfg, 0, alive, MIN);
    expect(ids(v.leases)).toContain(w.id);
    expect(v.leases.find(e => e.id === w.id)?.backfill_for).toBe(head.id);
    expect(ids(v.waiting)).toEqual([head.id]);
  });

  it("TM: est 15m, no estimate, or an over-running lease → not admitted", () => {
    for (const [waiter, lease, runs] of [
      [{ est_ms: 15 * MIN }, {}, {}],
      [{}, {}, {}],
      [{ est_ms: 3 * MIN }, { est_ms: undefined }, {}],
    ] as const) {
      const { state, w } = tm(waiter, lease);
      expect(ids(schedule(state, cfg, 0, alive, MIN, runs).waiting)).toContain(w.id);
    }
    const { state, w } = tm({ est_ms: 3 * MIN });
    const runs = { [state.leases[0].id]: 9, [state.leases[1].id]: 9 };
    expect(ids(schedule(state, cfg, 9, alive, MIN, runs).waiting)).toContain(w.id);
    // a lease past its estimate ends at an unknown time
    expect(ids(schedule(state, cfg, 0, alive, 11 * MIN).waiting)).toContain(w.id);
  });

  it("without estimates nothing passes the head, starved or not", () => {
    const held = entry(5, { started: 0 });
    const big = entry(7, { arrived: 0 });
    const one = entry(1, { arrived: 1 });
    for (const now of [1, 901_000]) {
      const v = schedule({ leases: [held], waiting: [big, one] }, cfg, 0, alive, now);
      expect(ids(v.waiting)).toEqual([big.id, one.id]);
    }
  });

  it("a flexible head inside its wait_full window waits for its max", () => {
    const a = entry(4, { started: 0, est_ms: 10 * MIN });
    const b = entry(4, { started: 0, est_ms: 20 * MIN });
    const head = entry(10, { min_threads: 4, full_until: 30 * MIN });
    const w = entry(2, { est_ms: 15 * MIN });
    // max 10 needs both leases gone (20m): 15m passes; after the window min 4 frees at 10m: it does not
    expect(
      ids(schedule({ leases: [a, b], waiting: [head, w] }, cfg, 0, alive, 1).leases),
    ).toContain(w.id);
    expect(
      ids(
        schedule({ leases: [a, b], waiting: [{ ...head, full_until: 0 }, w] }, cfg, 0, alive, 1)
          .waiting,
      ),
    ).toContain(w.id);
  });

  it("a backfilled lease past twice its estimate stops backfill past that head", () => {
    const head = entry(6);
    const late = entry(2, { started: 0, est_ms: MIN, backfill_for: head.id });
    const other = entry(4, { started: 0, est_ms: 10 * MIN });
    const next = entry(2, { est_ms: MIN });
    const v = schedule(
      { leases: [late, other], waiting: [head, next] },
      cfg,
      0,
      alive,
      2 * MIN + 1,
    );
    expect(v.backfill_off).toBe(head.id);
    expect(ids(v.waiting)).toEqual([head.id, next.id]);
    // once the head is gone the mark goes with it
    const v2 = schedule({ leases: [], waiting: [], backfill_off: head.id }, cfg, 0, alive, 1);
    expect(v2.backfill_off).toBeUndefined();
  });

  it("locks: a waiter blocked by a lock never backfills; priority order is kept", () => {
    const l = entry(0, { started: 0, locks: ["db"] });
    const a = entry(4, { started: 0, est_ms: 10 * MIN });
    const b = entry(4, { started: 0, est_ms: 10 * MIN });
    const head = entry(4);
    const locked = entry(1, { est_ms: MIN, locks: ["db"] });
    const v = schedule({ leases: [l, a, b], waiting: [head, locked] }, cfg, 0, alive, 1);
    expect(ids(v.waiting)).toEqual([head.id, locked.id]);
  });
});

/** Seeded PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Job {
  readonly entry: PoolEntry;
  readonly run: number;
}

/** Start times by id: `schedule` every tick, a lease ends after its true run. */
function simulate(leases: Job[], waiters: Job[]): Map<string, number> {
  const run = new Map([...leases, ...waiters].map(j => [j.entry.id, j.run]));
  let state: PoolState = { leases: leases.map(j => j.entry), waiting: waiters.map(j => j.entry) };
  const starts = new Map<string, number>();
  for (let t = 0; state.waiting.length > 0 && t < 10_000; t++) {
    const live = state.leases.filter(e => e.started! + run.get(e.id)! > t);
    const v = schedule({ ...state, leases: live }, { ...cfg, starve_after: 1e9 }, 0, alive, t);
    for (const e of v.leases) if (!starts.has(e.id)) starts.set(e.id, e.started!);
    state = { leases: v.leases, waiting: v.waiting, backfill_off: v.backfill_off };
  }
  return starts;
}

/** Strict order: grant in queue order until the first waiter that does not fit. */
function strictStarts(leases: Job[], waiters: Job[]): Map<string, number> {
  const run = new Map([...leases, ...waiters].map(j => [j.entry.id, j.run]));
  let held = leases.map(j => ({ end: j.run, n: j.entry.threads }));
  const queue = waiters.map(j => j.entry).sort(byQueueOrder);
  const starts = new Map<string, number>();
  for (let t = 0; queue.length > 0; t++) {
    held = held.filter(h => h.end > t);
    while (queue.length > 0) {
      const used = held.reduce((s, h) => s + h.n, 0);
      if (used + queue[0].threads > cfg.budget) break;
      const w = queue.shift()!;
      starts.set(w.id, t);
      held.push({ end: t + run.get(w.id)!, n: w.threads });
    }
  }
  return starts;
}

describe("schedule: backfill never delays the head beyond strict order + bounded slip", () => {
  for (const [name, overrun, withEst] of [
    ["accurate estimates", 1, true],
    ["runs up to twice the estimate", 2, true],
    ["no estimates", 1, false],
  ] as const) {
    it(name, () => {
      const r = rng(name.length * 7919);
      for (let c = 0; c < 400; c++) {
        let used = 0;
        const leases: Job[] = [];
        for (let i = 0, n = 1 + Math.floor(r() * 3); i < n; i++) {
          const threads = 1 + Math.floor(r() * 5);
          if (used + threads > cfg.budget) break;
          used += threads;
          const est = 1 + Math.floor(r() * 50);
          leases.push({
            entry: entry(threads, { started: 0, ...(withEst ? { est_ms: est } : {}) }),
            run: Math.max(1, Math.ceil(est * (0.3 + r() * (overrun - 0.3)))),
          });
        }
        let maxEst = 0;
        const waiters: Job[] = [];
        for (let i = 0, n = 2 + Math.floor(r() * 5); i < n; i++) {
          const est = 1 + Math.floor(r() * 40);
          const hasEst = withEst && r() < 0.8;
          if (hasEst) maxEst = Math.max(maxEst, est);
          waiters.push({
            entry: entry(1 + Math.floor(r() * 8), {
              priority: Math.floor(r() * 2),
              ...(hasEst ? { est_ms: est } : {}),
            }),
            run: Math.max(1, Math.ceil(est * (0.3 + r() * (overrun - 0.3)))),
          });
        }
        const strict = strictStarts(leases, waiters);
        const head = waiters
          .map(j => j.entry)
          .sort(byQueueOrder)
          .find(e => strict.get(e.id)! > 0);
        if (!head) continue;
        const got = simulate(leases, waiters).get(head.id);
        expect(got).toBeDefined();
        expect(got!).toBeLessThanOrEqual(strict.get(head.id)! + overrun * maxEst);
      }
    });
  }
});

describe("estimates reach the pool", () => {
  it("an exec's lease carries the step's estimate on its threads; a flexible one has none", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-bf-"));
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ budget: 10, load_threshold: 0 }),
      );
      const pool = new Pool(dir, {
        perfCores: () => 12,
        loadavg: () => 0,
        cpuTicks: () => ({ busy: 0, total: 0, cpus: 1 }),
        isAlive: isPidAlive,
        isGroupAlive,
      });
      const asked: number[] = [];
      const ctx = {
        sessionId: "s",
        rootSessionId: "s",
        estimate: (threads: number) => {
          asked.push(threads);
          return 5000;
        },
      };
      const cat = `cat "${path.join(dir, "pool.json")}"`;
      const fixed: StateDefinition = { type: "exec", command: cat, resource: { threads: 3 } };
      const r = await new Executor(pool).execute(fixed, {}, ctx);
      expect(r.stdout).toContain('"est_ms": 5000');
      expect(asked).toEqual([3]);
      const flexible: StateDefinition = { ...fixed, resource: { threads: { min: 1, max: 3 } } };
      const r2 = await new Executor(pool).execute(flexible, {}, ctx);
      expect(r2.stdout).not.toContain("est_ms");
    } finally {
      cleanupDir(dir);
    }
  });
});
