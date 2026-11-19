import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ENG-TESTS-NO-REPO-HISTORY-GUARD: CI checks out with depth 1, where a read of THIS repo's history
// (a pinned commit, `git log`, `git show <sha>:<path>`) returns nothing, while every local run has the
// whole history and stays green. A test that needs a commit builds its own scratch repo or keeps a fixture.
const SRC = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

/** The git subcommands that read history (the ones a depth-1 clone answers differently). */
const HISTORY = [
  "log",
  "show",
  "rev-list",
  "rev-parse",
  "cat-file",
  "describe",
  "blame",
  "diff",
  "merge-base",
  "ls-tree",
  "tag",
  "archive",
  "show-ref",
  "for-each-ref",
  "shortlog",
  "reflog",
  "branch",
];

/** What a test file reads of this repo's history, one finding per read; a scratch repo's commits are not this. */
function repoHistoryReads(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\b[0-9a-f]{40}\b/g)) found.push(`a pinned commit ${m[0]}`);
  const historyWord = `["'\`](?:${HISTORY.join("|")})["'\`]`;
  // A git call is on THIS repo when its statement names the root (`ROOT`, the process's cwd) or sets
  // no directory at all (no `cwd`, no `-C`: it runs in the process's cwd, the repo root under vitest).
  const rooted = (statement: string): boolean =>
    /\bROOT\b|process\.cwd\(\)/.test(statement) ||
    !(/\bcwd\b/.test(statement) || /["'`]-C["'`]/.test(statement));
  const calls = /\b(?:execFileSync|execSync|spawnSync|spawnChild)\(\s*["'`]git["'`],[^;]*/gs;
  for (const m of text.matchAll(calls)) {
    if (!rooted(m[0])) continue;
    const hit = new RegExp(historyWord).exec(m[0]);
    if (hit) found.push(`git ${hit[0]} at the repo root`);
    // a helper bound to the root (`const git = (...args) => execFileSync("git", args, { cwd: ROOT })`)
    const helper = /(?:const|let)\s+(\w+)\s*=\s*\([^)]*\)\s*(?::[^=]+)?=>\s*$/.exec(
      text.slice(Math.max(0, m.index - 120), m.index),
    );
    if (helper && new RegExp(`\\b${helper[1]}\\(\\s*${historyWord}`).test(text))
      found.push(`git ${helper[1]}(<history read>) through a helper bound to the repo root`);
  }
  // the one-string form: execSync("git log -1")
  const strings = new RegExp(
    `\\b(?:execSync|spawnSync)\\(\\s*["'\`]git (?:${HISTORY.join("|")})\\b[^;]*`,
    "gs",
  );
  for (const m of text.matchAll(strings))
    if (rooted(m[0]))
      found.push(`${m[0].slice(m[0].indexOf("git"), m[0].indexOf("git") + 12)} at the repo root`);
  return found;
}

describe("a test does not read this repo's git history", () => {
  it("no test file pins a commit or runs a history read at the repo root", () => {
    const files = fs.readdirSync(SRC).filter(f => f.endsWith(".test.ts") && f !== SELF);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.flatMap(f =>
      repoHistoryReads(fs.readFileSync(path.join(SRC, f), "utf8")).map(r => `${f}: ${r}`),
    );
    expect(offenders).toEqual([]);
  });

  it("the scan finds a pinned commit and a history read at the repo root", () => {
    const sha = "ea3bcf4".padEnd(40, "0");
    expect(repoHistoryReads(`const base = "${sha}";`)).toHaveLength(1);
    expect(
      repoHistoryReads(
        `execFileSync("git", ["show", "HEAD:README.md"], { cwd: ROOT, encoding: "utf8" });`,
      ),
    ).toHaveLength(1);
  });

  it("the scan counts a git call with no cwd and no -C as a call on the repo root", () => {
    expect(
      repoHistoryReads(`execFileSync("git", ["log", "-1"], { encoding: "utf8" });`),
    ).toHaveLength(1);
    expect(repoHistoryReads(`execFileSync("git", ["log", "-1"]);`)).toHaveLength(1);
  });

  it("the scan finds the one-string form of a history read", () => {
    expect(repoHistoryReads(`execSync("git log -1", { encoding: "utf8" });`)).toHaveLength(1);
    expect(repoHistoryReads(`execSync("git log -1", { cwd: repo });`)).toEqual([]);
    expect(repoHistoryReads(`execSync("git status", { encoding: "utf8" });`)).toEqual([]);
  });

  it("the scan follows a git helper bound to the repo root", () => {
    const helper = `const git = (...args: string[]): string =>\n  execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });\n`;
    expect(repoHistoryReads(`${helper}git("log", "-1");`)).toHaveLength(1);
    expect(repoHistoryReads(`${helper}git("ls-files", "a");`)).toEqual([]);
  });

  it("the scan lets a scratch repo's history and a tree-only read of the repo pass", () => {
    expect(
      repoHistoryReads(`execFileSync("git", ["-C", repo, "log", "-1"], { encoding: "utf8" });`),
    ).toEqual([]);
    expect(
      repoHistoryReads(
        `execFileSync("git", ["ls-files", "docs/x.json"], { cwd: ROOT, encoding: "utf8" });`,
      ),
    ).toEqual([]);
    expect(repoHistoryReads(`const digest = "${"a".repeat(64)}";`)).toEqual([]);
  });
});
