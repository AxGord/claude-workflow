import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { render } from "./template.js";

// ENG-UNAMENDED-FIXES-GUARD-FOLLOWUPS: (1) engine-task's work_check refusal prints the review through
// `head -c 8000`, but the FIXES list is at the END of the review, so a long review loses it; (2) the bundled
// templates/batch-task.yaml work_check passes a branch the worker never amended after a review FIXES.
const here = resolve(__dirname, "..");
type St = { command: string; env?: Record<string, string> };
const load = (file: string) =>
  (parse(readFileSync(join(here, file), "utf8")) as { states: Record<string, St> }).states
    .work_check;

const git = (cwd: string, ...a: string[]) =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t", ...a],
    { cwd, encoding: "utf8" },
  ).trim();

function run(state: St, cwd: string, ctx: Record<string, string>) {
  const vars = { context: ctx };
  const env = Object.fromEntries(
    Object.entries(state.env ?? {}).map(([k, v]) => [k, render(v, vars)]),
  );
  return spawnSync("sh", ["-c", render(state.command, vars)], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, WF_PLUGIN_ROOT: here, ...env },
  });
}

describe("engine-task work_check: a long review", () => {
  it("still prints the FIXES list at the end of a review over 8000 bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-long-"));
    const main = join(root, "main");
    mkdirSync(main);
    git(main, "init", "-q", "-b", "master");
    writeFileSync(join(main, "CHANGELOG.md"), "## Unreleased\n");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "base");
    const wt = join(root, "wt");
    git(main, "worktree", "add", "-q", wt, "-b", "eng/x", "master");
    writeFileSync(join(wt, "CHANGELOG.md"), "## Unreleased\n- entry\n");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "the change");
    const review = `${"reasoning line of the review.\n".repeat(400)}FIXES:\n1. LAST-ITEM-OF-THE-LIST`;
    expect(review.length).toBeGreaterThan(8000);
    const r = run(load(".claude/workflows/engine-task.yaml"), wt, {
      wt,
      review_text: review,
      reviewed_sha: git(wt, "rev-parse", "HEAD"),
    });
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("LAST-ITEM-OF-THE-LIST");
  });
});

describe("batch-task work_check: unamended after FIXES", () => {
  it("refuses a branch still at the reviewed commit when the review ended in FIXES", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-batch-"));
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "master");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    const wt = join(root, "wt");
    git(repo, "worktree", "add", "-q", wt, "-b", "batch/T1", "master");
    writeFileSync(join(wt, "b.txt"), "b\n");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "the change");
    // The same context keys engine-task uses for the review round.
    const r = run(load("templates/batch-task.yaml"), repo, {
      task: "T1",
      wt,
      review_text: "1. fix the thing\nFIXES:\n1. fix the thing",
      reviewed_sha: git(wt, "rev-parse", "HEAD"),
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("1. fix the thing");
  });
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "wc-batch2-"));
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "master");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    const wt = join(root, "wt");
    git(repo, "worktree", "add", "-q", wt, "-b", "batch/T1", "master");
    writeFileSync(join(wt, "b.txt"), "b\n");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "the change");
    return { repo, wt };
  };

  it("accepts the amended branch, a MERGE verdict and a first round without a review", () => {
    const { repo, wt } = setup();
    const reviewed = git(wt, "rev-parse", "HEAD");
    const review_text = "VERDICT FIXES fix the thing review=/tmp/x/review.md design=no";
    writeFileSync(join(wt, "b.txt"), "bb\n");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "--amend", "-m", "the change");
    const state = load("templates/batch-task.yaml");
    expect(run(state, repo, { task: "T1", wt, review_text, reviewed_sha: reviewed }).status).toBe(
      0,
    );
    const tip = git(wt, "rev-parse", "HEAD");
    const merge = { task: "T1", wt, review_text: "VERDICT MERGE ok", reviewed_sha: tip };
    expect(run(state, repo, merge).status).toBe(0);
    expect(run(state, repo, { task: "T1", wt }).status).toBe(0);
  });

  it("the driver prompts record reviewed_sha and review_text, and a fix round never checks on entering", () => {
    const text = readFileSync(join(here, "templates/batch-task.yaml"), "utf8");
    expect(text).toContain("context_set `reviewed_sha` = the sha of the worker's latest DONE");
    expect(text).toContain("context_set `review_text` = its one-line handback verbatim");
    expect(text).toContain("never `check` on entering this state");
  });
});

describe("work_check: an abbreviated reviewed_sha", () => {
  it("engine-task refuses a branch at the reviewed commit named by its short sha", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-short-e-"));
    const main = join(root, "main");
    mkdirSync(main);
    git(main, "init", "-q", "-b", "master");
    writeFileSync(join(main, "CHANGELOG.md"), "## Unreleased\n");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "base");
    const wt = join(root, "wt");
    git(main, "worktree", "add", "-q", wt, "-b", "eng/x", "master");
    writeFileSync(join(wt, "CHANGELOG.md"), "## Unreleased\n- entry\n");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "the change");
    const short = git(wt, "rev-parse", "--short", "HEAD");
    expect(short.length).toBeLessThan(40);
    const r = run(load(".claude/workflows/engine-task.yaml"), wt, {
      wt,
      review_text: "FIXES:\n1. SHORT-SHA-ITEM",
      reviewed_sha: short,
    });
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("SHORT-SHA-ITEM");
  });

  it("batch-task refuses a branch at the reviewed commit named by its short sha", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-short-b-"));
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "master");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    const wt = join(root, "wt");
    git(repo, "worktree", "add", "-q", wt, "-b", "batch/T1", "master");
    writeFileSync(join(wt, "b.txt"), "b\n");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "the change");
    const r = run(load("templates/batch-task.yaml"), repo, {
      task: "T1",
      wt,
      review_text: "FIXES:\n1. SHORT-SHA-ITEM",
      reviewed_sha: git(wt, "rev-parse", "--short", "HEAD"),
    });
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("SHORT-SHA-ITEM");
  });
});
