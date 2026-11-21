import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, cleanupDir, createFixtureDir } from "./test-helpers.js";
import { registerTools } from "./tools.js";

// ENG-DRIVER-KNOWS-ITS-DISPATCHER: a task session started by a dispatcher carries the dispatcher's
// agent id, so a driver can check a relayed decision's sender against status(key: "dispatcher_agent").

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
const dirs: string[] = [];
beforeEach(() => {
  process.env.WF_T_DISP = "1";
  process.env.WF_DISPATCHER = "1";
});
afterEach(() => {
  delete process.env.WF_T_DISP;
  delete process.env.WF_DISPATCHER;
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const FIXTURE = {
  disp: {
    initial: "plan",
    dispatcher: {
      model: "haiku",
      effort: "low",
      prompt_ref: "dispatch-driver",
      env: "WF_T_DISP",
    },
    states: {
      plan: { prompt: "plan", transitions: { go: "fin" } },
      fin: { terminal: true, outcome: "complete" },
    },
  },
  task: {
    initial: "claim",
    states: {
      claim: { prompt: "claim", transitions: { go: "done" } },
      done: { terminal: true, outcome: "complete" },
    },
  },
};

describe("a task session started by a dispatcher", () => {
  it("carries the dispatcher's agent id as `dispatcher_agent`", async () => {
    const dir = createFixtureDir(FIXTURE);
    dirs.push(dir);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, new Loader(TEMPLATES, dir, null), new Executor());
    const handlers = new Map<
      string,
      (a: object) => Promise<{ content: Array<{ text: string }> }>
    >();
    registerTools(
      { registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h) } as never,
      engine,
      {} as never,
      new Loader(TEMPLATES, dir, null),
      storage,
    );
    const call = async (n: string, a: object) => (await handlers.get(n)!(a)).content[0].text;
    const d = /SESSION: (\w+)/.exec(await call("start", { workflow: "disp", reply: "id" }))![1];
    await call("link_agent", { session_id: d, agent_id: "ae7ba885586291184" });
    const p = /SESSION: (\w+)/.exec(
      await call("start", {
        workflow: "task",
        reply: "id",
        parent_session_id: d,
        context: { task: "T1" },
      }),
    )![1];
    const status = await call("status", { session_id: p, key: "dispatcher_agent" });
    expect(storage.read(p)!.context.dispatcher_agent).toBe("ae7ba885586291184");
    expect(status).toContain("ae7ba885586291184");
    // a respawned dispatcher replaces the id in its live task sessions
    await call("link_agent", { session_id: d, agent_id: "ab12cd34ef567890a" });
    expect(storage.read(p)!.context.dispatcher_agent).toBe("ab12cd34ef567890a");
  });

  it.each(["templates/drivers/task-driver.md", "agents/driver.md"])("%s names the key", f => {
    const t = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    expect(t).toContain('key: "dispatcher_agent"');
    expect(t).toContain("key is unset");
  });
});
