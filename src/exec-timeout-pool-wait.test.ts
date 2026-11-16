import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Executor } from "./executor.js";
import { Pool, systemProbes } from "./pool.js";
import { cleanupDir } from "./test-helpers.js";
import type { DetachedRun, StateDefinition } from "./types.js";

// ENG-EXEC-TIMEOUT-EXCLUDES-POOL-WAIT: an exec's command that waits for a pool lease through
// `wf-run` (carrying the session's id) must not spend the exec's `timeout` while it waits.
describe("exec timeout and the pool wait of its command", () => {
  let dir: string;
  let pool: Pool;
  let executor: Executor;
  const SID = "sess-timeout-pool-wait";
  const ctx = { sessionId: SID, rootSessionId: SID };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-exec-poolwait-"));
    fs.writeFileSync(path.join(dir, "config.yaml"), "budget: 1\nload_threshold: 0\n");
    pool = new Pool(dir, { ...systemProbes, loadavg: () => 0 });
    executor = new Executor(pool, path.join(dir, "runs"));
  });
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) c.kill();
    cleanupDir(dir);
  });

  /** A live process of its own: `wf-run` is a child of the command, never the engine's pid. */
  const livePid = (): number => {
    const c = spawn("sleep", ["60"], { stdio: "ignore" });
    children.push(c);
    return c.pid!;
  };

  /** What `wf-run` inside the command does: queue in the pool under the session's id, run, release. */
  const wfRunStandIn = async (flag: string): Promise<void> => {
    const got = await pool.acquire({
      threads: 1,
      label: "wf-run",
      sessionId: SID,
      cwd: dir,
      pid: livePid(),
    });
    if (got.status !== "granted") throw new Error("not granted");
    await got.lease.release();
    fs.writeFileSync(flag, "done");
  };

  // the command finishes when the stand-in's lease was granted and released
  const waitCommand = (flag: string): StateDefinition => ({
    type: "exec",
    command: `while [ ! -e '${flag}' ]; do sleep 0.05; done`,
    timeout: 1000,
  });

  it("a command that waits 2 s in the pool under a 1 s timeout completes", async () => {
    const holder = await pool.acquire({
      threads: 1,
      label: "holder",
      sessionId: "other",
      cwd: dir,
    });
    if (holder.status !== "granted") throw new Error("holder not granted");
    const flag = path.join(dir, "flag");
    const running = executor.execute(waitCommand(flag), {}, ctx);
    const waiter = wfRunStandIn(flag);
    await new Promise(r => setTimeout(r, 2000));
    await holder.lease.release();
    await waiter;
    const result = await running;
    expect(result.exit_code).toBe(0);
    expect(result.success).toBe(true);
    // the pool wait is recorded beside the run, not in it
    expect(result.wait_ms).toBeGreaterThanOrEqual(1500);
    expect(result.duration_ms).toBeLessThan(result.wait_ms! + 1000);
  }, 15000);

  it("a wait that never ends is cut at the ceiling, 4x the timeout", async () => {
    const holder = await pool.acquire({
      threads: 1,
      label: "holder",
      sessionId: "other",
      cwd: dir,
    });
    if (holder.status !== "granted") throw new Error("holder not granted");
    const flag = path.join(dir, "never");
    const started = Date.now();
    const running = executor.execute({ ...waitCommand(flag), timeout: 500 }, {}, ctx);
    const waiter = pool.acquire({
      threads: 1,
      label: "wf-run",
      sessionId: SID,
      cwd: dir,
      pid: livePid(),
    });
    const result = await running;
    const took = Date.now() - started;
    expect(result.exit_code).toBe(124);
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThan(4000);
    await holder.lease.release();
    const got = await waiter;
    if (got.status === "granted") await got.lease.release();
  }, 15000);

  it("a waiter of another session does not stretch the timeout", async () => {
    const holder = await pool.acquire({
      threads: 1,
      label: "holder",
      sessionId: "other",
      cwd: dir,
    });
    if (holder.status !== "granted") throw new Error("holder not granted");
    const waiter = pool.acquire({ threads: 1, label: "wf-run", sessionId: "other-2", cwd: dir });
    const result = await executor.execute(
      { type: "exec", command: "sleep 3", timeout: 500 },
      {},
      ctx,
    );
    expect(result.exit_code).toBe(124);
    await holder.lease.release();
    const got = await waiter;
    if (got.status === "granted") await got.lease.release();
  }, 15000);

  it("a command that runs 2 s of work under a 1 s timeout still times out", async () => {
    const result = await executor.execute(
      { type: "exec", command: "sleep 2", timeout: 1000 },
      {},
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  }, 15000);
  it("a fanout shard whose sibling waits for its own lease still times out on its own work", async () => {
    const result = await executor.execute(
      {
        type: "exec",
        command: "sleep 2.5",
        timeout: 1000,
        fanout: { count: 2, threads_each: 1, max_parallel: 2 },
      },
      {},
      ctx,
    );
    expect(result.exit_code).toBe(124);
    // both shards time out on their own work; the one that queued for its lease behind the
    // other waited ~1 s, and that wait stretched nobody's deadline
    const [first, second] = result.shards!;
    expect(first.exit_code).toBe(124);
    expect(second.exit_code).toBe(124);
    expect(Math.min(first.wait_ms, second.wait_ms)).toBeLessThan(200);
  }, 15000);

  it("an adopted run starts from the pool wait its first server counted", async () => {
    let run: DetachedRun | undefined;
    const pending = executor.execute(
      { type: "exec", command: "sleep 1", timeout: 60_000 },
      {},
      {
        ...ctx,
        onDetached: d => {
          run = d;
          return Promise.resolve();
        },
      },
    );
    for (let i = 0; i < 100 && !run; i++) await new Promise(r => setTimeout(r, 10));
    fs.writeFileSync(`${run!.rc}.wait`, "5000");
    const state: StateDefinition = { type: "exec", command: "sleep 1", timeout: 500 };
    const adopted = await new Executor(pool, path.join(dir, "runs")).adopt(run!, state, ctx);
    // plain deadline 500 ms would kill it; the recorded wait stretches it to the 4x ceiling (2 s)
    expect(adopted).toMatchObject({ exit_code: 0, success: true });
    expect(adopted!.wait_ms).toBeGreaterThanOrEqual(5000);
    await pending;
  }, 15000);
});
