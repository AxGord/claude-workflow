import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool, type PoolProbes } from "./pool.js";
import { Executor } from "./executor.js";
import { isGroupAlive, isPidAlive } from "./process.js";
import { cleanupDir } from "./test-helpers.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) cleanupDir(d);
});

const probes = (): PoolProbes => ({
  perfCores: () => 12,
  loadavg: () => 0,
  cpuTicks: () => ({ busy: 0, total: 0, cpus: 1 }),
  isAlive: isPidAlive,
  isGroupAlive,
});

// pool.test.ts "waits for a lease, runs, releases" copies the pool file to `seen` inside the leased command.
// A failed cp must fail exit_code and show its stderr, instead of passing every assertion up to a later
// readFileSync(seen) ENOENT with no cause in sight.
describe("pool.test.ts seen-file command shape", () => {
  it("a failed cp joined with && fails exit_code and shows its stderr", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-pool-"));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, "config.yaml"),
      JSON.stringify({ budget: 10, load_threshold: 0 }),
    );
    const executor = new Executor(new Pool(dir, probes()));
    const seen = path.join(dir, "no-such-dir", "seen");
    const r = await executor.execute(
      {
        type: "exec",
        command: `cp "${path.join(dir, "pool.json")}" "${seen}" && sleep 0.05`,
        resource: { threads: 6 },
      },
      {},
      { sessionId: "s1", rootSessionId: "s1" },
    );
    expect(r.stderr).toMatch(/No such file or directory/);
    expect(r.exit_code).not.toBe(0);
  });

  const body = (): string => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "pool.test.ts"), "utf8");
    const start = src.indexOf('it("waits for a lease, runs, releases; wait_ms beside duration_ms"');
    const end = src.indexOf('it("no lease within wait_timeout', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  it("the real test joins its cp with && so a failed cp is the command's exit code", () => {
    const b = body();
    expect(b).toMatch(
      /cp "\$\{path\.join\(dir, "pool\.json"\)\}" "\$\{leasedDuringRun\}" && sleep 0\.05/,
    );
    expect(b).not.toMatch(/leasedDuringRun\}"; sleep/);
  });

  it("the real test asserts exit_code and stderr (stderr in the message) before it reads seen", () => {
    const b = body();
    const read = b.indexOf("readFileSync(leasedDuringRun");
    const exit = b.indexOf("r.exit_code, `");
    const err = b.indexOf("r.stderr");
    expect(read).toBeGreaterThan(0);
    expect(exit).toBeGreaterThan(0);
    expect(exit).toBeLessThan(read);
    expect(b).toMatch(/r\.exit_code, `[^`]*\$\{r\.stderr\}`/);
    expect(err).toBeGreaterThan(0);
    expect(err).toBeLessThan(read);
  });
});
