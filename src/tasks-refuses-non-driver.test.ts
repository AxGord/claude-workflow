import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, cleanupDir } from "./test-helpers.js";
import { registerTools } from "./tools.js";

// ENG-TASKS-REFUSES-NON-DRIVER: a write of the dispatcher's `tasks` key naming a worker as the driver of a task
// session must be refused, with the task session's linked driver named; the write naming the driver passes.
const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
const DRIVER = "a1111111111111111";
const WORKER = "a2222222222222222";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

async function mount() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-tasks-"));
  dirs.push(d);
  const storage = new InMemoryStorage();
  const engine = new Engine(storage, new Loader(TEMPLATES, d, null), new Executor());
  type Handler = (args: object) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  const handlers = new Map<string, Handler>();
  const server = { registerTool: (name: string, _c: unknown, h: Handler) => handlers.set(name, h) };
  registerTools(server as never, engine, {} as never, new Loader(TEMPLATES, d, null), storage);
  const call = async (name: string, args: object) => {
    const r = await handlers.get(name)!(args);
    return { text: r.content[0].text, isError: r.isError === true };
  };
  const disp = await engine.start("batch");
  const dcur = storage.read(disp.sessionId)!;
  dcur.stack[dcur.active_frame].current_state = "dispatch";
  await storage.write(disp.sessionId, dcur);
  const task = await engine.start("batch-task", undefined, disp.sessionId, d, undefined, {
    task: "T1",
  });
  await call("link_agent", { session_id: task.sessionId, agent_id: DRIVER, role: "driver" });
  await call("link_agent", { session_id: task.sessionId, agent_id: WORKER, role: "worker" });
  return { storage, call, disp: disp.sessionId, task: task.sessionId };
}

describe("the dispatcher's `tasks` key", () => {
  it("context_set refuses an entry whose driver= is a worker, naming the linked driver", async () => {
    const { storage, call, disp, task } = await mount();
    const r = await call("context_set", {
      session_id: disp,
      key: "tasks",
      value: `T1=${task} driver=${WORKER}`,
      force: true,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(DRIVER);
    expect(storage.read(disp)!.context.tasks).toBeUndefined();
  });

  it("a transition `set` of `tasks` refuses it the same way and writes nothing", async () => {
    const { storage, call, disp, task } = await mount();
    const r = await call("transition", {
      session_id: disp,
      transition: "dispatched",
      set: { tasks: `T1=${task} driver=${WORKER}` },
      force: true,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(DRIVER);
    expect(storage.read(disp)!.context.tasks).toBeUndefined();
  });

  it("an entry naming the linked driver passes", async () => {
    const { storage, call, disp, task } = await mount();
    const r = await call("context_set", {
      session_id: disp,
      key: "tasks",
      value: `T1=${task} driver=${DRIVER}`,
      force: true,
    });
    expect(r.isError).toBeFalsy();
    expect(storage.read(disp)!.context.tasks).toBe(`T1=${task} driver=${DRIVER}`);
  });

  it("`driver=-` is not checked", async () => {
    const { storage, call, disp, task } = await mount();
    const r = await call("context_set", {
      session_id: disp,
      key: "tasks",
      value: `T1=${task} driver=-`,
      force: true,
    });
    expect(r.isError).toBeFalsy();
    expect(storage.read(disp)!.context.tasks).toBe(`T1=${task} driver=-`);
  });
});
