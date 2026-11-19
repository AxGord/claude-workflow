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

// ENG-TASK-BLOCKED-REGATE-ROUTE: a task parked in `blocked` after a red gate on a test outside its files has no route to
// run the gate again on the unchanged branch: the REAL engine runs the REAL engine-task.yaml (gates stubbed green) and
// the parent's transition `regate` from `blocked` must run the gate, not be refused.
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

async function sandbox(regateCommand = `echo "gate ran (stub of npm run check)"`) {
  const TASK = `T-REGATE-${process.pid}-${++seq}`;
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rv-regate-")));
  dirs.push(base);
  const main = join(base, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "master");
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  git(main, "config", "commit.gpgsign", "false");
  writeFileSync(join(main, "CHANGELOG.md"), "## Unreleased\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "base");
  mkdirSync(join(base, "batch"));
  const queue = join(base, "batch", "queue.yaml");
  writeFileSync(queue, `  - id: ${TASK}\n    kind: feature\n`);

  const def = parse(readFileSync(join(root, ".claude/workflows/engine-task.yaml"), "utf8")) as {
    states: Record<string, { command?: string; env?: unknown; resource?: unknown }>;
  };
  for (const s of ["project_gate", "project_gate_rebased"]) {
    def.states[s].command = `echo "gate ran (stub of npm run check)"`;
    delete def.states[s].resource;
  }
  def.states.regate_gate.command = regateCommand;
  delete def.states.regate_gate.resource;
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
  const engine = new Engine(new InMemoryStorage(), loader, new Executor());
  const first = await engine.start("engine-task", undefined, undefined, main, undefined, {
    task: TASK,
    queue_file: queue,
  });
  const id = first.sessionId;
  return { to: (t: string) => engine.transition(id, t) };
}

describe("engine-task: a blocked task whose gate went red outside its files", () => {
  it("`regate` from blocked runs the gate again on the unchanged branch", async () => {
    const { to } = await sandbox();
    await to("prepare"); // the worker's state
    const blocked = await to("blocked");
    expect(blocked.currentStateName).toBe("blocked");
    const after = await to("regate");
    const path = after.history.map(h => h.to);
    expect(path, JSON.stringify(path)).toContain("regate_gate");
    expect(after.currentStateName).not.toBe("blocked");
  }, 60000);

  it("a red regate returns to `blocked` through `regate_red`, and the prompt there says the way on", async () => {
    const { to } = await sandbox(`echo "1 failed: outside.test.ts"; exit 1`);
    await to("prepare");
    await to("blocked");
    const red = await to("regate");
    expect(red.currentStateName).toBe("regate_red");
    expect(JSON.stringify(red)).toContain("outside.test.ts");
    const back = await to("blocked");
    expect(back.currentStateName).toBe("blocked");
    expect(JSON.stringify(back)).toContain("regate");
  }, 60000);

  it("the third regate runs nothing: its visit limit sends it back to `blocked`", async () => {
    const { to } = await sandbox(`echo "1 failed"; exit 1`);
    await to("prepare");
    await to("blocked");
    await to("regate");
    await to("blocked");
    await to("regate");
    await to("blocked");
    const third = await to("regate");
    expect(third.currentStateName).toBe("blocked");
    expect(third.history.map(h => h.to).filter(s => s === "regate_gate")).toHaveLength(2);
  }, 60000);
});

describe("the dispatcher's relay of the parent's decision", () => {
  const FORM = "MAIN DECISION (quoted, the main conversation's own word): task=<ID>: <decision>";
  const read = (f: string) => readFileSync(join(root, f), "utf8");

  it("dispatch-driver.md gives the exact relay form", () => {
    expect(read("templates/drivers/dispatch-driver.md")).toContain(FORM);
  });

  it.each(["templates/drivers/task-driver.md", "agents/driver.md"])(
    "%s takes a decision relayed in that form as the parent's own answer",
    f => {
      const md = read(f).replace(/\s+/g, " ");
      expect(md).toContain(FORM);
      expect(md).toContain("it IS that answer, not the dispatcher asking");
      expect(md).toContain("`parent_edited`");
    },
  );

  it("the blocked prompt names `regate` and when it applies", () => {
    const def = parse(read(".claude/workflows/engine-task.yaml")) as {
      states: Record<string, { prompt?: string; max_visits?: number; on_exhausted?: string }>;
    };
    expect(def.states.blocked.prompt).toContain("`regate`");
    expect(def.states.blocked.prompt).toContain("OUTSIDE the task's diff");
    expect(def.states.regate_gate.max_visits).toBe(2);
    expect(def.states.regate_gate.on_exhausted).toBe("blocked");
  });
});
