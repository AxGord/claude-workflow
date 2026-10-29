import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  Pool,
  schedule,
  describeWait,
  formatEntry,
  projectRoot,
  type CpuTicks,
  type PoolEntry,
  type PoolProbes,
  type PoolState,
} from "./pool.js";
import { registerTools } from "./tools.js";
import { isGroupAlive, isPidAlive } from "./process.js";
import { Executor } from "./executor.js";
import { Engine } from "./engine.js";
import { InMemoryStorage, createTestLoader, cleanupDir } from "./test-helpers.js";
import { Storage } from "./storage.js";
import type { StateDefinition } from "./types.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const tmpDirs: string[] = [];
const tmp = (prefix: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) cleanupDir(d);
});

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
const cfg = { budget: 10, load_threshold: 0 };
const ids = (es: readonly PoolEntry[]) => es.map(e => e.id);

describe("schedule (one admission pass)", () => {
  it("admits while held + N + external fits the budget", () => {
    const held = entry(6);
    const big = entry(6);
    expect(ids(schedule({ leases: [held], waiting: [big] }, cfg, 0, alive, 1).leases)).toEqual([
      held.id,
    ]);
    const small = entry(4);
    const v = schedule({ leases: [held], waiting: [small] }, cfg, 0, alive, 1);
    expect(ids(v.leases)).toEqual([held.id, small.id]);
    expect(v.held).toBe(10);
    expect(v.leases[1].started).toBe(1);
  });

  it("external load = load − leased − load_threshold counts against the budget beside a lease", () => {
    const held = entry(6);
    const three = entry(3);
    // the noise floor: load 9.5 − 6 leased − 2 = 1.5 external, 6 + 3 + 1.5 > 10; at threshold 3 it fits
    expect(
      schedule(
        { leases: [held], waiting: [three] },
        { budget: 10, load_threshold: 2 },
        9.5,
        alive,
        1,
      ).leases,
    ).toHaveLength(1);
    expect(
      schedule(
        { leases: [held], waiting: [three] },
        { budget: 10, load_threshold: 3 },
        9.5,
        alive,
        1,
      ).leases,
    ).toHaveLength(2);
    // leased threads are not external: load 7 with 6 leased = 1 external
    const v = schedule({ leases: [held], waiting: [three] }, cfg, 7, alive, 1);
    expect(v.external).toBe(1);
    expect(ids(v.leases)).toEqual([held.id, three.id]);
    expect(schedule({ leases: [held], waiting: [entry(4)] }, cfg, 7, alive, 1).leases).toHaveLength(
      1,
    );
  });

  it("external load never blocks an empty pool; beside a live lease it does", () => {
    const ten = entry(10);
    expect(ids(schedule({ leases: [], waiting: [ten] }, cfg, 12, alive, 1).leases)).toEqual([
      ten.id,
    ]);
    const held = entry(1);
    expect(
      ids(schedule({ leases: [held], waiting: [entry(2)] }, cfg, 12, alive, 1).leases),
    ).toEqual([held.id]);
  });

  it("N > budget counts as the budget: waits for an empty pool, then runs alone", () => {
    const huge = entry(20);
    const one = entry(1);
    expect(schedule({ leases: [one], waiting: [huge] }, cfg, 0, alive, 1).leases).toEqual([one]);
    const v = schedule({ leases: [], waiting: [huge, entry(1)] }, cfg, 0, alive, 1);
    expect(ids(v.leases)).toEqual([huge.id]);
    expect(v.held).toBe(10);
    expect(v.waiting).toHaveLength(1);
  });

  it("strict (priority desc, arrival) order: a smaller task never overtakes the head", () => {
    const a = entry(6, { arrived: 1 });
    const b = entry(6, { arrived: 2, priority: 5 });
    const c = entry(2, { arrived: 3 });
    const held = entry(6);
    // head is b (priority), it does not fit; c would fit but waits behind it
    const blocked = schedule({ leases: [held], waiting: [a, b, c] }, cfg, 0, alive, 1);
    expect(ids(blocked.leases)).toEqual([held.id]);
    expect(ids(blocked.waiting)).toEqual([b.id, a.id, c.id]);
    // empty machine: b, then a does not fit beside it, so c still waits
    const free = schedule({ leases: [], waiting: [a, b, c] }, cfg, 0, alive, 1);
    expect(ids(free.leases)).toEqual([b.id]);
    expect(ids(free.waiting)).toEqual([a.id, c.id]);
  });

  it("reaps leases and waiters whose pid is dead, freeing their threads", () => {
    const dead = entry(10, { pid: 666 });
    const deadWaiter = entry(1, { pid: 666, arrived: 0 });
    const w = entry(6);
    const v = schedule({ leases: [dead], waiting: [deadWaiter, w] }, cfg, 0, e => e.pid !== 666, 1);
    expect(ids(v.leases)).toEqual([w.id]);
    expect(v.waiting).toEqual([]);
  });

  it("a lock and the threads are granted together or not at all", () => {
    const holder = entry(1, { locks: ["L"] });
    const w = entry(3, { locks: ["L", "M"] });
    // L is held: w takes neither its threads nor the free lock M
    const blocked = schedule({ leases: [holder], waiting: [w] }, cfg, 0, alive, 1);
    expect(ids(blocked.leases)).toEqual([holder.id]);
    expect(blocked.held).toBe(1);
    // L free but the threads do not fit: w holds no lock either
    const full = entry(9);
    const noThreads = schedule({ leases: [full], waiting: [w] }, cfg, 0, alive, 1);
    expect(ids(noThreads.leases)).toEqual([full.id]);
    expect(
      ids(
        schedule({ leases: [full], waiting: [w, entry(0, { locks: ["M"] })] }, cfg, 0, alive, 1)
          .leases,
      ),
    ).toEqual([full.id]);
    const v = schedule({ leases: [], waiting: [w] }, cfg, 0, alive, 1);
    expect(v.leases.map(e => [e.id, e.locks])).toEqual([[w.id, ["L", "M"]]]);
    expect(v.held).toBe(3);
  });

  it("a lock goes in queue order; a waiter blocked by a lock claims no threads, one blocked by threads does", () => {
    const holder = entry(0, { locks: ["L"] });
    const a = entry(6, { locks: ["L"], arrived: 1 });
    const b = entry(0, { locks: ["L"], arrived: 2 });
    const c = entry(8, { arrived: 3 });
    const v = schedule({ leases: [holder], waiting: [a, b, c] }, cfg, 0, alive, 1);
    expect(ids(v.leases)).toEqual([holder.id, c.id]);
    expect(ids(v.waiting)).toEqual([a.id, b.id]);
    // the holder ends: a (first in line for L) gets it, b still waits for it
    const next = schedule({ leases: [], waiting: [a, b] }, cfg, 0, alive, 1);
    expect(ids(next.leases)).toEqual([a.id]);
    expect(ids(next.waiting)).toEqual([b.id]);

    const big = entry(8);
    const e = entry(6, { locks: ["M"], arrived: 1 });
    const f = entry(1, { arrived: 2 });
    const g = entry(0, { locks: ["N"], arrived: 3 });
    const h = entry(0, { locks: ["M"], arrived: 4 });
    // e fits by locks, not by threads: f may not take threads past it, h not its lock; g needs neither
    const w = schedule({ leases: [big], waiting: [e, f, g, h] }, cfg, 0, alive, 1);
    expect(ids(w.leases)).toEqual([big.id, g.id]);
    expect(ids(w.waiting)).toEqual([e.id, f.id, h.id]);
  });

  it("a lock-only lease takes no threads and no load blocks it", () => {
    const held = entry(10);
    const lockOnly = entry(0, { locks: ["port:3000"] });
    const v = schedule({ leases: [held], waiting: [lockOnly] }, cfg, 100, alive, 1);
    expect(ids(v.leases)).toEqual([held.id, lockOnly.id]);
    expect(v.held).toBe(10);
  });

  it("reaps a dead lock holder, freeing its lock", () => {
    const dead = entry(0, { pid: 666, locks: ["L"] });
    const w = entry(0, { locks: ["L"] });
    expect(
      ids(schedule({ leases: [dead], waiting: [w] }, cfg, 0, e => e.pid !== 666, 1).leases),
    ).toEqual([w.id]);
  });
});

