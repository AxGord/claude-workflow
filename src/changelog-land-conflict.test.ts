import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const root = resolve(__dirname, "..");
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

test("two branches appending a bullet under ## Unreleased rebase without a conflict", () => {
  const d = mkdtempSync(join(tmpdir(), "chlog-"));
  git(d, "init", "-q", "-b", "master");
  if (existsSync(join(root, ".gitattributes")))
    copyFileSync(join(root, ".gitattributes"), join(d, ".gitattributes"));
  writeFileSync(
    join(d, "CHANGELOG.md"),
    "# Changelog\n\n## Unreleased\n\n- old entry\n\n## 1.0.0\n\n- first\n",
  );
  git(d, "add", "-A");
  git(d, "commit", "-qm", "base");
  const add = (b: string, line: string) => {
    git(d, "checkout", "-q", "-b", b, "master");
    const p = join(d, "CHANGELOG.md");
    writeFileSync(
      p,
      readFileSync(p, "utf8").replace("## Unreleased\n\n", `## Unreleased\n\n- ${line}\n`),
    );
    git(d, "commit", "-qam", b);
  };
  add("a", "entry A");
  add("b", "entry B");
  git(d, "checkout", "-q", "master");
  git(d, "merge", "-q", "--ff-only", "a");
  git(d, "checkout", "-q", "b");
  expect(() => git(d, "rebase", "master")).not.toThrow();
});
