import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listOrphans,
  parseLsofCwd,
  parseTable,
  runOrphans,
  selectOrphans,
  type ProcRow,
} from "./orphans.js";
import { cleanupDir } from "./test-helpers.js";

// ENG-WF-ORPHANS-CLI: one lister of the processes still alive inside a worktree, for every flow's check state.

const dirs: string[] = [];
const sleepers: number[] = [];
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-orphans-")));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const pid of sleepers.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const row = (pid: number, ppid: number, command: string, stat = "S"): ProcRow => ({
  pid,
  ppid,
  stat,
  command,
});

/**
 * A detached sleeper: its launcher exits at once, so it is reparented to init and is no descendant of this process.
 * `argv0` goes to the shell's `$0`, which puts a path on the command line of a sleeper whose cwd is elsewhere.
 */
function sleeper(cwd: string, argv0 = "x"): number {
  const scratch = tmp();
  const pidFile = path.join(scratch, "pids");
  const script = path.join(scratch, "hold.sh");
  fs.writeFileSync(
    script,
    `sleep 300 &\necho $$ $! > '${pidFile}.tmp'\nmv '${pidFile}.tmp' '${pidFile}'\nwait\n`,
  );
  spawnSync("sh", ["-c", `(nohup sh '${script}' '${argv0}' >/dev/null 2>&1 </dev/null &)`], {
    cwd,
  });
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) spawnSync("sleep", ["0.05"]);
  const [shell, sleep] = fs.readFileSync(pidFile, "utf8").trim().split(" ").map(Number);
  if (shell === undefined || sleep === undefined) throw new Error("the sleeper did not start");
  sleepers.push(shell, sleep);
  return sleep;
}

describe("selectOrphans (a process table and a cwd map in, no machine)", () => {
  const WT = "/w/ENG-X";
  const table = [
    row(1, 0, "init"),
    row(10, 1, "claude"),
    row(20, 10, "sh check.sh"),
    row(30, 20, "node wf-orphans.js"),
    row(31, 30, "ps -axww"),
    row(40, 1, "node server.js"),
    row(41, 1, "vite --root /w/ENG-X/app"),
    row(42, 1, "tail -f /w/ENG-X-browsers/log"),
    row(43, 1, "tail -f /w/ENG-X.log/L.log"),
    row(44, 1, "cat /other/w/ENG-X/f"),
    row(45, 1, "[sleep]", "Z"),
    row(46, 1, "node /w/ENG-X"),
  ];
  const cwds = new Map<number, string>([
    [20, "/w/ENG-X"],
    [30, "/w/ENG-X"],
    [31, "/w/ENG-X"],
    [40, "/w/ENG-X/sub"],
    [42, "/w/ENG-X-browsers"],
    [45, "/w/ENG-X"],
  ]);

  it("lists a process by its cwd below the worktree and by a path on its command line", () => {
    const found = selectOrphans(table, cwds, [WT], 30);
    expect(found.map(o => [o.pid, o.by])).toEqual([
      [40, "cwd"],
      [41, "cmd"],
      [46, "cmd"],
    ]);
  });

  it("never lists the caller, its ancestors or what it spawned, though they stand in the worktree", () => {
    const pids = selectOrphans(table, cwds, [WT], 30).map(o => o.pid);
    for (const own of [10, 20, 30, 31]) expect(pids).not.toContain(own);
  });

  it("does not take a sibling directory (-browsers, .log), a longer path or an ended process for the worktree", () => {
    const pids = selectOrphans(table, cwds, [WT], 30).map(o => o.pid);
    for (const other of [42, 43, 44, 45]) expect(pids).not.toContain(other);
  });

  it("names the worktree by every root it is given (the path and its real path)", () => {
    const found = selectOrphans(
      [row(1, 0, "init"), row(5, 1, "tail /private/w/ENG-X/log")],
      new Map(),
      [WT, "/private/w/ENG-X"],
      99,
    );
    expect(found.map(o => o.pid)).toEqual([5]);
  });
});

describe("the process readers", () => {
  it("parses a ps table, a command with spaces kept whole", () => {
    expect(parseTable("  12     1 Ss   /bin/sh -c sleep 3\n 345   12 R+   ps -axww\n\n")).toEqual([
      { pid: 12, ppid: 1, stat: "Ss", command: "/bin/sh -c sleep 3" },
      { pid: 345, ppid: 12, stat: "R+", command: "ps -axww" },
    ]);
  });

  it("parses lsof -Fpn: the first n line of a pid is its cwd", () => {
    expect([...parseLsofCwd("p12\nn/a/b\np34\nn/c\nn/d\n")]).toEqual([
      [12, "/a/b"],
      [34, "/c"],
    ]);
  });
});

describe("wf-orphans on this machine", () => {
  it("lists a detached process whose cwd is in the worktree, and not one that has none there", () => {
    const wt = tmp();
    fs.mkdirSync(path.join(wt, "sub"));
    const elsewhere = tmp();
    const inCwd = sleeper(path.join(wt, "sub"));
    const away = sleeper(elsewhere);
    const found = listOrphans(wt);
    const mine = found.find(o => o.pid === inCwd);
    expect(mine?.by).toBe("cwd");
    expect(found.some(o => o.pid === away)).toBe(false);
  });

  it("lists a process whose command line names a path in the worktree", () => {
    const wt = tmp();
    const named = sleeper(tmp(), path.join(wt, "dist", "server.js"));
    const found = listOrphans(wt);
    expect(found.find(o => o.command.includes(path.join(wt, "dist", "server.js")))?.by).toBe("cmd");
    expect(named).toBeGreaterThan(0);
  });

  it("does not list a process of a sibling directory that shares the worktree's name as a prefix", () => {
    const wt = tmp();
    const sibling = `${wt}-browsers`;
    fs.mkdirSync(sibling);
    dirs.push(sibling);
    const pid = sleeper(sibling);
    expect(listOrphans(wt).some(o => o.pid === pid)).toBe(false);
  });

  it("finds nothing in a quiet worktree, and CLI exits 0 then 1 as a sleeper starts", () => {
    const wt = tmp();
    expect(runOrphans([wt])).toEqual({ lines: [], code: 0 });
    const pid = sleeper(wt);
    const r = runOrphans([wt]);
    expect(r.code).toBe(1);
    expect(r.lines.some(l => l.startsWith(`pid ${pid} cwd `))).toBe(true);
  });

  it("reads through a symlinked path: a worktree given by a link finds the cwd of the real path", () => {
    const wt = tmp();
    const link = path.join(tmp(), "link");
    fs.symlinkSync(wt, link);
    const pid = sleeper(wt);
    expect(listOrphans(link).some(o => o.pid === pid)).toBe(true);
  });

  it("refuses a missing directory and a bad argument with exit 2", () => {
    expect(runOrphans([path.join(tmp(), "nope")]).code).toBe(2);
    expect(runOrphans([]).code).toBe(2);
    expect(runOrphans(["--nope"]).code).toBe(2);
    expect(runOrphans(["--help"]).code).toBe(0);
  });
});
