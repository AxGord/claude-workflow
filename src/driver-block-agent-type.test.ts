import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DRIVER_AGENT_TYPE, renderDriverCall } from "./driver.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { cleanupDir, createFixtureDir, createTestEngine } from "./test-helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

function call(driver: Record<string, string>): string {
  return renderDriverCall({
    driver: driver as never,
    sessionId: "S1",
    task: "T",
    queueFile: undefined,
    instructions: "/x/driver.md",
    instructionsExist: true,
  });
}

const TASK = {
  initial: "claim",
  driver: { model: "haiku", effort: "low", prompt_ref: "task-driver" },
  states: {
    claim: { prompt: "claim", transitions: { go: "done" } },
    done: { terminal: true, outcome: "complete" },
  },
};

describe("rendered driver call names the agent type", () => {
  it("contains subagent_type: workflow:driver by default, on the call's own line", () => {
    const out = call({ model: "sonnet", effort: "low" });
    expect(out).toContain('subagent_type: "workflow:driver"');
    expect(out).toContain(
      'model: sonnet, effort: low, run_in_background: true, subagent_type: "workflow:driver", description: "drive T", prompt:',
    );
  });

  it("the default is the plugin's shipped agent", () => {
    expect(DEFAULT_DRIVER_AGENT_TYPE).toBe("workflow:driver");
    const md = fs.readFileSync(path.join(ROOT, "agents", "driver.md"), "utf8");
    expect(md).toMatch(/^name: driver$/m);
  });

  it("driver.agent_type overrides it", () => {
    const out = call({ model: "m", effort: "low", agent_type: "proj:slice-driver" });
    expect(out).toContain('subagent_type: "proj:slice-driver"');
    expect(out).not.toContain("workflow:driver");
  });

  it("the loader accepts agent_type and refuses an empty one; a heir inherits it", () => {
    const orig = console.error;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    let loader: Loader;
    try {
      const dir = createFixtureDir({
        ok: { ...TASK, driver: { ...TASK.driver, agent_type: "proj:d" } },
        empty: { ...TASK, driver: { ...TASK.driver, agent_type: "" } },
        heir: { extends: "ok" },
      });
      dirs.push(dir);
      loader = new Loader(null, dir, null);
    } finally {
      console.error = orig;
    }
    expect(loader.names().sort()).toEqual(["heir", "ok"]);
    expect(loader.get("heir")?.driver?.agent_type).toBe("proj:d");
    expect(errors.join("\n")).toContain("agent_type");
  });

  it("start answers with the block carrying the type", async () => {
    const { engine } = createTestEngine({
      task: TASK,
      parent: {
        initial: "run",
        states: { run: { prompt: "run", transitions: { end: "fin" } }, fin: { terminal: true } },
      },
    });
    const p = await engine.start("parent");
    const s = await engine.start("task", undefined, p.sessionId);
    expect(s.driverCall).toContain('subagent_type: "workflow:driver"');
  });
});

// The default driver type has no shell: the shipped batch-task asks the driver to run none.
const TEMPLATES = path.join(ROOT, "templates");
const batchTask = () =>
  new Loader(TEMPLATES, fs.mkdtempSync(path.join(os.tmpdir(), "wf-bt-")), null).get("batch-task")!;

describe("batch-task under the shell-less workflow:driver", () => {
  it("no prompt state asks the driver for a shell command (agent prompts, indented, are not the driver's)", () => {
    const offenders: string[] = [];
    for (const [name, def] of Object.entries(batchTask().states)) {
      if (def.type === "exec" || !def.prompt) continue;
      for (const line of def.prompt.split("\n")) {
        if (/^ {3,}/.test(line)) continue;
        if (/\bgit\b|--porcelain|\bgrep\b|\bcat\b|\bls\b/.test(line))
          offenders.push(`${name}: ${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the verification and the repo state are exec states", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-bt-")));
    dirs.push(root);
    const repo = path.join(root, "proj");
    fs.mkdirSync(repo);
    const git = (cwd: string, ...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
        cwd,
        encoding: "utf8",
      }).trim();
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    const wt = path.join(root, "wt");
    git(repo, "worktree", "add", "-q", wt, "-b", "batch/T1");
    const vars = { context: { task: "T1", cwd: repo, wt } };
    const bt = batchTask();
    const run = (name: string) =>
      new Executor().execute({ ...bt.states[name], resource: undefined }, vars, { cwd: repo });
    expect(bt.states.work.transitions).toMatchObject({ check: "work_check" });
    expect((await run("work_check")).exit_code).toBe(1);
    fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
    expect((await run("work_check")).exit_code).toBe(1);
    git(wt, "add", ".");
    git(wt, "commit", "-qm", "work");
    const ok = await run("work_check");
    expect(ok.exit_code).toBe(0);
    expect(ok.stdout).toContain("commits on batch/T1 beyond HEAD: 1");
    const timeout = await run("land_timeout");
    expect(timeout.exit_code).toBe(0);
    git(repo, "merge", "-q", "--no-ff", "-m", "merge", "batch/T1");
    expect((await run("land_timeout")).exit_code).not.toBe(0);
    const st = await run("stop_state");
    expect(st.exit_code).toBe(0);
    expect(st.stdout).toContain("merge");
  });
});
