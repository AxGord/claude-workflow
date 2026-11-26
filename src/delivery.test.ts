import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Pool, type PoolEntry } from "./pool.js";
import { registerTools } from "./tools.js";
import { InMemoryStorage, cleanupDir, createTestLoader } from "./test-helpers.js";

// ENG-DELIVERY-KEY-ADVANCES: the agent a state waits on delivers by writing the state's `delivers:` key; the engine
// takes the write as the delivery (no end of the agent's turn needed), fills the tokens key from the agent's
// transcript and warns the agent of a pool waiter it left alive.

const AGENT = "a8a8bb7cd343aa2ad";
const OTHER = "a1b2c3d4e5f6a7b8c";

const TASK = {
  initial: "investigate",
  driver: { model: "haiku", effort: "medium", prompt_ref: "task-driver" },
  states: {
    investigate: {
      prompt: "wait for the report",
      delivers: { key: "report_text", tokens: "tokens_worker", agent: "investigator_agent" },
      transitions: { reported: "check" },
    },
    check: { prompt: "check", transitions: { again: "investigate", done: "fin" } },
    fin: { terminal: true, outcome: "complete" },
  },
};
const PARENT = {
  initial: "collect",
  states: {
    collect: { prompt: "collect", transitions: { done: "fin", again: "collect" } },
    fin: { terminal: true },
  },
};