describe("schedule: flexible threads", () => {
  it("takes the threads that fit, at least its min, at once; below its min it waits and closes the threads", () => {
    const held = entry(6);
    const flex = entry(8, { min_threads: 2, full_until: 0 });
    const v = schedule({ leases: [held], waiting: [flex] }, cfg, 0, alive, 1);
    expect(v.leases.map(e => [e.id, e.threads, e.asked_threads])).toEqual([
      [held.id, 6, undefined],
      [flex.id, 4, 8],
    ]);
    expect(v.held).toBe(10);
    const full = entry(9);
    const small = entry(1);
    const w = schedule({ leases: [full], waiting: [flex, small] }, cfg, 0, alive, 1);
    expect(ids(w.leases)).toEqual([full.id]);
    expect(ids(w.waiting)).toEqual([flex.id, small.id]);
  });

  it("inside its wait_full window it waits for its max and closes the threads behind it; after it, takes what fits", () => {
    const held = entry(6);
    const flex = entry(8, { min_threads: 2, full_until: 100 });
    const small = entry(1);
    const inWindow = schedule({ leases: [held], waiting: [flex, small] }, cfg, 0, alive, 50);
    expect(ids(inWindow.leases)).toEqual([held.id]);
    expect(ids(inWindow.waiting)).toEqual([flex.id, small.id]);
    const freed = schedule({ leases: [], waiting: [flex] }, cfg, 0, alive, 50);
    expect(freed.leases.map(e => [e.threads, e.full_until])).toEqual([[8, undefined]]);
    const after = schedule({ leases: [held], waiting: [flex, small] }, cfg, 0, alive, 100);
    expect(after.leases.map(e => [e.id, e.threads])).toEqual([
      [held.id, 6],
      [flex.id, 4],
    ]);
    expect(ids(after.waiting)).toEqual([small.id]);
  });

  it("external load and the budget bound a flexible grant; min = max is the fixed form", () => {
    const held = entry(2);
    const flex = entry(20, { min_threads: 3, full_until: 0 });
    // budget 10, 2 leased, external 5 − 2 = 3: room for 5
    expect(
      schedule({ leases: [held], waiting: [flex] }, cfg, 5, alive, 1).leases.map(e => e.threads),
    ).toEqual([2, 5]);
    // an empty pool ignores external load; the max clamps to the budget
    expect(
      schedule({ leases: [], waiting: [flex] }, cfg, 50, alive, 1).leases.map(e => [
        e.threads,
        e.asked_threads,
      ]),
    ).toEqual([[10, 20]]);
    const fixedLike = entry(4, { min_threads: 4, full_until: 0 });
    expect(
      ids(schedule({ leases: [entry(8)], waiting: [fixedLike] }, cfg, 0, alive, 1).waiting),
    ).toEqual([fixedLike.id]);
  });
});

describe("pool rows and projects", () => {
  it("a row names what is held or wanted, priority and level, since when, project, session and step", () => {
    const home = "/Users/me";
    const now = new Date(2026, 0, 1, 10, 0, 12).getTime();
    const lease: PoolEntry = {
      ...entry(4, {
        min_threads: 2,
        asked_threads: 8,
        locks: ["L"],
        priority: 101,
        level: "high",
        session_id: "abcd",
      }),
      project: "/Users/me/dev/x",
      step: "coding/run_tests",
      label: "npm test",
      started: now - 12_000,
    };
    expect(formatEntry(lease, 10, now, home)).toBe(
      "  pid 100  holds 4 threads (asked 2-8) + lock L  prio 101 high  since 10:00:00 (12s)  ~/dev/x  session abcd  step coding/run_tests  npm test",
    );
    const waiter: PoolEntry = {
      ...entry(8, { min_threads: 2, priority: -100, level: "low" }),
      arrived: now - 3_000,
      cwd: "/srv/y",
    };
    expect(formatEntry(waiter, 10, now, home)).toBe(
      "  pid 100  wants 2-8 threads  prio -100 low  since 10:00:09 (3s)  /srv/y  -",
    );
  });

  it("projectRoot: the nearest .git; a linked worktree maps to its main worktree; no repo = the cwd", () => {
    const main = tmp("wf-proj-");
    fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
    fs.mkdirSync(path.join(main, "src", "deep"), { recursive: true });
    expect(projectRoot(path.join(main, "src", "deep"))).toBe(main);
    const wt = tmp("wf-wt-");
    fs.writeFileSync(
      path.join(wt, ".git"),
      `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`,
    );
    fs.mkdirSync(path.join(wt, "sub"));
    expect(projectRoot(path.join(wt, "sub"))).toBe(main);
    const sub = tmp("wf-submodule-");
    fs.writeFileSync(path.join(sub, ".git"), "gitdir: ../.git/modules/x\n");
    expect(projectRoot(sub)).toBe(sub);
    const bare = tmp("wf-norepo-");
    expect(projectRoot(bare)).toBe(bare);
  });
});

/** Fixed load (loadavg, and cpu ticks frozen so no window ever measures); real liveness. */
function fakeProbes(load = 0): PoolProbes {
  return {
    perfCores: () => 12,
    loadavg: () => load,
    cpuTicks: () => ({ busy: 0, total: 0, cpus: 1 }),
    isAlive: isPidAlive,
    isGroupAlive,
  };
}

