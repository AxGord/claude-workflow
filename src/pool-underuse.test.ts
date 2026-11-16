import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool, formatStatus, type PoolProbes } from "./pool.js";
import { isGroupAlive, isPidAlive } from "./process.js";
import { cleanupDir } from "./test-helpers.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) cleanupDir(d);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a lease holding more threads than it uses", () => {
  it("is logged as UNDERUSE with its label after a grace period, and the status shows used against held", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-pool-underuse-"));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, "config.yaml"),
      JSON.stringify({ budget: 10, load_threshold: 0 }),
    );
    // a group no real process has: only the injected process table knows its members
    const pgid = 2_000_000_001;
    const probes: PoolProbes = {
      perfCores: () => 12,
      loadavg: () => 0,
      cpuTicks: () => ({ busy: 0, total: 0, cpus: 1 }),
      isAlive: isPidAlive,
      isGroupAlive,
      // the leased command's whole tree is idle: 0 cores used
      processes: () => [
        { pid: pgid, ppid: 1, pgid, cpu: 0 },
        { pid: pgid + 1, ppid: pgid, pgid, cpu: 0 },
      ],
    };
    const pool = new Pool(dir, probes);
    const holder = await pool.acquire({ threads: 4, label: "slice-gate infra4" });
    if (holder.status !== "granted") throw new Error("not granted");
    await holder.lease.attach(pgid);
    await pool.status();

    // far beyond any plausible grace period, the lease still uses 0 of its 4 threads
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60 * 60 * 1000 });
    const view = await pool.status();
    const text = formatStatus(view, dir);
    const log = fs.existsSync(path.join(dir, "pool.log"))
      ? fs.readFileSync(path.join(dir, "pool.log"), "utf8")
      : "";
    await holder.lease.release();

    expect(log).toMatch(/underuse: pid \d+ holds 4 threads, runs ~0 — slice-gate infra4/);
    expect(text).toMatch(/holds 4 threads, runs ~0 .*slice-gate infra4/);
  });
});
