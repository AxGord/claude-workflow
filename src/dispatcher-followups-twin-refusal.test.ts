import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPAWN_DEPTH_ENV } from "./driver.js";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, cleanupDir, createFixtureDir } from "./test-helpers.js";
import { registerTools } from "./tools.js";

// ENG-DISPATCHER-FOLLOWUPS items 2, 3 and 12: the twin refusal, the rule for a `stopped` task, the full `dispatch` recipe.
// Item 2: the twin refusal names `key: "driver_call"`
// also when the twin's workflow has no `driver:`, so that call has no answer.

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["WF_T_DISP", SPAWN_DEPTH_ENV]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const WORKFLOWS = {
  disp: {
    initial: "plan",
    dispatcher: {
      model: "haiku",
      effort: "low",
      prompt_ref: "dispatch-driver",
      env: "WF_T_DISP",
      after: "plan",
    },
    states: {
      plan: { prompt: "plan", transitions: { ready: "fin" } },
      fin: { terminal: true, outcome: "complete" },
    },
  },
  // a task workflow WITH `driver:`
  drv: {
    initial: "claim",
    driver: { model: "haiku", effort: "low", prompt_ref: "task-driver" },
    states: {
      claim: { prompt: "claim", transitions: { go: "done" } },
      done: { terminal: true, outcome: "complete" },
    },
  },
  // a task workflow WITHOUT `driver:`
  task: {
    initial: "claim",
    states: {
      claim: { prompt: "claim", transitions: { go: "done" } },
      done: { terminal: true, outcome: "complete" },
    },
  },
};

async function twinOf(task: string) {
  process.env.WF_T_DISP = "1";
  const dir = createFixtureDir(WORKFLOWS);
  dirs.push(dir);
  const loader = new Loader(null, dir, null);
  const storage = new InMemoryStorage();
  const engine = new Engine(storage, loader, new Executor());
  const handlers = new Map<
    string,
    (a: object) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
  >();
  const server = {
    registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h),
  };
  registerTools(server as never, engine, {} as never, loader, storage);
  const call = async (n: string, a: object) => {
    const r = await handlers.get(n)!(a);
    return { isError: r.isError, text: r.content[0].text };
  };
  const id = (t: string) => /SESSION: (\w+)/.exec(t)![1];
  const d = id((await call("start", { workflow: "disp", reply: "id" })).text);
  const start = { workflow: task, reply: "id", parent_session_id: d, context: { task: "T1" } };
  const p = id((await call("start", start)).text);
  const twin = await call("start", start);
  return { loader, storage, p, twin, call };
}

describe("the twin refusal under a dispatcher session", () => {
  it("does not send the caller to a context key the twin never had", async () => {
    const { loader, storage, p, twin } = await twinOf("task");
    expect(loader.get("task")?.driver).toBeUndefined();
    expect(twin.isError).toBe(true);
    // no `driver:` -> no driver call to name: the refusal names the session and who drives it
    expect(twin.text).toContain(p);
    expect(twin.text).not.toContain("driver_call");
    expect(twin.text).toContain("no `driver:`");
    expect(Object.keys(storage.read(p)!.context)).not.toContain("driver_call");
  });

  it("a twin with a driver is still sent to its driver_call, a key it has", async () => {
    const { storage, p, twin, call } = await twinOf("drv");
    expect(twin.isError).toBe(true);
    expect(twin.text).toContain(`status({ session_id: "${p}", key: "driver_call" })`);
    expect((await call("status", { session_id: p, key: "driver_call" })).isError).toBeUndefined();
    expect(Object.keys(storage.read(p)!.context)).toContain("driver_call");
  });
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), "utf8");

describe("the dispatcher's instructions and the bundled dispatch state", () => {
  it("a task that ended `stopped` has a rule: handed to main, the slot kept, `stop` on main's word", () => {
    const md = read("templates/drivers/dispatch-driver.md");
    expect(md).toContain("**A task that ended `stopped`**");
    expect(md).toContain("see=state stopped");
    expect(md).toContain("`stop` follows only when main says so");
  });

  it("the twin refusal without a driver_call is a rule too: the task stays main's", () => {
    const md = read("templates/drivers/dispatch-driver.md");
    expect(md).toContain("declares no `driver:` names no `driver_call`");
  });

  it("bundled `dispatch` delivers its full prompt on a revisit, so a taking-over agent never guesses", () => {
    const empty = createFixtureDir({});
    dirs.push(empty);
    const loader = new Loader(path.join(ROOT, "templates"), empty, null);
    const batch = loader.get("batch");
    expect(batch?.states.dispatch.full_on_revisit).toBe(true);
  });

  it("the mechanism: the transition that re-enters a state answers `Revisit #N`, status the full prompt, the flag the full prompt", async () => {
    const reply = async (flag: boolean) => {
      const dir = createFixtureDir({
        w: {
          initial: "pick",
          states: {
            pick: { type: "exec", command: "true", on_success: "dispatch", on_error: "dispatch" },
            dispatch: {
              ...(flag ? { full_on_revisit: true } : {}),
              prompt: "FULL RECIPE",
              transitions: { dispatched: "collect" },
            },
            collect: { prompt: "c", transitions: { slot_free: "pick", end: "fin" } },
            fin: { terminal: true, outcome: "complete" },
          },
        },
      });
      dirs.push(dir);
      const loader = new Loader(null, dir, null);
      const storage = new InMemoryStorage();
      const handlers = new Map<
        string,
        (a: object) => Promise<{ content: Array<{ text: string }> }>
      >();
      const server = { registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h) };
      registerTools(
        server as never,
        new Engine(storage, loader, new Executor()),
        {} as never,
        loader,
        storage,
      );
      const call = async (n: string, a: object) => (await handlers.get(n)!(a)).content[0].text;
      const id = /SESSION: (\w+)/.exec(await call("start", { workflow: "w", reply: "id" }))![1];
      await call("transition", { session_id: id, transition: "dispatched" });
      return {
        reentered: await call("transition", { session_id: id, transition: "slot_free" }),
        status: await call("status", { session_id: id }),
      };
    };
    const off = await reply(false);
    expect(off.reentered).toContain("Revisit #2");
    expect(off.reentered).not.toContain("FULL RECIPE");
    expect(off.status).toContain("FULL RECIPE");
    expect((await reply(true)).reentered).toContain("FULL RECIPE");
  });

  it("rotate=due is counted in a context key, not in the agent's memory", () => {
    const md = read("templates/drivers/dispatch-driver.md");
    expect(md).toContain('lands_done: "<the old value, 0 when\n  absent, plus 1>"');
    expect(md).toContain('key: "lessons_lands"');
    expect(md).toContain("has reached or passed a multiple of 4×N since the previous");
    expect(md).toContain("`lands_done` (the context key, never your memory)");
  });
});
