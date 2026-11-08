import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { addQueueLine, editQueueLine, pickQueue, readQueue, setQueueWindow } from "./queue.js";
import { InMemoryStorage } from "./test-helpers.js";

// What an approved plan hands to execution: planning writes the task table, master's
// route_execution reads the plan's `Tasks` field, enqueue_plan queues the tasks and batch runs them.
const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-tpl-")));
  dirs.push(d);
  return d;
};

const planningPrompt = (state: string): string => {
  const def = new Loader(TEMPLATES, tmp(), null).get("planning")!;
  return def.states[state].prompt!;
};

describe("planning: the Workflow section", () => {
  it.each(["design", "create_workflow"])("%s keeps the hook-parsed Resume line byte-exact", s => {
    expect(planningPrompt(s)).toContain('- **Resume**: `transition("<session_id>", "planned")`');
  });

  it.each(["design", "create_workflow"])("%s names the Tasks field after Resume", s => {
    const lines = planningPrompt(s).split("\n");
    const resume = lines.findIndex(l => l.includes("- **Resume**:"));
    const tasks = lines.findIndex(l => l.includes("- **Tasks**:"));
    expect(resume).toBeGreaterThan(0);
    // Last in the list: the hook reads Session within five lines of the heading.
    expect(tasks).toBe(resume + 1);
  });

  it("the Session line stays within five lines of the heading, as the start hook reads it", () => {
    const lines = planningPrompt("design").split("\n");
    const head = lines.findIndex(l => l.trim() === "## Workflow");
    const session = lines.findIndex(l => l.includes("- **Session**:"));
    expect(session - head).toBeLessThanOrEqual(5);
  });

  it("states the two levels and the table columns", () => {
    const p = planningPrompt("design");
    expect(p).toMatch(/A TASK can be tested, reviewed\s+and landed on its own/);
    expect(p).toMatch(/A STEP cannot/);
    expect(p).toContain("| id | after | touches | difficulty |");
  });
});

const masterPrompt = (state: string): string =>
  new Loader(TEMPLATES, tmp(), null).get("master")!.states[state].prompt!;

describe("enqueue_plan: the rules its prompt states", () => {
  const p = masterPrompt("enqueue_plan");

  it("one bad touches path removes the task's whole list", () => {
    expect(p).toMatch(/If ANY path of a task\s+fails, remove that task's WHOLE `touches` list/);
  });

  it("every task is checked before the first add, and a failed pass parks its lines", () => {
    expect(p).toMatch(/check EVERY task\s+before the first `queue_add`/);
    expect(p).toMatch(/`parked: true`/);
  });

  it("a heir is found by extends: batch, and its header is left alone", () => {
    const pattern = /grep -lE '([^']+)'/.exec(p)?.[1];
    expect(pattern).toBe("^extends: *batch *$");
    const heir = new RegExp(pattern as string);
    expect(heir.test("extends: batch")).toBe(true);
    expect(heir.test("extends:   batch  ")).toBe(true);
    // a heir of batch-task has no plan_queue: it is not a queue heir
    expect(heir.test("extends: batch-task")).toBe(false);
    expect(p).toMatch(/leave its header \(`batch_size`,\s+`reason`\) and `queue_file` alone/);
    expect(p).toMatch(/Own queue only/);
  });

  it("does not claim the land verifies touches", () => {
    expect(p).not.toMatch(/never merged silently/);
    expect(p).toMatch(/different hunks of an undeclared shared file merge cleanly/);
  });
});

/** The rows of a plan's `## Tasks` table as queue lines, `touches` checked the way enqueue_plan says. */
function plannedLines(plan: string, project: string): Record<string, unknown>[] {
  const exists = (rel: string): boolean =>
    fs.existsSync(path.join(project, rel)) || fs.existsSync(path.join(project, path.dirname(rel)));
  return plan
    .split("\n")
    .filter(l => /^\| T\d/.test(l))
    .map(l => {
      const [id, after, touches, difficulty] = l
        .split("|")
        .slice(1, 5)
        .map(c => c.trim());
      const paths = touches.split(",").map(c => c.trim());
      return {
        id,
        status: "pending",
        difficulty: Number(difficulty),
        ...(after === "—" ? {} : { after: after.split(",").map(c => c.trim()) }),
        // One failing path removes the whole list.
        ...(paths.every(exists) ? { touches: paths } : {}),
        text: `Do ${id}.`,
      };
    });
}

