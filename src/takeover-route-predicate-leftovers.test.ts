import { spawn } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { formatResume } from "./tools.js";
import { cliLoader, pickupReport } from "./session-cli.js";
import type { Storage } from "./storage.js";
import { InMemoryStorage, cleanupDir, createTestLoader } from "./test-helpers.js";

const TASK = {
  initial: "work",
  driver: { model: "haiku", effort: "low", prompt_ref: "task-driver" },
  states: {
    work: { prompt: "work", transitions: { routed: "plan_route" } },
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

async function kill(storage: InMemoryStorage, ids: string[]): Promise<void> {
  const dead = spawn("true");
  await new Promise(r => dead.on("exit", r));
  for (const id of ids) {
    const s = storage.read(id)!;
    await storage.write(id, {
      ...s,
      claude_session_id: "conv",
      context: { ...s.context, claude_code_pid: dead.pid! },
    });
  }
}

it("CLI pickup report: worker linked at work is this visit's agent at plan_spawn", async () => {
  const storage = new InMemoryStorage();
  const { loader, dir } = createTestLoader({ task: TASK, child: CHILD });
  dirs.push(dir);
  const engine = new Engine(storage, loader, new Executor());
  const p = (await engine.start("task")).sessionId;
  const w = (await engine.start("child", undefined, p)).sessionId;
  await engine.linkAgent(w, "aebad64149cc767ba");
  await engine.transition(p, "routed");
  await kill(storage, [p, w]);
  await engine.reapOrphanedSessions();
  const text = await pickupReport(
    storage as unknown as Storage,
    "conv",
    process.pid,
    undefined,
    s => engine.routeTest(s),
  );
  expect(text).toContain(w);
  expect(text).not.toContain("an earlier step's agent");
});

it("formatResume: a grandchild is judged by its own parent's workflow routes", async () => {
  const storage = new InMemoryStorage();
  // the resumed root's workflow has an exec state `plan_route`; the mid workflow's `plan_route` is a plain step
  const ROOT = {
    initial: "idle",
    states: {
      idle: { prompt: "i", transitions: { x: "plan_route" } },
      plan_route: { type: "exec", command: "true", on_success: "fin", on_error: "fin" },
      fin: { terminal: true },
    },
  };
  const MID = {
    initial: "a",
    driver: { model: "haiku", effort: "low", prompt_ref: "task-driver" },
    states: {
      a: { prompt: "a", transitions: { next: "plan_route" } },
      plan_route: { prompt: "r", transitions: { next: "plan_spawn" } },
      plan_spawn: { prompt: "m", transitions: { done: "fin" } },
      fin: { terminal: true },
    },
  };
  const { loader, dir } = createTestLoader({ root: ROOT, mid: MID, child: CHILD });
  dirs.push(dir);
  const engine = new Engine(storage, loader, new Executor());
  const r = (await engine.start("root")).sessionId;
  const m = (await engine.start("mid", undefined, r)).sessionId;
  await engine.transition(m, "next");
  const g = (await engine.start("child", undefined, m)).sessionId;
  await engine.linkAgent(g, "a27b2b200b4920595");
  await engine.transition(m, "next");
  await kill(storage, [r, m, g]);
  await engine.reapOrphanedSessions();
  const text = formatResume(await new Engine(storage, loader, new Executor()).resume(r));
  expect(text).not.toContain("an earlier step's agent");
  expect(text).toContain(`SendMessage({ to: "a27b2b200b4920595"`);
});

it("pickupReport with a loader that lacks the parent's workflow still returns the report", async () => {
  const storage = new InMemoryStorage();
  const { loader, dir } = createTestLoader({ task: TASK, child: CHILD });
  dirs.push(dir);
  const engine = new Engine(storage, loader, new Executor());
  const p = (await engine.start("task")).sessionId;
  const w = (await engine.start("child", undefined, p)).sessionId;
  await engine.linkAgent(w, "aebad64149cc767ba");
  await engine.transition(p, "routed");
  await kill(storage, [p, w]);
  await engine.reapOrphanedSessions();
  const { loader: empty, dir: dir2 } = createTestLoader({ other: CHILD });
  dirs.push(dir2);
  const blind = new Engine(storage, empty, new Executor());
  const text = await pickupReport(
    storage as unknown as Storage,
    "conv",
    process.pid,
    undefined,
    s => blind.routeTest(s),
  );
  expect(text).toContain(p);
});

it("cliLoader reads the workflow dir the server reads (WORKFLOW_DIR)", () => {
  const { dir } = createTestLoader({ task: TASK });
  dirs.push(dir);
  const old = process.env["WORKFLOW_DIR"];
  process.env["WORKFLOW_DIR"] = dir;
  try {
    expect(cliLoader().get("task")).toBeDefined();
  } finally {
    if (old === undefined) delete process.env["WORKFLOW_DIR"];
    else process.env["WORKFLOW_DIR"] = old;
  }
});
