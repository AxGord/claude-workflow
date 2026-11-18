import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnChild } from "./test-helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// CI checks out with actions/checkout's default depth of 1. A test that reads a commit, tag or path
// of THIS repo's history passes on a developer machine (the history is whole) and fails only on CI.
describe("CI checks out with depth 1, so a test must not need this repo's history", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** The tree as it stands now (tracked and not ignored, so an uncommitted change is in it), as the single commit of a fresh repo: what a depth-1 clone of it holds. */
  function singleCommitCopy(): string {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wf-shallow-"));
    dirs.push(scratch);
    const copy = path.join(scratch, "clone");
    const listed = spawnChild(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: ROOT,
        maxBuffer: 1 << 28,
        timeout: 60_000,
      },
    );
    expect(listed.status, listed.stderr).toBe(0);
    for (const rel of listed.stdout.split("\0").filter(Boolean)) {
      const from = path.join(ROOT, rel);
      if (!fs.existsSync(from)) continue; // tracked, deleted in the tree
      fs.mkdirSync(path.dirname(path.join(copy, rel)), { recursive: true });
      fs.cpSync(from, path.join(copy, rel), { verbatimSymlinks: true });
    }
    const inCopy = (...a: string[]) =>
      spawnChild(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a],
        { cwd: copy, timeout: 60_000 },
      );
    expect(inCopy("init", "-q").status).toBe(0);
    expect(inCopy("add", "-A").status).toBe(0);
    const c = inCopy("commit", "-q", "-m", "snapshot");
    expect(c.status, c.stderr).toBe(0);
    expect(inCopy("rev-list", "--count", "HEAD").stdout.trim()).toBe("1");
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(copy, "node_modules"));
    return copy;
  }

  it("src/skill-rename-workflow-authoring.test.ts passes in a depth-1 clone", () => {
    const clone = singleCommitCopy();
    // one worker, and a timeout below the test's own, so a hung child fails with its own output
    const r = spawnChild(
      path.join(clone, "node_modules", ".bin", "vitest"),
      ["run", "--maxWorkers=1", "src/skill-rename-workflow-authoring.test.ts"],
      { cwd: clone, env: { ...process.env, CI: "1" }, timeout: 150_000 },
    );
    expect(r.stdout + r.stderr).not.toContain("AssertionError");
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 170_000);
});