function poolDir(config: object = { budget: 10, load_threshold: 0 }): string {
  const dir = tmp("wf-pool-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  return dir;
}

const readPool = (dir: string): PoolState =>
  JSON.parse(fs.readFileSync(path.join(dir, "pool.json"), "utf8"));

describe("Pool", () => {
  it("default budget = performance cores − 2 (at least 1); config.json overrides; a bad key throws", () => {
    const dir = tmp("wf-pool-");
    expect(new Pool(dir, fakeProbes()).config()).toEqual({ budget: 10, load_threshold: 2 });
    expect(new Pool(dir, { ...fakeProbes(), perfCores: () => 2 }).config().budget).toBe(1);
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ budget: 4, load_threshold: 0.5 }),
    );
    expect(new Pool(dir, fakeProbes()).config()).toEqual({ budget: 4, load_threshold: 0.5 });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ budgte: 4 }));
    expect(() => new Pool(dir, fakeProbes()).config()).toThrow(/unknown key "budgte"/);
  });

  it("a lease blocks a second one past the budget until released; a timeout withdraws from the queue", async () => {
    const dir = poolDir();
    const pool = new Pool(dir, fakeProbes());
    const a = await pool.acquire({ threads: 6, label: "a" });
    expect(a.status).toBe("granted");
    const progress: string[] = [];
    const b = await pool.acquire(
      { threads: 6 },
      { waitTimeoutMs: 250, pollMs: 20, onProgress: (s, v) => progress.push(describeWait(s, v)) },
    );
    expect(b.status).toBe("timeout");
    expect(b.waitMs).toBeGreaterThanOrEqual(240);
    expect(progress[0]).toBe("wf-run: waiting for 6 threads — held 6/10 by a (6), external 0.0");
    expect(readPool(dir).waiting).toEqual([]);

    const c = pool.acquire({ threads: 6 }, { pollMs: 20 });
    await new Promise(r => setTimeout(r, 100));
    if (a.status === "granted") await a.lease.release();
    const got = await c;
    expect(got.status).toBe("granted");
    expect(got.waitMs).toBeGreaterThanOrEqual(90);
    if (got.status === "granted") await got.lease.release();
    expect(readPool(dir)).toEqual({ leases: [], waiting: [] });
  });

  it("load = busy cpus over the tick window since the previous pass; loadavg only without a window", async () => {
    let ticks: CpuTicks = { busy: 0, total: 0, cpus: 4 };
    const advance = (ms: number, busyCpus: number) => {
      ticks = { busy: ticks.busy + ms * busyCpus, total: ticks.total + ms * 4, cpus: 4 };
    };
    const pool = new Pool(poolDir(), { ...fakeProbes(12), cpuTicks: () => ticks });
    expect((await pool.status()).load).toBe(12); // first pass: no window yet
    advance(1000, 1.5);
    expect((await pool.status()).load).toBeCloseTo(1.5); // 1 s window
    advance(100, 4);
    expect((await pool.status()).load).toBeCloseTo(1.5); // < 0.5 s: keeps the last measurement
    advance(900, 0);
    expect((await pool.status()).load).toBeCloseTo(0.4); // 0.1 s at 4 + 0.9 s at 0
    advance(60_000, 1);
    expect((await pool.status()).load).toBe(12); // stale window: falls back, restarts
    advance(1000, 2);
    expect((await pool.status()).load).toBeCloseTo(2);
  });

  it("a release wakes a waiter at once, not at its next poll", async () => {
    const dir = poolDir();
    const pool = new Pool(dir, fakeProbes());
    const a = await pool.acquire({ threads: 10 });
    const b = pool.acquire({ threads: 1 }, { pollMs: 5000 });
    await new Promise(r => setTimeout(r, 100));
    const released = Date.now();
    if (a.status === "granted") await a.lease.release();
    const got = await b;
    expect(got.status).toBe("granted");
    expect(Date.now() - released).toBeLessThan(1000);
    if (got.status === "granted") await got.lease.release();
  }, 10_000);

  it("a lease reports its threads clamped to the budget; a lock-only request needs locks, a lock name one word", async () => {
    const pool = new Pool(poolDir(), fakeProbes());
    const big = await pool.acquire({ threads: 20, locks: ["L", "L"] });
    expect(big.status).toBe("granted");
    if (big.status !== "granted") return;
    expect(big.lease.threads).toBe(10);
    expect(big.lease.entry.locks).toEqual(["L"]);
    await big.lease.release();
    await expect(pool.acquire({ threads: 0 })).rejects.toThrow(
      /threads must be a positive integer, got 0/,
    );
    await expect(pool.acquire({ threads: 0, locks: ["a b"] })).rejects.toThrow(/one word/);
    const lockOnly = await pool.acquire({ threads: 0, locks: ["L"] });
    expect(lockOnly.status === "granted" && lockOnly.lease.threads).toBe(0);
    const second = await pool.acquire(
      { threads: 0, locks: ["L"], label: "b" },
      { waitTimeoutMs: 100, pollMs: 20 },
    );
    expect(second.status).toBe("timeout");
    if (lockOnly.status === "granted") await lockOnly.lease.release();
  });

  it("an abort signal withdraws a waiter", async () => {
    const dir = poolDir({ budget: 2, load_threshold: 0 });
    const pool = new Pool(dir, fakeProbes());
    const a = await pool.acquire({ threads: 2 });
    const ac = new AbortController();
    const b = pool.acquire({ threads: 1 }, { pollMs: 20, signal: ac.signal });
    setTimeout(() => ac.abort(), 60);
    expect((await b).status).toBe("aborted");
    expect(readPool(dir).waiting).toEqual([]);
    if (a.status === "granted") await a.lease.release();
  });
});