describe("a state's delivers: key", () => {
  let cfg: string;
  let poolDir: string;
  let wfDir: string;
  let savedCfg: string | undefined;

  beforeEach(() => {
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), "wf-deliver-cfg-"));
    poolDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-deliver-pool-"));
    savedCfg = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
  });
  afterEach(() => {
    if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedCfg;
    cleanupDir(cfg);
    cleanupDir(poolDir);
    if (wfDir) cleanupDir(wfDir);
  });

  /** The agent's transcript: one turn whose context is `context` tokens. */
  const transcript = (context: number, agent = AGENT): void => {
    const subs = path.join(cfg, "projects", "p", "conv", "subagents");
    fs.mkdirSync(subs, { recursive: true });
    fs.writeFileSync(
      path.join(subs, `agent-${agent}.jsonl`),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "m1",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: context - 1 },
        },
      }) + "\n",
    );
  };

  /** pool.json holding `entries` (what `wf-run` of an agent leaves). */
  const pool = (entries: Partial<PoolEntry>[], key: "waiting" | "leases" = "waiting"): void => {
    const full = entries.map((e, i) => ({
      id: `e${i}`,
      pid: process.pid,
      threads: 2,
      priority: 0,
      label: "node bin/dev.js worker-build",
      cwd: "/nowhere",
      session_id: "",
      arrived: Date.now() - 5000,
      ...(key === "leases" ? { started: Date.now() - 1000 } : {}),
      ...e,
    }));
    fs.writeFileSync(
      path.join(poolDir, "pool.json"),
      JSON.stringify({
        leases: key === "leases" ? full : [],
        waiting: key === "waiting" ? full : [],
      }),
    );
  };

  async function mount(task: object = TASK) {
    const storage = new InMemoryStorage();
    const { loader, dir } = createTestLoader({ task, parent: PARENT });
    wfDir = dir;
    const engine = new Engine(storage, loader, new Executor(new Pool(poolDir)));
    type Handler = (a: object) => Promise<{ content: Array<{ text: string }> }>;
    const handlers = new Map<string, Handler>();
    const server = { registerTool: (n: string, _c: unknown, h: Handler) => handlers.set(n, h) };
    registerTools(server as never, engine, {} as never, loader, storage);
    const call = async (n: string, a: object) => (await handlers.get(n)!(a)).content[0].text;
    const d = (await engine.start("parent")).sessionId;
    const p = (
      await engine.start("task", undefined, d, undefined, undefined, {
        investigator_agent: AGENT,
      })
    ).sessionId;
    return { engine, call, d, p, storage };
  }

  it("a delivery with a live pool waiter is recorded, the tokens key is set from the transcript, the agent is warned", async () => {
    transcript(120_000);
    const { call, p, engine } = await mount();
    pool([{ session_id: p }]);
    const answer = await call("context_set", {
      session_id: p,
      key: "report_text",
      value: "## Question check",
    });
    expect(answer).toContain('Context "report_text" set successfully.');
    expect(answer).toContain('Delivery of "report_text" recorded');
    expect(answer).toContain("`tokens_worker` = 120000");
    expect(answer).toContain("WARNING");
    expect(answer).toContain(`waiter pid ${process.pid} "node bin/dev.js worker-build"`);
    expect(await call("status", { key: "tokens_worker", session_id: p })).toContain("120000");
    expect(engine.deliveryLines(p)).toHaveLength(1);
  });

  it("the driver's status, its dispatcher's status and its dispatcher's transition reply name the delivery, with the transition to take", async () => {
    transcript(5000);
    const { call, p, d } = await mount();
    await call("context_set", { session_id: p, key: "report_text", value: "r" });
    for (const sid of [p, d]) {
      const status = await call("status", { session_id: sid });
      expect(status).toContain(`DELIVERY: session ${p}`);
      expect(status).toContain(
        "take transition `reported` now, without waiting for the agent's notification",
      );
      expect(status).toContain("`tokens_worker` = 5000");
    }
    const reply = await call("transition", { session_id: d, transition: "again" });
    expect(reply).toContain(`DELIVERY: session ${p}`);
    expect(reply).toContain("take transition `reported` now");
  });

  it("a delivery with nothing alive in the pool is not warned; a dead waiter, an exec's own lease and another session's are not the agent's", async () => {
    transcript(1000);
    const { call, p } = await mount();
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
    pool([
      { session_id: p, pid: dead },
      { session_id: p, step: "task/investigate" },
      { session_id: "other" },
    ]);
    const answer = await call("context_set", { session_id: p, key: "report_text", value: "r" });
    expect(answer).toContain('Delivery of "report_text" recorded');
    expect(answer).not.toContain("WARNING");
  });

  it("a live lease the session owns is named too; a command run in the session's worktree counts without a session id", async () => {
    transcript(1000);
    const { call, p, engine } = await mount();
    await engine.setContext(p, "wt", "/work/tree");
    pool([{ cwd: "/work/tree/sub", label: "sleep 900" }], "leases");
    const answer = await call("context_set", { session_id: p, key: "report_text", value: "r" });
    expect(answer).toContain("WARNING");
    expect(answer).toContain("lease pid");
    expect(answer).toContain('"sleep 900"');
    pool([{ cwd: "/work/treehouse" }], "leases");
    const again = await call("context_set", { session_id: p, key: "report_text", value: "r2" });
    expect(again).not.toContain("WARNING");
  });

  it("a second delivery in the same visit counts the agent once; the next visit adds to what the key held", async () => {
    transcript(1000);
    const { call, p, engine } = await mount();
    await call("context_set", { session_id: p, key: "report_text", value: "r" });
    transcript(1500);
    await call("context_set", { session_id: p, key: "report_text", value: "r again" });
    expect(await call("status", { session_id: p, key: "tokens_worker" })).toBe("1500");
    await engine.transition(p, "reported");
    await engine.transition(p, "again");
    transcript(700, OTHER);
    await engine.setContext(p, "investigator_agent", OTHER);
    await call("context_set", { session_id: p, key: "report_text", value: "second investigator" });
    expect(await call("status", { session_id: p, key: "tokens_worker" })).toBe("2200");
  });

  it("once the session moved on, the delivery is gone: no DELIVERY line, and a later write of the key records nothing", async () => {
    transcript(1000);
    const { call, p, d, engine } = await mount();
    await call("context_set", { session_id: p, key: "report_text", value: "r" });
    await engine.transition(p, "reported");
    expect(engine.deliveryLines(p)).toEqual([]);
    expect(engine.deliveryLines(d)).toEqual([]);
    transcript(9999);
    const late = await call("context_set", { session_id: p, key: "report_text", value: "late" });
    expect(late).not.toContain("Delivery of");
    expect(await call("status", { session_id: p, key: "tokens_worker" })).toBe("1000");
  });

  it("a key the step does not declare, an empty value and a state without delivers: are ordinary writes", async () => {
    transcript(1000);
    const { call, p, engine } = await mount();
    expect(await call("context_set", { session_id: p, key: "notes", value: "x" })).not.toContain(
      "Delivery",
    );
    expect(
      await call("context_set", { session_id: p, key: "report_text", value: "" }),
    ).not.toContain("Delivery");
    await engine.transition(p, "reported");
    expect(
      await call("context_set", { session_id: p, key: "report_text", value: "x" }),
    ).not.toContain("Delivery");
    expect(engine.deliveryLines(p)).toEqual([]);
  });

  it("with no agent to name or no transcript the delivery stands and the tokens key is left to the notification", async () => {
    const { call, p } = await mount();
    const answer = await call("context_set", { session_id: p, key: "report_text", value: "r" });
    expect(answer).toContain('Delivery of "report_text" recorded');
    expect(answer).not.toContain("tokens_worker");
    expect(await call("status", { session_id: p, key: "tokens_worker" })).not.toContain("1");
    expect(await call("status", { session_id: p })).toContain("DELIVERY:");
  });

  it("a bare `delivers: <key>` and a link_agent-ed agent: the latest non-driver link of this visit is read", async () => {
    transcript(4242);
    const bare = {
      ...TASK,
      states: {
        ...TASK.states,
        investigate: {
          prompt: "wait",
          delivers: "report_text",
          transitions: { reported: "check" },
        },
      },
    };
    const { call, p } = await mount(bare);
    await call("link_agent", { session_id: p, agent_id: AGENT, role: "worker" });
    const answer = await call("context_set", { session_id: p, key: "report_text", value: "r" });
    expect(answer).toContain('Delivery of "report_text" recorded');
    expect(answer).not.toContain("`tokens_worker`");
    expect(await call("status", { session_id: p })).toContain(`agent ${AGENT} set \`report_text\``);
  });

  it("the dispatcher's STALE line for a quiet driver says the agent already delivered", async () => {
    transcript(1000);
    const { call, p, engine, d } = await mount();
    await call("link_agent", { session_id: p, agent_id: "a0000000000000001", role: "driver" });
    await call("context_set", { session_id: p, key: "report_text", value: "r" });
    const long = Date.now() + 86_400_000;
    expect(engine.staleLines(d, true, long).join("\n")).toContain(
      "the agent already delivered `report_text`",
    );
  });
});

