import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scripts = join(__dirname, "..", "scripts");

let tmp: string;
let repo: string;
let live: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

const put = (cwd: string, rel: string, text: string): void => {
  mkdirSync(join(cwd, rel, ".."), { recursive: true });
  writeFileSync(join(cwd, rel), text);
};

// `git commit` through the REAL hook, exactly as the engine's checkout installs it.
const commit = (
  cwd: string,
  args: string[] = [],
  env: Record<string, string> = {},
): { code: number; out: string } => {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "x",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: tmp, CLAUDE_SKILLS_DIR: live, ...env },
    },
  );
  return { code: r.status ?? -1, out: r.stdout + r.stderr };
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "commit-scope-test-"));
  repo = join(tmp, "repo");
  live = join(tmp, "live");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  for (const f of ["check-commit-scope.sh", "check-skill-sync.sh", "pre-commit.sh"]) {
    copyFileSync(join(scripts, f), join(repo, "scripts", f));
  }
  put(repo, "templates/skills/a/SKILL.md", "v1\n");
  put(live, "a/SKILL.md", "v1\n");
  put(repo, "docs/decisions.md", "one\n");
  put(repo, "src/a.ts", "1\n");
  git(repo, "init", "-q", "-b", "master");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  // the stub docs/development.md gives, installed in the repo's hooks directory
  const hook = join(repo, ".git", "hooks", "pre-commit");
  writeFileSync(
    hook,
    '#!/bin/sh\nroot="$(git rev-parse --show-toplevel)"\n' +
      '[ -f "$root/scripts/pre-commit.sh" ] && exec sh "$root/scripts/pre-commit.sh"\n' +
      'exec sh "$root/scripts/check-skill-sync.sh"\n',
  );
  chmodSync(hook, 0o755);
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("pre-commit commit scope on the main checkout", () => {
  it("lets a docs/decisions.md line through", () => {
    put(repo, "docs/decisions.md", "one\ntwo\n");
    git(repo, "add", "docs/decisions.md");
    expect(commit(repo).code).toBe(0);
  });

  it("refuses a source edit, names the file and the queue tool", () => {
    put(repo, "src/a.ts", "2\n");
    git(repo, "add", "src/a.ts");
    const r = commit(repo);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("REFUSED");
    expect(r.out).toContain("src/a.ts");
    expect(r.out).toContain("queue_add");
  });

  it("refuses a decisions line that travels with another file", () => {
    put(repo, "docs/decisions.md", "one\ntwo\n");
    put(repo, "docs/other.md", "x\n");
    git(repo, "add", "-A");
    const r = commit(repo);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("docs/other.md");
    expect(r.out).not.toMatch(/^ {4}docs\/decisions\.md$/m);
  });

  it("refuses a bundled-skill edit made by hand", () => {
    put(repo, "templates/skills/a/SKILL.md", "v2\n");
    put(live, "a/SKILL.md", "v2\n");
    git(repo, "add", "-A");
    const r = commit(repo);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("templates/skills/a/SKILL.md");
  });

  it("refuses `commit -a` of a tracked file", () => {
    put(repo, "src/a.ts", "2\n");
    expect(commit(repo, ["-a"]).code).not.toBe(0);
  });

  it("refuses a new file, a deletion and a rename", () => {
    put(repo, "src/new.ts", "n\n");
    git(repo, "add", "src/new.ts");
    expect(commit(repo).code).not.toBe(0);
    git(repo, "reset", "-q");
    git(repo, "rm", "-q", "src/a.ts");
    expect(commit(repo).code).not.toBe(0);
    git(repo, "reset", "-q", "--hard");
    git(repo, "mv", "src/a.ts", "docs/decisions-moved.md");
    expect(commit(repo).code).not.toBe(0);
  });

  it("lets the user's own commit through with WF_ENGINE_USER_COMMIT", () => {
    put(repo, "src/a.ts", "2\n");
    git(repo, "add", "src/a.ts");
    expect(commit(repo, [], { WF_ENGINE_USER_COMMIT: "1" }).code).toBe(0);
  });

  it("lets the merge of a branch through", () => {
    git(repo, "checkout", "-q", "-b", "side");
    put(repo, "src/b.ts", "b\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "side", "--no-verify");
    git(repo, "checkout", "-q", "master");
    put(repo, "docs/decisions.md", "one\nm\n");
    git(repo, "add", "-A");
    expect(commit(repo).code).toBe(0);
    git(repo, "merge", "--no-commit", "--no-ff", "-q", "side");
    expect(commit(repo).code).toBe(0);
  });

  it("never refuses the land: a fast-forward makes no commit", () => {
    git(repo, "checkout", "-q", "-b", "eng/x");
    put(repo, "src/b.ts", "b\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "w", "--no-verify");
    git(repo, "checkout", "-q", "master");
    expect(git(repo, "merge", "--ff-only", "-q", "eng/x")).toBe("");
    expect(git(repo, "rev-parse", "master")).toBe(git(repo, "rev-parse", "eng/x"));
  });

  it("lets a task worktree commit its work", () => {
    const wt = join(tmp, "wt");
    git(repo, "worktree", "add", "-q", wt, "-b", "eng/x", "master");
    put(wt, "src/a.ts", "2\n");
    git(wt, "add", "src/a.ts");
    expect(commit(wt).code).toBe(0);
  });
});

describe("pre-commit skill sync", () => {
  beforeEach(() => {
    // the live copy moved on; the bundled one lags it
    put(live, "a/SKILL.md", "v2\n");
  });

  it("only warns when the commit touches no skill", () => {
    put(repo, "docs/decisions.md", "one\ntwo\n");
    git(repo, "add", "-A");
    const r = commit(repo);
    expect(r.code).toBe(0);
    expect(r.out).toContain("WARNING");
    expect(r.out).toContain("DRIFT: a");
  });

  it("blocks a commit that touches a skill", () => {
    const wt = join(tmp, "wt");
    git(repo, "worktree", "add", "-q", wt, "-b", "eng/x", "master");
    put(wt, "templates/skills/a/SKILL.md", "v3\n");
    git(wt, "add", "-A");
    const r = commit(wt);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("DRIFT: a");
  });

  it("falls back to the drift check when scripts/pre-commit.sh is absent (an older base)", () => {
    rmSync(join(repo, "scripts", "pre-commit.sh"));
    put(repo, "docs/decisions.md", "one\ntwo\n");
    git(repo, "add", "-A");
    const r = commit(repo);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("DRIFT: a");
  });
});