describe("Executor resource:", () => {
  it("waits for a lease, runs, releases; wait_ms beside duration_ms", async () => {
    const dir = poolDir();
    const pool = new Pool(dir, fakeProbes());
    const executor = new Executor(pool);
    const holder = await pool.acquire({ threads: 6 });
    setTimeout(() => {
      if (holder.status === "granted") void holder.lease.release();
    }, 150);
    const leasedDuringRun = path.join(dir, "seen");
    const t0 = performance.now();
    const r = await executor.execute(
      {
        type: "exec",
        command: `cp "${path.join(dir, "pool.json")}" "${leasedDuringRun}"; sleep 0.05`,
        resource: { threads: 6 },
      },
      {},
      { sessionId: "s1", rootSessionId: "s1" },
    );
    const elapsed = performance.now() - t0;
    expect(r.exit_code).toBe(0);
    expect(r.wait_ms).toBeGreaterThanOrEqual(100);
    expect(r.duration_ms).toBeGreaterThanOrEqual(40);
    // the wait is not inside duration_ms: the two add up to the call, not more
    expect(r.duration_ms! + r.wait_ms!).toBeLessThanOrEqual(elapsed + 5);
    const during = JSON.parse(fs.readFileSync(leasedDuringRun, "utf8")) as PoolState;
    expect(during.leases.map(l => [l.threads, l.session_id])).toEqual([[6, "s1"]]);
    expect(readPool(dir)).toEqual({ leases: [], waiting: [] });
  }, 10_000);

  it("no lease within wait_timeout exits 75 (busy) without running; abort withdraws a wait", async () => {
    const dir = poolDir();
    const pool = new Pool(dir, fakeProbes());
    const executor = new Executor(pool);
    const holder = await pool.acquire({ threads: 10 });
    const marker = path.join(dir, "ran");
    const busy = await executor.execute(
      { type: "exec", command: `touch "${marker}"`, resource: { threads: 1, wait_timeout: 0.2 } },
      {},
    );
    expect(busy.exit_code).toBe(75);
    expect(busy.stderr).toMatch(/^busy: 1 threads not free within 0.2s \(held 10\/10/);
    expect(busy.wait_ms).toBeGreaterThanOrEqual(190);
    expect(fs.existsSync(marker)).toBe(false);

    const pending = executor.execute(
      { type: "exec", command: `touch "${marker}"`, resource: { threads: 1 } },
      {},
      { sessionId: "s2", rootSessionId: "s2" },
    );
    await new Promise(r => setTimeout(r, 100));
    executor.killSession("s2");
    const aborted = await pending;
    expect(aborted.exit_code).toBe(130);
    expect(fs.existsSync(marker)).toBe(false);
    expect(readPool(dir).waiting).toEqual([]);
    if (holder.status === "granted") await holder.lease.release();
  }, 10_000);

  it("a lock name renders session values: the rendered name is the lock held", async () => {
    const dir = poolDir();
    const executor = new Executor(new Pool(dir, fakeProbes()));
    const holder = await new Pool(dir, fakeProbes()).acquire({
      threads: 0,
      locks: ["/r/a_b-land"],
    });
    const run = (cwd: string) =>
      executor.execute(
        {
          type: "exec",
          command: "true",
          resource: { locks: ["{{context.cwd}}-land"], wait_timeout: 0.2 },
        },
        { context: { cwd } },
      );
    const blocked = await run("/r/a b");
    expect(blocked.exit_code).toBe(75);
    expect(blocked.stderr).toContain("lock /r/a_b-land");
    expect((await run("/r/other")).exit_code).toBe(0);
    if (holder.status === "granted") await holder.lease.release();
  }, 10_000);

  it("a lock name that renders empty keeps its template text", async () => {
    const dir = poolDir();
    const executor = new Executor(new Pool(dir, fakeProbes()));
    const holder = await new Pool(dir, fakeProbes()).acquire({
      threads: 0,
      locks: ["{{context.none}}"],
    });
    const r = await executor.execute(
      {
        type: "exec",
        command: "true",
        resource: { locks: ["{{context.none}}"], wait_timeout: 0.2 },
      },
      {},
    );
    expect(r.exit_code).toBe(75);
    if (holder.status === "granted") await holder.lease.release();
  }, 10_000);

  it("an abort that lands as the lease is granted gives the lease back without running", async () => {
    const dir = poolDir();
    const marker = path.join(dir, "ran");
    let executor: Executor;
    class AbortOnGrant extends Pool {
      override async acquire(...a: Parameters<Pool["acquire"]>) {
        const got = await super.acquire(...a);
        executor.killSession("s3");
        return got;
      }
    }
    executor = new Executor(new AbortOnGrant(dir, fakeProbes()));
    const r = await executor.execute(
      { type: "exec", command: `touch "${marker}"`, resource: { threads: 1 } },
      {},
      { sessionId: "s3", rootSessionId: "s3" },
    );
    expect(r.exit_code).toBe(130);
    expect(fs.existsSync(marker)).toBe(false);
    expect(readPool(dir)).toEqual({ leases: [], waiting: [] });
  });

  it("WF_THREADS = the threads granted (clamped, budget); absent without threads, inherited one dropped", async () => {
    const dir = poolDir({ budget: 7, load_threshold: 0 });
    const executor = new Executor(new Pool(dir, fakeProbes()));
    const threadsOf = async (resource?: StateDefinition["resource"]) =>
      (
        await executor.execute(
          { type: "exec", command: 'printf "%s" "${WF_THREADS-unset}"', resource },
          {},
        )
      ).stdout;
    const outer = process.env.WF_THREADS;
    process.env.WF_THREADS = "99";
    try {
      expect(await threadsOf({ threads: 3 })).toBe("3");
      expect(await threadsOf({ threads: 20 })).toBe("7");
      expect(await threadsOf({ threads: "budget" })).toBe("7");
      expect(await threadsOf({ locks: ["L"] })).toBe("unset");
      expect(await threadsOf()).toBe("unset");
    } finally {
      if (outer === undefined) delete process.env.WF_THREADS;
      else process.env.WF_THREADS = outer;
    }
  });

  it("a held lock: wait_timeout exits 75 naming the lock; abort withdraws the wait", async () => {
    const dir = poolDir();
    const pool = new Pool(dir, fakeProbes());
    const executor = new Executor(pool);
    const holder = await pool.acquire({ threads: 0, locks: ["port:3000"] });
    const marker = path.join(dir, "ran");
    const busy = await executor.execute(
      {
        type: "exec",
        command: `touch "${marker}"`,
        resource: { threads: 2, locks: ["port:3000"], wait_timeout: 0.2 },
      },
      {},
    );
    expect(busy.exit_code).toBe(75);
    expect(busy.stderr).toMatch(/^busy: 2 threads \+ lock port:3000 not free within 0.2s/);
    expect(fs.existsSync(marker)).toBe(false);
    const pending = executor.execute(
      { type: "exec", command: `touch "${marker}"`, resource: { locks: ["port:3000"] } },
      {},
      { sessionId: "s4", rootSessionId: "s4" },
    );
    await new Promise(r => setTimeout(r, 100));
    executor.killSession("s4");
    expect((await pending).exit_code).toBe(130);
    expect(fs.existsSync(marker)).toBe(false);
    expect(readPool(dir).waiting).toEqual([]);
    if (holder.status === "granted") await holder.lease.release();
  }, 10_000);

  it('threads: "budget" leases the configured budget', async () => {
    const dir = poolDir({ budget: 7, load_threshold: 0 });
    const executor = new Executor(new Pool(dir, fakeProbes()));
    const seen = path.join(dir, "seen");
    const r = await executor.execute(
      {
        type: "exec",
        command: `cp "${path.join(dir, "pool.json")}" "${seen}"`,
        resource: { threads: "budget" },
      },
      {},
    );
    expect(r.exit_code).toBe(0);
    expect(
      (JSON.parse(fs.readFileSync(seen, "utf8")) as PoolState).leases.map(l => l.threads),
    ).toEqual([7]);
    expect(readPool(dir)).toEqual({ leases: [], waiting: [] });
  });

  it("{{wait_ms}} reaches the states after a resource: exec", async () => {
    const dir = poolDir();
    const pool = new Pool(dir, fakeProbes());
    const holder = await pool.acquire({ threads: 10 });
    setTimeout(() => {
      if (holder.status === "granted") void holder.lease.release();
    }, 150);
    const { loader, dir: wfDir } = createTestLoader({
      e: {
        initial: "run",
        states: {
          run: {
            type: "exec",
            command: "true",
            resource: { threads: 2 },
            on_success: "echo",
            on_error: "echo",
          },
          echo: {
            type: "exec",
            command: 'echo "$W"',
            env: { W: "{{wait_ms}}" },
            on_success: "show",
            on_error: "show",
            success_prompt: "{{stdout}}",
          },
          show: { prompt: "show", transitions: { done: "end" } },
          end: { terminal: true, outcome: "complete" },
        },
      },
    });
    tmpDirs.push(wfDir);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, loader, new Executor(pool));
    const { sessionId, prompt } = await engine.start("e");
    const waited = storage.read(sessionId)!.history.find(h => h.from === "run")!.wait_ms!;
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(prompt.trim()).toBe(String(waited));
  }, 10_000);

  it("the engine routes 75 through cases and records wait_ms in history and the ledger", async () => {
    const dir = poolDir();
    const pool = new Pool(dir, fakeProbes());
    const holder = await pool.acquire({ threads: 10 });
    const { loader, dir: wfDir } = createTestLoader({
      e: {
        initial: "run",
        states: {
          run: {
            type: "exec",
            command: "true",
            resource: { threads: 2, wait_timeout: 0.1 },
            cases: { "0": "ok", "75": "busy" },
            default: "ok",
          },
          ok: { terminal: true, outcome: "complete" },
          busy: { terminal: true, outcome: "fail" },
        },
      },
    });
    tmpDirs.push(wfDir);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, loader, new Executor(pool));
    const { sessionId } = await engine.start("e");
    const s = storage.read(sessionId)!;
    expect(s.outcome).toBe("failed");
    const action = s.history.find(h => h.event === "action")!;
    expect(action.to).toBe("busy");
    expect(action.exit_code).toBe(75);
    expect(action.wait_ms).toBeGreaterThanOrEqual(90);
    const line = storage.ledger[0] as { execs: Array<{ wait_ms?: number }>; wait_ms_total: number };
    expect(line.execs[0].wait_ms).toBe(action.wait_ms);
    expect(line.wait_ms_total).toBe(action.wait_ms);
    if (holder.status === "granted") await holder.lease.release();
  }, 10_000);
});

