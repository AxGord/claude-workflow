#!/usr/bin/env node
// wf-run: run a heavy command under a lease from the machine-wide thread pool.
//   wf-run [--threads N] [--priority P] [--wait-timeout SEC] [--label TEXT] [--efficiency] -- <cmd> [args…]
//   wf-run --status
import { spawn } from "node:child_process";
import os from "node:os";
import { EX_TEMPFAIL, Pool, describeWait, effectiveThreads, formatStatus, resolvePoolDir } from "./pool.js";
import { killProcessGroup } from "./process.js";

const USAGE = "usage: wf-run [--threads N] [--priority P] [--wait-timeout SEC] [--label TEXT] [--efficiency] -- <cmd> [args…]\n"
  + "       wf-run --status";
const EX_USAGE = 64;
const EX_NOEXEC = 126;
const EX_NOTFOUND = 127;
const LABEL_MAX = 80;
const STATUS_WINDOW_MS = 600;
const FORWARDED: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

interface Options {
  readonly status: boolean;
  readonly threads: number;
  readonly priority: number;
  readonly waitTimeoutSec?: number;
  readonly label?: string;
  readonly efficiency: boolean;
  readonly command: readonly string[];
}

function parseArgs(argv: readonly string[]): Options {
  let status = false;
  let efficiency = false;
  let threads = 1;
  let priority = 0;
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
      case "--threads": threads = integer(flag, value(flag, inline), 1); break;
      case "--priority": priority = integer(flag, value(flag, inline), -Infinity); break;
      case "--label": label = value(flag, inline); break;
      case "--wait-timeout": {
        const v = value(flag, inline);
        waitTimeoutSec = Number(v);
        if (!(waitTimeoutSec >= 0)) throw new Error(`${flag}: expected seconds >= 0, got "${v}"`);
        break;
      }
      default: throw new Error(`unknown option ${flag}`);
    }
  }
  const command = argv.slice(i);
  if (!status && command.length === 0) throw new Error("no command given");
  return { status, threads, priority, waitTimeoutSec, label, efficiency, command };
}

/**
 * Run the child in its own process group, forwarding signals to the group;
 * resolves its exit code. `onSpawn` gets the group id once the child exists.
 */
function run(cmd: string, args: readonly string[], onSpawn?: (pgid: number) => Promise<void>): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: "inherit", detached: true });
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
    // The first pass only starts the cpu tick window the second one measures.
    await pool.status();
    await new Promise(r => setTimeout(r, STATUS_WINDOW_MS));
    process.stdout.write(formatStatus(await pool.status(), pool.dir) + "\n");
    return 0;
  }
  const [cmd, ...args] = opts.command;
  if (opts.efficiency) {
    // Background QoS: efficiency cores, lowest priority — outside the budget.
    if (process.platform === "darwin") return run("taskpolicy", ["-b", cmd, ...args]);
    process.stderr.write(`wf-run: --efficiency needs macOS (taskpolicy); running through the pool instead\n`);
  }

  // A signal while waiting withdraws from the queue and exits as that signal would.
  const ac = new AbortController();
  let caught: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    caught = signal;
    ac.abort();
  };
  for (const s of FORWARDED) process.on(s, onSignal);
  const result = await pool.acquire(
    {
      threads: opts.threads,
      priority: opts.priority,
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
      `wf-run: busy — ${effectiveThreads(opts, view.budget)} threads not free within ${opts.waitTimeoutSec}s `
      + `(held ${view.held}/${view.budget}, external ${view.external.toFixed(1)})\n`,
    );
    return EX_TEMPFAIL;
  }
  try {
    // A SIGKILLed wf-run cannot release: the child's group keeps the lease alive while it runs.
    return await run(cmd, args, pgid => result.lease.attach(pgid));
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
