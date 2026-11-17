import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { ROOT } from "./site-browser-helpers.js";

// ENG-WORKER-NO-SHARED-BROWSER-INSTALL: a worker that ran `npx playwright install chromium` from its worktree replaced
// the browsers in the machine-wide cache that every parallel slice's gate launches from, and a gate went red on a
// missing chromium. The engine-task worker prompt forbids the bare install and prescribes a per-worktree
// PLAYWRIGHT_BROWSERS_PATH; --dry-run prints the directories an install would replace, without touching them.

const shared = path.join(os.homedir(), "Library/Caches/ms-playwright");
const wt = "/tmp/wf-SOME-SLICE";

const workPrompt = (
  parse(readFileSync(path.join(ROOT, ".claude/workflows/engine-task.yaml"), "utf8")) as {
    states: Record<string, { prompt: string }>;
  }
).states.work.prompt;

function installTargets(env: NodeJS.ProcessEnv): string[] {
  const out = execFileSync("npx", ["playwright", "install", "--dry-run", "chromium"], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
  return [...out.matchAll(/Install location:\s+(\S+)/g)].map(m => m[1] ?? "");
}

describe("a worker's playwright install", () => {
  it("the worker prompt forbids a bare install and prescribes a per-worktree browsers path", () => {
    expect(workPrompt).toMatch(/Never run `playwright install`/);
    expect(workPrompt).toMatch(
      /PLAYWRIGHT_BROWSERS_PATH=\{\{context\.wt\}\}-browsers npx playwright install/,
    );
    expect(workPrompt).toMatch(/never write the shared cache/);
  });

  it("the prescribed command targets a directory outside the shared cache the other slices' gates read", () => {
    const m = /PLAYWRIGHT_BROWSERS_PATH=(\S+) npx playwright install/.exec(workPrompt);
    expect(m).not.toBeNull();
    const dir = (m?.[1] ?? "").replace("{{context.wt}}", wt);
    const targets = installTargets({ ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir });
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter(t => path.resolve(t).startsWith(shared + path.sep))).toEqual([]);
    expect(targets.every(t => path.resolve(t).startsWith(dir + path.sep))).toBe(true);
  });
});

// A worker's probe that launched a browser outside a lease and never closed it stayed alive for an hour (ppid 1) and
// WebKit put a window on the desktop. The worker prompt asks for a lease and a finally; work_check lists the orphans.
const workCheck = (
  parse(readFileSync(path.join(ROOT, ".claude/workflows/engine-task.yaml"), "utf8")) as {
    states: Record<string, { command: string }>;
  }
).states.work_check.command;
const hasTools = ["lsof", "pgrep"].every(
  c => spawnSync("sh", ["-c", `command -v ${c}`]).status === 0,
);

describe("a worker's browser launch", () => {
  it("the worker prompt asks for a lease, a finally and no process left in the worktree", () => {
    expect(workPrompt).toMatch(/\{\{context\.cwd\}\}\/scripts\/wf-run --threads 1 -- <cmd>/);
    expect(workPrompt).toMatch(/never a bare `wf-run` off PATH/);
    expect(workPrompt).toMatch(/closes the browser in a `finally`/);
    expect(workPrompt).toMatch(/no process of yours\s+still has the worktree as its cwd/);
  });

  it.skipIf(!hasTools)(
    "work_check refuses a tree where an orphaned process has the worktree as its cwd",
    () => {
      const wt = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wc-orphan-")));
      mkdirSync(path.join(wt, "sub"));
      // Double fork: the sleeper's parent exits at once, so it is reparented to init (ppid 1) with its cwd in the worktree.
      spawnSync("sh", ["-c", `cd '${wt}/sub' && (nohup sleep 300 >/dev/null 2>&1 &)`]);
      const r = spawnSync("sh", ["-c", workCheck], {
        cwd: wt,
        encoding: "utf8",
        env: { ...process.env, TEXT: "", REVIEWED: "" },
      });
      const pids = [...r.stdout.matchAll(/pid (\d+) sleep 300/g)].map(m => Number(m[1]));
      for (const pid of pids) process.kill(pid);
      expect(r.status).toBe(3);
      expect(r.stdout).toMatch(/orphaned process\(es\) with the worktree as cwd/);
      expect(pids.length).toBe(1);
    },
  );
});

// The per-worktree browsers directory is the cleanup exec's to remove, by the exact path its guard already admits.
const cleanup = (
  parse(readFileSync(path.join(ROOT, ".claude/workflows/engine-task.yaml"), "utf8")) as {
    states: Record<string, { command: string }>;
  }
).states.cleanup.command;

describe("the cleanup exec", () => {
  const git = (cwd: string, ...a: string[]) =>
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t", ...a],
      {
        cwd,
        encoding: "utf8",
      },
    );

  it("removes the worktree, its -browsers directory and its branch together", () => {
    const task = `BROWSERS-PIN-${process.pid}`;
    const wt = `/tmp/wf-${task}`;
    const main = mkdtempSync(path.join(os.tmpdir(), "cl-main-"));
    try {
      git(main, "init", "-q", "-b", "master");
      git(main, "commit", "-q", "--allow-empty", "-m", "base");
      git(main, "worktree", "add", "-q", wt, "-b", "eng/x", "master");
      mkdirSync(`${wt}-browsers/chromium-1`, { recursive: true });
      const r = spawnSync("sh", ["-c", cleanup], {
        cwd: main,
        encoding: "utf8",
        env: { ...process.env, TASK: task, WT: wt, BRANCH: "eng/x" },
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(existsSync(wt)).toBe(false);
      expect(existsSync(`${wt}-browsers`)).toBe(false);
    } finally {
      rmSync(`${wt}-browsers`, { recursive: true, force: true });
      rmSync(main, { recursive: true, force: true });
    }
  });
});