describe("Pool: flexible leases and re-ranking", () => {
  it("a flexible lease reports the threads granted; wait_full waits for the max, then takes what is free", async () => {
    const pool = new Pool(poolDir(), fakeProbes());
    const holder = await pool.acquire({ threads: 6 });
    const now = await pool.acquire({ threads: 8, minThreads: 2 });
    expect(now.status === "granted" && now.lease.threads).toBe(4);
    if (now.status === "granted") await now.lease.release();
    // the window ends with no release: what is free, woken by the window's end, not by the next poll
    const late = await pool.acquire(
      { threads: 8, minThreads: 2, waitFullMs: 300 },
      { pollMs: 5_000 },
    );
    expect(late.status === "granted" && late.lease.threads).toBe(4);
    expect(late.waitMs).toBeGreaterThanOrEqual(290);
    expect(late.waitMs).toBeLessThan(2_000);
    if (late.status === "granted") await late.lease.release();
    // freed inside the window: the full max
    setTimeout(() => {
      if (holder.status === "granted") void holder.lease.release();
    }, 100);
    const full = await pool.acquire(
      { threads: 8, minThreads: 2, waitFullMs: 5_000 },
      { pollMs: 20 },
    );
    expect(full.status === "granted" && full.lease.threads).toBe(8);
    expect(full.waitMs).toBeLessThan(2_000);
    if (full.status === "granted") await full.lease.release();
    await expect(pool.acquire({ threads: 2, minThreads: 3 })).rejects.toThrow(
      /min threads must be an integer in 1\.\.2/,
    );
    await expect(pool.acquire({ threads: 2, waitFullMs: 10 })).rejects.toThrow(/needs a min/);
  }, 10_000);

  it("reprioritize moves only the waiters of the sessions that carry a level; leases keep theirs", async () => {
    const dir = poolDir();
    const pool = new Pool(dir, fakeProbes());
    const pid = process.pid;
    const lease: PoolEntry = {
      ...entry(10, { pid, session_id: "s1", level: "normal" }),
      started: 1,
    };
    const a = entry(1, { pid, session_id: "s1", level: "normal", priority: 1, arrived: 2 });
    const b = entry(1, { pid, priority: 50, arrived: 1 });
    const c = entry(1, { pid, session_id: "s2", level: "normal", arrived: 3 });
    const d = entry(1, { pid, session_id: "s1", priority: 7, arrived: 4 });
    fs.writeFileSync(
      path.join(dir, "pool.json"),
      JSON.stringify({ leases: [lease], waiting: [a, b, c, d] }),
    );
    expect(await pool.reprioritize(new Set(["s1"]), "high")).toBe(1);
    const after = readPool(dir);
    // stored in admission order: priority desc, then arrival
    expect(after.waiting.map(e => [e.id, e.priority, e.level])).toEqual([
      [a.id, 101, "high"],
      [b.id, 50, undefined],
      [d.id, 7, undefined],
      [c.id, 0, "normal"],
    ]);
    expect(after.leases.map(e => [e.priority, e.level])).toEqual([[0, "normal"]]);
    expect(await pool.reprioritize(new Set(["s1"]), "low")).toBe(1);
    expect(readPool(dir).waiting.map(e => [e.id, e.priority])).toEqual([
      [b.id, 50],
      [d.id, 7],
      [c.id, 0],
      [a.id, -99],
    ]);
  });
});

