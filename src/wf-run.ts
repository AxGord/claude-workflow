#!/usr/bin/env node
// wf-run: run a heavy command under a lease from the machine-wide thread pool.
//   wf-run [--threads N|budget|MIN-MAX [--wait-full SEC]] [--lock NAME]… [--priority P] [--wait-timeout SEC] [--label TEXT] [--efficiency] -- <cmd> [args…]
//   wf-run --status
// The child gets WF_THREADS = the threads granted (absent for a lock-only or --efficiency run)
// and WF_PRIORITY = this run's priority. Without --priority it is WF_PRIORITY from the environment
// (a session exec's), and the run keeps WF_PRIORITY_LEVEL so `set_priority` can re-rank it.
import { spawn } from "node:child_process";
import os from "node:os";
import { EX_TEMPFAIL, Pool, describeRequest, describeWait, formatStatus, resolvePoolDir } from "./pool.js";
import { killProcessGroup } from "./process.js";
import { LOCK_NAME_PATTERN, PriorityLevelSchema, RESOURCE_THREADS_BUDGET, type PriorityLevel } from "./types.js";

const USAGE = "usage: wf-run [--threads N|budget|MIN-MAX [--wait-full SEC]] [--lock NAME]… [--priority P] [--wait-timeout SEC] [--label TEXT] [--efficiency] -- <cmd> [args…]\n"
  + "       wf-run --status";
const EX_USAGE = 64;
const EX_NOEXEC = 126;
const EX_NOTFOUND = 127;
const LABEL_MAX = 80;
const FORWARDED: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

type ThreadCount = number | typeof RESOURCE_THREADS_BUDGET;

interface Options {
  readonly status: boolean;
  /** The threads asked for; a `MIN-MAX` range: its max. */
  readonly threads: ThreadCount;
  readonly minThreads?: number;
  readonly waitFullSec?: number;
  readonly locks: readonly string[];
  readonly priority: number;
  /** The session level the priority came with (only when it came from WF_PRIORITY). */
  readonly level?: PriorityLevel;
  readonly waitTimeoutSec?: number;
  readonly label?: string;
  readonly efficiency: boolean;
  readonly command: readonly string[];
}

function parseArgs(argv: readonly string[]): Options {
  let status = false;
  let efficiency = false;
  // Default: 1 thread, none beside a --lock (a lock-only lease).
  let threads: ThreadCount | undefined;
  let minThreads: number | undefined;
  let waitFullSec: number | undefined;
  const locks: string[] = [];
  let priority: number | undefined;
  let waitTimeoutSec: number | undefined;
  let label: string | undefined;
  let i = 0;
  const value = (flag: string, inline: string | undefined): string => {
    if (inline !== undefined) return inline;
    const v = argv[++i];
    if (v === undefined) throw new Error(`${flag} needs a value`);
    return v;
  };
  const integer = (flag: string, v: string, min: number): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new Error(`${flag}: expected an integer >= ${min}, got "${v}"`);
    return n;
  };
  const count = (flag: string, v: string): ThreadCount => (v === RESOURCE_THREADS_BUDGET ? v : integer(flag, v, 1));
  const seconds = (flag: string, v: string): number => {
    const n = Number(v);
    if (!(n >= 0)) throw new Error(`${flag}: expected seconds >= 0, got "${v}"`);
    return n;
  };
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { i++; break; }
    if (!arg.startsWith("--")) break;
    const eq = arg.indexOf("=");
    const flag = eq < 0 ? arg : arg.slice(0, eq);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    switch (flag) {
      case "--status": status = true; break;
      case "--efficiency": efficiency = true; break;
      case "--threads": {
        const v = value(flag, inline);
        const range = /^([^-]+)-([^-]+)$/.exec(v);
        threads = count(flag, range ? range[2] : v);
        minThreads = range ? integer(flag, range[1], 1) : undefined;
        if (minThreads !== undefined && typeof threads === "number" && minThreads > threads)
          throw new Error(`${flag}: the min ${minThreads} exceeds the max ${threads}`);
        break;
      }
      case "--wait-full": waitFullSec = seconds(flag, value(flag, inline)); break;
      case "--lock": {
        const v = value(flag, inline);
        if (!LOCK_NAME_PATTERN.test(v)) throw new Error(`${flag}: a lock name is one word without whitespace, got "${v}"`);
        locks.push(v);
        break;
      }
      case "--priority": priority = integer(flag, value(flag, inline), -Infinity); break;
      case "--label": label = value(flag, inline); break;
      case "--wait-timeout": waitTimeoutSec = seconds(flag, value(flag, inline)); break;
      default: throw new Error(`unknown option ${flag}`);
    }
  }
  const command = argv.slice(i);
  if (!status && command.length === 0) throw new Error("no command given");
  if (waitFullSec !== undefined && minThreads === undefined) throw new Error("--wait-full needs --threads MIN-MAX");
  // A session exec's own priority (its level's plus its step's) is the default.
  const inherited = priority === undefined ? fromEnvironment() : undefined;
  return {
    status,
    threads: threads ?? (locks.length > 0 ? 0 : 1),
    minThreads,
    waitFullSec,
    locks,
    priority: priority ?? inherited?.priority ?? 0,
    level: inherited?.level,
    waitTimeoutSec,
    label,
    efficiency,
    command,
  };
}

