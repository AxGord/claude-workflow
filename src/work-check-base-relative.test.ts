import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// ENG-WORK-CHECK-BASE-RELATIVE: engine-task's work_check looks for the CHANGELOG entry in `git diff master..HEAD`,
// the moving master, so a CHANGELOG change another line landed meanwhile counts as this branch's entry.
const here = resolve(__dirname, "..");
const states = (
  parse(readFileSync(join(here, ".claude/workflows/engine-task.yaml"), "utf8")) as {
    states: Record<string, { command: string }>;
  }
).states;

const git = (cwd: string, ...a: string[]) =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t", ...a],
    { cwd, encoding: "utf8" },
  );

// A worktree branched from master with one commit (src/x.ts, no CHANGELOG change), then master moves on:
// another line lands and adds its own CHANGELOG entry.
function movedMaster(withOwnChangelog: boolean) {
  const root = mkdtempSync(join(tmpdir(), "work-base-"));
  const main = join(root, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "master");
  writeFileSync(join(main, "CHANGELOG.md"), "## Unreleased\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "base");
  const wt = join(root, "wt");
  git(main, "worktree", "add", "-q", wt, "-b", "eng/x", "master");
  writeFileSync(join(main, "CHANGELOG.md"), "## Unreleased\n- another line's entry\n");
  git(main, "commit", "-q", "-a", "-m", "another line lands");
  mkdirSync(join(wt, "src"));
  writeFileSync(join(wt, "src/x.ts"), "export const x = 1;\n");
  if (withOwnChangelog) writeFileSync(join(wt, "CHANGELOG.md"), "## Unreleased\n- my entry\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "the change");
  return wt;
}

const run = (wt: string) =>
  spawnSync("sh", ["-c", states.work_check.command], { cwd: wt, encoding: "utf8" });

describe("work_check compares against the worktree's own base", () => {
  it("does not take a CHANGELOG entry another line landed on master for this branch's own", () => {
    const r = run(movedMaster(false));
    expect(r.stdout).toContain("no CHANGELOG.md entry");
    expect(r.status).toBe(3);
  });

  it("accepts a branch that changed CHANGELOG.md itself", () => {
    const r = run(movedMaster(true));
    expect(r.status).toBe(0);
  });
});