describe("session priority levels", () => {
  const until = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 300 && !cond(); i++) await new Promise(r => setTimeout(r, 20));
    expect(cond()).toBe(true);
  };

  it("a lease's priority = the session level + the step's; children inherit the level; execs get WF_PRIORITY and WF_PRIORITY_LEVEL", async () => {
    const dir = poolDir();
    const seen = tmp("wf-seen-");
    const { loader, dir: wfDir } = createTestLoader({
      p: {
        initial: "run",
        states: {
          run: {
            type: "exec",
            command:
              'cp "$POOL" "$SEEN/{{session_id}}"; printf "%s %s" "$WF_PRIORITY" "$WF_PRIORITY_LEVEL"',
            env: { POOL: path.join(dir, "pool.json"), SEEN: seen },
            resource: { threads: 1, priority: 3 },
            on_success: "light",
            on_error: "light",
            context_set: { leased: "{{stdout}}" },
          },
          light: {
            type: "exec",
            command: 'printf "%s %s" "$WF_PRIORITY" "$WF_PRIORITY_LEVEL"',
            on_success: "show",
            on_error: "show",
          },
          show: { prompt: "{{context.leased}} / {{stdout}}", transitions: { done: "end" } },
          end: { terminal: true, outcome: "complete" },
        },
      },
    });
    tmpDirs.push(wfDir);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, loader, new Executor(new Pool(dir, fakeProbes())));
    const outer = { p: process.env.WF_PRIORITY, l: process.env.WF_PRIORITY_LEVEL };
    process.env.WF_PRIORITY = "999";
    process.env.WF_PRIORITY_LEVEL = "urgent";
    try {
      const root = await engine.start("p", undefined, undefined, undefined, "high");
      expect(root.prompt).toBe("103 high / 100 high");
      const lease = (
        JSON.parse(fs.readFileSync(path.join(seen, root.sessionId), "utf8")) as PoolState
      ).leases[0];
      expect([lease.priority, lease.level, lease.step, lease.session_id]).toEqual([
        103,
        "high",
        "p/run",
        root.sessionId,
      ]);
      const child = await engine.start("p", undefined, root.sessionId);
      expect(child.prompt).toBe("103 high / 100 high");
      expect(storage.read(child.sessionId)!.priority).toBe("high");
      const own = await engine.start("p", undefined, root.sessionId, undefined, "low");
      expect(own.prompt).toBe("-97 low / -100 low");
      await engine.abort(root.sessionId);
      const plain = await engine.start("p");
      expect(plain.prompt).toBe("3 normal / 0 normal");
      await expect(
        engine.start("p", undefined, undefined, undefined, "max" as never),
      ).rejects.toThrow();
    } finally {
      for (const [k, v] of [
        ["WF_PRIORITY", outer.p],
        ["WF_PRIORITY_LEVEL", outer.l],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 10_000);

  it("set_priority re-ranks a session's waiting exec at once, survives the exec, reaches descendants; a running lease keeps its priority", async () => {
    const dir = poolDir();
    const pool = new Pool(dir, fakeProbes());
    const holder = await pool.acquire({ threads: 10, label: "holder" });
    const early = pool.acquire({ threads: 10, priority: 50, label: "early" }, { pollMs: 20 });
    const seen = path.join(dir, "seen");
    const { loader, dir: wfDir } = createTestLoader({
      w: {
        initial: "run",
        states: {
          run: {
            type: "exec",
            command: `cp "${path.join(dir, "pool.json")}" "${seen}"`,
            resource: { threads: 10 },
            on_success: "idle",
            on_error: "idle",
          },
          idle: { prompt: "idle", transitions: { done: "end" } },
          end: { terminal: true, outcome: "complete" },
        },
      },
      idle: {
        initial: "idle",
        states: {
          idle: { prompt: "idle", transitions: { done: "end" } },
          end: { terminal: true, outcome: "complete" },
        },
      },
    });
    tmpDirs.push(wfDir);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, loader, new Executor(pool));
    const run = engine.start("w");
    await until(() => readPool(dir).waiting.length === 2);
    const rootId = storage.readAll()[0].session_id;
    expect(readPool(dir).waiting.map(e => e.session_id)).toEqual(["", rootId]);
    const child = await engine.start("idle", undefined, rootId);
    const running = await pool.acquire({
      threads: 0,
      locks: ["x"],
      sessionId: child.sessionId,
      level: "normal",
    });
    expect(await engine.setPriority(rootId, "urgent")).toEqual({
      sessions: [rootId, child.sessionId],
      moved: 1,
    });
    const ranked = readPool(dir).waiting;
    expect(ranked.map(e => [e.session_id, e.priority, e.level])).toEqual([
      [rootId, 200, "urgent"],
      ["", 50, undefined],
    ]);
    expect(readPool(dir).leases.find(e => e.session_id === child.sessionId)!.priority).toBe(0);
    if (holder.status === "granted") await holder.lease.release();
    await run;
    // the re-ranked exec ran first: the earlier waiter was still queued while it held the lease
    const during = JSON.parse(fs.readFileSync(seen, "utf8")) as PoolState;
    expect(during.leases.find(e => e.session_id === rootId)!.level).toBe("urgent");
    expect(during.waiting.map(e => e.label)).toEqual(["early"]);
    expect(storage.read(rootId)!.priority).toBe("urgent");
    expect(storage.read(child.sessionId)!.priority).toBe("urgent");
    const later = await engine.start("idle", undefined, child.sessionId);
    expect(storage.read(later.sessionId)!.priority).toBe("urgent");
    if (running.status === "granted") await running.lease.release();
    const got = await early;
    if (got.status === "granted") await got.lease.release();
    await engine.abort(rootId);
    await expect(engine.setPriority(rootId, "high")).rejects.toThrow(/has ended/);
  }, 15_000);

  it("a flexible resource: WF_THREADS = the threads granted; history and ledger record threads_granted, wait_ms, duration_ms, step_key", async () => {
    const dir = poolDir();
    const pool = new Pool(dir, fakeProbes());
    const holder = await pool.acquire({ threads: 6 });
    const repo = tmp("wf-repo-");
    fs.mkdirSync(path.join(repo, ".git"));
    fs.mkdirSync(path.join(repo, "pkg"));
    const { loader, dir: wfDir } = createTestLoader({
      f: {
        initial: "run",
        states: {
          run: {
            type: "exec",
            command: 'printf "%s" "$WF_THREADS"',
            resource: { threads: { min: 2, max: 8 } },
            on_success: "show",
            on_error: "show",
          },
          show: { prompt: "{{stdout}}", transitions: { done: "end" } },
          end: { terminal: true, outcome: "complete" },
        },
      },
    });
    tmpDirs.push(wfDir);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, loader, new Executor(pool));
    const { sessionId, prompt } = await engine.start(
      "f",
      undefined,
      undefined,
      path.join(repo, "pkg"),
    );
    expect(prompt).toBe("4");
    await engine.transition(sessionId, "done");
    const action = storage.read(sessionId)!.history.find(h => h.event === "action")!;
    expect(action.threads_granted).toBe(4);
    expect(action.step_key).toBe(`${repo}|f|run`);
    const line = storage.ledger[0] as { execs: Array<Record<string, unknown>> };
    expect(line.execs[0]).toMatchObject({
      state: "run",
      threads_granted: 4,
      step_key: `${repo}|f|run`,
      exit_code: 0,
    });
    expect(typeof line.execs[0].wait_ms).toBe("number");
    expect(typeof line.execs[0].duration_ms).toBe("number");
    if (holder.status === "granted") await holder.lease.release();
  }, 10_000);

  it("set_priority racing a child's last transition on the real Storage never resurrects the ended child", async () => {
    const pool = new Pool(poolDir(), fakeProbes());
    const { loader, dir: wfDir } = createTestLoader({
      idle: {
        initial: "idle",
        states: {
          idle: { prompt: "idle", transitions: { done: "end" } },
          end: { terminal: true, outcome: "complete" },
        },
      },
    });
    tmpDirs.push(wfDir);
    const storage = new Storage(tmp("wf-state-"));
    const engine = new Engine(storage, loader, new Executor(pool));
    const { sessionId: rootId } = await engine.start("idle");
    const resurrected: string[] = [];
    const failed: string[] = [];
    for (let i = 0; i < 40; i++) {
      const { sessionId: childId } = await engine.start("idle", undefined, rootId);
      const settled = await Promise.allSettled([
        engine.setPriority(rootId, i % 2 ? "high" : "low"),
        engine.transition(childId, "done"),
      ]);
      for (const r of settled) if (r.status === "rejected") failed.push(String(r.reason));
      const child = storage.read(childId)!;
      if (child.stack.length !== 0 || child.outcome !== "completed") resurrected.push(childId);
    }
    expect({ resurrected: resurrected.length, failed }).toEqual({ resurrected: 0, failed: [] });
    expect(storage.read(rootId)!.priority).toBe("high");
  }, 30_000);

  it("the set_priority and pool_status tools", async () => {
    const dir = poolDir();
    const pool = new Pool(dir, fakeProbes());
    const { loader, dir: wfDir } = createTestLoader({
      idle: {
        initial: "idle",
        states: {
          idle: { prompt: "idle", transitions: { done: "end" } },
          end: { terminal: true, outcome: "complete" },
        },
      },
    });
    tmpDirs.push(wfDir);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, loader, new Executor(pool));
    const handlers = new Map<
      string,
      (args: object) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
    >();
    const server = {
      registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h),
    };
    registerTools(server as never, engine, {} as never, loader, storage, pool);
    const { sessionId } = await engine.start("idle", undefined, undefined, undefined, "low");
    const set = await handlers.get("set_priority")!({ session_id: sessionId, level: "high" });
    expect(set.content[0].text).toBe(
      `Priority high (100) set on ${sessionId}; 0 waiting pool entries re-ranked.`,
    );
    expect(storage.read(sessionId)!.priority).toBe("high");
    expect(
      (await handlers.get("set_priority")!({ session_id: "nope", level: "high" })).isError,
    ).toBe(true);
    const holder = await pool.acquire({
      threads: 3,
      label: "holder",
      sessionId,
      level: "high",
      priority: 100,
      step: "idle/idle",
    });
    const status = await handlers.get("pool_status")!({});
    expect(status.content[0].text).toMatch(new RegExp(`^pool ${dir}: budget 10, held 3`));
    expect(status.content[0].text).toMatch(
      new RegExp(
        `holds 3 threads {2}prio 100 high {2}since .* {2}session ${sessionId} {2}step idle/idle {2}holder`,
      ),
    );
    if (holder.status === "granted") await holder.lease.release();
  }, 10_000);
});

