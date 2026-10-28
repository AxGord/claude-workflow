import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Pool, schedule, describeWait, type CpuTicks, type PoolEntry, type PoolProbes, type PoolState } from "./pool.js";
import { isGroupAlive, isPidAlive } from "./process.js";
import { Executor } from "./executor.js";
import { Engine } from "./engine.js";
import { InMemoryStorage, createTestLoader, cleanupDir } from "./test-helpers.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const tmpDirs: string[] = [];
const tmp = (prefix: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterAll(() => { for (const d of tmpDirs) cleanupDir(d); });

let seq = 0;
const entry = (threads: number, extra: Partial<PoolEntry> = {}): PoolEntry => ({
  id: `e${++seq}`, pid: 100, threads, priority: 0, label: "", cwd: "/", session_id: "", arrived: seq, ...extra,
});
const alive = () => true;
const cfg = { budget: 10, load_threshold: 0 };
const ids = (es: readonly PoolEntry[]) => es.map(e => e.id);

describe("schedule (one admission pass)", () => {
  it("admits while held + N + external fits the budget", () => {
    const held = entry(6);
    const big = entry(6);
    expect(ids(schedule({ leases: [held], waiting: [big] }, cfg, 0, alive, 1).leases)).toEqual([held.id]);
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
    expect(schedule({ leases: [held], waiting: [three] }, { budget: 10, load_threshold: 2 }, 9.5, alive, 1).leases).toHaveLength(1);
    expect(schedule({ leases: [held], waiting: [three] }, { budget: 10, load_threshold: 3 }, 9.5, alive, 1).leases).toHaveLength(2);
    // leased threads are not external: load 7 with 6 leased = 1 external
    const v = schedule({ leases: [held], waiting: [three] }, cfg, 7, alive, 1);
    expect(v.external).toBe(1);
    expect(ids(v.leases)).toEqual([held.id, three.id]);
    expect(schedule({ leases: [held], waiting: [entry(4)] }, cfg, 7, alive, 1).leases).toHaveLength(1);
  });

  it("external load never blocks an empty pool; beside a live lease it does", () => {
    const ten = entry(10);
    expect(ids(schedule({ leases: [], waiting: [ten] }, cfg, 12, alive, 1).leases)).toEqual([ten.id]);
    const held = entry(1);
    expect(ids(schedule({ leases: [held], waiting: [entry(2)] }, cfg, 12, alive, 1).leases)).toEqual([held.id]);
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

const readPool = (dir: string): PoolState => JSON.parse(fs.readFileSync(path.join(dir, "pool.json"), "utf8"));

describe("Pool", () => {
  it("default budget = performance cores − 2 (at least 1); config.json overrides; a bad key throws", () => {
    const dir = tmp("wf-pool-");
    expect(new Pool(dir, fakeProbes()).config()).toEqual({ budget: 10, load_threshold: 2 });
    expect(new Pool(dir, { ...fakeProbes(), perfCores: () => 2 }).config().budget).toBe(1);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ budget: 4, load_threshold: 0.5 }));
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
    const b = await pool.acquire({ threads: 6 }, { waitTimeoutMs: 250, pollMs: 20, onProgress: (s, v) => progress.push(describeWait(s, v)) });
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
    setTimeout(() => { if (holder.status === "granted") void holder.lease.release(); }, 150);
    const leasedDuringRun = path.join(dir, "seen");
    const t0 = performance.now();
    const r = await executor.execute(
      { type: "exec", command: `cp "${path.join(dir, "pool.json")}" "${leasedDuringRun}"; sleep 0.05`, resource: { threads: 6 } },
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
      { type: "exec", command: `touch "${marker}"`, resource: { threads: 1, wait_timeout: 0.2 } }, {},
    );
    expect(busy.exit_code).toBe(75);
    expect(busy.stderr).toMatch(/^busy: 1 threads not free within 0.2s \(held 10\/10/);
    expect(busy.wait_ms).toBeGreaterThanOrEqual(190);
    expect(fs.existsSync(marker)).toBe(false);

    const pending = executor.execute(
      { type: "exec", command: `touch "${marker}"`, resource: { threads: 1 } }, {}, { sessionId: "s2", rootSessionId: "s2" },
    );
    await new Promise(r => setTimeout(r, 100));
    executor.killSession("s2");
    const aborted = await pending;
    expect(aborted.exit_code).toBe(130);
    expect(fs.existsSync(marker)).toBe(false);
    expect(readPool(dir).waiting).toEqual([]);
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
      { type: "exec", command: `touch "${marker}"`, resource: { threads: 1 } }, {}, { sessionId: "s3", rootSessionId: "s3" },
    );
    expect(r.exit_code).toBe(130);
    expect(fs.existsSync(marker)).toBe(false);
    expect(readPool(dir)).toEqual({ leases: [], waiting: [] });
  });

  it('threads: "budget" leases the configured budget', async () => {
    const dir = poolDir({ budget: 7, load_threshold: 0 });
    const executor = new Executor(new Pool(dir, fakeProbes()));
    const seen = path.join(dir, "seen");
    const r = await executor.execute(
      { type: "exec", command: `cp "${path.join(dir, "pool.json")}" "${seen}"`, resource: { threads: "budget" } }, {},
    );
    expect(r.exit_code).toBe(0);
    expect((JSON.parse(fs.readFileSync(seen, "utf8")) as PoolState).leases.map(l => l.threads)).toEqual([7]);
    expect(readPool(dir)).toEqual({ leases: [], waiting: [] });
  });

  it("{{wait_ms}} reaches the states after a resource: exec", async () => {
    const dir = poolDir();
    const pool = new Pool(dir, fakeProbes());
    const holder = await pool.acquire({ threads: 10 });
    setTimeout(() => { if (holder.status === "granted") void holder.lease.release(); }, 150);
    const { loader, dir: wfDir } = createTestLoader({
      e: {
        initial: "run",
        states: {
          run: { type: "exec", command: "true", resource: { threads: 2 }, on_success: "echo", on_error: "echo" },
          echo: { type: "exec", command: 'echo "$W"', env: { W: "{{wait_ms}}" }, on_success: "show", on_error: "show", success_prompt: "{{stdout}}" },
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
          run: { type: "exec", command: "true", resource: { threads: 2, wait_timeout: 0.1 }, cases: { "0": "ok", "75": "busy" }, default: "ok" },
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

describe("wf-run CLI (real processes)", () => {
  let cli = "";
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    cli = path.join(tmp("wf-run-bin-"), "wf-run.cjs");
    await build({ entryPoints: [path.join(SRC, "wf-run.ts")], bundle: true, platform: "node", format: "cjs", target: "node18", outfile: cli, logLevel: "silent" });
  });
  // Groups of commands a test detached from wf-run: never left running past the test.
  const groups: number[] = [];
  afterEach(() => {
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
    children.length = 0;
    for (const g of groups) if (isGroupAlive(g)) process.kill(-g, "SIGKILL");
    groups.length = 0;
  });

  interface Run { code: number | null; stderr: string; stdout: string }
  function wfRun(dir: string, args: string[]): { child: ChildProcess; done: Promise<Run> } {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, WF_POOL_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", d => { stdout += d; });
    child.stderr!.on("data", d => { stderr += d; });
    const done = new Promise<Run>(resolve => child.on("close", code => resolve({ code, stderr, stdout })));
    return { child, done };
  }
  // The real loadavg of the test machine is not part of these tests.
  const quiet = { budget: 10, load_threshold: 1000 };

  it("parallel processes never hold more than the budget at once", async () => {
    const dir = poolDir(quiet);
    const log = path.join(dir, "log");
    const job = (name: string, threads: number) => wfRun(dir, [
      "--threads", String(threads), "--label", name, "--", process.execPath, "-e",
      `const fs=require("fs");fs.appendFileSync(${JSON.stringify(log)},"start ${name} ${threads} "+Date.now()+"\\n");`
      + `setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},"end ${name} ${threads} "+Date.now()+"\\n"),300)`,
    ]);
    const runs = await Promise.all([job("a", 6), job("b", 6), job("c", 4)].map(j => j.done));
    expect(runs.map(r => r.code)).toEqual([0, 0, 0]);
    const events = fs.readFileSync(log, "utf8").trim().split("\n").map(l => l.split(" "))
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
    expect(status.stdout).toMatch(/threads 8 {2}prio 0 .* holder/);
    const r = await wfRun(dir, ["--threads", "6", "--wait-timeout", "0.5", "--", "true"]).done;
    expect(r.code).toBe(75);
    expect(r.stderr).toMatch(/waiting for 6 threads — held 8\/10 by holder \(8\)/);
    expect(r.stderr).toMatch(/busy/);
    expect(readPool(dir).waiting).toEqual([]);
    if (holder.status === "granted") await holder.lease.release();
  }, 15_000);

  it("--threads budget leases the configured budget", async () => {
    const dir = poolDir({ budget: 5, load_threshold: 1000 });
    const seen = path.join(dir, "seen");
    const r = await wfRun(dir, ["--threads", "budget", "--", "cp", path.join(dir, "pool.json"), seen]).done;
    expect(r.code).toBe(0);
    expect((JSON.parse(fs.readFileSync(seen, "utf8")) as PoolState).leases.map(l => l.threads)).toEqual([5]);
    expect((await wfRun(dir, ["--threads", "all", "--", "true"]).done).code).toBe(64);
  }, 15_000);

  it("forwards SIGTERM to the child's group, exits with the child's code and releases the lease", async () => {
    const dir = poolDir(quiet);
    const ready = path.join(dir, "ready");
    const got = path.join(dir, "got");
    const { child, done } = wfRun(dir, [
      "--threads", "3", "--", process.execPath, "-e",
      `const fs=require("fs");process.on("SIGTERM",()=>{fs.writeFileSync(${JSON.stringify(got)},"x");process.exit(7)});`
      + `fs.writeFileSync(${JSON.stringify(ready)},"x");setInterval(()=>{},1000)`,
    ]);
    for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await new Promise(r => setTimeout(r, 25));
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
      "--threads", "4", "--", process.execPath, "-e",
      `require("fs").writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`,
    ]);
    for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await new Promise(r => setTimeout(r, 25));
    const grandchild = Number(fs.readFileSync(ready, "utf8"));
    groups.push(grandchild);
    for (let i = 0; i < 100 && readPool(dir).leases[0]?.pgid === undefined; i++) await new Promise(r => setTimeout(r, 20));
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
    for (let i = 0; i < 100 && isGroupAlive(grandchild); i++) await new Promise(r => setTimeout(r, 20));
    expect((await pool.status()).leases).toEqual([]);
  }, 15_000);

  it.runIf(process.platform === "darwin")("--efficiency runs under taskpolicy outside the budget", async () => {
    const dir = poolDir({ budget: 1, load_threshold: 0 });
    const holder = await new Pool(dir, fakeProbes()).acquire({ threads: 1 });
    const r = await wfRun(dir, ["--efficiency", "--threads", "4", "--", "sh", "-c", "exit 3"]).done;
    expect(r.code).toBe(3);
    if (holder.status === "granted") await holder.lease.release();
  }, 15_000);
});
