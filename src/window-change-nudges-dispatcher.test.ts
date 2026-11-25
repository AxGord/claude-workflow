import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, cleanupDir } from "./test-helpers.js";
import { registerTools } from "./tools.js";
import type { SessionState } from "./types.js";
import { windowNudge } from "./window-nudge.js";

// ENG-WINDOW-CHANGE-NUDGES-DISPATCHER: a raised window admits nothing by itself (a dispatcher at
// `collect` moves on `slot_free` / `refill`, at `paused` on `retry`), so the answer of the call that
// raised it names the dispatcher session and the exact call.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(ROOT, "templates");
const AGENT = "ae7ba885586291184";
const dirs: string[] = [];
beforeEach(() => {
  process.env.WF_DISPATCHER = "1";
});
afterEach(() => {
  delete process.env.WF_DISPATCHER;
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const task = (id: string, status: string, touches: string): string =>
  `  - {id: ${id}, status: ${status}, touches: [${touches}], repo: REPO, workflow: batch-task, difficulty: 3}\n`;

function mount() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-nudge-")));
  dirs.push(dir);
  const storage = new InMemoryStorage();
  const engine = new Engine(storage, new Loader(TEMPLATES, dir, null), new Executor());
  const handlers = new Map<
    string,
    (a: object) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
  >();
  registerTools(
    { registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h) } as never,
    engine,
    {} as never,
    new Loader(TEMPLATES, dir, null),
    storage,
  );
  const call = async (name: string, args: object) => {
    const r = await handlers.get(name)!(args);
    return { isError: r.isError, text: r.content[0].text };
  };
  const queue = path.join(dir, "q.yaml");
  const write = (size: number, tasks: string) =>
    fs.writeFileSync(
      queue,
      `batch_size: ${size}\noverlap: files\ntasks:\n${tasks}`.replaceAll("REPO", dir),
    );
  /** A batch session moved past plan_queue and its first pick; `agent` links a dispatcher agent. */
  const session = async (agent: boolean): Promise<string> => {
    const s = await call("start", { workflow: "batch", cwd: dir, reply: "id" });
    const id = /SESSION: (\w+)/.exec(s.text)![1];
    await call("context_set", { session_id: id, key: "queue_file", value: queue });
    await call("context_set", { session_id: id, key: "task_workflow", value: "batch-task" });
    await call("transition", { session_id: id, transition: "continue" });
    await call("transition", { session_id: id, transition: "ready" });
    if (agent) await call("link_agent", { session_id: id, agent_id: AGENT });
    return id;
  };
  return { dir, queue, call, write, session, storage };
}

describe("queue_header names the dispatcher a raised window must wake", () => {
  it("at collect: the session, its state and `lines added` to its agent", async () => {
    const { call, write, session, queue } = mount();
    write(1, task("RUN", "running", "r.ts"));
    const id = await session(true);
    write(1, task("RUN", "running", "r.ts") + task("A", "pending", "a.ts"));
    const r = await call("queue_header", { file: queue, batch_size: 3, reason: "wider" });
    expect(r.text).toContain("batch_size 1 → 3  # wider");
    expect(r.text).toContain(`dispatcher session ${id} (batch @ collect) holds this queue`);
    expect(r.text).toContain("a pick would admit 1 line(s) now");
    expect(r.text).toContain(`SendMessage({ to: "${AGENT}", message: "lines added" })`);
  });

  it("with no agent linked the main conversation drives it: the transition, not a SendMessage", async () => {
    const { call, write, session, queue } = mount();
    write(1, task("RUN", "running", "r.ts"));
    const id = await session(false);
    write(1, task("RUN", "running", "r.ts") + task("A", "pending", "a.ts"));
    const r = await call("queue_header", { file: queue, batch_size: 3, reason: "wider" });
    expect(r.text).toContain(`transition({ session_id: "${id}", transition: "refill" })`);
    expect(r.text).not.toContain("SendMessage");
  });

  it("at paused: `retry`, and that message's route exists", async () => {
    const { call, write, session, queue } = mount();
    write(0, task("A", "pending", "a.ts"));
    const id = await session(true);
    expect((await call("status", { session_id: id })).text).toContain("paused");
    const r = await call("queue_header", { file: queue, batch_size: 2, reason: "lifted" });
    expect(r.text).toContain(`(batch @ paused)`);
    expect(r.text).toContain(`SendMessage({ to: "${AGENT}", message: "retry" })`);
    const moved = await call("transition", { session_id: id, transition: "retry" });
    expect(moved.isError).toBeUndefined();
    expect((await call("status", { session_id: id })).text).toContain("dispatch");
  });

  it("nothing for a window that shrinks or stays, or at collect when no line would be admitted", async () => {
    const { call, write, session, queue } = mount();
    write(3, task("RUN", "running", "r.ts"));
    await session(true);
    const shrink = await call("queue_header", { file: queue, batch_size: 2, reason: "narrow" });
    expect(shrink.text).toBe("batch_size 3 → 2  # narrow");
    const idle = await call("queue_header", { file: queue, batch_size: 4, reason: "no lines" });
    expect(idle.text).toBe("batch_size 2 → 4  # no lines");
  });

  it("a queue with no dispatcher session answers as before", async () => {
    const { call, write, queue } = mount();
    write(1, task("A", "pending", "a.ts"));
    const r = await call("queue_header", { file: queue, batch_size: 3, reason: "wider" });
    expect(r.text).toBe("batch_size 1 → 3  # wider");
  });
});