describe("wf-run CLI (real processes)", () => {
  let cli = "";
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    cli = path.join(tmp("wf-run-bin-"), "wf-run.cjs");
    await build({
      entryPoints: [path.join(SRC, "wf-run.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node18",
      outfile: cli,
      logLevel: "silent",
    });
  });
  // Groups of commands a test detached from wf-run: never left running past the test.
  const groups: number[] = [];
  afterEach(() => {
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
    children.length = 0;
    for (const g of groups) if (isGroupAlive(g)) process.kill(-g, "SIGKILL");
    groups.length = 0;
  });

  interface Run {
    code: number | null;
    stderr: string;
    stdout: string;
  }
  function wfRun(
    dir: string,
    args: string[],
    extra: Record<string, string> = {},
  ): { child: ChildProcess; done: Promise<Run> } {
    // A test run from inside a session exec must not hand its own session's priority to these runs.
    const { WF_PRIORITY: _p, WF_PRIORITY_LEVEL: _l, WF_SESSION_ID: _s, ...base } = process.env;
    const env = { ...base, WF_THREADS: "99", WF_POOL_DIR: dir, ...extra };
    const child = spawn(process.execPath, [cli, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", d => {
      stdout += d;
    });
    child.stderr!.on("data", d => {
      stderr += d;
    });
    const done = new Promise<Run>(resolve =>
      child.on("close", code => resolve({ code, stderr, stdout })),
    );
    return { child, done };
  }
  // The real loadavg of the test machine is not part of these tests.
  const quiet = { budget: 10, load_threshold: 1000 };

  it("parallel processes never hold more than the budget at once", async () => {
    const dir = poolDir(quiet);
    const log = path.join(dir, "log");
    const job = (name: string, threads: number) =>
      wfRun(dir, [
        "--threads",
        String(threads),
        "--label",
        name,
        "--",
        process.execPath,
        "-e",
        `const fs=require("fs");fs.appendFileSync(${JSON.stringify(log)},"start ${name} ${threads} "+Date.now()+"\\n");` +
          `setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},"end ${name} ${threads} "+Date.now()+"\\n"),300)`,
      ]);
    const runs = await Promise.all([job("a", 6), job("b", 6), job("c", 4)].map(j => j.done));
    expect(runs.map(r => r.code)).toEqual([0, 0, 0]);
    const events = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map(l => l.split(" "))
      .map(([kind, , threads, at]) => ({ kind, threads: Number(threads), at: Number(at) }))
      .sort((x, y) => x.at - y.at || (x.kind === "end" ? -1 : 1));
    let running = 0;
    let peak = 0;
    for (const e of events) {
      running += e.kind === "start" ? e.threads : -e.threads;
      peak = Math.max(peak, running);
    }
    expect(events).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(10);
    expect(readPool(dir)).toEqual({ leases: [], waiting: [] });
  }, 30_000);

  it("busy past --wait-timeout exits 75; --status lists the lease", async () => {
    const dir = poolDir(quiet);
    const holder = await new Pool(dir, fakeProbes()).acquire({ threads: 8, label: "holder" });
    const status = await wfRun(dir, ["--status"]).done;
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/budget 10, held 8/);
    expect(status.stdout).toMatch(/holds 8 threads {2}prio 0 .* holder/);
    const r = await wfRun(dir, ["--threads", "6", "--wait-timeout", "0.5", "--", "true"]).done;
    expect(r.code).toBe(75);
    expect(r.stderr).toMatch(/waiting for 6 threads — held 8\/10 by holder \(8\)/);
    expect(r.stderr).toMatch(/busy/);
    expect(readPool(dir).waiting).toEqual([]);
    if (holder.status === "granted") await holder.lease.release();
  }, 15_000);

  it("two processes behind one --lock never overlap; a lock-only run takes no threads", async () => {
    const dir = poolDir(quiet);
    const log = path.join(dir, "log");
    const job = (name: string) =>
      wfRun(dir, [
        "--lock",
        "port:3000",
        "--label",
        name,
        "--",
        process.execPath,
        "-e",
        `const fs=require("fs");fs.appendFileSync(${JSON.stringify(log)},"start ${name} "+Date.now()+" "+(process.env.WF_THREADS??"-")+"\\n");` +
          `setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},"end ${name} "+Date.now()+"\\n"),300)`,
      ]);
    // a full pool: the lock-only runs still go, one at a time
    const holder = await new Pool(dir, fakeProbes()).acquire({ threads: 10, label: "full" });
    const runs = await Promise.all([job("a"), job("b")].map(j => j.done));
    if (holder.status === "granted") await holder.lease.release();
    expect(runs.map(r => r.code)).toEqual([0, 0]);
    const lines = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map(l => l.split(" "));
    expect(lines.filter(l => l[0] === "start").map(l => l[3])).toEqual(["-", "-"]);
    const at = (kind: string, name: string) =>
      Number(lines.find(l => l[0] === kind && l[1] === name)![2]);
    const [first, second] = at("start", "a") < at("start", "b") ? ["a", "b"] : ["b", "a"];
    expect(at("start", second)).toBeGreaterThanOrEqual(at("end", first));
    expect(readPool(dir)).toEqual({ leases: [], waiting: [] });
  }, 30_000);

  it("--lock: --status shows it, a busy lock exits 75, a dead holder is reaped; the child gets WF_THREADS", async () => {
    const dir = poolDir({ budget: 5, load_threshold: 1000 });
    const pool = new Pool(dir, fakeProbes());
    const holder = await pool.acquire({ threads: 1, locks: ["sim"], label: "holder" });
    const status = await wfRun(dir, ["--status"]).done;
    expect(status.stdout).toMatch(/locks held: sim/);
    expect(status.stdout).toMatch(/holds 1 threads \+ lock sim {2}prio 0 .* holder/);
    const busy = await wfRun(dir, ["--lock", "sim", "--wait-timeout", "0.3", "--", "true"]).done;
    expect(busy.code).toBe(75);
    expect(busy.stderr).toMatch(/waiting for lock sim — .*lock sim held by holder/);
    expect(busy.stderr).toMatch(/busy — lock sim not free/);
    if (holder.status === "granted") await holder.lease.release();
    // a holder whose process is gone
    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise(r => gone.on("exit", r));
    const dead: PoolEntry = { ...entry(0, { pid: gone.pid!, locks: ["sim"] }), started: 1 };
    fs.writeFileSync(path.join(dir, "pool.json"), JSON.stringify({ leases: [dead], waiting: [] }));
    const r = await wfRun(dir, [
      "--lock",
      "sim",
      "--threads",
      "9",
      "--wait-timeout",
      "5",
      "--",
      "sh",
      "-c",
      'printf "%s" "$WF_THREADS"',
    ]).done;
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("5");
    expect((await wfRun(dir, ["--lock", "a b", "--", "true"]).done).code).toBe(64);
    expect(readPool(dir)).toEqual({ leases: [], waiting: [] });
  }, 20_000);

  it("--threads budget leases the configured budget", async () => {
    const dir = poolDir({ budget: 5, load_threshold: 1000 });
    const seen = path.join(dir, "seen");
    const r = await wfRun(dir, [
      "--threads",
      "budget",
      "--",
      "cp",
      path.join(dir, "pool.json"),
      seen,
    ]).done;
    expect(r.code).toBe(0);
    expect(
      (JSON.parse(fs.readFileSync(seen, "utf8")) as PoolState).leases.map(l => l.threads),
    ).toEqual([5]);
    expect((await wfRun(dir, ["--threads", "all", "--", "true"]).done).code).toBe(64);
  }, 15_000);

  it("forwards SIGTERM to the child's group, exits with the child's code and releases the lease", async () => {
    const dir = poolDir(quiet);
    const ready = path.join(dir, "ready");
    const got = path.join(dir, "got");
    const { child, done } = wfRun(dir, [
      "--threads",
      "3",
      "--",
      process.execPath,
      "-e",
      `const fs=require("fs");process.on("SIGTERM",()=>{fs.writeFileSync(${JSON.stringify(got)},"x");process.exit(7)});` +
        `fs.writeFileSync(${JSON.stringify(ready)},"x");setInterval(()=>{},1000)`,
    ]);
    for (let i = 0; i < 200 && !fs.existsSync(ready); i++)
      await new Promise(r => setTimeout(r, 25));
    expect(readPool(dir).leases.map(l => l.threads)).toEqual([3]);
    child.kill("SIGTERM");
    const r = await done;
    expect(r.code).toBe(7);
    expect(fs.existsSync(got)).toBe(true);
    expect(readPool(dir)).toEqual({ leases: [], waiting: [] });
  }, 15_000);

  it("a SIGKILLed wf-run keeps the lease while its child's group runs", async () => {
    const dir = poolDir(quiet);
    const ready = path.join(dir, "ready");
    const { child, done } = wfRun(dir, [
      "--threads",
      "4",
      "--",
      process.execPath,
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`,
    ]);
    for (let i = 0; i < 200 && !fs.existsSync(ready); i++)
      await new Promise(r => setTimeout(r, 25));
    const grandchild = Number(fs.readFileSync(ready, "utf8"));
    groups.push(grandchild);
    for (let i = 0; i < 100 && readPool(dir).leases[0]?.pgid === undefined; i++)
      await new Promise(r => setTimeout(r, 20));
    expect(readPool(dir).leases[0].pgid).toBe(grandchild);
    // the grandchild holds the stdio pipes open: wait for the exit, not the close
    const exited = new Promise(r => child.on("exit", r));
    child.kill("SIGKILL");
    await exited;
    void done;
    const pool = new Pool(dir, fakeProbes());
    try {
      expect((await pool.status()).leases.map(l => l.threads)).toEqual([4]);
    } finally {
      process.kill(-grandchild, "SIGKILL");
    }
    for (let i = 0; i < 100 && isGroupAlive(grandchild); i++)
      await new Promise(r => setTimeout(r, 20));
    expect((await pool.status()).leases).toEqual([]);
  }, 15_000);

  it("--threads MIN-MAX takes the free threads at once; --wait-full waits for the max until its window ends", async () => {
    const dir = poolDir(quiet);
    const holder = await new Pool(dir, fakeProbes()).acquire({ threads: 6, label: "holder" });
    const threads = ["--", "sh", "-c", 'printf "%s" "$WF_THREADS"'];
    const now = await wfRun(dir, ["--threads", "2-8", ...threads]).done;
    expect([now.code, now.stdout]).toEqual([0, "4"]);
    const t0 = Date.now();
    const late = await wfRun(dir, ["--threads", "2-8", "--wait-full", "0.5", ...threads]).done;
    expect([late.code, late.stdout]).toEqual([0, "4"]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    // the holder ends inside the window: the full max (here the whole budget)
    setTimeout(() => {
      if (holder.status === "granted") void holder.lease.release();
    }, 300);
    const full = await wfRun(dir, ["--threads", "2-budget", "--wait-full", "10", ...threads]).done;
    expect([full.code, full.stdout]).toEqual([0, "10"]);
    // a min above the budget clamps with the max: it runs on an empty pool instead of waiting forever
    const clamped = await wfRun(dir, ["--threads", "11-20", "--wait-timeout", "2", ...threads])
      .done;
    expect([clamped.code, clamped.stdout]).toEqual([0, "10"]);
    for (const bad of [
      ["--wait-full", "1"],
      ["--threads", "5-2"],
      ["--threads", "0-2"],
      ["--threads", "2-x"],
    ])
      expect((await wfRun(dir, [...bad, "--", "true"]).done).code).toBe(64);
    expect(readPool(dir)).toEqual({ leases: [], waiting: [] });
  }, 20_000);

  it("without --priority a run takes WF_PRIORITY and its level from the environment; --status shows level, project, session and step", async () => {
    const dir = poolDir(quiet);
    const pool = new Pool(dir, fakeProbes());
    const holder = await pool.acquire({
      threads: 10,
      label: "holder",
      sessionId: "sess1",
      level: "high",
      priority: 100,
      step: "wf/run",
      project: "/p/x",
    });
    const show = ["--", "sh", "-c", 'printf "%s %s" "$WF_PRIORITY" "${WF_PRIORITY_LEVEL-unset}"'];
    const waiter = wfRun(dir, ["--threads", "1", "--label", "waiter", ...show], {
      WF_PRIORITY: "103",
      WF_PRIORITY_LEVEL: "high",
      WF_SESSION_ID: "sess2",
    });
    for (let i = 0; i < 200 && readPool(dir).waiting.length === 0; i++)
      await new Promise(r => setTimeout(r, 25));
    expect(readPool(dir).waiting.map(e => [e.priority, e.level, e.session_id])).toEqual([
      [103, "high", "sess2"],
    ]);
    const status = await wfRun(dir, ["--status"]).done;
    expect(status.stdout).toMatch(
      /holds 10 threads {2}prio 100 high {2}since \d\d:\d\d:\d\d \(\d+s\) {2}\/p\/x {2}session sess1 {2}step wf\/run {2}holder/,
    );
    expect(status.stdout).toMatch(
      /wants 1 threads {2}prio 103 high {2}since .* {2}session sess2 {2}waiter/,
    );
    if (holder.status === "granted") await holder.lease.release();
    expect((await waiter.done).stdout).toBe("103 high");
    const explicit = await wfRun(dir, ["--priority", "5", ...show], {
      WF_PRIORITY: "103",
      WF_PRIORITY_LEVEL: "high",
    }).done;
    expect(explicit.stdout).toBe("5 unset");
    expect((await wfRun(dir, show).done).stdout).toBe("0 unset");
  }, 20_000);

  it.runIf(process.platform === "darwin")(
    "--efficiency runs under taskpolicy outside the budget",
    async () => {
      const dir = poolDir({ budget: 1, load_threshold: 0 });
      const holder = await new Pool(dir, fakeProbes()).acquire({ threads: 1 });
      const r = await wfRun(dir, ["--efficiency", "--threads", "4", "--", "sh", "-c", "exit 3"])
        .done;
      expect(r.code).toBe(3);
      if (holder.status === "granted") await holder.lease.release();
    },
    15_000,
  );
});
