import { spawn } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { formatResume } from "./tools.js";
import { InMemoryStorage, cleanupDir, createTestLoader } from "./test-helpers.js";

const TASK = {
  initial: "work",
  driver: { model: "haiku", effort: "low", prompt_ref: "task-driver" },
  states: {
    work: { prompt: "work", transitions: { plan: "plan_spawn", routed: "plan_route" } },
    plan_route: { type: "exec", command: "true", on_success: "plan_spawn", on_error: "plan_spawn" },
    plan_spawn: { prompt: "plan", transitions: { done: "fin" } },
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

it.each([["plan"], ["routed"]])(
  "restart at plan_spawn via %s: a worker linked at work is this visit's agent",
  async via => {
    const storage = new InMemoryStorage();
    const { loader, dir } = createTestLoader({ task: TASK, child: CHILD });
    dirs.push(dir);
    const engine = new Engine(storage, loader, new Executor());
    const p = (await engine.start("task")).sessionId;
    const w = (await engine.start("child", undefined, p)).sessionId;
    await engine.linkAgent(w, "worker1");
    await engine.transition(p, via);
    const dead = spawn("true");
    await new Promise(r => dead.on("exit", r));
    for (const id of [p, w]) {
      const s = storage.read(id)!;
      await storage.write(id, {
        ...s,
        claude_session_id: "conv",
        context: { ...s.context, claude_code_pid: dead.pid! },
      });
    }
    await engine.reapOrphanedSessions();
    const text = formatResume(await new Engine(storage, loader, new Executor()).resume(p));
    expect(text).not.toContain("an earlier step's agent");
    expect(text).toContain("worker1 → " + w);
    expect(text).toContain(`SendMessage({ to: "worker1"`);
  },
);