describe("windowNudge picks only the live dispatcher sessions of that queue", () => {
  const base = (over: Partial<SessionState> & { context?: Record<string, unknown> }) =>
    ({
      session_id: "d1d1d1d1",
      stack: [
        { workflow: "batch", current_state: "collect", state_visits: {}, total_transitions: 0 },
      ],
      active_frame: 0,
      started_at: "",
      updated_at: "",
      history: [],
      overrides: {},
      ...over,
      context: { queue_file: "/q/a.yaml", task_workflow: "batch-task", ...over.context },
    }) as SessionState;
  const grew = { from: 1, to: 3 };

  it("names a root session of the queue", () => {
    expect(windowNudge([base({})], "/q/a.yaml", grew, 2)).toHaveLength(1);
  });

  it.each([
    ["another queue", base({ context: { queue_file: "/q/b.yaml" } })],
    ["a suspended session", base({ suspended_at: "2026-11-25T00:00:00Z" })],
    [
      "a task session (its own task, a parent)",
      base({ parent_session_id: "d0", context: { task: "T1" } }),
    ],
    ["a session with no task_workflow", base({ context: { task_workflow: "" } })],
    ["an ended session", base({ stack: [] })],
  ])("ignores %s", (_n, s) => {
    expect(windowNudge([s], "/q/a.yaml", grew, 2)).toEqual([]);
  });

  it("skips a `{}` placeholder session file and still names the real one", () => {
    const placeholder = {} as SessionState;
    expect(windowNudge([placeholder, base({})], "/q/a.yaml", grew, 2)).toHaveLength(1);
  });

  it("is silent for a window that did not grow", () => {
    expect(windowNudge([base({})], "/q/a.yaml", { from: 3, to: 3 }, 2)).toEqual([]);
    expect(windowNudge([base({})], "/q/a.yaml", { from: 3, to: 1 }, 2)).toEqual([]);
  });

  it("says to wait for collect at dispatch, and nothing at a state main drives", () => {
    const at = (state: string) =>
      base({
        stack: [
          { workflow: "batch", current_state: state, state_visits: {}, total_transitions: 0 },
        ],
      });
    expect(windowNudge([at("dispatch")], "/q/a.yaml", grew, 2)[0]).toContain(
      "once it stands at collect (it is at dispatch now)",
    );
    expect(windowNudge([at("cross_check")], "/q/a.yaml", grew, 2)).toEqual([]);
  });
});

describe("wf-queue --batch-size prints the same line", () => {
  const argv = process.argv;
  let state: string;
  beforeEach(() => {
    state = fs.mkdtempSync(path.join(os.tmpdir(), "wf-nudge-state-"));
    dirs.push(state);
    process.env.STATE_DIR = state;
  });
  afterEach(() => {
    delete process.env.STATE_DIR;
    process.argv = argv;
    process.exitCode = undefined;
  });

  async function cli(...args: string[]): Promise<{ code: unknown; out: string }> {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(c => (out.push(String(c)), true));
    process.argv = ["node", "wf-queue", ...args];
    process.exitCode = undefined;
    vi.resetModules();
    await import("./queue-cli.js");
    for (let i = 0; i < 100 && process.exitCode === undefined; i++)
      await new Promise(r => setTimeout(r, 10));
    vi.restoreAllMocks();
    return { code: process.exitCode, out: out.join("") };
  }

  it("names a session stored in STATE_DIR; an empty state directory adds nothing", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-nudge-q-")));
    dirs.push(dir);
    const queue = path.join(dir, "q.yaml");
    const body = `batch_size: 1\noverlap: files\ntasks:\n${task("RUN", "running", "r.ts")}${task("A", "pending", "a.ts")}`;
    fs.writeFileSync(queue, body.replaceAll("REPO", dir));
    const none = await cli(queue, "--batch-size", "2", "--reason", "wider");
    expect(none.out).toBe("batch_size 1 → 2  # wider\n");

    const session = {
      session_id: "d1d1d1d1",
      stack: [
        { workflow: "batch", current_state: "collect", state_visits: {}, total_transitions: 0 },
      ],
      active_frame: 0,
      started_at: "",
      updated_at: "",
      history: [],
      overrides: {},
      context: { queue_file: queue, task_workflow: "batch-task" },
    };
    fs.writeFileSync(path.join(state, "d1d1d1d1.json"), JSON.stringify(session));
    const named = await cli(queue, "--batch-size", "3", "--reason", "wider still");
    expect(named.code).toBe(0);
    expect(named.out).toContain("batch_size 2 → 3  # wider still\n");
    expect(named.out).toContain("dispatcher session d1d1d1d1 (batch @ collect) holds this queue");
    expect(named.out).toContain('transition({ session_id: "d1d1d1d1", transition: "refill" })');
  });
});

describe("the shipped text says what the answer names", () => {
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

  it("the dispatcher takes main's `retry` at paused", () => {
    const t = read("templates/drivers/dispatch-driver.md");
    expect(t).toContain("`retry` (at `paused` only");
    expect(t).toContain('transition({session_id: D, transition: "retry"})');
  });

  it("the DRIVER block's duties, the paused prompt and the tool description name it", () => {
    expect(read("src/driver.ts")).toContain("`lines added` at `collect` or `retry` at `paused`");
    expect(read("templates/batch.yaml")).toContain("the `queue_header` answer names this session");
    expect(read("src/tools.ts")).toContain("naming that session, its state and the call");
  });
});
