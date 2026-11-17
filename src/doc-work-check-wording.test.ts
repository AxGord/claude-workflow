import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// ENG-DOC-WORK-CHECK-WORDING: docs/development.md says work_check lists "a bug branch's changes", but
// work_check runs on every engine-task branch whatever its kind; only repro_route / repro_check are bug-only.
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

// A branch that is not a bug fix: its queue line carries no `kind: bug` (nothing here marks one at all).
function featureBranch() {
  const root = mkdtempSync(join(tmpdir(), "doc-wc-"));
  const main = join(root, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "master");
  writeFileSync(join(main, "CHANGELOG.md"), "## Unreleased\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "base");
  const wt = join(root, "wt");
  git(main, "worktree", "add", "-q", wt, "-b", "eng/feature", "master");
  mkdirSync(join(wt, "src"));
  writeFileSync(join(wt, "src/x.ts"), "export const x = 1;\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "a feature, no CHANGELOG entry");
  return wt;
}

describe("docs/development.md on the engine-task checks", () => {
  it("does not tie work_check to a bug branch when work_check runs on a non-bug branch", () => {
    const r = spawnSync("sh", ["-c", states.work_check.command], {
      cwd: featureBranch(),
      encoding: "utf8",
    });
    // work_check ran its CHANGELOG check on a branch that is not a bug fix
    expect(r.stdout).toContain("no CHANGELOG.md entry");

    const doc = readFileSync(join(here, "docs/development.md"), "utf8");
    const sentence = doc
      .split("\n")
      .flatMap(l => l.split(/(?<=\.)\s+/))
      .find(s => s.includes("`work_check`"));
    expect(sentence, "development.md names work_check").toBeDefined();
    expect(sentence).not.toMatch(/bug branch/);
  });
});
