import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, cleanupDir, createFixtureDir } from "./test-helpers.js";
import { registerTools } from "./tools.js";

// ENG-PARENT-ANSWER-VIA-DISPATCHER: the parent answers a NEEDS-PARENT by recording the answer in the engine
// (a `parent_answer` on the task session: route + text); the dispatcher's `collect` cannot end while a task
// holds an answer it has not relayed, and the engine names the driver and the text. Today the parent
// SendMessages the driver itself, so the driver's terminal notification reaches the parent.

const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
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

const ANSWER = "route=work: use the second design, keep the old name";

async function dispatcherWithAnsweredTask(): Promise<{
  engine: Engine;
  disp: string;
  task: string;
}> {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-parent-answer-"));
  dirs.push(d);
  const storage = new InMemoryStorage();
  const engine = new Engine(storage, new Loader(TEMPLATES, d, null), new Executor());
  const disp = await engine.start("batch");
  const dcur = storage.read(disp.sessionId)!;
  dcur.stack[dcur.active_frame].current_state = "collect";
  const queue = path.join(d, "queue.yaml");
  fs.writeFileSync(queue, "batch_size: 2\ntasks:\n  - id: T1\n    status: running\n");
  dcur.context.queue_file = queue;
  await storage.write(disp.sessionId, dcur);
  const task = await engine.start("batch-task", undefined, disp.sessionId, d, undefined, {
    task: "T1",
  });
  await engine.setContext(disp.sessionId, "tasks", `T1=${task.sessionId} driver=drv1`);
  // the parent's answer, recorded in the engine on the task session (the line's own example key)
  await engine.setContext(task.sessionId, "parent_answer", ANSWER);
  return { engine, disp: disp.sessionId, task: task.sessionId };
}

describe("a parent answer recorded in the engine is relayed by the dispatcher", () => {
  it("collect names the driver and the text of an answer not yet relayed", async () => {
    const { engine, disp } = await dispatcherWithAnsweredTask();
    const prompt = engine.getStatus(disp).prompt;
    expect(prompt).toContain(ANSWER);
    expect(prompt).toMatch(/drv1/u);
  });

  it("collect cannot end (slot_free) while a task holds an unrelayed answer", async () => {
    const { engine, disp } = await dispatcherWithAnsweredTask();
    await expect(engine.transition(disp, "slot_free")).rejects.toThrow(/parent_answer|unrelayed/u);
  });
});

