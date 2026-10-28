import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool, type PoolProbes, type PoolState } from "./pool.js";
import { isGroupAlive, isPidAlive } from "./process.js";
import { Executor } from "./executor.js";
import { Engine } from "./engine.js";
import { InMemoryStorage, createTestLoader, cleanupDir } from "./test-helpers.js";

const tmpDirs: string[] = [];
const tmp = (prefix: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterAll(() => { for (const d of tmpDirs) cleanupDir(d); });

const probes: PoolProbes = {
  perfCores: () => 12,
  loadavg: () => 0,
  cpuTicks: () => ({ busy: 0, total: 0, cpus: 1 }),
  isAlive: isPidAlive,
  isGroupAlive,
};

/** An executor over a private pool of `budget` threads (never the machine's real pool). */
function executorWith(budget: number): { executor: Executor; dir: string } {
  const dir = tmp("wf-fanout-pool-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ budget, load_threshold: 1000 }));
  return { executor: new Executor(new Pool(dir, probes)), dir };
}

const readPool = (dir: string): PoolState => JSON.parse(fs.readFileSync(path.join(dir, "pool.json"), "utf8"));

/**
 * A shard command that records how many shards run at once: it adds itself
 * to `running/` while it holds its lease, logs the count it sees, then leaves.
 */
function probeCommand(work: string, sleep = 0.3): string {
  return `mkdir -p "${work}/running" && touch "${work}/running/$$" && `
    + `echo "$(ls "${work}/running" | wc -l | tr -d ' ') \${WF_SHARD:-$WF_ITEM} $WF_THREADS" >> "${work}/log" && `
    + `sleep ${sleep}; rm "${work}/running/$$"`;
}

const logLines = (work: string) => fs.readFileSync(path.join(work, "log"), "utf8").trim().split("\n").map(l => l.split(" "));

describe("Executor fanout:", () => {
  it("real processes: every shard runs with WF_SHARD=i/N and its own lease; peak parallelism stays within the budget", async () => {
    const { executor, dir } = executorWith(4);
    const work = tmp("wf-fanout-work-");
    const r = await executor.execute(
      // max_parallel above what the budget runs: the pool, not the worker count, holds the peak
      { type: "exec", command: probeCommand(work), timeout: 10_000, fanout: { count: 6, threads_each: 2, max_parallel: 6 } },
      {},
      { sessionId: "f1", rootSessionId: "f1" },
    );
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toBe("fanout: 6/6 ok");
    const lines = logLines(work);
    expect(lines.map(l => l[1]).sort()).toEqual(["1/6", "2/6", "3/6", "4/6", "5/6", "6/6"]);
    expect(lines.every(l => l[2] === "2")).toBe(true);
    const peak = Math.max(...lines.map(l => Number(l[0])));
    // budget 4 / 2 threads each: never more than two at once, and they did overlap
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
    expect(r.shards!.map(s => s.shard)).toEqual(["1/6", "2/6", "3/6", "4/6", "5/6", "6/6"]);
    expect(r.shards!.every(s => s.exit_code === 0 && s.threads_granted === 2 && s.duration_ms >= 250)).toBe(true);
    // the later shards waited for threads to free up
    expect(r.shards!.filter(s => s.wait_ms >= 200).length).toBeGreaterThanOrEqual(2);
    expect(readPool(dir)).toEqual({ leases: [], waiting: [] });
  }, 20_000);

  it("max_parallel caps the shards in flight below what the budget allows", async () => {
    const { executor } = executorWith(10);
    const work = tmp("wf-fanout-work-");
    const r = await executor.execute(
      { type: "exec", command: probeCommand(work, 0.1), timeout: 10_000, fanout: { count: 4, threads_each: 1, max_parallel: 1 } }, {},
    );
    expect(r.exit_code).toBe(0);
    expect(logLines(work).map(l => l[1])).toEqual(["1/4", "2/4", "3/4", "4/4"]);
    expect(Math.max(...logLines(work).map(l => Number(l[0])))).toBe(1);
  }, 20_000);

  it("without max_parallel only as many shards as the budget runs side by side queue in the pool", async () => {
    const dir = tmp("wf-fanout-pool-");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ budget: 4, load_threshold: 1000 }));
    let inFlight = 0;
    let peak = 0;
    class Counting extends Pool {
      override async acquire(...a: Parameters<Pool["acquire"]>) {
        peak = Math.max(peak, ++inFlight);
        const got = await super.acquire(...a);
        if (got.status !== "granted") { inFlight--; return got; }
        const release = got.lease.release.bind(got.lease);
        got.lease.release = async () => { inFlight--; await release(); };
        return got;
      }
    }
    const executor = new Executor(new Counting(dir, probes));
    const r = await executor.execute({ type: "exec", command: "sleep 0.05", timeout: 10_000, fanout: { count: 6, threads_each: 2 } }, {});
    expect(r.exit_code).toBe(0);
    expect(r.shards).toHaveLength(6);
    // budget 4 / 2 threads: two in the pool (waiting or leased) at a time, not all six
    expect(peak).toBe(2);
    // threads_each over the budget still runs, one at a time
    peak = 0;
    expect((await executor.execute({ type: "exec", command: "true", fanout: { count: 3, threads_each: 9 } }, {})).exit_code).toBe(0);
    expect(peak).toBe(1);
  }, 20_000);

  it("items_command: CRLF lines lose their \\r", async () => {
    const { executor } = executorWith(10);
    const r = await executor.execute(
      { type: "exec", command: '[ "$WF_ITEM" = a ] || [ "$WF_ITEM" = b ]', fanout: { items_command: "printf 'a\\r\\nb\\r\\n'", threads_each: 1 } }, {},
    );
    expect(r.shards!.map(s => [s.shard, s.exit_code])).toEqual([["a", 0], ["b", 0]]);
  }, 20_000);

  it("items_command: one shard per non-empty line with WF_ITEM; a failure is summarised with its output tail", async () => {
    const { executor } = executorWith(10);
    const r = await executor.execute(
      {
        type: "exec",
        command: 'echo "item $WF_ITEM"; [ "$WF_ITEM" != "b c" ] || { echo "broken $WF_ITEM" >&2; exit 3; }',
        timeout: 10_000,
        fanout: { items_command: "printf 'a\\nb c\\n\\nd\\n'", threads_each: 1 },
      },
      {},
    );
    expect(r.exit_code).toBe(3);
    expect(r.success).toBe(false);
    expect(r.shards!.map(s => [s.shard, s.exit_code])).toEqual([["a", 0], ["b c", 3], ["d", 0]]);
    expect(r.stdout).toBe("fanout: 2/3 ok, 1 failed (exit 3)\n--- shard b c: exit 3 ---\nitem b c\nbroken b c\n");
  }, 20_000);

  it("a failing items_command fails the step without running a shard; no items is a pass", async () => {
    const { executor } = executorWith(10);
    const work = tmp("wf-fanout-work-");
    const failed = await executor.execute(
      { type: "exec", command: `touch "${work}/ran"`, fanout: { items_command: "echo a; exit 4", threads_each: 1 } }, {},
    );
    expect(failed.exit_code).toBe(4);
    expect(failed.error).toMatch(/^items_command failed/);
    // a failed listing's output is cut to the usual tail, not the listing's 1 MB
    const loud = await executor.execute(
      { type: "exec", command: "true", fanout: { items_command: "seq 1 20000; exit 4", threads_each: 1 } }, {},
    );
    expect(loud.exit_code).toBe(4);
    expect(loud.stdout!.length).toBeLessThanOrEqual(10 * 1024 + 20);
    expect(loud.stdout).toMatch(/20000\n$/);
    expect(fs.existsSync(path.join(work, "ran"))).toBe(false);
    const none = await executor.execute({ type: "exec", command: "exit 1", fanout: { items_command: "true", threads_each: 1 } }, {});
    expect(none.exit_code).toBe(0);
    expect(none.stdout).toBe("fanout: 0/0 ok");
  }, 20_000);

  it("exit code: every failing shard timed out → 124; differing failures → 1", async () => {
    const { executor } = executorWith(10);
    const allSlow = await executor.execute(
      { type: "exec", command: '[ "$WF_SHARD" = 1/3 ] || sleep 5', timeout: 300, fanout: { count: 3, threads_each: 1 } }, {},
    );
    expect(allSlow.shards!.map(s => s.exit_code)).toEqual([0, 124, 124]);
    expect(allSlow.exit_code).toBe(124);
    expect(allSlow.stdout).toMatch(/--- shard 2\/3: exit 124 \(timed out\) ---/);
    const mixed = await executor.execute(
      { type: "exec", command: 'case "$WF_SHARD" in 1/3) exit 0;; 2/3) exit 2;; *) sleep 5;; esac', timeout: 300, fanout: { count: 3, threads_each: 1 } }, {},
    );
    expect(mixed.shards!.map(s => s.exit_code)).toEqual([0, 2, 124]);
    expect(mixed.exit_code).toBe(1);
  }, 20_000);

  it("abort kills the running shards, withdraws the waiting ones and starts no more", async () => {
    const { executor, dir } = executorWith(2);
    const work = tmp("wf-fanout-work-");
    const pending = executor.execute(
      { type: "exec", command: `sleep 5; touch "${work}/finished.$WF_SHARD"`, timeout: 10_000, fanout: { count: 5, threads_each: 1, max_parallel: 3 } },
      {},
      { sessionId: "fa", rootSessionId: "fa" },
    );
    await new Promise(r => setTimeout(r, 400));
    const t0 = performance.now();
    executor.killSession("fa");
    const r = await pending;
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(r.exit_code).not.toBe(0);
    expect(r.shards).toHaveLength(5);
    expect(r.shards!.every(s => s.exit_code !== 0)).toBe(true);
    // two ran (budget 2), one waited (max_parallel 3), two never started
    expect(r.shards!.filter(s => s.exit_code === 130 && s.duration_ms === 0 && s.wait_ms === 0).length).toBeGreaterThanOrEqual(2);
    await new Promise(r => setTimeout(r, 300));
    expect(fs.readdirSync(work)).toEqual([]);
    expect(readPool(dir)).toEqual({ leases: [], waiting: [] });
  }, 20_000);
});

