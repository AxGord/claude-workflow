import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, cleanupDir } from "./test-helpers.js";
import { agentContextOf } from "./spend.js";

// ENG-LINK-AGENT-ROLE: task-driver.md has the driver link_agent its worker onto the task session
// too; the later link overwrites agent_id, so every line that names the session's driver names the worker.
const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
const DRIVER = "a1111111111111111";
const WORKER = "a2222222222222222";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

describe("link_agent: a worker linked after the driver", () => {
  const setup = async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-role-"));
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
    await engine.linkAgent(task.sessionId, DRIVER); // the dispatcher's link: the driver
    await engine.linkAgent(task.sessionId, WORKER); // the driver's link of its worker
    return { storage, engine, disp: disp.sessionId, sid: task.sessionId };
  };

  it("the session's agent_id stays the driver, the worker joins linked_agents", async () => {
    const { storage, sid } = await setup();
    expect(storage.read(sid)!.linked_agents).toEqual([DRIVER, WORKER]);
    expect(storage.read(sid)!.agent_id).toBe(DRIVER);
  });

  it("a stale task's STALE and NEEDS-PARENT lines name the driver, not the worker", async () => {
    const { storage, engine, disp, sid } = await setup();
    const cur = storage.read(sid)!;
    cur.stack[cur.active_frame].current_state = "work";
    await storage.write(sid, {
      ...cur,
      updated_at: new Date(Date.now() - 17 * 3600 * 1000).toISOString(),
    });
    const lines = engine.staleLines(disp, true).join("\n");
    expect(lines).toContain(`NEEDS-PARENT task=T1 session=${sid}`);
    expect(lines).toContain(`agent=${DRIVER} `);
    expect(lines).not.toMatch(new RegExp(`(agent|driver)=${WORKER}`));
    expect(lines).not.toContain("waiting on");
  });
});

describe("link_agent role", () => {
  const setup = async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-role-"));
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
    return { d, storage, engine, disp: disp.sessionId, sid: task.sessionId };
  };

  it("an explicit worker link never takes agent_id, even as the first link", async () => {
    const { storage, engine, sid } = await setup();
    await engine.linkAgent(sid, WORKER, "worker");
    expect(storage.read(sid)!.agent_id).toBeUndefined();
    expect(storage.read(sid)!.linked_agents).toEqual([WORKER]);
    await engine.linkAgent(sid, DRIVER, "driver");
    expect(storage.read(sid)!.agent_id).toBe(DRIVER);
  });

  it("an explicit driver link replaces the driver (a respawn), the worker stays recorded", async () => {
    const { storage, engine, sid } = await setup();
    const DRIVER2 = "a3333333333333333";
    await engine.linkAgent(sid, DRIVER);
    await engine.linkAgent(sid, WORKER, "worker");
    await engine.linkAgent(sid, DRIVER2, "driver");
    const cur = storage.read(sid)!;
    expect(cur.agent_id).toBe(DRIVER2);
    expect(cur.linked_agents).toEqual([DRIVER, WORKER, DRIVER2]);
    expect(cur.agent_links!.map(l => [l.agent_id, l.role])).toEqual([
      [DRIVER, "driver"],
      [WORKER, "worker"],
      [DRIVER2, "driver"],
    ]);
  });

  it("a non-driver link records no agent_step; the driver link keeps its own", async () => {
    const { storage, engine, sid } = await setup();
    await engine.linkAgent(sid, DRIVER);
    const before = storage.read(sid)!.agent_step;
    await engine.linkAgent(sid, WORKER, "worker");
    expect(storage.read(sid)!.agent_step).toEqual(before);
  });

  it("a malformed role is refused", async () => {
    const { engine, sid } = await setup();
    await expect(engine.linkAgent(sid, WORKER, "Worker One")).rejects.toThrow(/not a role/u);
  });

  it("the worker's own step is on its agent_links row", async () => {
    const { storage, engine, sid } = await setup();
    await engine.linkAgent(sid, DRIVER);
    await engine.linkAgent(sid, WORKER, "worker");
    const row = storage.read(sid)!.agent_links!.find(l => l.agent_id === WORKER)!;
    const f = storage.read(sid)!.stack[0];
    expect(row.step).toEqual({
      workflow: f.workflow,
      state: f.current_state,
      visit: f.state_visits[f.current_state] ?? 0,
    });
  });

  it("the UNANSWERED line names the driver after a worker was linked", async () => {
    const { engine, disp, sid } = await setup();
    await engine.linkAgent(sid, DRIVER, "driver");
    await engine.linkAgent(sid, WORKER, "worker");
    await engine.setContext(sid, "ask_parent", "which design?");
    const lines = engine.unansweredAskLines(disp, Date.now() + 3_600_000).join("\n");
    expect(lines).toContain(`driver=${DRIVER}`);
    expect(lines).not.toContain(WORKER);
  });

  it("status of the task lists a worker linked onto it, current at its visit", async () => {
    const { engine, sid } = await setup();
    await engine.linkAgent(sid, DRIVER, "driver");
    await engine.linkAgent(sid, WORKER, "worker");
    const lines = engine.linkedAgentLines(sid);
    expect(lines.join("\n")).toContain(`agent ${WORKER} (worker, linked to this session itself)`);
    expect(lines.join("\n")).toContain("→ current");
    expect(lines.join("\n")).not.toContain(DRIVER);
  });

  it("the worker's context is read from the worker's transcript, not the driver's", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-role-ctx-"));
    dirs.push(root);
    const dir = path.join(root, "proj", "conv", "subagents");
    fs.mkdirSync(dir, { recursive: true });
    const turn = (n: number) =>
      JSON.stringify({
        type: "assistant",
        message: {
          id: "m",
          model: "x",
          usage: { input_tokens: n, output_tokens: 1 },
        },
      });
    fs.writeFileSync(path.join(dir, `agent-${DRIVER}.jsonl`), turn(1000));
    fs.writeFileSync(path.join(dir, `agent-${WORKER}.jsonl`), turn(90000));
    const link = (agent_id: string, role: string) => ({
      agent_id,
      at: "2026-11-25T00:00:00Z",
      role,
    });
    const base = { claude_session_id: "conv" };
    expect(
      agentContextOf(
        {
          ...base,
          agent_id: DRIVER,
          agent_links: [link(DRIVER, "driver"), link(WORKER, "worker")],
        },
        root,
      ),
    ).toBe(90000);
    expect(
      agentContextOf({ ...base, agent_id: DRIVER, agent_links: [link(DRIVER, "driver")] }, root),
    ).toBe(1000);
  });
});