describe("the engine holds the answer until the dispatcher clears it", () => {
  it("the line names the task and session; slot_free and stalled refuse, refill and a cleared key do not", async () => {
    const { engine, disp, task } = await dispatcherWithAnsweredTask();
    expect(engine.parentAnswerLines(disp)).toEqual([
      `PARENT-ANSWER: task=T1 session=${task} driver=drv1: ${ANSWER}`,
    ]);
    await expect(engine.transition(disp, "stalled")).rejects.toThrow(/unrelayed/u);
    await engine.setContext(task, "parent_answer", "");
    expect(engine.parentAnswerLines(disp)).toEqual([]);
    expect(engine.getStatus(disp).prompt).not.toContain("PARENT-ANSWER: task=T1");
    await expect(engine.transition(disp, "slot_free")).resolves.toBeDefined();
  });

  it("a held answer is not repeated as an UNANSWERED question", async () => {
    const { engine, disp, task } = await dispatcherWithAnsweredTask();
    await engine.setContext(task, "ask_parent", "which design?");
    const later = Date.now() + 3_600_000;
    expect(engine.unansweredAskLines(disp, later)).toEqual([]);
    await engine.setContext(task, "parent_answer", "");
    expect(engine.unansweredAskLines(disp, later)).toHaveLength(1);
  });

  it("context_set of parent_answer names the dispatcher session that relays it", async () => {
    const { engine, task, disp } = await dispatcherWithAnsweredTask();
    expect(engine.parentAnswerNote(task)).toContain(disp);
    expect(engine.parentAnswerNote(task)).toContain("held by the engine");
  });

  it("with a dispatcher agent holding the root, the note names its id, the `answer` wake and no SendMessage to the driver", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-parent-answer-agent-"));
    dirs.push(d);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, new Loader(TEMPLATES, d, null), new Executor());
    const disp = await engine.start("batch");
    const dcur = storage.read(disp.sessionId)!;
    dcur.context.dispatcher_call = "DRIVER — the dispatcher";
    await storage.write(disp.sessionId, { ...dcur, agent_id: "disp-agent" });
    const task = await engine.start("batch-task", undefined, disp.sessionId, d, undefined, {
      task: "T1",
    });
    const note = engine.parentAnswerNote(task.sessionId)!;
    expect(note).toContain('SendMessage({ to: "disp-agent", message: "answer" })');
    expect(note).toContain("no SendMessage to the driver");
  });

  it("the dispatcher's instructions tell it to relay, then clear the key, and the driver's to take it", () => {
    const disp = fs.readFileSync(path.join(TEMPLATES, "drivers", "dispatch-driver.md"), "utf8");
    expect(disp).toContain("PARENT-ANSWER:");
    expect(disp).toContain('key: "parent_answer", value: ""');
    expect(disp).toContain("MAIN DECISION (quoted, the main conversation's own word)");
    const drv = fs.readFileSync(path.join(TEMPLATES, "drivers", "task-driver.md"), "utf8");
    expect(drv).toContain("`parent_answer` on P");
  });
});

describe("a reply that does not render the prompt's answers still carries them", () => {
  it("a transition and a status reply of the dispatching session show the held PARENT-ANSWER line", async () => {
    const dir = createFixtureDir({
      disp: {
        initial: "plan",
        states: {
          plan: { prompt: "plan", transitions: { go: "collect" } },
          collect: { prompt: "collect", transitions: { end: "fin" } },
          fin: { terminal: true, outcome: "complete" },
        },
      },
      task: {
        initial: "claim",
        states: {
          claim: { prompt: "claim", transitions: { stop: "fin" } },
          fin: { terminal: true, outcome: "complete" },
        },
      },
    });
    dirs.push(dir);
    const loader = new Loader(null, dir, null);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, loader, new Executor());
    const handlers = new Map<
      string,
      (args: object) => Promise<{ content: Array<{ text: string }> }>
    >();
    const server = {
      registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h),
    };
    registerTools(server as never, engine, {} as never, loader, storage);
    const call = async (name: string, args: object): Promise<string> =>
      (await handlers.get(name)!(args)).content[0].text;
    const d = /SESSION: (\w+)/.exec(await call("start", { workflow: "disp", reply: "id" }))![1];
    const p = /SESSION: (\w+)/.exec(
      await call("start", {
        workflow: "task",
        reply: "id",
        parent_session_id: d,
        context: { task: "T1" },
      }),
    )![1];
    await call("context_set", { session_id: d, key: "tasks", value: `T1=${p} driver=drv1` });
    await call("context_set", { session_id: p, key: "parent_answer", value: ANSWER });
    const line = `PARENT-ANSWER: task=T1 session=${p} driver=drv1: ${ANSWER}`;
    expect(await call("transition", { session_id: d, transition: "go" })).toContain(line);
    expect(await call("status", { session_id: d })).toContain(line);
    await call("context_set", { session_id: p, key: "parent_answer", value: "" });
    expect(await call("status", { session_id: d })).not.toContain("PARENT-ANSWER:");
  });
});

describe("the NEEDS-PARENT prompt the parent sees", () => {
  it("does not tell the parent to SendMessage the task's driver", async () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-parent-answer-blk-"));
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
    expect(block).not.toMatch(/answer THAT driver directly: SendMessage to the `driver=` id/u);
    expect(block).toContain("parent_answer");
  });
});
