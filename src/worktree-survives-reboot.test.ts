import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, trustStoreFor } from "./test-helpers.js";

// ENG-TASK-WORKTREE-SURVIVES-REBOOT: engine-task kept its worktree under /tmp/wf-<TASK>; a reboot wipes /tmp while the
// branch and its commit survive. The worktree now lives beside the repo (<repo>/../.wt/<repo-name>/<TASK>), and a missing
// directory with a surviving branch is re-attached by project_prepare and by the land's rebase. The REAL engine runs the REAL engine-task.yaml over a sandbox repo; the loss is simulated
// by removing the worktree directory (git then lists it prunable). Gates and the land's merge are stubs as in the
// land-rebase-conflict test.
const root = resolve(__dirname, "..");
let seq = 0;

const git = (cwd: string, ...a: string[]) =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t", ...a],
    { cwd, encoding: "utf8" },
  ).trim();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function sandbox() {
  const TASK = `T-REBOOT-${process.pid}-${++seq}`;
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rv-reboot-")));
  dirs.push(base);
  const main = join(base, "main");
  // engine-task keeps the worktree beside the repo, outside /tmp: <repo>/../.wt/<repo-name>/<TASK>.
  const WT = join(base, ".wt", "main", TASK);
  mkdirSync(main);
  git(main, "init", "-q", "-b", "master");
  // The engine's own `git rebase` runs outside this file's -c flags: it needs an identity and no signing from the repo itself.
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  git(main, "config", "commit.gpgsign", "false");
  writeFileSync(join(main, "CHANGELOG.md"), "## Unreleased\n");
  mkdirSync(join(main, "src"));
  writeFileSync(join(main, "src/y.ts"), "const l1 = 1;\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "base");
  mkdirSync(join(base, "batch"));
  const queue = join(base, "batch", "queue.yaml");
  writeFileSync(queue, `  - id: ${TASK}\n    kind: feature\n`);

  const def = parse(readFileSync(join(root, ".claude/workflows/engine-task.yaml"), "utf8")) as {
    states: Record<string, { command?: string; env?: unknown; resource?: unknown }>;
  };
  for (const s of ["project_gate", "project_gate_rebased"]) {
    def.states[s].command = `echo "gate green (stub of npm run check): $(git log --oneline -1)"`;
    delete def.states[s].resource;
  }
  // The land keeps its real "master moved past the branch" exit 5; a rebased branch reaches the stubbed merge (exit 9).
  def.states.project_land.command = [
    `main=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")`,
    `cd "$main" || exit 2`,
    `git merge-base --is-ancestor master "$BRANCH" || { echo "master moved past $BRANCH's base: rebase"; exit 5; }`,
    `echo 'stub: would land'; exit 9`,
  ].join("\n");
  delete def.states.project_land.resource;
  const project = join(base, "project-workflows");
  mkdirSync(project);
  writeFileSync(join(project, "engine-task.yaml"), stringify(def));
  const loader = new Loader(
    join(root, "templates"),
    join(base, "global"),
    project,
    trustStoreFor(join(project, "engine-task.yaml")),
  );

  const engine = new Engine(new InMemoryStorage(), loader, new Executor());
  const first = await engine.start("engine-task", undefined, undefined, main, undefined, {
    task: TASK,
    queue_file: queue,
  });
  const id = first.sessionId;
  const to = (t: string) => engine.transition(id, t);
  const set = (k: string, v: string) => engine.setContext(id, k, v);
  return { to, set, main, WT, TASK, sha: () => git(WT, "rev-parse", "HEAD") };
}

const reboot = (WT: string) => rmSync(WT, { recursive: true, force: true });

describe("engine-task: a worktree wiped by a reboot", () => {
  it("the worktree is placed outside /tmp, beside the repo", async () => {
    const { to, main, WT, TASK } = await sandbox();
    await to("prepare");
    expect(git(main, "worktree", "list", "--porcelain")).toContain(`worktree ${WT}\n`);
    expect(WT).toBe(join(dirname(main), ".wt", basename(main), TASK));
    expect(WT).not.toBe(`/tmp/wf-${TASK}`);
  }, 120000);

  it("project_prepare re-attaches the surviving branch instead of failing on `-b`", async () => {
    const { to, main, WT, TASK } = await sandbox();
    await to("prepare");
    writeFileSync(join(WT, "src/y.ts"), "const l1 = 11;\n");
    git(WT, "add", ".");
    git(WT, "commit", "-q", "-m", "the change");
    const committed = git(WT, "rev-parse", "HEAD");
    reboot(WT);
    expect(git(main, "worktree", "list", "--porcelain")).toContain("prunable");
    const def = parse(readFileSync(join(root, ".claude/workflows/engine-task.yaml"), "utf8")) as {
      states: Record<string, { command: string }>;
    };
    const r = spawnSync("sh", ["-c", def.states.project_prepare.command], {
      cwd: main,
      encoding: "utf8",
      env: { ...process.env, TASK },
    });
    expect(r.stderr, `exit ${r.status}`).not.toContain("already exists");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(WT);
    expect(git(WT, "rev-parse", "HEAD")).toBe(committed);
    expect(git(main, "worktree", "list", "--porcelain")).not.toContain("prunable");
    expect(r.stderr).toContain("re-attached");
  }, 120000);

  it("a land whose worktree is gone is not read as a rebase conflict", async () => {
    const { to, set, main, WT, sha } = await sandbox();
    await to("prepare");
    writeFileSync(join(WT, "src/y.ts"), "const l1 = 11;\n");
    writeFileSync(join(WT, "CHANGELOG.md"), "## Unreleased\n- slice\n");
    git(WT, "add", ".");
    git(WT, "commit", "-q", "-m", "the change");
    await set("worker_agent", "w1");
    await to("check");
    await set("reviewer_agent", "r1");
    await set("reviewed_sha", sha());
    await set("review_text", "MERGE");
    // Master moves on a file the slice leaves alone: the rebase itself is clean once the worktree is back.
    writeFileSync(join(main, "README.md"), "master\n");
    git(main, "add", "README.md");
    git(main, "commit", "-q", "-m", "master moves 1");
    reboot(WT);
    const s = await to("filed");
    const path = s.history.map(h => h.to);
    expect(path, JSON.stringify(path)).not.toContain("rebase_conflict");
    expect(path).not.toContain("rebase_fix");
    // The missing worktree is told apart (exit 6), re-attached, and the rebase then runs: the rebased branch reaches the gate and the land.
    expect(path.indexOf("project_rebase")).toBeLessThan(path.indexOf("rebase_reattach"));
    expect(path.lastIndexOf("project_rebase"), JSON.stringify(path)).toBeGreaterThan(
      path.indexOf("rebase_reattach"),
    );
    expect(path).toContain("project_gate_rebased");
    expect(git(WT, "merge-base", "--is-ancestor", "master", "HEAD")).toBe("");
  }, 120000);

  it("a worktree that stays missing leaves the reattach loop for land_failed", async () => {
    const { to, set, main, WT, sha } = await sandbox();
    await to("prepare");
    writeFileSync(join(WT, "src/y.ts"), "const l1 = 11;\n");
    writeFileSync(join(WT, "CHANGELOG.md"), "## Unreleased\n- slice\n");
    git(WT, "add", ".");
    git(WT, "commit", "-q", "-m", "the change");
    await set("worker_agent", "w1");
    await to("check");
    await set("reviewer_agent", "r1");
    await set("reviewed_sha", sha());
    await set("review_text", "MERGE");
    // Master moves on a file the slice leaves alone: the rebase itself is clean once the worktree is back.
    writeFileSync(join(main, "README.md"), "master\n");
    git(main, "add", "README.md");
    git(main, "commit", "-q", "-m", "master moves 1");
    const branch = git(WT, "symbolic-ref", "--short", "HEAD");
    reboot(WT);
    // The branch is checked out in a live worktree elsewhere: the re-attach is refused, and the route must not loop.
    git(main, "worktree", "prune");
    git(main, "worktree", "add", "-q", `${WT}-elsewhere`, branch);
    const s = await to("filed");
    const path = s.history.map(h => h.to);
    expect(path, JSON.stringify(path)).toContain("rebase_reattach");
    expect(path).not.toContain("rebase_conflict");
    expect(path[path.length - 1]).toBe("land_failed");
  }, 120000);

  it("a missing worktree AND a missing branch is exit 7 to land_failed, never a new empty branch", async () => {
    const { to, set, main, WT, sha } = await sandbox();
    await to("prepare");
    writeFileSync(join(WT, "src/y.ts"), "const l1 = 11;\n");
    writeFileSync(join(WT, "CHANGELOG.md"), "## Unreleased\n- slice\n");
    git(WT, "add", ".");
    git(WT, "commit", "-q", "-m", "the change");
    await set("worker_agent", "w1");
    await to("check");
    await set("reviewer_agent", "r1");
    await set("reviewed_sha", sha());
    await set("review_text", "MERGE");
    writeFileSync(join(main, "README.md"), "master\n");
    git(main, "add", "README.md");
    git(main, "commit", "-q", "-m", "master moves 1");
    const branch = git(WT, "symbolic-ref", "--short", "HEAD");
    reboot(WT);
    git(main, "worktree", "prune");
    git(main, "branch", "-D", branch);
    const s = await to("filed");
    const path = s.history.map(h => h.to);
    expect(path, JSON.stringify(path)).not.toContain("rebase_reattach");
    expect(path[path.length - 1]).toBe("land_failed");
    expect(() => git(main, "rev-parse", "--verify", `refs/heads/${branch}`)).toThrow();
  }, 120000);
});
