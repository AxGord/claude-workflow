import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { addQueueLine, describeQueue, editQueueLine, markQueue, readQueue } from "./queue.js";
import { InMemoryStorage, cleanupDir } from "./test-helpers.js";
import { registerTools } from "./tools.js";

// ENG-PARENT-OWED-ON-TASK-END: a queue line's `on_end_tell_parent: <text>` is a step the parent owes when the line
// ends. The engine reads it from the queue file (durable) and the dispatcher's `owed_handed` context key, so a
// line that ended yields exactly one OWED-DUE line until it is handed, on done and on failed, and none without the key.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(ROOT, "templates");
const dirs: string[] = [];
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.WF_DISPATCHER;
  process.env.WF_DISPATCHER = "1";
});
afterEach(() => {
  if (saved === undefined) delete process.env.WF_DISPATCHER;
  else process.env.WF_DISPATCHER = saved;
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const OWED = "tell sibling: the engine landed";

async function setup(): Promise<{ engine: Engine; disp: string; queue: string }> {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-owed-"));
  dirs.push(d);
  fs.mkdirSync(path.join(d, "q"));
  const queue = path.join(d, "q", "queue.yaml");
  fs.writeFileSync(queue, "batch_size: 3\ntasks: []\n");
  for (const id of ["A", "B", "C"])
    await addQueueLine(queue, {
      id,
      status: "pending",
      difficulty: 3,
      model: "—",
      text: `line ${id}`,
      ...(id === "C" ? {} : { on_end_tell_parent: `${OWED} ${id}` }),
    });
  const storage = new InMemoryStorage();
  const engine = new Engine(storage, new Loader(TEMPLATES, d, null), new Executor());
  const disp = await engine.start("batch");
  const cur = storage.read(disp.sessionId)!;
  cur.stack[cur.active_frame].current_state = "collect";
  cur.context.queue_file = queue;
  cur.context.task_workflow = "batch-task";
  await storage.write(disp.sessionId, cur);
  return { engine, disp: disp.sessionId, queue };
}

const end = async (queue: string, id: string, to: "running" | "done" | "failed"): Promise<void> => {
  if (to === "running") await markQueue(queue, id, "running", undefined, { force: "test" });
  else await markQueue(queue, id, to, to === "done" ? "landed abcdef1" : "stopped");
};

describe("on_end_tell_parent on a queue line", () => {
  it("is a task key: add and edit set it, one non-empty line only, the view lists it", async () => {
    const { queue } = await setup();
    expect(describeQueue(readQueue(queue)).lines.find(l => l.id === "A")?.onEndTellParent).toBe(
      `${OWED} A`,
    );
    expect(
      describeQueue(readQueue(queue)).lines.find(l => l.id === "C")?.onEndTellParent,
    ).toBeUndefined();
    await editQueueLine(queue, "C", { on_end_tell_parent: "x" });
    expect(describeQueue(readQueue(queue)).lines.find(l => l.id === "C")?.onEndTellParent).toBe(
      "x",
    );
    await expect(editQueueLine(queue, "C", { on_end_tell_parent: "a\nb" })).rejects.toThrow(
      /one line/u,
    );
    await editQueueLine(queue, "C", { on_end_tell_parent: "" });
    expect(
      describeQueue(readQueue(queue)).lines.find(l => l.id === "C")?.onEndTellParent,
    ).toBeUndefined();
  });
});

describe("the engine names an owed step once, at the end of its line", () => {
  it("none while the line runs; one on done with its sha; one on failed; none without the key", async () => {
    const { engine, disp, queue } = await setup();
    for (const id of ["A", "B", "C"]) await end(queue, id, "running");
    expect(engine.owedLines(disp)).toEqual([]);
    await end(queue, "A", "done");
    await end(queue, "B", "failed");
    await end(queue, "C", "done");
    expect(engine.owedLines(disp)).toEqual([
      `OWED-DUE: task=A status=done sha=abcdef1: ${OWED} A`,
      `OWED-DUE: task=B status=failed sha=none: ${OWED} B`,
    ]);
    expect(engine.getStatus(disp).prompt).toContain(
      `OWED-DUE: task=A status=done sha=abcdef1: ${OWED} A`,
    );
  });

  it("is held until handed: setting owed_handed records it on the line, once", async () => {
    const { engine, disp, queue } = await setup();
    await end(queue, "A", "running");
    await end(queue, "A", "done");
    expect(engine.owedLines(disp)).toHaveLength(1);
    expect(engine.owedLines(disp)).toHaveLength(1);
    await engine.setContext(disp, "owed_handed", "A");
    expect(engine.owedLines(disp)).toEqual([]);
    expect(fs.readFileSync(queue, "utf8")).toMatch(/owed_handed: \d{4}-\d{2}-\d{2}/u);
  });

  it("a second dispatcher session on the same queue does not hand an ended line again", async () => {
    const { engine, disp, queue } = await setup();
    await end(queue, "A", "running");
    await end(queue, "A", "done");
    await end(queue, "B", "running");
    await end(queue, "B", "done");
    await engine.setContext(disp, "owed_handed", "A");
    const second = (
      await engine.start(
        "batch",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "test: a later dispatcher",
      )
    ).sessionId;
    await engine.setContext(second, "queue_file", queue);
    await engine.setContext(second, "task_workflow", "batch-task");
    expect(engine.owedLines(second)).toEqual([
      `OWED-DUE: task=B status=done sha=abcdef1: ${OWED} B`,
    ]);
  });

  it("owed_handed is the engine's: queue_add and queue_edit refuse it", async () => {
    const { queue } = await setup();
    await expect(editQueueLine(queue, "A", { owed_handed: "2026-01-01" })).rejects.toThrow(
      /owed_handed/u,
    );
    await expect(
      addQueueLine(queue, { id: "D", difficulty: 3, owed_handed: "2026-01-01", text: "x" }),
    ).rejects.toThrow(/owed_handed/u);
  });
});

describe("the instructions name the field and the hand-back", () => {
  it("the dispatcher's rules hand back OWED once per task, keyed by owed_handed", () => {
    const rules = fs.readFileSync(path.join(TEMPLATES, "drivers", "dispatch-driver.md"), "utf8");
    expect(rules).toContain("OWED-DUE:");
    expect(rules).toContain("owed_handed");
    expect(rules).toContain("at least once");
    expect(fs.readFileSync(path.join(ROOT, "agents", "dispatcher.md"), "utf8")).toContain("OWED");
    expect(fs.readFileSync(path.join(TEMPLATES, "batch.yaml"), "utf8")).toContain(
      "an OWED message",
    );
    expect(rules).toContain("OWED task=<ID> status=<done|failed> sha=<sha|none>: <text>");
  });
});

describe("the parent's DRIVER block names the field", () => {
  it("start renders the OWED hand-back and on_end_tell_parent", async () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-owed-blk-"));
    dirs.push(userDir);
    const loader = new Loader(TEMPLATES, userDir, null);
    const engine = new Engine(new InMemoryStorage(), loader, new Executor());
    const handlers = new Map<
      string,
      (args: object) => Promise<{ content: Array<{ text: string }> }>
    >();
    const server = {
      registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h),
    };
    registerTools(server as never, engine, {} as never, loader, new InMemoryStorage());
    const reply = await handlers.get("start")!({ workflow: "batch", reply: "id" });
    const text = reply.content[0].text;
    const block = text.slice(text.indexOf("---\nDRIVER"));
    expect(block).toContain("`OWED task=<ID> status=<done|failed> sha=<sha|none>: <text>`");
    expect(block).toContain("on_end_tell_parent");
  });
});
