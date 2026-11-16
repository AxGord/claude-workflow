import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { Loader } from "./loader.js";

const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    cwd,
    encoding: "utf8",
  }).trim();

it("cleanup removes the branch when its worktree directory is already gone (prunable)", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-cleanup-")));
  dirs.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const wt = path.join(root, "wt", "T1");
  git(repo, "worktree", "add", "-q", wt, "-b", "batch/T1", "HEAD");
  fs.rmSync(wt, { recursive: true, force: true }); // a reboot wiped it
  const def = new Loader(TEMPLATES, fs.mkdtempSync(path.join(root, "e")), null).get("batch-task")!
    .states.cleanup;
  const r = spawnSync("sh", ["-c", def.command as string], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, TASK: "T1", WT: wt },
  });
  expect(r.stdout + r.stderr).not.toContain("cannot delete branch");
  expect(r.status).toBe(0);
  expect(git(repo, "branch", "--list", "batch/T1")).toBe("");
});
