import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { registerTools } from "./tools.js";
import { InMemoryStorage, cleanupDir, createTestLoader } from "./test-helpers.js";

// work -> plan_spawn: the worker is linked while the parent stands at `work`; the re-spawned driver
// then reads status at `plan_spawn` and must see that live worker, else it spawns a second one.
const TASK = {
  initial: "work",
  driver: { model: "haiku", effort: "medium", prompt_ref: "task-driver" },
  states: {
    work: { prompt: "work", transitions: { next: "plan_spawn", other: "gate" } },
    gate: { prompt: "gate", transitions: { done: "fin" } },
    plan_spawn: { prompt: "plan_spawn", transitions: { done: "fin" } },
    fin: { terminal: true, outcome: "complete" },
  },
};
// the real pipelines: recon, then work -> plan_route (exec) -> plan_spawn; a warm review that gives no verdict -> review_spawn
const PIPE = {
  initial: "recon_spawn",
  driver: { model: "haiku", effort: "medium", prompt_ref: "task-driver" },
  states: {
    recon_spawn: { prompt: "recon", transitions: { skip: "work" } },
    work: { prompt: "work", transitions: { started: "plan_route" } },
    plan_route: { type: "exec", command: "true", on_success: "plan_spawn", on_error: "plan_spawn" },
    plan_spawn: { prompt: "plan_spawn", transitions: { done: "review" } },
    review: { prompt: "review", transitions: { warm: "review_warm" } },
    review_warm: { prompt: "review_warm", transitions: { no_verdict: "review_spawn" } },
    review_spawn: { prompt: "review_spawn", transitions: { done: "fin" } },
    fin: { terminal: true, outcome: "complete" },
  },
};
const CHILD = {
  initial: "go",
  states: { go: { prompt: "go", transitions: { end: "fin" } }, fin: { terminal: true } },
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const tick = () => new Promise<void>(r => setTimeout(r, 8));

function mount(task: object = TASK) {
  const storage = new InMemoryStorage();
  const { loader, dir } = createTestLoader({ task, child: CHILD });
  dirs.push(dir);
  const engine = new Engine(storage, loader, new Executor());
  type Handler = (a: object) => Promise<{ content: Array<{ text: string }> }>;
  const handlers = new Map<string, Handler>();
  const server = { registerTool: (n: string, _c: unknown, h: Handler) => handlers.set(n, h) };
  registerTools(server as never, engine, {} as never, loader, storage);
  const call = async (n: string, a: object) => (await handlers.get(n)!(a)).content[0].text;
  return { engine, call };
}

describe("ENG-DRIVER-ENFORCE-MIDRUN-WAIT", () => {
  it("a worker linked at work and still running is listed by status at plan_spawn", async () => {
    const { engine, call } = mount();
    const p = (await engine.start("task")).sessionId;
    const w = (await engine.start("child", undefined, p)).sessionId;
    await call("link_agent", { session_id: w, agent_id: "worker1" });
    await engine.transition(p, "next");

    const status = await call("status", { session_id: p });
    expect(status).toContain("plan_spawn");
    expect(status).toContain("LINKED AGENTS");
    expect(status).toContain("worker1");
    expect(status).toContain("live (its session still runs)");
    expect(engine.linkedAgentLines(p).join("\n")).toContain("worker1");
  });

  it("an ended worker is not listed at a spawn state, nor a running one at a state that is no spawn state", async () => {
    const ended = mount();
    const p = (await ended.engine.start("task")).sessionId;
    const w = (await ended.engine.start("child", undefined, p)).sessionId;
    await ended.call("link_agent", { session_id: w, agent_id: "worker1" });
    await ended.engine.transition(w, "end");
    await ended.engine.transition(p, "next");
    expect(ended.engine.linkedAgentLines(p)).toEqual([]);

    const other = mount();
    const q = (await other.engine.start("task")).sessionId;
    const x = (await other.engine.start("child", undefined, q)).sessionId;
    await other.call("link_agent", { session_id: x, agent_id: "w2" });
    await other.engine.transition(q, "other");
    expect(other.engine.linkedAgentLines(q)).toEqual([]);
  });

  it("a worker linked at work is listed at plan_spawn through the exec plan_route; a recon agent linked at recon_spawn is not", async () => {
    const { engine, call } = mount(PIPE);
    const p = (await engine.start("task")).sessionId;
    const recon = (await engine.start("child", undefined, p)).sessionId;
    await call("link_agent", { session_id: recon, agent_id: "recon1" });
    await tick();
    await engine.transition(p, "skip");
    await tick();
    const w = (await engine.start("child", undefined, p)).sessionId;
    await call("link_agent", { session_id: w, agent_id: "worker1" });
    await tick();
    await engine.transition(p, "started");
    const at = engine.linkedAgentLines(p).join("\n");
    expect(at).toContain("plan_spawn");
    expect(at).toContain("worker1");
    expect(at).not.toContain("recon1");
  });

  it("a recon agent linked at recon_spawn is not listed at plan_spawn when no worker was linked", async () => {
    const { engine, call } = mount(PIPE);
    const p = (await engine.start("task")).sessionId;
    const recon = (await engine.start("child", undefined, p)).sessionId;
    await call("link_agent", { session_id: recon, agent_id: "recon1" });
    await tick();
    await engine.transition(p, "skip");
    await tick();
    await engine.transition(p, "started");
    expect(engine.linkedAgentLines(p)).toEqual([]);
  });

  it("a warm reviewer linked at review_warm, started at an earlier state, is not listed at review_spawn", async () => {
    const { engine, call } = mount(PIPE);
    const p = (await engine.start("task")).sessionId;
    await engine.transition(p, "skip");
    await engine.transition(p, "started");
    await engine.transition(p, "done");
    await tick();
    const r = (await engine.start("child", undefined, p)).sessionId;
    await tick();
    await engine.transition(p, "warm");
    await tick();
    await call("link_agent", { session_id: r, agent_id: "rev1" });
    await tick();
    await engine.transition(p, "no_verdict");
    expect(engine.linkedAgentLines(p)).toEqual([]);
  });

  it("both driver instruction files answer a hand-back enforce prompt mid-run with the WAITING line and name the live agent", () => {
    for (const f of ["agents/driver.md", "templates/drivers/task-driver.md"]) {
      const md = fs.readFileSync(path.resolve(f), "utf8").replace(/\s+/g, " ");
      expect(md).toContain(
        "A harness prompt `[handback-send-enforce] Your report has not been delivered…` that arrives while P has not ended (not terminal) AND your last line is a WAITING line (you await an agent) is NOT a request to hand back: answer it with the WAITING line only",
      );
      expect(md).toContain('"The worker is still running" is never a reason to hand back');
      expect(md).toContain(
        "At a `_spawn` state (`work_spawn`, `plan_spawn`) the status also lists, as `live`, the running agent linked at the state P stood at just before it",
      );
    }
  });
});