describe("master: an approved plan reaches execution", () => {
  let cwd: string;
  let storage: InMemoryStorage;
  let engine: Engine;
  beforeEach(() => {
    cwd = tmp();
    storage = new InMemoryStorage();
    engine = new Engine(storage, new Loader(TEMPLATES, tmp(), null), new Executor());
  });

  /** master → plan → planning's design → `planned` → route_execution. */
  async function approved(): Promise<string> {
    const { sessionId } = await engine.start("master", { cwd });
    await engine.transition(sessionId, "plan");
    await engine.transition(sessionId, "continue");
    await engine.transition(sessionId, "skip");
    const done = await engine.transition(sessionId, "planned");
    expect(done.prompt).toContain("route to the correct execution workflow");
    return sessionId;
  }

  it("one task: the plan's Execution workflow runs as before, nothing is queued", async () => {
    const id = await approved();
    const next = await engine.transition(id, "coding");
    expect(next.prompt).toContain("DO NOT write code or edit files in this state");
    expect(fs.existsSync(path.join(cwd, ".claude"))).toBe(false);
  });

  it("a two-task plan: table -> lines -> queue_file -> plan_queue resumes it -> the pick", async () => {
    fs.mkdirSync(path.join(cwd, ".git"));
    for (const f of ["src/a/x.txt", "src/b/y.txt", "docs/x.md"]) {
      fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true });
      fs.writeFileSync(path.join(cwd, f), "");
    }
    const plan = `## Tasks
| id | after | touches | difficulty |
|----|-------|---------|------------|
| T1 | —     | src/a, docs/x.md | 4 |
| T2 | —     | src/b            | 3 |
| T3 | T1    | src/a/deep       | 3 |
| T4 | —     | src/a, nope/z    | 2 |

## Workflow
- **Execution workflow**: batch
- **Tasks**: 4
`;
    const lines = plannedLines(plan, cwd);
    // T4 names a path that fails the check: it has no touches at all, not a shortened list.
    expect(lines.map(l => Object.keys(l).includes("touches"))).toEqual([true, true, true, false]);

    const id = await approved();
    const enq = await engine.transition(id, "queue");
    expect(enq.prompt).toContain("Hand the approved plan's tasks to the task queue");

    const file = path.join(cwd, ".claude", "batch", "plan-x.yaml");
    for (const l of lines) await addQueueLine(file, l, {}, { create: true });
    await setQueueWindow(file, 3, "plan: x");
    await engine.setContext(id, "queue_file", file);

    await engine.transition(id, "batch");
    const queued = await engine.transition(id, "continue");
    expect(queued.prompt).toMatch(/Handed over/);
    expect(storage.read(id)?.context.queue_file).toBe(file);

    // Disjoint T1 and T2 run together; T3 waits on T1; T4 (no touches) runs alone, after them.
    const pick = await pickQueue(file, { dryRun: true });
    expect(pick.admitted.map(a => a.id)).toEqual(["T1", "T2"]);
    expect(readQueue(file).lines.find(l => l.id === "T4")?.meta.touches).toBeUndefined();
  });

  it("a plan that cannot be queued returns to planning", async () => {
    const id = await approved();
    await engine.transition(id, "queue");
    const back = await engine.transition(id, "replan");
    expect(back.prompt).toContain("Determine if codebase exploration is needed");
  });

  it("a project heir of batch is wired through run_project", async () => {
    const id = await approved();
    await engine.transition(id, "queue");
    await engine.setContext(id, "project_workflow", "batch");
    const next = await engine.transition(id, "project");
    expect(next.prompt).toContain("project-specific workflow");
  });
});

describe("a failed pass leaves nothing for the pick", () => {
  it("parked lines are never admitted; a re-add of the same id is refused", async () => {
    const proj = tmp();
    fs.mkdirSync(path.join(proj, ".git"));
    const file = path.join(proj, ".claude", "batch", "plan-y.yaml");
    const line = { id: "T1", status: "pending", difficulty: 3, touches: ["src/a"], text: "Do T1." };
    await addQueueLine(file, line, {}, { create: true });
    await addQueueLine(file, { ...line, id: "T2", touches: ["src/b"] });
    await setQueueWindow(file, 3, "plan: y");
    for (const id of ["T1", "T2"]) await editQueueLine(file, id, { parked: true });
    expect((await pickQueue(file, { dryRun: true })).admitted).toEqual([]);
    await expect(addQueueLine(file, line)).rejects.toThrow(/already in/);
  });
});
