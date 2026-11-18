import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, trustStoreFor } from "./test-helpers.js";

// ENG-REVIEW-VISITS-VERIFY-ONLY-FIX: in engine-task, a fix round whose tree differs from the reviewed commit only in
// prose (a verify-only FIXES item answered by a record, or a rebase_fix that kept only the conflicted hunk)
// still enters `review` once its max_visits is spent, and the engine reroutes it to `blocked`.
// The REAL engine runs the REAL engine-task.yaml over a sandbox git repo; only the three commands that would run the
// whole suite or merge into a live checkout (the two gates, the land) are replaced by stubs that keep their routes.
const root = resolve(__dirname, "..");
// One task id (so one /tmp/wf-<id> worktree) per sandbox: the git-no-sign guard runs this file in a child while the
// outer run holds its own, and project_prepare makes the worktree at a path fixed by the id.
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

async function sandbox(queueExtra = "") {
  const TASK = `T-VISITS-${process.pid}-${++seq}`;
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rv-visits-")));
  dirs.push(base);
  const main = join(base, "main");
  // engine-task keeps the worktree beside the repo, outside /tmp: <repo>/../.wt/<repo-name>/<TASK>.
  const WT = join(base, ".wt", "main", TASK);
  mkdirSync(main);
  git(main, "init", "-q", "-b", "master");
  writeFileSync(join(main, "CHANGELOG.md"), "## Unreleased\n");
  mkdirSync(join(main, "src"));
  writeFileSync(
    join(main, "src/y.ts"),
    `${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `const l${n} = ${n};`).join("\n")}\n`,
  );
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "base");
  mkdirSync(join(base, "batch"));
  const queue = join(base, "batch", "queue.yaml");
  writeFileSync(queue, `  - id: ${TASK}\n    kind: feature\n${queueExtra}`);

  const def = parse(readFileSync(join(root, ".claude/workflows/engine-task.yaml"), "utf8")) as {
    states: Record<string, { command?: string; env?: unknown; resource?: unknown }>;
  };
  for (const s of ["project_gate", "project_gate_rebased"]) {
    def.states[s].command = `echo "gate green (stub of npm run check): $(git log --oneline -1)"`;
    delete def.states[s].resource;
  }
  // The land keeps its real "master moved past the branch" exit 5 and also takes it once when `conflictNext` asked
  // (project_rebase then reports the conflict once without touching the tree); otherwise it ends at the stubbed merge.
  const mark = join(main, ".force-conflict");
  def.states.project_land.command = [
    `[ -e "${mark}" ] && { echo "master moved (forced)"; exit 5; }`,
    `git merge-base --is-ancestor master "$BRANCH" || { echo "master moved past $BRANCH's base: rebase"; exit 5; }`,
    `echo 'stub: would land'; exit 9`,
  ].join("\n");
  delete def.states.project_land.resource;
  const realRebase = def.states.project_rebase.command as string;
  def.states.project_rebase.command = `if [ -e "${mark}" ]; then rm -f "${mark}"; echo "rebase of $BRANCH onto master conflicts: aborted"; exit 1; fi\n${realRebase}`;
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
  const conflictNext = () => writeFileSync(mark, "");
  return { engine, id, to, set, main, WT, sha: () => git(WT, "rev-parse", "HEAD"), conflictNext };
}

const FIXES = "FIXES:\n1. do the browser check and record it in CHANGELOG.md";

