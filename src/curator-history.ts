// The curator's shadow history: every edit it makes to a target directory (a memory dir, a skills dir) is one
// commit in a git directory of the engine's own state, used with `--work-tree=<target>`. The target never gets a
// `.git` (a user may keep ~/.claude in a dotfiles repo, and a plugin's skills are not the user's to version), and
// each edit keeps a diff, a log line and a revert of its own.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { projectDirName, stateDir } from "./curator.js";

/** The shadow git directory of one target. */
export function historyGitDir(target: string, dir: string = stateDir()): string {
  return path.join(dir, "curator-history", `${projectDirName(path.resolve(target))}.git`);
}

function git(target: string, dir: string, args: readonly string[]): string {
  return execFileSync(
    "git",
    [
      `--git-dir=${historyGitDir(target, dir)}`,
      `--work-tree=${path.resolve(target)}`,
      "-c",
      "user.name=wf-curator",
      "-c",
      "user.email=wf-curator@localhost",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: path.resolve(target), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function ensure(target: string, dir: string): void {
  if (fs.existsSync(path.join(historyGitDir(target, dir), "HEAD"))) return;
  fs.mkdirSync(path.dirname(historyGitDir(target, dir)), { recursive: true });
  git(target, dir, ["init", "-q"]);
}

/** Paths of a target as git takes them: relative to the target, refused when outside it. */
function relative(target: string, files: readonly string[]): string[] {
  const root = path.resolve(target);
  return files.map(f => {
    const rel = path.relative(root, path.resolve(root, f));
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
      throw new Error(`${f} is not inside ${root}`);
    return rel;
  });
}

/** Commit what `files` hold now (deleted ones included); null when they match the last commit. */
function commitFiles(
  target: string,
  dir: string,
  files: readonly string[],
  message: string,
): string | null {
  // a path that neither exists nor is tracked (a file the edit is about to create) has nothing to stage yet
  const tracked = new Set(git(target, dir, ["ls-files"]).split("\n"));
  const rel = relative(target, files).filter(
    f => tracked.has(f) || fs.existsSync(path.join(path.resolve(target), f)),
  );
  if (rel.length === 0) return null;
  git(target, dir, ["add", "-A", "--", ...rel]);
  const staged = git(target, dir, ["diff", "--cached", "--name-only"]);
  if (staged === "") return null;
  git(target, dir, ["commit", "-q", "-m", message]);
  return git(target, dir, ["rev-parse", "HEAD"]);
}

/**
 * One edit of `files` in `target` as one commit: their state before `edit` is committed first (a baseline, when it
 * differs from the history), then `edit` runs and what it left is the edit's commit. Returns that commit (null when
 * the edit changed nothing).
 */
export function historyEdit(
  target: string,
  files: readonly string[],
  message: string,
  edit: () => void,
  dir: string = stateDir(),
): string | null {
  ensure(target, dir);
  commitFiles(target, dir, files, "baseline: the files as found before the next edit");
  edit();
  return commitFiles(target, dir, files, message);
}

/** The history of a target, newest first: `<sha> <subject>` per commit; empty before the first edit. */
export function historyLog(target: string, dir: string = stateDir()): string {
  if (!fs.existsSync(path.join(historyGitDir(target, dir), "HEAD"))) return "";
  try {
    return git(target, dir, ["log", "--format=%H %s"]);
  } catch {
    return "";
  }
}

/** One commit's patch. */
export function historyDiff(target: string, rev: string, dir: string = stateDir()): string {
  return git(target, dir, ["show", "--format=%H %s%n%n%b", rev]);
}

/** The files (relative to the target) one commit touched. */
export function historyFiles(target: string, rev: string, dir: string = stateDir()): string[] {
  const sha = git(target, dir, ["rev-parse", "--verify", `${rev}^{commit}`]);
  return git(target, dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha])
    .split("\n")
    .filter(f => f !== "");
}

/**
 * Undo one commit in the target (the others stay): the files it touched are first committed as found (a later hand
 * edit is kept in the history), then the reverse of that commit alone is applied. A revert whose lines were changed
 * since fails and leaves the target as it was.
 */
export function historyRevert(target: string, rev: string, dir: string = stateDir()): string {
  const sha = git(target, dir, ["rev-parse", "--verify", `${rev}^{commit}`]);
  const files = historyFiles(target, sha, dir);
  commitFiles(target, dir, files, "baseline: the files as found before a revert");
  try {
    git(target, dir, ["revert", "--no-edit", sha]);
  } catch (err) {
    try {
      git(target, dir, ["revert", "--abort"]);
    } catch {
      // nothing to abort
    }
    throw new Error(
      `revert of ${sha.slice(0, 12)} in ${target} refused: ${(err as Error).message}`,
    );
  }
  return git(target, dir, ["rev-parse", "HEAD"]);
}
