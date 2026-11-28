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

// ENG-PARENT-EDITED-PRECHECK: `parent_edited` from `blocked` ran the gate at once. A parent's "the worker will rebase, amend,
// then the gate runs" taken before the worker was done sent the line to gate_failed (exit 3, red mark) instead of back to
// `blocked`. The REAL engine runs the REAL engine-task.yaml and the REAL gate command; only the leased check is a stub.
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

/** A session of engine-task parked in `blocked` with one committed branch commit; `gateRuns()` counts runs of the check stub. */
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
  await to("blocked");
  const gateRuns = () =>
    existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").length : 0;
  const precheckOut = () => String(storage.read(id)!.context.precheck_out);
  return { to, gateRuns, main, WT, precheckOut };
}

describe("engine-task: parent_edited from blocked checks the branch before the gate", () => {
  it("a dirty worktree refuses back to blocked, without a gate run and without gate_failed", async () => {
    const { to, gateRuns, WT } = await sandbox();
    writeFileSync(join(WT, "src/y.ts"), "const l1 = 12; // the worker is still editing\n");
    const s = await to("parent_edited");
    const path = s.history.map(h => h.to);
    expect(path, JSON.stringify(path)).not.toContain("gate_failed");
    expect(s.currentStateName, JSON.stringify(path)).toBe("blocked");
    expect(gateRuns()).toBe(0);
  }, 60000);

  it("a branch not on master refuses back to blocked, without a gate run", async () => {
    const { to, gateRuns, main } = await sandbox();
    writeFileSync(join(main, "other.txt"), "master moved\n");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "master moved");
    const s = await to("parent_edited");
    const path = s.history.map(h => h.to);
    expect(path, JSON.stringify(path)).not.toContain("gate_failed");
    expect(s.currentStateName, JSON.stringify(path)).toBe("blocked");
    expect(gateRuns()).toBe(0);
  }, 60000);

  it("a refusal names what is missing in context.precheck_out, and the green pass empties it", async () => {
    const { to, gateRuns, main, WT, precheckOut } = await sandbox();
    writeFileSync(join(WT, "src/y.ts"), "const l1 = 12;\n");
    git(WT, "add", "src/y.ts");
    writeFileSync(join(main, "other.txt"), "master moved\n");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "master moved");
    const s = await to("parent_edited");
    expect(s.currentStateName).toBe("blocked");
    const out = precheckOut();
    expect(out).toContain("staged files not in the commit:");
    expect(out).toContain("src/y.ts");
    expect(out).toMatch(/not rebased onto master [0-9a-f]+/);
    expect(gateRuns()).toBe(0);
    git(WT, "commit", "-q", "--amend", "-a", "--no-edit");
    git(WT, "rebase", "master");
    const ok = await to("parent_edited");
    expect(ok.history.map(h => h.to)).toContain("project_gate_rebased");
    expect(precheckOut()).toBe("");
    expect(gateRuns()).toBe(1);
  }, 60000);

  it("a branch of two commits refuses back to blocked", async () => {
    const { to, gateRuns, WT, precheckOut } = await sandbox();
    writeFileSync(join(WT, "src/z.ts"), "const z = 1;\n");
    git(WT, "add", ".");
    git(WT, "commit", "-q", "-m", "second");
    const s = await to("parent_edited");
    expect(s.currentStateName).toBe("blocked");
    expect(precheckOut()).toContain("2 commits over master, expected one");
    expect(gateRuns()).toBe(0);
  }, 60000);

  it("the blocked prompt, gate_failed prompt and both driver files order the worker's DONE before parent_edited", () => {
    const read = (f: string) => readFileSync(join(root, f), "utf8").replace(/\s+/g, " ");
    const def = parse(readFileSync(WORKFLOW, "utf8")) as {
      states: Record<string, { prompt?: string }>;
    };
    for (const p of [def.states.blocked.prompt, def.states.gate_failed.prompt])
      expect((p ?? "").replace(/\s+/g, " ")).toContain("wait for its DONE, and only then take");
    for (const f of ["agents/driver.md", "templates/drivers/task-driver.md"])
      expect(read(f)).toContain("wait for its DONE, and only then take `parent_edited`");
  });

  it("a clean one-commit branch on top of master reaches the gate", async () => {
    const { to, gateRuns } = await sandbox();
    const s = await to("parent_edited");
    const path = s.history.map(h => h.to);
    expect(path, JSON.stringify(path)).toContain("project_gate_rebased");
    expect(gateRuns()).toBe(1);
  }, 60000);
});
