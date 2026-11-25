import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, cleanupDir } from "./test-helpers.js";

// ENG-DISPATCHER-SURFACES-STALE-TASKS: a stale task session at the dispatcher's `collect` is one
// NEEDS-PARENT line (task, session, state, idle time, linked agent), not a bare STALE line.
const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

describe("dispatcher collect with a stale task session", () => {
  const setup = async (idleH: number, header = ""): Promise<{ prompt: string; sid: string }> => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-stale-"));
    dirs.push(d);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, new Loader(TEMPLATES, d, null), new Executor());
    const disp = await engine.start("batch");
    const dcur = storage.read(disp.sessionId)!;
    dcur.stack[dcur.active_frame].current_state = "collect";
    const queue = path.join(d, "queue.yaml");
    fs.writeFileSync(queue, `batch_size: 2\n${header}tasks:\n  - id: T1\n    status: running\n`);
    dcur.context.queue_file = queue;
    await storage.write(disp.sessionId, dcur);

    const task = await engine.start("batch-task", undefined, disp.sessionId, d, undefined, {
      task: "T1",
    });
    const tcur = storage.read(task.sessionId)!;
    tcur.stack[tcur.active_frame].current_state = "work";
    await storage.write(task.sessionId, {
      ...tcur,
      agent_id: "worker1",
      updated_at: new Date(Date.now() - idleH * 3600 * 1000).toISOString(),
    });

    return { prompt: engine.getStatus(disp.sessionId).prompt, sid: task.sessionId };
  };

  it("surfaces it as a NEEDS-PARENT line", async () => {
    const { prompt, sid } = await setup(17);
    expect(prompt).toMatch(new RegExp(`NEEDS-PARENT task=T1 session=${sid} .*state=work.*worker1`));
  });

  it("raises none below the default threshold of 60 minutes, the STALE line stays", async () => {
    const { prompt } = await setup(0.75);
    expect(prompt).toContain("STALE: session");
    expect(prompt).not.toContain("NEEDS-PARENT task=T1");
  });

  it("takes the threshold from the queue header's stale_task_after (minutes)", async () => {
    const quiet = await setup(17, "stale_task_after: 1200\n");
    expect(quiet.prompt).not.toContain("NEEDS-PARENT task=T1");
    const loud = await setup(2, "stale_task_after: 90\n");
    expect(loud.prompt).toContain("NEEDS-PARENT task=T1");
  });
});
