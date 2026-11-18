import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, trustStoreFor } from "./test-helpers.js";

// ENG-LAND-REBASE-CONFLICT-AUTO-FIX: in engine-task, a land whose `git rebase master` conflicts (project_rebase exit 1)
// goes to land_failed and waits for the parent, which only relays the answer `rebase_fix`. The workflow must route that
// exit straight to rebase_fix (no parent, no driver choice) for a bounded number of times (2 per task); the third
// conflict goes to land_failed. The REAL engine runs the REAL engine-task.yaml and the REAL project_rebase over a
// sandbox git repo; only the gates and the land's merge are stubs (the land keeps its real "master moved" exit 5).
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
  const TASK = `T-LANDCONF-${process.pid}-${++seq}`;
  const WT = `/tmp/wf-${TASK}`;
  dirs.push(WT, `${WT}-logs`);
  const base = mkdtempSync(join(tmpdir(), "rv-landconf-"));
  dirs.push(base);
  const main = join(base, "main");
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
  return { to, set, main, WT, sha: () => git(WT, "rev-parse", "HEAD") };
}

describe("engine-task: a land whose rebase conflicts", () => {
  it("goes to rebase_fix twice with no parent choice, then to land_failed", async () => {
    const { to, set, main, WT, sha } = await sandbox();
    await to("prepare");
    writeFileSync(join(WT, "src/y.ts"), "const l1 = 11;\n");
    writeFileSync(join(WT, "CHANGELOG.md"), "## Unreleased\n- slice\n");
    git(WT, "add", ".");
    git(WT, "commit", "-q", "-m", "the change");
    await set("worker_agent", "w1");
    let s = await to("check");
    expect(s.currentStateName, JSON.stringify(s.history.slice(-3))).toBe("review");
    await set("reviewer_agent", "r1");
    await set("reviewed_sha", sha());
    await set("review_text", "MERGE");

    const moveMaster = (n: number) => {
      writeFileSync(join(main, "CHANGELOG.md"), `## Unreleased\n- master${n}\n`);
      git(main, "commit", "-q", "-a", "-m", `master moves ${n}`);
    };

    const seen: string[] = [];
    moveMaster(1);
    s = await to("filed"); // MERGE → land: master moved (exit 5) → project_rebase conflicts (exit 1)
    seen.push(s.currentStateName);
    for (let n = 2; n <= 3 && s.currentStateName === "rebase_fix"; n++) {
      // the worker's round: rebase onto master, keep both sides, one commit
      expect(() => git(WT, "-c", "core.editor=true", "rebase", "master")).toThrow();
      writeFileSync(join(WT, "CHANGELOG.md"), `## Unreleased\n- master${n - 1}\n- slice\n`);
      git(WT, "add", ".");
      git(WT, "-c", "core.editor=true", "rebase", "--continue");
      moveMaster(n); // master moves again before the land: the next rebase conflicts too
      s = await to("gate");
      seen.push(s.currentStateName);
    }
    expect(seen, `history: ${JSON.stringify(s.history.slice(-6).map(h => h.to))}`).toEqual([
      "rebase_fix",
      "rebase_fix",
      "land_failed",
    ]);
  }, 120000);

  it("a branch that only lags master again rebases in the land, with no round back to the worker", async () => {
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
    writeFileSync(join(main, "CHANGELOG.md"), "## Unreleased\n- master1\n");
    git(main, "commit", "-q", "-a", "-m", "master moves 1");
    let s = await to("filed");
    expect(s.currentStateName).toBe("rebase_fix");
    expect(() => git(WT, "-c", "core.editor=true", "rebase", "master")).toThrow();
    writeFileSync(join(WT, "CHANGELOG.md"), "## Unreleased\n- master1\n- slice\n");
    git(WT, "add", ".");
    git(WT, "-c", "core.editor=true", "rebase", "--continue");
    // master moves again, in a file the branch does not touch: the land's own rebase takes it
    writeFileSync(join(main, "src/z.ts"), "const z = 1;\n");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "master moves 2");
    s = await to("gate");
    const path = s.history.map(h => h.to);
    expect(path.slice(-5), JSON.stringify(path)).toEqual([
      "project_land",
      "project_rebase",
      "project_gate_rebased",
      "project_land",
      "land_failed", // the stubbed merge's exit 9: the rebase and its gate ran, the worker was not asked again
    ]);
    expect(path.filter(n => n === "rebase_fix")).toHaveLength(1);
    expect(() => git(WT, "merge-base", "--is-ancestor", "master", "HEAD")).not.toThrow();
  }, 120000);

  it("rebase_fix's verify no longer asks whether master is an ancestor, and land_failed no longer offers rebase_fix", () => {
    const def = parse(readFileSync(join(root, ".claude/workflows/engine-task.yaml"), "utf8")) as {
      states: Record<
        string,
        { prompt?: string; transitions?: Record<string, string>; cases?: Record<string, string> }
      >;
    };
    expect(def.states.rebase_fix.prompt).not.toContain("--is-ancestor");
    expect(def.states.land_failed.transitions).not.toHaveProperty("rebase_fix");
    expect(def.states.project_rebase.cases).toMatchObject({ "1": "rebase_conflict" });
  });
});
