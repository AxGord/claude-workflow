import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool, schedule, type PoolEntry } from "./pool.js";
import { Executor } from "./executor.js";
import { isGroupAlive, isPidAlive } from "./process.js";
import { cleanupDir } from "./test-helpers.js";
import type { StateDefinition } from "./types.js";

const SEC = 1000;
let seq = 0;
const entry = (threads: number, extra: Partial<PoolEntry> = {}): PoolEntry => ({
  id: `e${++seq}`,
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

// 60 s serial + 960 s / threads, for 2..8 threads: 2 → 540 s, 4 → 300 s, 8 → 180 s.
const curve = Object.fromEntries([2, 3, 4, 5, 6, 7, 8].map(k => [String(k), (60 + 960 / k) * SEC]));
// a 6-thread lease started at 0 that ends `endsIn` ms from the pass at 1000
const lease6 = (endsIn: number, extra: Partial<PoolEntry> = {}) =>
  entry(6, { started: 0, est_ms: 1000 + endsIn, ...extra });
const flex = (extra: Partial<PoolEntry> = {}) =>
  entry(8, { min_threads: 2, full_until: 0, est_curve: curve, ...extra });

describe("a flexible waiter with an estimate by threads picks the size that ends earliest", () => {
  it("waits when more threads free soon enough: 20 s for 8 threads (ends in 200 s) beats 4 now (300 s)", () => {
    const held = lease6(20 * SEC);
    const w = flex();
    const small = entry(1);
    const v = schedule({ leases: [held], waiting: [w, small] }, cfg, 0, alive, 1000);
    expect(ids(v.leases)).toEqual([held.id]);
    // it is the head: it closes the threads to the waiter behind it
    expect(ids(v.waiting)).toEqual([w.id, small.id]);
    // its reservation is the 20 s: a 10 s task passes it, a 30 s one does not
    const quick = entry(1, { est_ms: 10 * SEC });
    const slow = entry(1, { est_ms: 30 * SEC });
    const behind = schedule({ leases: [held], waiting: [w, quick, slow] }, cfg, 0, alive, 1000);
    expect(ids(behind.leases)).toEqual([held.id, quick.id]);
    expect(behind.leases[1].backfill_for).toBe(w.id);
    // once the lease has ended it takes the 8 threads, with that size's estimate on the lease
    const freed = schedule({ leases: [], waiting: [w] }, cfg, 0, alive, 21_000);
    expect(freed.leases.map(e => [e.threads, e.asked_threads, e.est_ms, e.est_curve])).toEqual([
      [8, 8, 180 * SEC, undefined],
    ]);
  });

  it("the reservation is the start of the size it waits for, not of its min", () => {
    // 1 thread frees at 90 s, 5 more at 100 s: 8 threads from 100 s end at 280 s, before 4 now (300 s)
    const a = entry(1, { started: 0, est_ms: 91 * SEC });
    const b = entry(5, { started: 0, est_ms: 101 * SEC });
    const w = flex();
    // a task of 95 s starts at 1 s and ends at 96 s: past the 2 threads' 90 s, inside the 8's 100 s
    const task = entry(1, { est_ms: 95 * SEC });
    const v = schedule({ leases: [a, b], waiting: [w, task] }, cfg, 0, alive, 1000);
    expect(ids(v.leases)).toEqual([a.id, b.id, task.id]);
    expect(ids(v.waiting)).toEqual([w.id]);
  });

  it("starts now when they do not: 200 s for 8 threads (ends in 380 s) loses to 4 now (300 s)", () => {
    const held = lease6(200 * SEC);
    const w = flex();
    const v = schedule({ leases: [held], waiting: [w] }, cfg, 0, alive, 1000);
    expect(v.leases.map(e => [e.id, e.threads, e.est_ms])).toEqual([
      [held.id, 6, held.est_ms],
      [w.id, 4, 300 * SEC],
    ]);
    expect(v.leases[1].est_curve).toBeUndefined();
  });

  it("a lease that ends at an unknown time (no estimate, past it, over-running) is not waited for", () => {
    for (const lease of [lease6(20 * SEC, { est_ms: undefined }), lease6(-1, { est_ms: 500 })]) {
      const v = schedule({ leases: [lease], waiting: [flex()] }, cfg, 0, alive, 1000);
      expect(v.leases.map(e => e.threads)).toEqual([6, 4]);
    }
    // an over-running lease (its tree runs far above what it leased) ends at an unknown time too
    const held = lease6(20 * SEC);
    const v = schedule({ leases: [held], waiting: [flex()] }, cfg, 9, alive, 1000, {
      [held.id]: 9,
    });
    expect(v.leases.map(e => e.threads)).toEqual([6, 4]);
  });

  it("no estimate falls back to wait_full: inside the window it waits, after it takes what fits", () => {
    const held = lease6(20 * SEC);
    for (const noCurve of [undefined, { ...curve, "5": 0 }, { "2": 540 * SEC }]) {
      const w = flex({ est_curve: noCurve, full_until: 5000 });
      const inWindow = schedule({ leases: [held], waiting: [w] }, cfg, 0, alive, 1000);
      expect(ids(inWindow.leases)).toEqual([held.id]);
      const after = schedule({ leases: [held], waiting: [w] }, cfg, 0, alive, 5000);
      expect(after.leases.map(e => e.threads)).toEqual([6, 4]);
    }
  });

  it("ignores wait_full: a window still open does not hold it when starting now ends earlier", () => {
    const held = lease6(200 * SEC);
    const w = flex({ full_until: 10 ** 9 });
    expect(schedule({ leases: [held], waiting: [w] }, cfg, 0, alive, 1000).leases).toHaveLength(2);
  });

  it("takes the size with the earliest end among those that fit, the larger on a tie", () => {
    const flat = Object.fromEntries([2, 3, 4].map(k => [String(k), 100 * SEC]));
    const w = entry(4, { min_threads: 2, full_until: 0, est_curve: flat });
    const v = schedule({ leases: [entry(6, { started: 0 })], waiting: [w] }, cfg, 0, alive, 1000);
    expect(v.leases[1].threads).toBe(4);
    // a faster small size wins over a bigger one that fits
    const odd = entry(4, {
      min_threads: 2,
      full_until: 0,
      est_curve: { ...flat, "3": 50 * SEC },
    });
    const v2 = schedule(
      { leases: [entry(6, { started: 0 })], waiting: [odd] },
      cfg,
      0,
      alive,
      1000,
    );
    expect(v2.leases[1].threads).toBe(3);
  });

  it("behind a head it backfills only a size that ends before the head starts", () => {
    // 2 free; the head wants 4 (a 6-lease... ends at 100 s)
    const a = entry(8, { started: 0, est_ms: 100 * SEC + 1000 });
    const head = entry(6);
    // 2 threads take 540 s: past the head's start → not admitted
    const late = flex({
      threads: 2,
      min_threads: 1,
      est_curve: { "1": 700 * SEC, "2": 540 * SEC },
    });
    expect(
      ids(schedule({ leases: [a], waiting: [head, late] }, cfg, 0, alive, 1000).leases),
    ).toEqual([a.id]);
    const quick = flex({
      threads: 2,
      min_threads: 1,
      est_curve: { "1": 70 * SEC, "2": 50 * SEC },
    });
    const v = schedule({ leases: [a], waiting: [head, quick] }, cfg, 0, alive, 1000);
    expect(v.leases.map(e => [e.threads, e.backfill_for, e.est_ms])).toEqual([
      [8, undefined, a.est_ms],
      [2, head.id, 50 * SEC],
    ]);
  });
});

describe("estimates by threads reach the pool from an exec", () => {
  it("a flexible exec asks the step's curve and its lease carries the granted size's estimate", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-eta-"));
    try {
      fs.writeFileSync(
        path.join(dir, "config.yaml"),
        JSON.stringify({ budget: 10, load_threshold: 0 }),
      );
      const pool = new Pool(dir, {
        perfCores: () => 12,
        loadavg: () => 0,
        cpuTicks: () => ({ busy: 0, total: 0, cpus: 1 }),
        isAlive: isPidAlive,
        isGroupAlive,
      });
      const asked: [number, number][] = [];
      const ctx = {
        sessionId: "s",
        rootSessionId: "s",
        estimateCurve: (min: number, max: number) => {
          asked.push([min, max]);
          return { 2: 9000, 3: 7000, 4: 8000 };
        },
      };
      const state: StateDefinition = {
        type: "exec",
        command: `cat "${path.join(dir, "pool.json")}"`,
        resource: { threads: { min: 2, max: 4 } },
      };
      const r = await new Executor(pool).execute(state, {}, ctx);
      // 4 fit now, but 3 ends earlier on the step's own history
      expect(r.threads_granted).toBe(3);
      expect(asked).toEqual([[2, 4]]);
      expect(r.stdout).toContain('"est_ms": 7000');
      expect(r.stdout).not.toContain("est_curve");
      // a curve the history cannot give: today's rule (4 fit)
      const none = await new Executor(pool).execute(
        state,
        {},
        {
          sessionId: "s",
          rootSessionId: "s",
          estimateCurve: () => undefined,
        },
      );
      expect(none.threads_granted).toBe(4);
      expect(none.stdout).not.toContain("est_ms");
    } finally {
      cleanupDir(dir);
    }
  });
});
