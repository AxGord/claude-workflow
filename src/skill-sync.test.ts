import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = readFileSync(join(__dirname, "..", "scripts", "check-skill-sync.sh"), "utf8");

let tmp: string;
let repo: string;
let live: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
    },
  );

const write = (dir: string, text: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text);
};

const run = (cwd: string): { code: number; out: string } => {
  const r = spawnSync("sh", [join(cwd, "scripts", "check-skill-sync.sh")], {
    env: { PATH: process.env.PATH, HOME: tmp, CLAUDE_SKILLS_DIR: live },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: r.stdout + r.stderr };
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "skill-sync-test-"));
  repo = join(tmp, "repo");
  live = join(tmp, "live");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeFileSync(join(repo, "scripts", "check-skill-sync.sh"), script);
  write(join(repo, "templates", "skills", "a"), "v1\n");
  write(join(live, "a"), "v1\n");
  git(repo, "init", "-q", "-b", "master");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("check-skill-sync.sh", () => {
  it("passes when bundled equals live", () => {
    expect(run(repo).code).toBe(0);
  });

  it("fails on drift in the main checkout", () => {
    write(join(repo, "templates", "skills", "a"), "v2\n");
    const r = run(repo);
    expect(r.code).toBe(1);
    expect(r.out).toContain("DRIFT: a");
  });

  describe("task worktree on an eng/* branch", () => {
    let wt: string;
    beforeEach(() => {
      wt = join(tmp, "wt");
      git(repo, "worktree", "add", "-q", wt, "-b", "eng/x", "master");
    });

    it("accepts a bundled skill ahead of live (live equals master)", () => {
      write(join(wt, "templates", "skills", "a"), "v2\n");
      const r = run(wt);
      expect(r.code).toBe(0);
      expect(r.out).toContain("ahead of live");
    });

    it("still fails when live is ahead of master's bundled", () => {
      write(join(live, "a"), "v3\n");
      write(join(wt, "templates", "skills", "a"), "v2\n");
      expect(run(wt).code).toBe(1);
    });

    it("still fails when live is ahead and the branch is untouched", () => {
      write(join(live, "a"), "v3\n");
      expect(run(wt).code).toBe(1);
    });
  });

  it("does not relax on a linked worktree of another branch name", () => {
    const wt = join(tmp, "wt2");
    git(repo, "worktree", "add", "-q", wt, "-b", "feature/x", "master");
    write(join(wt, "templates", "skills", "a"), "v2\n");
    expect(run(wt).code).toBe(1);
  });
});

describe("sync-live-skills.sh", () => {
  const sync = readFileSync(join(__dirname, "..", "scripts", "sync-live-skills.sh"), "utf8");
  let before: string;

  const land = (): { code: number; out: string } => {
    const merged = git(repo, "rev-parse", "HEAD").trim();
    const r = spawnSync("sh", [join(repo, "scripts", "sync-live-skills.sh"), before, merged], {
      env: { PATH: process.env.PATH, HOME: tmp, CLAUDE_SKILLS_DIR: live },
      encoding: "utf8",
    });
    return { code: r.status ?? -1, out: r.stdout + r.stderr };
  };
  const commit = (): void => {
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "change");
  };
  const read = (dir: string): string => readFileSync(join(dir, "SKILL.md"), "utf8");

  beforeEach(() => {
    writeFileSync(join(repo, "scripts", "sync-live-skills.sh"), sync);
    write(join(repo, "templates", "skills", "b"), "b1\n");
    write(join(live, "b"), "b1\n");
    commit();
    before = git(repo, "rev-parse", "HEAD").trim();
  });

  it("syncs a changed skill, names it, leaves an unchanged one", () => {
    write(join(repo, "templates", "skills", "a"), "v2\n");
    commit();
    const r = land();
    expect(r.code).toBe(0);
    expect(r.out).toContain("synced live skill: a");
    expect(r.out).not.toContain("skill: b");
    expect(read(join(live, "a"))).toBe("v2\n");
    expect(read(join(live, "b"))).toBe("b1\n");
  });

  it("skips a skill listed in .skillsyncignore", () => {
    writeFileSync(join(repo, ".skillsyncignore"), "a\n");
    write(join(repo, "templates", "skills", "a"), "v2\n");
    commit();
    const r = land();
    expect(r.out).not.toContain("synced");
    expect(read(join(live, "a"))).toBe("v1\n");
  });

  it("does not overwrite a live copy edited since the pre-merge state", () => {
    write(join(live, "a"), "mine\n");
    write(join(repo, "templates", "skills", "a"), "v2\n");
    commit();
    const r = land();
    expect(r.code).toBe(0);
    expect(r.out).toContain("WARNING");
    expect(read(join(live, "a"))).toBe("mine\n");
  });

  it("does not delete the live copy of a skill the merge deleted", () => {
    git(repo, "rm", "-rq", "templates/skills/a");
    commit();
    const r = land();
    expect(r.code).toBe(0);
    expect(read(join(live, "a"))).toBe("v1\n");
  });

  it("does nothing without a live skills dir", () => {
    write(join(repo, "templates", "skills", "a"), "v2\n");
    commit();
    rmSync(live, { recursive: true, force: true });
    const r = land();
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });
});