/** WF_PRIORITY (and WF_PRIORITY_LEVEL) of the environment; a malformed value counts as absent. */
function fromEnvironment(): { priority: number; level?: PriorityLevel } | undefined {
  const priority = Number(process.env.WF_PRIORITY);
  if (process.env.WF_PRIORITY === undefined || process.env.WF_PRIORITY === "" || !Number.isInteger(priority)) return undefined;
  const level = PriorityLevelSchema.safeParse(process.env.WF_PRIORITY_LEVEL);
  return { priority, ...(level.success ? { level: level.data } : {}) };
}

/**
 * Run the child in its own process group, forwarding signals to the group;
 * resolves its exit code. `onSpawn` gets the group id once the child exists.
 * WF_THREADS describes this run's own lease: `threads` when it has threads,
 * never one inherited from an outer lease; WF_PRIORITY is this run's priority.
 */
function run(
  cmd: string,
  args: readonly string[],
  opts: Pick<Options, "priority" | "level">,
  threads?: number,
  onSpawn?: (pgid: number) => Promise<void>,
): Promise<number> {
  const { WF_THREADS: _threads, WF_PRIORITY: _priority, WF_PRIORITY_LEVEL: _level, ...env } = process.env;
  if (threads !== undefined && threads > 0) env.WF_THREADS = String(threads);
  env.WF_PRIORITY = String(opts.priority);
  if (opts.level) env.WF_PRIORITY_LEVEL = opts.level;
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: "inherit", detached: true, env });
    if (child.pid && onSpawn) {
      onSpawn(child.pid).catch(err => process.stderr.write(`wf-run: could not record the process group: ${(err as Error).message}\n`));
    }
    const forward = (signal: NodeJS.Signals): void => {
      if (child.pid) killProcessGroup(child.pid, signal);
    };
    for (const s of FORWARDED) process.on(s, forward);
    const done = (code: number): void => {
      for (const s of FORWARDED) process.off(s, forward);
      resolve(code);
    };
    child.on("error", err => {
      process.stderr.write(`wf-run: ${cmd}: ${err.message}\n`);
      done((err as NodeJS.ErrnoException).code === "ENOENT" ? EX_NOTFOUND : EX_NOEXEC);
    });
    child.on("exit", (code, signal) => done(code ?? 128 + (signal ? os.constants.signals[signal] : 0)));
  });
}

async function main(argv: readonly string[]): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`wf-run: ${(err as Error).message}\n${USAGE}\n`);
    return EX_USAGE;
  }
  const pool = new Pool(resolvePoolDir());
  if (opts.status) {
    process.stdout.write(formatStatus(await pool.measuredStatus(), pool.dir) + "\n");
    return 0;
  }
  let [cmd, ...args] = opts.command;
  // Background QoS: efficiency cores, lowest priority — outside the budget, but its locks still hold.
  const efficient = opts.efficiency && process.platform === "darwin";
  if (opts.efficiency && !efficient)
    process.stderr.write(`wf-run: --efficiency needs macOS (taskpolicy); running through the pool instead\n`);
  if (efficient) {
    args = ["-b", cmd, ...args];
    cmd = "taskpolicy";
    if (opts.locks.length === 0) return run(cmd, args, opts);
  }

  // A signal while waiting withdraws from the queue and exits as that signal would.
  const ac = new AbortController();
  let caught: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    caught = signal;
    ac.abort();
  };
  for (const s of FORWARDED) process.on(s, onSignal);
  const threads = efficient ? 0 : opts.threads === RESOURCE_THREADS_BUDGET ? pool.config().budget : opts.threads;
  // A max the budget clamps below the min still runs: the min clamps with it.
  const minThreads = efficient || opts.minThreads === undefined ? undefined : Math.min(opts.minThreads, threads);
  const result = await pool.acquire(
    {
      threads,
      minThreads,
      waitFullMs: minThreads === undefined || opts.waitFullSec === undefined ? undefined : opts.waitFullSec * 1000,
      locks: opts.locks,
      priority: opts.priority,
      level: opts.level,
      label: opts.label ?? opts.command.join(" ").slice(0, LABEL_MAX),
      cwd: process.cwd(),
      sessionId: process.env.WF_SESSION_ID,
    },
    {
      waitTimeoutMs: opts.waitTimeoutSec === undefined ? undefined : opts.waitTimeoutSec * 1000,
      signal: ac.signal,
      onProgress: (self, view) => process.stderr.write(describeWait(self, view) + "\n"),
    },
  ).finally(() => {
    for (const s of FORWARDED) process.off(s, onSignal);
  });

  if (result.status !== "granted") {
    if (result.status === "aborted") return 128 + (caught ? os.constants.signals[caught] : 0);
    const { view } = result;
    process.stderr.write(
      `wf-run: busy — ${describeRequest({ threads, min_threads: minThreads, locks: opts.locks }, view.budget)} not free within ${opts.waitTimeoutSec}s `
      + `(held ${view.held}/${view.budget}, external ${view.external.toFixed(1)})\n`,
    );
    return EX_TEMPFAIL;
  }
  try {
    // A SIGKILLed wf-run cannot release: the child's group keeps the lease alive while it runs.
    return await run(cmd, args, opts, result.lease.threads, pgid => result.lease.attach(pgid));
  } finally {
    await result.lease.release();
  }
}

main(process.argv.slice(2)).then(
  code => { process.exitCode = code; },
  err => {
    process.stderr.write(`wf-run: ${(err as Error).message}\n`);
    process.exitCode = 1;
  },
);
