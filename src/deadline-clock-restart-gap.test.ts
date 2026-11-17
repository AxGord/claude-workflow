import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Executor, bootTimeMs } from "./executor.js";
import { Pool, systemProbes } from "./pool.js";
import { cleanupDir } from "./test-helpers.js";
import type { DetachedRun } from "./types.js";

// ENG-DEADLINE-CLOCK-RESTART-GAP: the session's pool wait between the last write of `<rc>.wait`
// (or the run's start) and a restarted server's takeover must count toward the adopted run's deadline.
describe("adopt after a restart counts the pool wait of the gap", () => {
  let dir: string;
  let pool: Pool;
  const SID = "sess-restart-gap";
  const ctx = { sessionId: SID, rootSessionId: SID };
  const children: ChildProcess[] = [];
  // the wf-run stand-ins' queued acquires: settled (and released) before the directory goes
  const waiters: ReturnType<Pool["acquire"]>[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-exec-gap-"));
    fs.writeFileSync(path.join(dir, "config.yaml"), "budget: 1\nload_threshold: 0\n");
    pool = new Pool(dir, { ...systemProbes, loadavg: () => 0 });
  });
  afterEach(async () => {
    for (const w of waiters.splice(0)) {
      // a waiter whose pid is gone is dropped by the pool and never settles
      const got = await Promise.race([w, new Promise<undefined>(r => setTimeout(r, 300))]);
      if (got?.status === "granted") await got.lease.release();
    }
    for (const c of children.splice(0)) c.kill();
    cleanupDir(dir);
  });

  it("a 3 s pool wait nobody was ticking for stretches the adopted run's 2 s timeout", async () => {
    const holder = await pool.acquire({
      threads: 1,
      label: "holder",
      sessionId: "other",
      cwd: dir,
    });
    if (holder.status !== "granted") throw new Error("holder not granted");
    fs.mkdirSync(path.join(dir, "runs"));
    const rc = path.join(dir, "runs", "rc");
    // the run: a command of its own process group that ends (exit 0) 4 s after its start
    const cmd = spawn("sh", ["-c", `sleep 4; echo 0 > '${rc}'`], {
      detached: true,
      stdio: "ignore",
    });
    children.push(cmd);
    const started = Date.now();
    const run: DetachedRun = {
      pgid: cmd.pid!,
      out: path.join(dir, "runs", "out"),
      err: path.join(dir, "runs", "err"),
      rc,
      started_at: new Date(started).toISOString(),
      boot_ms: bootTimeMs(),
    };
    // the wf-run of the command queues in the pool now; the server is down for the next 3 s
    waiters.push(
      pool.acquire({
        threads: 1,
        label: "wf-run",
        sessionId: SID,
        cwd: dir,
        pid: cmd.pid!,
      }),
    );
    await new Promise(r => setTimeout(r, 3000));
    const adopting = new Executor(pool, path.join(dir, "runs")).adopt(
      run,
      { type: "exec", command: "x", timeout: 2000 },
      ctx,
    );
    setTimeout(() => void holder.lease.release(), 500);
    const result = await adopting;
    // the command waited 3.5 s in the pool of its 4 s: within its timeout once the wait is excluded
    expect(result).toMatchObject({ exit_code: 0, success: true });
    expect(result!.wait_ms).toBeGreaterThanOrEqual(3000);
  }, 20000);

  it("a recorded .wait count resumes at the file's mtime: the wait since then counts, the wait before it does not", async () => {
    const holder = await pool.acquire({
      threads: 1,
      label: "holder",
      sessionId: "other",
      cwd: dir,
    });
    if (holder.status !== "granted") throw new Error("holder not granted");
    fs.mkdirSync(path.join(dir, "runs"));
    const rc = path.join(dir, "runs", "rc");
    const cmd = spawn("sh", ["-c", `sleep 4; echo 0 > '${rc}'`], {
      detached: true,
      stdio: "ignore",
    });
    children.push(cmd);
    const started = Date.now();
    const run: DetachedRun = {
      pgid: cmd.pid!,
      out: path.join(dir, "runs", "out"),
      err: path.join(dir, "runs", "err"),
      rc,
      started_at: new Date(started).toISOString(),
      boot_ms: bootTimeMs(),
    };
    // queued from the run's start; the first server counted 500 ms of it, as of 1 s in
    waiters.push(
      pool.acquire({
        threads: 1,
        label: "wf-run",
        sessionId: SID,
        cwd: dir,
        pid: cmd.pid!,
      }),
    );
    await new Promise(r => setTimeout(r, 1000));
    fs.writeFileSync(`${rc}.wait`, "500");
    const at = new Date(Date.now());
    fs.utimesSync(`${rc}.wait`, at, at);
    await new Promise(r => setTimeout(r, 2000));
    // 3 s in: the plain 2 s timeout is over; 500 ms recorded + 2 s since the write = 2.5 s stretch
    const result = await new Executor(pool, path.join(dir, "runs")).adopt(
      run,
      { type: "exec", command: "x", timeout: 2000 },
      ctx,
    );
    await holder.lease.release();
    expect(result).toMatchObject({ exit_code: 0, success: true });
    // 500 ms + the wait from the write to the run's end (~3 s): not from `now` (500 ms only,
    // killed at once) and not from the run's start (~4.5 s)
    expect(result!.wait_ms).toBeGreaterThanOrEqual(3300);
    expect(result!.wait_ms).toBeLessThanOrEqual(4100);
  }, 20000);

  it("a wait ticked every 50 ms is written to the .wait file about once a second", async () => {
    const holder = await pool.acquire({
      threads: 1,
      label: "holder",
      sessionId: "other",
      cwd: dir,
    });
    if (holder.status !== "granted") throw new Error("holder not granted");
    const runs = path.join(dir, "runs");
    waiters.push(
      pool.acquire({
        threads: 1,
        label: "wf-run",
        sessionId: SID,
        cwd: dir,
        pid: livePid(),
      }),
    );
    const running = new Executor(pool, runs, undefined, 50).execute(
      { type: "exec", command: "sleep 2.6", timeout: 10000 },
      {},
      ctx,
    );
    const seen = new Set<string>();
    for (let i = 0; i < 130; i++) {
      for (const f of fs.existsSync(runs) ? fs.readdirSync(runs) : []) {
        if (!f.endsWith(".wait")) continue;
        try {
          seen.add(fs.readFileSync(path.join(runs, f), "utf8"));
        } catch {
          /* gone */
        }
      }
      await new Promise(r => setTimeout(r, 20));
    }
    await running;
    await holder.lease.release();
    // ~2.5 s of counted wait: a write per whole second, not one per tick
    expect(seen.size).toBeGreaterThanOrEqual(1);
    expect(seen.size).toBeLessThanOrEqual(4);
  }, 20000);

  const livePid = (): number => {
    const c = spawn("sleep", ["60"], { stdio: "ignore" });
    children.push(c);
    return c.pid!;
  };
});
