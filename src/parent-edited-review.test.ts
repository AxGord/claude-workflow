import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, trustStoreFor } from "./test-helpers.js";

// ENG-PARENT-EDITED-SKIPS-REVIEW: a worker blocked at `work` (no review round ever ran), then the parent's `parent_edited`,
// went blocked -> project_gate_rebased -> project_land -> done: the code never reached a reviewer. The REAL engine runs the
// REAL engine-task.yaml; only the leased check and the land are stubs.
const root = resolve(__dirname, "..");
const WORKFLOW = join(root, ".claude/workflows/engine-task.yaml");
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

type Def = {
  states: Record<string, { command?: string; env?: Record<string, string>; resource?: unknown }>;
};

/** A session of engine-task blocked at `work` with one committed branch commit, no review ever run. */
async function sandbox() {
  const TASK = `T-PEP-${process.pid}-${++seq}`;
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rv-pep-")));
  dirs.push(base);
  const main = join(base, "main");
  const WT = join(base, ".wt", "main", TASK);
  mkdirSync(main);
  git(main, "init", "-q", "-b", "master");
  writeFileSync(join(main, "CHANGELOG.md"), "## Unreleased\n");
  mkdirSync(join(main, "src"));
  writeFileSync(join(main, "src/y.ts"), "const l1 = 1;\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "base");
  mkdirSync(join(base, "batch"));
  const queue = join(base, "batch", "queue.yaml");
  writeFileSync(queue, `  - id: ${TASK}\n    kind: feature\n`);

  const counter = join(base, "runs");
  const stub = join(base, "check-stub.sh");
  writeFileSync(stub, `#!/bin/sh\necho x >> "${counter}"\necho "stub check green"\nexit 0\n`);
  chmodSync(stub, 0o755);

  const def = parse(readFileSync(WORKFLOW, "utf8")) as Def;
  for (const s of ["project_gate", "project_gate_rebased", "regate_gate"]) {
    def.states[s].env = { CHECK: stub };
    delete def.states[s].resource;
  }
  def.states.project_land.command = `echo 'stub: would land'; exit 9`;
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
  const storage = new InMemoryStorage();
  const engine = new Engine(storage, loader, new Executor());
  const first = await engine.start("engine-task", undefined, undefined, main, undefined, {
    task: TASK,
    queue_file: queue,
  });
  const id = first.sessionId;
  const to = (t: string) => engine.transition(id, t);
  await to("prepare");
  writeFileSync(join(WT, "src/y.ts"), "const l1 = 11;\n");
  writeFileSync(join(WT, "CHANGELOG.md"), "## Unreleased\n- slice\n");
  git(WT, "add", ".");
  git(WT, "commit", "-q", "-m", "the change");
  const gateRuns = () =>
    existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").length : 0;
  return { to, gateRuns, engine, id, WT };
}

const visited = (s: { history: { to: string }[] }) => s.history.map(h => h.to);

describe("engine-task: parent_edited from a block no review round has passed", () => {
  it("a block at work, then parent_edited, goes through a review before the land", async () => {
    const { to } = await sandbox();
    await to("blocked"); // the worker blocks at `work`: no review has run
    const s = await to("parent_edited");
    const path = visited(s);
    expect(path, JSON.stringify(path)).toContain("parent_edited_unreviewed");
    expect(path, JSON.stringify(path)).not.toContain("project_gate_rebased");
    expect(path, JSON.stringify(path)).not.toContain("project_land");
    expect(s.currentStateName, JSON.stringify(path)).toBe("review");
  }, 60000);

  it("a block after a review round, then parent_edited, goes straight to the gate and the land", async () => {
    const { to, engine, id, WT, gateRuns } = await sandbox();
    const sha = git(WT, "rev-parse", "HEAD");
    const r = await to("check"); // work -> work_check -> project_gate -> review_route -> review
    expect(r.currentStateName, JSON.stringify(visited(r))).toBe("review");
    await engine.transition(id, "filed", undefined, {
      review_text: "VERDICT MERGE fine",
      reviewed_sha: sha,
    });
    const l = await to("close"); // the land stub fails -> land_failed
    expect(l.currentStateName, JSON.stringify(visited(l))).toBe("blocked");
    const before = visited(l).length;
    const s = await to("parent_edited");
    const path = visited(s).slice(before);
    expect(path, JSON.stringify(path)).toEqual(
      expect.arrayContaining(["parent_edited_check", "project_gate_rebased", "project_land"]),
    );
    expect(path, JSON.stringify(path)).not.toContain("review");
    expect(path, JSON.stringify(path)).not.toContain("parent_edited_unreviewed");
    expect(gateRuns()).toBeGreaterThan(0);
  }, 60000);
});