describe("the rules name the delivery", () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  it("both driver files and the dispatcher's rules act on a DELIVERY: line", () => {
    for (const f of ["templates/drivers/task-driver.md", "agents/driver.md"]) {
      const md = read(f);
      expect(md).toContain("A `DELIVERY:` line");
      expect(md).toContain("The agent's notification, if it comes after");
    }
    expect(read("templates/drivers/dispatch-driver.md")).toContain("A `DELIVERY:` line");
  });
});

describe("the loader reads delivers:", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) cleanupDir(d);
  });
  function load(workflows: Record<string, object>) {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    const { loader, dir } = createTestLoader(workflows);
    dirs.push(dir);
    return { loader, errors: errors.join("\n") };
  }

  it("takes a bare key and an object on a prompt state; refuses it on a terminal state and on an exec", () => {
    const { loader, errors } = load({
      ok: {
        initial: "a",
        states: {
          a: { prompt: "p", delivers: "k", transitions: { go: "b" } },
          b: {
            prompt: "p",
            delivers: { key: "k", tokens: "t", agent: "x_agent" },
            transitions: { go: "e" },
          },
          e: { terminal: true },
        },
      },
      terminal: {
        initial: "a",
        states: {
          a: { prompt: "p", transitions: { go: "e" } },
          e: { terminal: true, delivers: "k" },
        },
      },
      exec: {
        initial: "a",
        states: {
          a: { type: "exec", command: "true", delivers: "k", on_success: "e", on_error: "e" },
          e: { terminal: true },
        },
      },
    });
    expect(loader.get("ok")!.states.a.delivers).toBe("k");
    expect(loader.get("terminal")).toBeUndefined();
    expect(loader.get("exec")).toBeUndefined();
    expect(errors).toContain('state "e" delivers is read only on a prompt state');
    expect(errors).toContain('state "a" delivers is read only on a prompt state');
  });

  it("refuses a key that is not a context key name", () => {
    const { loader, errors } = load({
      bad: { initial: "a", states: { a: { prompt: "p", delivers: "not a key", transitions: {} } } },
    });
    expect(loader.get("bad")).toBeUndefined();
    expect(errors).toContain("a context key name");
  });
});
