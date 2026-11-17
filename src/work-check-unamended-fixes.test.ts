import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { render } from "./template.js";

// ENG-WORK-CHECK-REFUSES-UNAMENDED-AFTER-FIXES: after a review FIXES the driver took `check` at `work` without
// sending the list to the worker; work_check passed on the unchanged commit (HEAD == reviewed_sha).
const here = resolve(__dirname, "..");
const state = (
  parse(readFileSync(join(here, ".claude/workflows/engine-task.yaml"), "utf8")) as {
    states: Record<string, { command: string; env?: Record<string, string> }>;
  }
).states.work_check;

const git = (cwd: string, ...a: string[]) =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t", ...a],
    { cwd, encoding: "utf8" },
  ).trim();

// A ready branch: one commit over master with a CHANGELOG entry, clean tree.
function readyBranch() {
  const root = mkdtempSync(join(tmpdir(), "wc-unamended-"));
  const main = join(root, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "master");
  writeFileSync(join(main, "CHANGELOG.md"), "## Unreleased\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "base");
  const wt = join(root, "wt");
  git(main, "worktree", "add", "-q", wt, "-b", "eng/x", "master");
  mkdirSync(join(wt, "src"));
  writeFileSync(join(wt, "src/x.ts"), "export const x = 1;\n");
  writeFileSync(join(wt, "CHANGELOG.md"), "## Unreleased\n- my entry\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "the change");
  return wt;
}

// Runs work_check as the engine would: command and env rendered from the session context.
function run(wt: string, ctx: { review_text: string; reviewed_sha: string }) {
  const vars = { context: { ...ctx, wt } };
  const env = Object.fromEntries(
    Object.entries(state.env ?? {}).map(([k, v]) => [k, render(v, vars)]),
  );
  return spawnSync("sh", ["-c", render(state.command, vars)], {
    cwd: wt,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const FIXES = "1. the CHANGELOG line is wrong.\nFIXES:\n1. fix the thing";

describe("work_check after a review FIXES round", () => {
  it("refuses a tree still at the reviewed commit when the review ended in FIXES", () => {
    const wt = readyBranch();
    const r = run(wt, { review_text: FIXES, reviewed_sha: git(wt, "rev-parse", "HEAD") });
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/FIXES|worker/);
  });

  it("prints the review's list itself, because work_unready forwards only stdout", () => {
    const wt = readyBranch();
    const r = run(wt, { review_text: FIXES, reviewed_sha: git(wt, "rev-parse", "HEAD") });
    expect(r.stdout).toContain("1. fix the thing");
    expect(r.stdout).toContain("1. the CHANGELOG line is wrong.");
  });

  it.each(["Verdict: FIXES", "**FIXES:**", "needs work"])(
    "refuses at the reviewed commit on a non-canonical verdict line (%s)",
    verdict => {
      const wt = readyBranch();
      const text = `1. fix the thing\n${verdict}`;
      const r = run(wt, { review_text: text, reviewed_sha: git(wt, "rev-parse", "HEAD") });
      expect(r.status).toBe(3);
      expect(r.stdout).toContain("1. fix the thing");
    },
  );

  it("accepts a first round with no review text yet", () => {
    const wt = readyBranch();
    expect(run(wt, { review_text: "", reviewed_sha: "" }).status).toBe(0);
  });

  it("accepts a tree amended since the reviewed commit", () => {
    const wt = readyBranch();
    const reviewed = git(wt, "rev-parse", "HEAD");
    writeFileSync(join(wt, "src/x.ts"), "export const x = 2;\n");
    git(wt, "commit", "-q", "-a", "--amend", "--no-edit");
    expect(run(wt, { review_text: FIXES, reviewed_sha: reviewed }).status).toBe(0);
  });

  it("accepts the reviewed commit when the review ended in MERGE", () => {
    const wt = readyBranch();
    const r = run(wt, {
      review_text: "all good\nMERGE",
      reviewed_sha: git(wt, "rev-parse", "HEAD"),
    });
    expect(r.status).toBe(0);
  });

  it("the work prompt sends the cause to the worker before any check", () => {
    const prompt = (
      parse(readFileSync(join(here, ".claude/workflows/engine-task.yaml"), "utf8")) as {
        states: Record<string, { prompt: string }>;
      }
    ).states.work.prompt;
    expect(prompt).toMatch(/BEFORE anything else/);
    expect(prompt).toMatch(/Never `check` on entering this state/);
  });
});
