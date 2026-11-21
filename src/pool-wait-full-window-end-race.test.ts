import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool, type PoolProbes } from "./pool.js";
import { isGroupAlive, isPidAlive } from "./process.js";
import { cleanupDir } from "./test-helpers.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  for (const d of dirs) cleanupDir(d);
});

function poolDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-pool-window-race-"));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "config.yaml"),
    JSON.stringify({ budget: 10, load_threshold: 0 }),
  );
  return dir;
}

describe("a flexible waiter whose wait_full window ends between its pass and its clock read", () => {
  it("passes again at the window's end, not one whole poll later", async () => {
    // Slow machine between the pass's judgement (`now` read) and acquire's own clock read:
    // the first loadavg call runs inside the pass, after its `now`, and outlasts the window.
    let spinUntil = 0;
    const probes: PoolProbes = {
      perfCores: () => 12,
      loadavg: () => {
        if (spinUntil > 0) {
          const end = spinUntil;
          spinUntil = 0;
          while (Date.now() < end) {
            /* busy: the pass takes longer than the window */
          }
        }
        return 0;
      },
      cpuTicks: () => ({ busy: 0, total: 0, cpus: 1 }),
      isAlive: isPidAlive,
      isGroupAlive,
    };
    // The pass's own write of pool.json can reach a watcher made right after it (macOS delivers it late) and
    // wake the waiter by accident; a watcher that never fires is the watch losing an event, which polling covers.
    vi.spyOn(fs, "watch").mockImplementation((() => ({
      close: () => undefined,
    })) as unknown as typeof fs.watch);
    const pool = new Pool(poolDir(), probes);
    const holder = await pool.acquire({ threads: 6 });
    const t0 = Date.now();
    spinUntil = t0 + 450;
    const late = await pool.acquire(
      { threads: 8, minThreads: 2, waitFullMs: 300 },
      { pollMs: 5_000 },
    );
    // the window ended with no release: what is free (4) is taken at the window's end
    expect(late.status === "granted" && late.lease.threads).toBe(4);
    expect(late.waitMs).toBeLessThan(2_000);
    if (late.status === "granted") await late.lease.release();
    if (holder.status === "granted") await holder.lease.release();
  }, 20_000);
});
