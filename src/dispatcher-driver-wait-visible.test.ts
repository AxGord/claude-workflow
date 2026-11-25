import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, cleanupDir } from "./test-helpers.js";

// ENG-DISPATCHER-WAKES-DRIVER-ONLY: a task driver ends its turn on WAITING (its worker still runs), which
// Claude Code never delivers to the dispatcher. The dispatcher's `collect` prompt is then all it has: it must
// show that the quiet task session is waiting on a live worker, else it pings and re-spawns the driver.
const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

describe("dispatcher collect with a quiet task session whose driver waits on its worker", () => {
  it("shows the wait on the live worker beside the STALE line", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-wait-"));
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
    const tcur = storage.read(task.sessionId)!;
    tcur.stack[tcur.active_frame].current_state = "work";
    await storage.write(task.sessionId, tcur);
    await engine.linkAgent(task.sessionId, "a1d00000000000001", "driver");
    await engine.linkAgent(task.sessionId, "a2e00000000000002", "worker");
    const aged = storage.read(task.sessionId)!;
    await storage.write(task.sessionId, {
      ...aged,
      updated_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    });

    const prompt = engine.getStatus(disp.sessionId).prompt;
    const stale = prompt.split("\n").filter(l => l.startsWith("STALE: session " + task.sessionId));
    expect(stale.length).toBe(1);
    expect(stale[0]).toContain("a1d00000000000001");
    expect(stale[0]).toMatch(/waiting on|worker a2e00000000000002/);
  });

  it("shows no wait for a worker of an earlier state", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-wait-"));
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
    const tcur = storage.read(task.sessionId)!;
    tcur.stack[tcur.active_frame].current_state = "work";
    await storage.write(task.sessionId, tcur);
    await engine.linkAgent(task.sessionId, "a1d00000000000001", "driver");
    await engine.linkAgent(task.sessionId, "a2e00000000000002", "worker");
    const moved = storage.read(task.sessionId)!;
    moved.stack[moved.active_frame].current_state = "review";
    await storage.write(task.sessionId, {
      ...moved,
      updated_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    });
    const prompt = engine.getStatus(disp.sessionId).prompt;
    const stale = prompt.split("\n").filter(l => l.startsWith("STALE: session " + task.sessionId));
    expect(stale.length).toBe(1);
    expect(stale[0]).not.toContain("waiting on");
  });
});
