// ENG-PUBLISH-RETRY-IDEMPOTENT: a re-run of the publish job must make the SAME release commit, so the
// tag step can be a no-op when the tag already names it. scripts/release-tree.sh --commit takes author,
// committer and dates from the environment (git config, the clock), so two runs differ.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function releaseCommit(env: Record<string, string>): string {
  return execFileSync(
    "sh",
    ["scripts/release-tree.sh", "--commit", "--rev", "HEAD", "--message", "m"],
    {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();
}

describe("release-tree.sh --commit determinism", () => {
  it("two runs with different clocks and identities make the same commit id", () => {
    const a = releaseCommit({
      GIT_AUTHOR_NAME: "run one",
      GIT_AUTHOR_EMAIL: "one@example.com",
      GIT_COMMITTER_NAME: "run one",
      GIT_COMMITTER_EMAIL: "one@example.com",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    });
    const b = releaseCommit({
      GIT_AUTHOR_NAME: "run two",
      GIT_AUTHOR_EMAIL: "two@example.com",
      GIT_COMMITTER_NAME: "run two",
      GIT_COMMITTER_EMAIL: "two@example.com",
      GIT_AUTHOR_DATE: "2026-02-02T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-02-02T00:00:00Z",
    });
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(b).toBe(a);
  }, 120_000);
});
