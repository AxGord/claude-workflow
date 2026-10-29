import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import type { StateDefinition } from "./types.js";

// The bundled batch-task's default extension points, run as shell against a real repo. The pool is
// left out (resource stripped) and wf-queue is a stub printing $LAND_TEST: the queue CLI has its own tests.
const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-batch-")));
  dirs.push(d);
  return d;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

function state(name: string, landTest: string, plugin: string): StateDefinition {
  const empty = tmp();
  const def = new Loader(TEMPLATES, empty, null).get("batch-task")!.states[name];
  return {
    ...def,
    resource: undefined,
    env: { ...def.env, WF_PLUGIN_ROOT: plugin, LAND_TEST: landTest },
  };
}

function setup(): { repo: string; plugin: string; vars: Record<string, unknown> } {
  const root = tmp();
  const repo = path.join(root, "proj");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  const plugin = path.join(root, "plugin");
  fs.mkdirSync(path.join(plugin, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(plugin, "scripts", "wf-queue"),
    '#!/bin/sh\nprintf %s "$LAND_TEST"\n',
    {
      mode: 0o755,
    },
  );
  const vars = { context: { task: "T1", cwd: repo, queue_file: path.join(root, "q.md") } };
  return { repo, plugin, vars };
}

describe("batch-task default extension points", () => {
  it("prepare makes the worktree beside the repo; land merges --no-ff and runs land_test", async () => {
    const { repo, plugin, vars } = setup();
    const ex = new Executor();
    const prep = await ex.execute(state("project_prepare", "", plugin), vars, { cwd: repo });
    expect(prep.exit_code).toBe(0);
    const wt = path.join(path.dirname(repo), ".wt", "proj", "T1");
    expect(prep.stdout).toBe(wt);
    fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
    git(wt, "add", ".");
    git(wt, "commit", "-qm", "work");
    const land = await ex.execute(state("project_land", "test -f b.txt", plugin), vars, {
      cwd: repo,
    });
    expect(land.exit_code).toBe(0);
    expect(land.stdout).toMatch(/landed batch\/T1: [0-9a-f]+/);
    expect(git(repo, "log", "-1", "--format=%P").split(" ")).toHaveLength(2);
    const again = await ex.execute(state("project_prepare", "", plugin), vars, { cwd: repo });
    expect(again.stderr).toContain(`kept ${wt}`);
  });

  it("a failed land_test takes the merge back; a dirty repo is refused before any merge", async () => {
    const { repo, plugin, vars } = setup();
    const ex = new Executor();
    const wt = (await ex.execute(state("project_prepare", "", plugin), vars, { cwd: repo })).stdout;
    fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
    git(wt, "add", ".");
    git(wt, "commit", "-qm", "work");
    const head = git(repo, "rev-parse", "HEAD");
    const red = await ex.execute(state("project_land", "echo boom; exit 4", plugin), vars, {
      cwd: repo,
    });
    expect(red.exit_code).toBe(1);
    expect(red.stdout).toContain("boom");
    expect(red.stdout).toContain("land_test failed (exit 4)");
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n");
    const dirty = await ex.execute(state("project_land", "", plugin), vars, { cwd: repo });
    expect(dirty.exit_code).toBe(3);
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
  });
  it("a red land_test keeps an edit made meanwhile; a HEAD moved during the test is never reset (4)", async () => {
    const { repo, plugin, vars } = setup();
    const ex = new Executor();
    const land = (cmd: string) =>
      ex.execute(state("project_land", cmd, plugin), vars, { cwd: repo });
    const wt = (await ex.execute(state("project_prepare", "", plugin), vars, { cwd: repo })).stdout;
    fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
    git(wt, "add", ".");
    git(wt, "commit", "-qm", "work");
    const head = git(repo, "rev-parse", "HEAD");
    const edited = await land("echo mine > a.txt; exit 5");
    expect(edited.exit_code).toBe(1);
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("mine\n");
    git(repo, "checkout", "-q", "--", "a.txt");
    const moved = await land(
      "git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x; exit 1",
    );
    expect(moved.exit_code).toBe(4);
    expect(moved.stdout).toContain("HEAD moved during land_test: nothing taken back");
    expect(git(repo, "log", "-1", "--format=%s")).toBe("x");
    expect(git(repo, "log", "-1", "--format=%s", "HEAD~1")).toMatch(/^Merge branch 'batch\/T1'/);
  });
});