describe("Engine: fanout history and on_timeout", () => {
  const engineWith = (workflows: Record<string, object>) => {
    const { loader, dir } = createTestLoader(workflows);
    tmpDirs.push(dir);
    const storage = new InMemoryStorage();
    const { executor } = executorWith(10);
    return { engine: new Engine(storage, loader, executor), storage };
  };

  it("records every shard in the history entry and the ledger line", async () => {
    const { engine, storage } = engineWith({
      f: {
        initial: "run",
        states: {
          run: { type: "exec", command: '[ "$WF_SHARD" != 2/2 ] || exit 5', fanout: { count: 2, threads_each: 1 }, on_success: "ok", on_error: "bad" },
          ok: { terminal: true },
          bad: { terminal: true, outcome: "fail" },
        },
      },
    });
    const { sessionId } = await engine.start("f");
    const s = storage.read(sessionId)!;
    expect(s.outcome).toBe("failed");
    const action = s.history.find(h => h.event === "action")!;
    expect(action.exit_code).toBe(5);
    expect(action.step_key).toMatch(/\|f\|run$/);
    expect(action.shards!.map(x => [x.shard, x.exit_code, x.threads_granted])).toEqual([["1/2", 0, 1], ["2/2", 5, 1]]);
    const line = storage.ledger[0] as { execs: Array<{ shards?: unknown }> };
    expect(line.execs[0].shards).toEqual(action.shards);
  }, 20_000);

  it("on_timeout routes an exec killed by its timeout apart from an ordinary failure", async () => {
    const flow = (command: string) => ({
      initial: "gate",
      states: {
        gate: { type: "exec", command, timeout: 200, on_success: "ok", on_error: "fix", on_timeout: "slow" },
        ok: { terminal: true },
        fix: { terminal: true, outcome: "fail" },
        slow: { prompt: "machine slow", transitions: { done: "ok" } },
      },
    });
    const { engine, storage } = engineWith({ slowGate: flow("sleep 5"), badGate: flow("exit 1"), okGate: flow("true") });
    const slow = await engine.start("slowGate");
    expect(slow.currentStateName).toBe("slow");
    expect(storage.read(slow.sessionId)!.history.find(h => h.event === "action")!.detail).toBe("exit 124 (timeout)");
    await engine.transition(slow.sessionId, "done");
    const bad = await engine.start("badGate");
    expect(storage.read(bad.sessionId)!.history.find(h => h.event === "action")!.to).toBe("fix");
    const ok = await engine.start("okGate");
    expect(storage.read(ok.sessionId)!.history.find(h => h.event === "action")!.to).toBe("ok");
  }, 20_000);

  it("on_timeout wins over cases; a timeout without on_timeout still goes through cases/on_error", async () => {
    const { engine, storage } = engineWith({
      withCases: {
        initial: "g",
        states: {
          g: { type: "exec", command: "sleep 5", timeout: 200, cases: { "0": "ok" }, default: "fix", on_timeout: "slow" },
          ok: { terminal: true }, fix: { terminal: true }, slow: { terminal: true },
        },
      },
      plain: {
        initial: "g",
        states: {
          g: { type: "exec", command: "sleep 5", timeout: 200, on_success: "ok", on_error: "fix" },
          ok: { terminal: true }, fix: { terminal: true },
        },
      },
    });
    const a = await engine.start("withCases");
    expect(storage.read(a.sessionId)!.history.find(h => h.event === "action")!.to).toBe("slow");
    const b = await engine.start("plain");
    expect(storage.read(b.sessionId)!.history.find(h => h.event === "action")!.to).toBe("fix");
  }, 20_000);
});
