import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// ENG-REPRO-CHECK-BASE-RELATIVE: engine-task's repro_check / repro_route diff against the MOVING master,
// so a line landing on master during the reproduce step reads as "files differ from master".
const here = resolve(__dirname, "..");
// The workflow is a TRACKED file of this repo (`.claude/workflows/engine-task.yaml`, un-ignored by .gitignore), so a slice's worktree can change it.
const yamlPath = join(here, ".claude/workflows/engine-task.yaml");
const states = (
  parse(readFileSync(yamlPath, "utf8")) as { states: Record<string, { command: string }> }
).states;

const git = (cwd: string, ...a: string[]) =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t", ...a],
    { cwd, encoding: "utf8" },
  );

// A worktree branched from master, then master moves on (another line lands, changing src/landed.ts).
function movedMaster() {
  const root = mkdtempSync(join(tmpdir(), "repro-base-"));
  const main = join(root, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "master");
  writeFileSync(join(main, "a.ts"), "export const a = 1;\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "base");
  const wt = join(root, "wt");
  git(main, "worktree", "add", "-q", wt, "-b", "eng/x", "master");
  mkdirSync(join(main, "src"));
  writeFileSync(join(main, "src/landed.ts"), "export const landed = 1;\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "another line lands");
  const logs = `${wt}-logs`;
  mkdirSync(logs);
  writeFileSync(
    join(logs, "repro.txt"),
    "untestable: the check stops before it runs a test\nout\n",
  );
  mkdirSync(join(wt, "src"));
  writeFileSync(join(wt, "src/x.test.ts"), "// the reproducer's only change\n");
  // repro_check keeps repro.txt at dirname(QUEUE)/../backups/slice-logs/T: inside this temp root.
  mkdirSync(join(root, "batch"));
  const queue = join(root, "batch", "queue.yaml");
  writeFileSync(queue, "  - id: T\n    kind: bug\n");
  return { wt, queue, root };
}

const run = (cmd: string, wt: string, queue: string) =>
  spawnSync("sh", ["-c", cmd], {
    cwd: wt,
    encoding: "utf8",
    env: { ...process.env, TASK: "T", QUEUE: queue, WT: wt, REPRO_TEST: "src/x.test.ts" },
  });

describe("repro check compares against the worktree's own base", () => {
  it("repro_check does not blame the worktree for what landed on master meanwhile", () => {
    const { wt, queue, root } = movedMaster();
    const r = run(states.repro_check.command, wt, queue);
    expect(existsSync(join(root, "backups/slice-logs/T/repro.txt"))).toBe(true);
    expect(r.stdout).not.toContain("files differ from");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("UNTESTABLE");
  });

  it("repro_check still refuses a source file the worktree itself changed", () => {
    const { wt, queue } = movedMaster();
    writeFileSync(join(wt, "src/own.ts"), "export const own = 1;\n");
    const r = run(states.repro_check.command, wt, queue);
    expect(r.status).toBe(12);
    expect(r.stdout).toContain("src/own.ts");
    expect(r.stdout).not.toContain("src/landed.ts");
  });

  it("repro_route does not record a skipped reproduction for what landed on master meanwhile", () => {
    const { wt, queue } = movedMaster();
    const r = run(states.repro_route.command, wt, queue);
    expect(existsSync(`${wt}-logs/repro-verdict.txt`)).toBe(false);
    expect(r.status).toBe(10);
  });

  it("repro_route still records a skipped reproduction when the branch changed source itself", () => {
    const { wt, queue } = movedMaster();
    writeFileSync(join(wt, "src/own.ts"), "export const own = 1;\n");
    const r = run(states.repro_route.command, wt, queue);
    expect(r.status).toBe(0);
    expect(readFileSync(`${wt}-logs/repro-verdict.txt`, "utf8")).toContain("src/own.ts");
    expect(readFileSync(`${wt}-logs/repro-verdict.txt`, "utf8")).not.toContain("src/landed.ts");
  });

  it("the workflow and pool-gate files are not ignored, and the rest of .claude/ stays ignored", () => {
    const listed = (p: string) =>
      git(here, "ls-files", "--cached", "--others", "--exclude-standard", "--", p).trim();
    for (const rel of [".claude/workflows/engine-task.yaml", ".claude/workflows/pool-gate.yaml"])
      expect(listed(rel)).toBe(rel);
    for (const other of [
      ".claude/batch/queue.yaml",
      ".claude/workflows/other.yaml",
      ".claude/settings.local.json",
    ])
      expect(() => git(here, "check-ignore", "-q", "--no-index", other), other).not.toThrow();
  });
});
