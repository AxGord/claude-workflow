import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { afterEach, expect, it, vi } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Storage } from "./storage.js";
import { cliLoader, cliReport } from "./session-cli.js";
import { cleanupDir, trustStoreFor } from "./test-helpers.js";
import { workflowDirs, workflowLoader } from "./workflow-dirs.js";

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

const tmp: string[] = [];
function mkdtemp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-loader-owner-"));
  tmp.push(d);
  return d;
}
/** A project with `.claude/workflows/<name>.yaml` per workflow, and an empty global dir. */
function project(workflows: Record<string, object>): {
  cwd: string;
  global: string;
  state: string;
} {
  const cwd = mkdtemp();
  const dir = path.join(cwd, ".claude", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, def] of Object.entries(workflows))
    fs.writeFileSync(path.join(dir, `${name}.yaml`), YAML.stringify({ name, ...def }));
  // the user ran `wf-trust` on the project: the files' exec states are approved in the state dir
  const state = mkdtemp();
  const store = trustStoreFor(...fs.readdirSync(dir).map(f => path.join(dir, f)));
  fs.copyFileSync(store.file!, path.join(state, "trusted-workflows.json"));
  return { cwd, global: mkdtemp(), state };
}
function inProject(p: { cwd: string; global: string; state: string }): void {
  vi.spyOn(process, "cwd").mockReturnValue(p.cwd);
  vi.stubEnv("WORKFLOW_DIR", p.global);
  vi.stubEnv("STATE_DIR", p.state);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of tmp.splice(0)) cleanupDir(d);
});

it("the CLI loads the same workflow directories as the server for a project with a local .claude/workflows", () => {
  const p = project({ localonly: CHILD });
  inProject(p);
  const dirs = workflowDirs();
  expect(dirs.project).toBe(path.join(p.cwd, ".claude", "workflows"));
  expect(dirs.global).toBe(p.global);
  expect(cliLoader().get("localonly")).toBeDefined();
  expect(cliLoader().names().sort()).toEqual(workflowLoader().names().sort());
  expect(cliLoader().projectDir).toBe(workflowLoader().projectDir);
  expect(cliLoader().globalDir).toBe(workflowLoader().globalDir);
});

it("a project directory equal to the global one is loaded once (null project)", () => {
  const cwd = mkdtemp();
  const dir = path.join(cwd, ".claude", "workflows");
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.stubEnv("WORKFLOW_DIR", dir);
  expect(workflowDirs().project).toBeNull();
});

it("a relative WORKFLOW_DIR resolves against the cwd", () => {
  const cwd = mkdtemp();
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.stubEnv("WORKFLOW_DIR", "rel/wf");
  expect(workflowDirs().global).toBe(path.join(cwd, "rel", "wf"));
});

it("neither entry point repeats the directory resolution", () => {
  const src = (f: string): string => fs.readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
  for (const f of ["index.ts", "session-cli.ts"]) {
    expect(src(f), f).not.toContain('"workflows"');
    expect(src(f), f).not.toContain("new Loader(");
  }
});

it("`pickup` through the CLI entry judges routes by a workflow only the project declares", async () => {
  const p = project({ task: TASK, child: CHILD });
  inProject(p);
  const stateDir = mkdtemp();
  const storage = new Storage(stateDir, { eventLog: false });
  const engine = new Engine(storage, workflowLoader(), new Executor());
  const parent = (await engine.start("task")).sessionId;
  const worker = (await engine.start("child", undefined, parent)).sessionId;
  await engine.linkAgent(worker, "worker1");
  await engine.transition(parent, "routed");
  const elsewhere = mkdtemp();
  const dead = spawn("true");
  await new Promise(r => dead.on("exit", r));
  for (const id of [parent, worker]) {
    const s = storage.read(id)!;
    await storage.write(id, {
      ...s,
      claude_session_id: "conv",
      // the session's own cwd holds no project workflows: only the CLI's loader can know them
      context: { ...s.context, cwd: elsewhere, claude_code_pid: dead.pid! },
    });
  }
  await engine.reapOrphanedSessions();
  const text = await cliReport(["pickup", stateDir, "conv", String(process.pid)]);
  expect(text).toContain(parent);
  expect(text).toContain(worker);
  expect(text).not.toContain("an earlier step's agent");
});
