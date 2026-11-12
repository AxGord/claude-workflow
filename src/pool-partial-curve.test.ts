import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool, schedule, type PoolEntry } from "./pool.js";
import { Executor } from "./executor.js";
import { Estimates } from "./estimate.js";
import { isGroupAlive, isPidAlive } from "./process.js";
import { cleanupDir } from "./test-helpers.js";
import type { StateDefinition } from "./types.js";

const SEC = 1000;
const entry = (threads: number, extra: Partial<PoolEntry> = {}): PoolEntry => ({
  id: `p${threads}${Object.keys(extra).length}`,
  pid: 100,
  threads,
  priority: 0,
  label: "",
  cwd: "/",
  session_id: "",
  arrived: 1,
  ...extra,
});
const alive = () => true;
const cfg = { budget: 10, load_threshold: 0, starve_after: 900 };

describe("a flexible lease whose curve is incomplete still carries an est_ms", () => {
  it("the granted size's own measured time", () => {
    const w = entry(8, { min_threads: 2, full_until: 0, est_curve: { "4": 300 * SEC } });
    const v = schedule({ leases: [], waiting: [w] }, cfg, 0, alive, 1000);
    // the pick keeps the old rule (8 fit), the end comes from the nearest measured size, as is
    expect([v.leases[0].threads, v.leases[0].est_ms]).toEqual([8, 300 * SEC]);
    const own = { ...w, est_curve: { "8": 90 * SEC } };
    const v2 = schedule({ leases: [], waiting: [own] }, cfg, 0, alive, 1000);
    expect(v2.leases[0].est_ms).toBe(90 * SEC);
  });

  it("no measured size: no est_ms", () => {
    const w = entry(8, { min_threads: 2, full_until: 0 });
    expect(
      schedule({ leases: [], waiting: [w] }, cfg, 0, alive, 1000).leases[0].est_ms,
    ).toBeUndefined();
  });

  it("Estimates.known lists the sizes with an estimate, in or out of a range", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-"));
    try {
      const file = path.join(dir, "ledger.jsonl");
      const now = Date.parse("2026-10-31T12:00:00Z");
      const run = { state: "b", duration_ms: 900, exit_code: 0, threads_granted: 4, step_key: "k" };
      fs.writeFileSync(
        file,
        JSON.stringify({
          session_id: "s",
          ended_at: new Date(now - 1000).toISOString(),
          execs: [run, run, run],
        }) + "\n",
      );
      const est = new Estimates(file);
      // one size cannot fit a curve over 2..8, but it is known
      expect(est.curve("k", 2, 8, now)).toBeUndefined();
      expect(est.known("k", now)).toEqual({ 4: 900 });
      expect(est.known("other", now)).toBeUndefined();
    } finally {
      cleanupDir(dir);
    }
  });

  it("an exec grants a lease with the partial map's estimate", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-"));
    try {
      const pool = new Pool(dir, {
        perfCores: () => 12,
        loadavg: () => 0,
        cpuTicks: () => ({ busy: 0, total: 0, cpus: 1 }),

        isAlive: isPidAlive,
        isGroupAlive,
      });
      const state: StateDefinition = {
        type: "exec",
        command: `cat "${path.join(dir, "pool.json")}"`,
        resource: { threads: { min: 2, max: 4 } },
      };
      const r = await new Executor(pool).execute(
        state,
        {},
        { sessionId: "s", rootSessionId: "s", estimateCurve: () => ({ 3: 7000 }) },
      );
      expect(r.stdout).toContain('"est_ms": 7000');
    } finally {
      cleanupDir(dir);
    }
  });
});