describe("engine-task: a fix round that changes no code, with review visits spent", () => {
  it("does not route the verify-only fix round to blocked", async () => {
    const { to, set, WT, sha, conflictNext } = await sandbox();
    let s = await to("prepare");
    expect(s.currentStateName).toBe("work");
    // the worker's ONE commit: code + a CHANGELOG entry
    mkdirSync(join(WT, "src"), { recursive: true });
    writeFileSync(join(WT, "src/x.ts"), "export const x = 1;\n");
    writeFileSync(join(WT, "CHANGELOG.md"), "## Unreleased\n- x\n");
    git(WT, "add", ".");
    git(WT, "commit", "-q", "-m", "the change");
    await set("worker_agent", "w1");
    s = await to("check");
    expect(s.currentStateName).toBe("review"); // review visit 1
    await set("reviewer_agent", "r1");
    await set("reviewed_sha", sha());
    await set("review_text", "FIXES:\n1. rename x");
    s = await to("filed");
    expect(s.currentStateName).toBe("work");
    writeFileSync(join(WT, "src/x.ts"), "export const x = 2;\n");
    git(WT, "commit", "-q", "-a", "--amend", "--no-edit");
    s = await to("check");
    expect(s.currentStateName).toBe("review"); // review visit 2: MERGE, then the land's rebase conflicts
    await set("reviewed_sha", sha());
    await set("review_text", "MERGE");
    conflictNext();
    s = await to("filed");
    expect(s.currentStateName).toBe("rebase_fix"); // the conflict goes to the worker by itself
    // the resolution changes code too, so the rebased tip is reviewed again
    writeFileSync(join(WT, "src/x.ts"), "export const x = 3;\n");
    git(WT, "commit", "-q", "-a", "--amend", "-m", "the change (rebased)");
    s = await to("gate");
    expect(s.currentStateName).toBe("review"); // review visit 3, the last one
    // its only FIXES item is a check: the worker records it in CHANGELOG.md, no code change
    await set("reviewed_sha", sha());
    await set("review_text", FIXES);
    s = await to("filed");
    expect(s.currentStateName).toBe("work");
    const reviewed = sha();
    writeFileSync(join(WT, "CHANGELOG.md"), "## Unreleased\n- x\n- browser check: done\n");
    git(WT, "commit", "-q", "-a", "--amend", "--no-edit");
    expect(git(WT, "diff", "--name-only", reviewed, "HEAD")).toBe("CHANGELOG.md");
    s = await to("check");

    // No code changed since reviewed_sha: one verify-only review that spends no `review` visit, never `blocked`.
    expect(
      s.currentStateName,
      `entered ${s.currentStateName}; history: ${JSON.stringify(s.history.slice(-4))}`,
    ).toBe("review_verify");
    await set("reviewed_sha", sha());
    await set("review_text", "MERGE");
    s = await to("filed");
    expect(s.currentStateName).toBe("land_failed"); // MERGE → the land (stub, exit 9)
  }, 60000);

  // The slice edits line 5 of src/y.ts and adds a CHANGELOG line, is reviewed MERGE, then master moves a code line above
  // that hunk and adds a conflicting CHANGELOG line: a real `git rebase master` conflicts in CHANGELOG.md only.
  async function mergedThenMasterMoved() {
    const sb = await sandbox();
    const { to, set, WT, sha, main } = sb;
    await to("prepare");
    const y = readFileSync(join(WT, "src/y.ts"), "utf8");
    writeFileSync(join(WT, "src/y.ts"), y.replace("const l5 = 5;", "const l5 = 55;"));
    writeFileSync(join(WT, "CHANGELOG.md"), "## Unreleased\n- slice\n");
    git(WT, "add", ".");
    git(WT, "commit", "-q", "-m", "the change");
    await set("worker_agent", "w1");
    const c = await to("check");
    expect(c.currentStateName, JSON.stringify(c.history.slice(-3))).toBe("review");
    await set("reviewer_agent", "r1");
    await set("reviewed_sha", sha());
    await set("review_text", "MERGE");
    let s = await to("filed");
    expect(s.currentStateName).toBe("land_failed");
    writeFileSync(join(main, "src/y.ts"), `const l0 = 0;\n${y}`);
    writeFileSync(join(main, "CHANGELOG.md"), "## Unreleased\n- master\n");
    git(main, "commit", "-q", "-a", "-m", "master moves");
    s = await to("retry"); // the land finds master moved, its rebase conflicts: rebase_fix follows by itself
    expect(s.currentStateName).toBe("rebase_fix");
    expect(() => git(WT, "-c", "core.editor=true", "rebase", "master")).toThrow();
    return sb;
  }
  const continueRebase = (WT: string) => {
    git(WT, "add", ".");
    git(WT, "-c", "core.editor=true", "rebase", "--continue");
  };

  it("does not route a real conflict-only rebase_fix after MERGE to review or blocked", async () => {
    const { to, WT } = await mergedThenMasterMoved();
    // both sides kept in CHANGELOG.md; src/y.ts rebased cleanly: its hunk header and index line moved, its +/- lines did not
    writeFileSync(join(WT, "CHANGELOG.md"), "## Unreleased\n- master\n- slice\n");
    continueRebase(WT);
    expect(
      git(WT, "diff", "--name-only", "HEAD^", "HEAD")
        .split("\n")
        .filter(f => f !== "node_modules")
        .sort(),
    ).toEqual(["CHANGELOG.md", "src/y.ts"]);
    const s = await to("gate");
    // MERGE was already given at this tree's code: the rebased tree goes to the land (stub exit 9), no review visit.
    expect(
      s.currentStateName,
      `entered ${s.currentStateName}; history: ${JSON.stringify(s.history.slice(-4))}`,
    ).toBe("land_failed");
    const visited = s.history.map(h => h.to);
    expect(visited.slice(visited.lastIndexOf("rebase_fix"))).not.toContain("review");
    expect(visited.slice(visited.lastIndexOf("rebase_fix"))).not.toContain("review_verify");
  }, 60000);

  it("a rebase_fix after MERGE whose resolution changed code goes to a verify-only review that spends no review visit", async () => {
    const { to, set, WT, sha } = await mergedThenMasterMoved();
    writeFileSync(join(WT, "CHANGELOG.md"), "## Unreleased\n- master\n- slice\n");
    const y = readFileSync(join(WT, "src/y.ts"), "utf8");
    writeFileSync(join(WT, "src/y.ts"), y.replace("const l8 = 8;", "const l8 = 88;"));
    continueRebase(WT);
    let s = await to("gate");
    expect(s.currentStateName).toBe("review_verify");
    expect(
      s.history
        .slice(-2)
        .map(h => h.detail ?? "")
        .join("|"),
    ).toContain("exit 25");
    await set("reviewed_sha", sha());
    await set("review_text", "MERGE");
    s = await to("filed");
    expect(s.currentStateName).toBe("land_failed");
  }, 60000);

  it("a round that changes only the site's own code under docs/ is reviewed, not verified or landed", async () => {
    const { to, set, WT, sha } = await sandbox();
    await to("prepare");
    mkdirSync(join(WT, "docs/.vitepress/theme"), { recursive: true });
    writeFileSync(join(WT, "docs/.vitepress/theme/Hero.vue"), "<template>a</template>\n");
    writeFileSync(join(WT, "docs/guide.md"), "a\n");
    writeFileSync(join(WT, "CHANGELOG.md"), "## Unreleased\n- x\n");
    git(WT, "add", ".");
    git(WT, "commit", "-q", "-m", "the change");
    await set("worker_agent", "w1");
    await to("check");
    await set("reviewer_agent", "r1");
    await set("reviewed_sha", sha());
    await set("review_text", "FIXES:\n1. the hero");
    let s = await to("filed");
    expect(s.currentStateName).toBe("work");
    // prose under docs/ only: verified
    writeFileSync(join(WT, "docs/guide.md"), "b\n");
    git(WT, "commit", "-q", "-a", "--amend", "--no-edit");
    s = await to("check");
    expect(s.currentStateName).toBe("review_verify");
    await set("reviewed_sha", sha());
    await set("review_text", "FIXES:\n1. the hero again");
    s = await to("filed");
    expect(s.currentStateName).toBe("work");
    // the theme's own code under docs/: a full review
    writeFileSync(join(WT, "docs/.vitepress/theme/Hero.vue"), "<template>b</template>\n");
    git(WT, "commit", "-q", "-a", "--amend", "--no-edit");
    s = await to("check");
    expect(s.currentStateName).toBe("review");
  }, 60000);

  it("a fix round that changes code still spends a review visit and is blocked when they are spent", async () => {
    const { to, set, WT, sha, conflictNext } = await sandbox();
    let s = await to("prepare");
    mkdirSync(join(WT, "src"), { recursive: true });
    writeFileSync(join(WT, "src/x.ts"), "export const x = 1;\n");
    writeFileSync(join(WT, "CHANGELOG.md"), "## Unreleased\n- x\n");
    git(WT, "add", ".");
    git(WT, "commit", "-q", "-m", "the change");
    await set("worker_agent", "w1");
    s = await to("check");
    // review 1: FIXES with a code change; review 2: MERGE, the land's rebase conflicts and the resolution changes code
    await set("reviewer_agent", "r1");
    await set("reviewed_sha", sha());
    await set("review_text", "FIXES:\n1. rename x");
    s = await to("filed");
    writeFileSync(join(WT, "src/x.ts"), "export const x = 2;\n");
    git(WT, "commit", "-q", "-a", "--amend", "--no-edit");
    s = await to("check");
    await set("reviewed_sha", sha());
    await set("review_text", "MERGE");
    conflictNext();
    s = await to("filed");
    expect(s.currentStateName).toBe("rebase_fix");
    writeFileSync(join(WT, "src/x.ts"), "export const x = 3;\n");
    git(WT, "commit", "-q", "-a", "--amend", "--no-edit");
    s = await to("gate");
    expect(s.currentStateName).toBe("review"); // review visit 3, the last one
    await set("reviewed_sha", sha());
    await set("review_text", FIXES);
    s = await to("filed");
    writeFileSync(join(WT, "src/x.ts"), "export const x = 4;\n");
    git(WT, "commit", "-q", "-a", "--amend", "--no-edit");
    s = await to("check");
    expect(s.currentStateName).toBe("blocked");
  }, 60000);

  it("a code-free round after MERGE on a breaking line waits for the parent, not the land", async () => {
    const { to, set, WT, sha, conflictNext } = await sandbox("    breaking: true\n");
    let s = await to("prepare");
    mkdirSync(join(WT, "src"), { recursive: true });
    writeFileSync(join(WT, "src/x.ts"), "export const x = 1;\n");
    writeFileSync(join(WT, "CHANGELOG.md"), "## Unreleased\n- x\n");
    git(WT, "add", ".");
    git(WT, "commit", "-q", "-m", "the change");
    await set("worker_agent", "w1");
    s = await to("check");
    await set("reviewer_agent", "r1");
    await set("reviewed_sha", sha());
    await set("review_text", "MERGE");
    s = await to("filed");
    expect(s.currentStateName).toBe("breaking_ready");
    conflictNext();
    s = await to("merge");
    expect(s.currentStateName).toBe("rebase_fix");
    writeFileSync(join(WT, "CHANGELOG.md"), "## Unreleased\n- x\n- master's\n");
    git(WT, "commit", "-q", "-a", "--amend", "--no-edit");
    s = await to("gate");
    expect(s.currentStateName).toBe("breaking_ready");
  }, 60000);
});
