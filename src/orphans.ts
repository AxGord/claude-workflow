#!/usr/bin/env node
// wf-orphans: which processes are still alive inside a worktree? One lister for every task flow's check
// or report state (a server, a watcher, a test runner, a detached `nohup` command a worker left behind),
// so no flow writes its own. A process is listed when its working directory is the worktree or below it,
// or its command line names a path inside it. It only reads: nothing is signalled, nothing is killed.
//   wf-orphans <worktree>
// The caller's own chain is never listed: this process, its ancestors (the exec's shell, the engine, a
// worker's shell) and what it spawned to read the process table.
// Exit: 0 nothing alive there · 1 at least one process (one `pid N cwd|cmd <command>` line each) · 2 usage.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ORPHANS_USAGE = "usage: wf-orphans <worktree>";

/** One row of the process table. */
export interface ProcRow {
  readonly pid: number;
  readonly ppid: number;
  /** The `ps` state letters; a `Z` is a process that has already ended and only awaits its parent. */
  readonly stat: string;
  readonly command: string;
}

/** A process found inside the worktree and why. */
export interface Orphan {
  readonly pid: number;
  readonly by: "cwd" | "cmd";
  readonly command: string;
}

const PATH_CHAR = "A-Za-z0-9._~-";

/** `root` as a whole path inside `command`: not the tail of a longer path, not the prefix of a sibling (`<root>-x`). */
function namesPath(command: string, root: string): boolean {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![/${PATH_CHAR}])${escaped}(?![${PATH_CHAR}])`).test(command);
}

function inside(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(`${root}/`);
}

/** The pids of `self`, its ancestors and everything below it in the table. */
function ownChain(table: readonly ProcRow[], self: number): Set<number> {
  const parent = new Map(table.map(r => [r.pid, r.ppid]));
  const skip = new Set<number>([self]);
  for (let p = parent.get(self); p !== undefined && p > 0 && !skip.has(p); p = parent.get(p))
    skip.add(p);
  for (const r of table) {
    for (let p: number | undefined = r.pid, n = 0; p !== undefined && p > 0 && n < 64; n++) {
      if (p === self) {
        skip.add(r.pid);
        break;
      }
      p = parent.get(p);
    }
  }
  return skip;
}

/**
 * The processes of `table` inside `roots` (the worktree as given and as the filesystem resolves it), by their
 * working directory (`cwdOf`) or their command line. Pure: the table and the cwd map are the caller's reading.
 */
export function selectOrphans(
  table: readonly ProcRow[],
  cwdOf: ReadonlyMap<number, string>,
  roots: readonly string[],
  self: number,
): Orphan[] {
  const skip = ownChain(table, self);
  const found: Orphan[] = [];
  for (const row of table) {
    if (skip.has(row.pid) || row.stat.startsWith("Z")) continue;
    const cwd = cwdOf.get(row.pid);
    if (cwd !== undefined && roots.some(r => inside(cwd, r)))
      found.push({ pid: row.pid, by: "cwd", command: row.command });
    else if (roots.some(r => namesPath(row.command, r)))
      found.push({ pid: row.pid, by: "cmd", command: row.command });
  }
  return found;
}

/** `ps -axww -o pid=,ppid=,stat=,command=`: the same columns on macOS and Linux. */
export function parseTable(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m !== null)
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3] ?? "", command: m[4] ?? "" });
  }
  return rows;
}

/** `lsof -Fpn` output (`p<pid>` then `n<path>`): the working directory of each pid. */
export function parseLsofCwd(text: string): Map<number, string> {
  const map = new Map<number, string>();
  let pid: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined && !map.has(pid))
      map.set(pid, line.slice(1));
  }
  return map;
}

function readTable(): ProcRow[] {
  const r = spawnSync("ps", ["-axww", "-o", "pid=,ppid=,stat=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error !== undefined || r.status !== 0)
    throw new Error(`ps failed: ${r.error?.message ?? r.stderr}`);
  return parseTable(r.stdout);
}

/** The working directory of every pid: `/proc/<pid>/cwd` where there is a /proc (Linux), else one `lsof` pass (macOS). */
function readCwds(pids: readonly number[]): Map<number, string> {
  const map = new Map<number, string>();
  if (fs.existsSync("/proc/self/cwd")) {
    for (const pid of pids) {
      try {
        map.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        // gone, or another user's: not readable, not listed by its cwd
      }
    }
    return map;
  }
  const r = spawnSync("lsof", ["-a", "-d", "cwd", "-Fpn"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error !== undefined) throw new Error(`lsof failed: ${r.error.message}`);
  return parseLsofCwd(r.stdout);
}

/** The processes alive inside `worktree` now, reading the machine's process table. */
export function listOrphans(worktree: string, self: number = process.pid): Orphan[] {
  const given = path.resolve(worktree);
  let real = given;
  try {
    real = fs.realpathSync(given);
  } catch {
    // a worktree already removed: nothing can have it as cwd, a command line may still name it
  }
  const table = readTable();
  return selectOrphans(table, readCwds(table.map(r => r.pid)), [...new Set([real, given])], self);
}

export interface OrphansResult {
  readonly lines: readonly string[];
  readonly code: 0 | 1 | 2;
}

/** What `wf-orphans <args>` prints and exits with. */
export function runOrphans(args: readonly string[], self: number = process.pid): OrphansResult {
  if (args.includes("-h") || args.includes("--help")) return { lines: [ORPHANS_USAGE], code: 0 };
  const flag = args.find(a => a.startsWith("-"));
  if (flag !== undefined) return { lines: [`unknown argument ${flag}`, ORPHANS_USAGE], code: 2 };
  if (args.length !== 1 || args[0] === undefined) return { lines: [ORPHANS_USAGE], code: 2 };
  if (!fs.statSync(args[0], { throwIfNoEntry: false })?.isDirectory())
    return { lines: [`not a directory: ${args[0]}`, ORPHANS_USAGE], code: 2 };
  const found = listOrphans(args[0], self);
  return {
    lines: found.map(o => `pid ${o.pid} ${o.by} ${o.command.slice(0, 160)}`),
    code: found.length > 0 ? 1 : 0,
  };
}

if (
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const r = runOrphans(process.argv.slice(2));
    if (r.lines.length > 0)
      (r.code === 2 ? process.stderr : process.stdout).write(`${r.lines.join("\n")}\n`);
    process.exitCode = r.code;
  } catch (err) {
    process.stderr.write(`wf-orphans: ${(err as Error).message}\n`);
    process.exitCode = 2;
  }
}
