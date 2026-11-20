import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool, formatStatus, type PoolProbes } from "./pool.js";
import { bootTimeMs, isGroupAlive, isPidAlive } from "./process.js";
import { cleanupDir } from "./test-helpers.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) cleanupDir(d);
});
afterEach(() => {
  vi.useRealTimers();
});

const pgid = 2_000_000_003;
const probes = (cpu: number): PoolProbes => ({
  perfCores: () => 12,
  loadavg: () => 0,
  cpuTicks: () => ({ busy: 0, total: 0, cpus: 1 }),
  isAlive: isPidAlive,
  isGroupAlive,
  processes: () => [
    { pid: pgid, ppid: 1, pgid, cpu },
    { pid: pgid + 1, ppid: pgid, pgid, cpu: 0 },
  ],
});

function poolDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-pool-cadence-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "config.yaml"), JSON.stringify({ budget: 6, load_threshold: 0 }));
  return dir;
}

describe("a lease that runs well below its threads while nobody polls the pool", () => {
  it("control: a holder that pulses (attach) is flagged by one status call after 300 s", async () => {
    const dir = poolDir();
    const pool = new Pool(dir, probes(1));
    const holder = await pool.acquire({ threads: 12, minThreads: 4, label: "slice-gate infra" });
    if (holder.status !== "granted") throw new Error("not granted");
    expect(holder.lease.threads).toBe(6);
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: Date.now() });
    await holder.lease.attach(pgid);

    // the holder's meter pulse is a real setInterval; the wall clock is advanced
    // 300 s in 5 s steps, nothing calls status in between
    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      await new Promise<void>(r => setImmediate(r));
      await new Promise<void>(r => setTimeout(r, 15));
    }
    // ONE status call, from another process's Pool instance
    const view = await new Pool(dir, probes(1)).status();
    const text = formatStatus(view, dir);
    await holder.lease.release();
    console.log(text);
    expect(text).toMatch(/holds 6 threads \(asked 4-12\), runs ~1 \(UNDERUSE\)/);
  });

  it("a lease nobody sampled for 300 s is flagged UNDERUSE by ONE status call (held 6, runs ~1)", async () => {
    const dir = poolDir();
    const holder = await new Pool(dir, probes(1)).acquire({
      threads: 12,
      minThreads: 4,
      label: "slice-gate infra",
    });
    if (holder.status !== "granted") throw new Error("not granted");
    expect(holder.lease.threads).toBe(6);
    // the group is recorded as a holder's attach would, but this holder never passes again
    // (no pulse: another process, an engine build without one) and nobody polls the pool
    const fp = path.join(dir, "pool.json");
    const state = JSON.parse(fs.readFileSync(fp, "utf8")) as {
      leases: Array<Record<string, unknown>>;
    };
    state.leases[0] = { ...state.leases[0], pgid, boot_ms: bootTimeMs() };
    fs.writeFileSync(fp, JSON.stringify(state));

    // 300 s pass with no pass at all, then ONE status call
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 300_000 });
    const view = await new Pool(dir, probes(1)).status();
    const text = formatStatus(view, dir);
    vi.useRealTimers();
    await holder.lease.release();
    console.log(text);
    expect(text).toMatch(/holds 6 threads \(asked 4-12\), runs ~1 \(UNDERUSE\)/);
  });
});
