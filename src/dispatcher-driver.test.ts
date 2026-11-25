import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  DEFAULT_DISPATCHER_AGENT_TYPE,
  DISPATCHER_CALL_KEY,
  SPAWN_DEPTH_ENV,
  dispatcherOn,
} from "./driver.js";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { pickupReport } from "./session-cli.js";
import { dispatcherHolds, dispatcherWakeLines } from "./takeover.js";
import { InMemoryStorage, cleanupDir, createFixtureDir } from "./test-helpers.js";
import { formatResume, registerTools } from "./tools.js";

// ENG-DISPATCHER-DRIVER: an opt-in dispatcher agent over the task drivers. Off, nothing changes.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(ROOT, "templates");
const OPT_IN = "WF_DISPATCHER";
const WF = "mcp__plugin_workflow_wf__";

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of [OPT_IN, "WF_T_DISP", SPAWN_DEPTH_ENV]) {
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

const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-disp-"));
  dirs.push(d);
  return d;
};

type Reply = { isError?: boolean; text: string };

function mount(loader: Loader) {
  const storage = new InMemoryStorage();
  const engine = new Engine(storage, loader, new Executor());
  const handlers = new Map<
    string,
    (args: object) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
  >();
  const server = { registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h) };
  registerTools(server as never, engine, {} as never, loader, storage);
  const call = async (name: string, args: object): Promise<Reply> => {
    const r = await handlers.get(name)!(args);
    return { isError: r.isError, text: r.content[0].text };
  };
  return { storage, engine, call };
}

const bundled = () => mount(new Loader(TEMPLATES, tmp(), null));

/** The bundled workflows with `dispatcher:` cut out of `batch`: what the engine shipped before the key. */
function withoutDispatcherKey() {
  const dir = tmp();
  for (const f of fs.readdirSync(TEMPLATES)) {
    if (!f.endsWith(".yaml")) continue;
    const raw = fs.readFileSync(path.join(TEMPLATES, f), "utf8");
    if (f !== "batch.yaml") {
      fs.writeFileSync(path.join(dir, f), raw);
      continue;
    }
    const doc = YAML.parse(raw) as Record<string, unknown>;
    expect(doc.dispatcher).toBeDefined();
    delete doc.dispatcher;
    fs.writeFileSync(path.join(dir, f), YAML.stringify(doc));
  }
  return mount(new Loader(dir, tmp(), null));
}

const SESSION = /SESSION: (\w+)/;
const sid = (text: string): string => SESSION.exec(text)![1];
const scrub = (text: string): string => text.replaceAll(sid(text), "<ID>");

const FIXTURE = {
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
      plan: { prompt: "plan the queue", transitions: { ready: "pick" } },
      pick: { type: "exec", command: "true", on_success: "dispatch", on_error: "dispatch" },
      dispatch: { prompt: "dispatch the lines", transitions: { dispatched: "collect" } },
      collect: { prompt: "collect", transitions: { slot_free: "pick", end: "fin" } },
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

function fixture(workflows: Record<string, object> = FIXTURE) {
  const dir = createFixtureDir(workflows);
  dirs.push(dir);
  return mount(new Loader(null, dir, null));
}

describe("the opt-in is off: bundled batch starts as before", () => {
  it("start's reply is byte for byte the reply of batch without the key, full and reply: id", async () => {
    for (const reply of [undefined, "id"]) {
      const now = await bundled().call("start", { workflow: "batch", reply });
      const before = await withoutDispatcherKey().call("start", { workflow: "batch", reply });
      expect(now.isError).toBeUndefined();
      expect(scrub(now.text)).toBe(scrub(before.text));
      expect(now.text).not.toContain("DRIVER");
    }
  });

  it("an off value is off, and the session holds no dispatcher key", async () => {
    for (const off of ["", "0", "false", "OFF", " no "]) {
      process.env[OPT_IN] = off;
      const m = bundled();
      const r = await m.call("start", { workflow: "batch", reply: "id" });
      expect(r.text).toBe(`SESSION: ${sid(r.text)} @ load_skills`);
      expect(m.storage.read(sid(r.text))!.context).not.toHaveProperty(DISPATCHER_CALL_KEY);
    }
  });

  it("the reply that leaves the `after` state carries no block, and a task may start twice", async () => {
    const m = fixture();
    const d = sid((await m.call("start", { workflow: "disp", reply: "id" })).text);
    const left = await m.call("transition", { session_id: d, transition: "ready" });
    expect(left.text).toContain("dispatch the lines");
    expect(left.text).not.toContain("DRIVER");
    const start = { workflow: "task", reply: "id", parent_session_id: d, context: { task: "T1" } };
    expect((await m.call("start", start)).isError).toBeUndefined();
    expect((await m.call("start", start)).isError).toBeUndefined();
  });
});

describe("the opt-in is on: start answers with the dispatcher's DRIVER block", () => {
  it("bundled batch: the block follows the unchanged reply and names the agent, the session and the depth", async () => {
    const off = await bundled().call("start", { workflow: "batch" });
    process.env[OPT_IN] = "1";
    const m = bundled();
    const on = await m.call("start", { workflow: "batch" });
    const d = sid(on.text);
    const [head, block] = [
      on.text.slice(0, on.text.indexOf("\n\n---\nDRIVER")),
      on.text.slice(on.text.indexOf("---\nDRIVER")),
    ];
    expect(scrub(head).replaceAll(d, "<ID>")).toBe(scrub(off.text));
    expect(block).toContain(
      `DRIVER — the dispatcher (opt-in ${OPT_IN} is set): once it has left \`plan_queue\``,
    );
    expect(block).toContain(
      `model: haiku, effort: medium, run_in_background: true, subagent_type: "workflow:dispatcher", description: "dispatch ${d}", prompt:`,
    );
    expect(block).toContain(`link_agent({session_id: "${d}", agent_id: <its id>})`);
    expect(block).toContain(`D = ${d}`);
    expect(block).toContain(path.join(TEMPLATES, "drivers", "dispatch-driver.md"));
    expect(block).not.toContain("WARNING");
    for (const kind of ["NEEDS-PARENT", "LESSONS lands=", "HANDOVER session=", "OWED task=<ID>"])
      expect(block).toContain(kind);
    expect(block.split("\n").filter(l => l.includes(SPAWN_DEPTH_ENV))).toEqual([
      expect.stringContaining(`set ${SPAWN_DEPTH_ENV}=4 (this engine process sees: unset)`),
    ]);
    expect(m.storage.read(d)!.context[DISPATCHER_CALL_KEY]).toBe(block);
    expect(DEFAULT_DISPATCHER_AGENT_TYPE).toBe("workflow:dispatcher");
  });

  it("reply: id carries the block too, and the depth line shows what the process sees", async () => {
    process.env[OPT_IN] = "yes";
    process.env[SPAWN_DEPTH_ENV] = "4";
    const r = await bundled().call("start", { workflow: "batch", reply: "id" });
    expect(
      r.text.startsWith(`SESSION: ${sid(r.text)} @ load_skills\n\n---\nDRIVER — the dispatcher`),
    ).toBe(true);
    expect(r.text).toContain("(this engine process sees: 4)");
  });

  it("the reply that leaves the `after` state repeats the block, through an exec chain, once", async () => {
    process.env.WF_T_DISP = "1";
    const m = fixture();
    const start = await m.call("start", { workflow: "disp", reply: "id" });
    const d = sid(start.text);
    const block = String(m.storage.read(d)!.context[DISPATCHER_CALL_KEY]);
    expect(start.text.endsWith(block)).toBe(true);
    const left = await m.call("transition", { session_id: d, transition: "ready" });
    expect(left.text).toContain("dispatch the lines");
    expect(left.text.endsWith(`\n\n${block}`)).toBe(true);
    const next = await m.call("transition", { session_id: d, transition: "dispatched" });
    expect(next.text).not.toContain("DRIVER");
    const again = await m.call("transition", { session_id: d, transition: "slot_free" });
    expect(again.text).not.toContain("DRIVER");
  });

  it("a task is never started twice under a dispatcher session; an ended one may run again", async () => {
    process.env.WF_T_DISP = "1";
    const m = fixture();
    const d = sid((await m.call("start", { workflow: "disp", reply: "id" })).text);
    const start = { workflow: "task", reply: "id", parent_session_id: d, context: { task: "T1" } };
    const p = sid((await m.call("start", start)).text);
    const twin = await m.call("start", start);
    expect(twin.isError).toBe(true);
    expect(twin.text).toContain(
      `task "T1" already runs under ${d} as session ${p} (no agent linked)`,
    );
    // ENG-DISPATCHER-FOLLOWUPS: the task workflow here has no `driver:`, so there is no driver call to name
    expect(twin.text).not.toContain("driver_call");
    expect(m.storage.readAll()).toHaveLength(2);
    const other = await m.call("start", { ...start, context: { task: "T2" } });
    expect(other.isError).toBeUndefined();
    await m.call("transition", { session_id: p, transition: "go" });
    expect((await m.call("start", start)).isError).toBeUndefined();
  });

  it("dispatcherOn: no env key is always on", () => {
    const d = { model: "haiku", effort: "low", prompt_ref: "dispatch-driver" } as const;
    expect(dispatcherOn(d, {})).toBe(true);
    expect(dispatcherOn({ ...d, env: "X" }, {})).toBe(false);
    expect(dispatcherOn({ ...d, env: "X" }, { X: "1" })).toBe(true);
  });
});

describe("the loader checks `dispatcher:`", () => {
  function load(workflows: Record<string, object>) {
    const orig = console.error;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    try {
      const dir = createFixtureDir(workflows);
      dirs.push(dir);
      return { loader: new Loader(null, dir, null), errors: errors.join("\n") };
    } finally {
      console.error = orig;
    }
  }
  const base = FIXTURE.disp;

  it("an unknown `after` state, an unknown shipped name, a bad env name and `driver:` beside it fail the load", () => {
    const { loader, errors } = load({
      ok: base,
      heir: { extends: "ok" },
      after: { ...base, dispatcher: { ...base.dispatcher, after: "nowhere" } },
      ref: { ...base, dispatcher: { ...base.dispatcher, prompt_ref: "no-such-driver" } },
      env: { ...base, dispatcher: { ...base.dispatcher, env: "not a name" } },
      both: {
        ...base,
        driver: { model: "haiku", effort: "low", prompt_ref: "task-driver" },
      },
    });
    expect(loader.names().sort()).toEqual(["heir", "ok"]);
    expect(loader.get("heir")?.dispatcher).toEqual(base.dispatcher);
    expect(errors).toContain('dispatcher.after: state "nowhere" does not exist');
    expect(errors).toContain('dispatcher.prompt_ref "no-such-driver"');
    expect(errors).toContain("an environment variable name");
    expect(errors).toContain("`driver:` or `dispatcher:`, not both");
  });

  it("bundled batch declares it, off by default, after plan_queue; batch-task does not", () => {
    const loader = new Loader(TEMPLATES, tmp(), null);
    expect(loader.get("batch")?.dispatcher).toEqual({
      model: "haiku",
      effort: "medium",
      prompt_ref: "dispatch-driver",
      env: OPT_IN,
      after: "plan_queue",
    });
    expect(loader.get("batch")?.driver).toBeUndefined();
    expect(loader.get("batch-task")?.dispatcher).toBeUndefined();
  });
});

describe("the shipped dispatcher agent type", () => {
  const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");
  const frontmatter = (): Record<string, string> =>
    YAML.parse(/^---\n([\s\S]*?)\n---\n/u.exec(read("agents/dispatcher.md"))![1]) as Record<
      string,
      string
    >;
  const tools = (): string[] =>
    frontmatter()
      .tools.split(",")
      .map(t => t.trim());

  it("holds none of the five refused tools, nor any other that ends, rewrites or re-owns a session", () => {
    for (const name of ["abort", "delete", "queue_mark", "queue_edit", "queue_add"])
      expect(tools()).not.toContain(WF + name);
    for (const name of ["create", "modify", "resume", "set_priority", "queue_header", "queue_next"])
      expect(tools()).not.toContain(WF + name);
    for (const t of ["Bash", "Edit", "Write"]) expect(tools()).not.toContain(t);
  });

  it("is exactly the list the instructions need, on a cheap model", () => {
    expect(tools()).toEqual([
      `${WF}start`,
      `${WF}status`,
      `${WF}transition`,
      `${WF}context_set`,
      `${WF}link_agent`,
      "Agent",
      "SendMessage",
      "Read",
      "ToolSearch",
      "SubagentHandback",
    ]);
    const fm = frontmatter();
    expect(fm.name).toBe("dispatcher");
    expect(fm.model).toBe("haiku");
    const rules = read("templates/drivers/dispatch-driver.md");
    for (const name of ["start", "status", "transition", "context_set", "link_agent"])
      expect(rules).toMatch(new RegExp(`\\b${name}\\(`, "u"));
    for (const t of ["SendMessage", "SubagentHandback", "Read"]) expect(rules).toContain(t);
  });

  it("the instructions ask for no tool the type lacks, and name the four hand-backs", () => {
    const rules = read("templates/drivers/dispatch-driver.md");
    for (const name of [
      "abort",
      "queue_mark",
      "queue_edit",
      "queue_add",
      "queue_header",
      "sessions",
    ])
      expect(rules).not.toMatch(new RegExp(`\\b${name}\\(`, "u"));
    for (const line of [
      "NEEDS-PARENT",
      "LESSONS lands=<n> session=<D>",
      "HANDOVER session=<D>",
      "OWED task=<ID>",
    ])
      expect(rules).toContain(line);
    expect(rules).toContain("DISPATCHING session=<D> running=");
    expect(rules).toContain("lessons_every");
    expect(read("agents/dispatcher.md")).toContain("templates/drivers/dispatch-driver.md");
  });
});

describe("a restart: the pickup wakes the dispatcher only", () => {
  /** A dispatcher root with task T1 (driver1, a worker below it) and a session `tasks` does not name (rev1). */
  async function restarted(o: { link: boolean; left: boolean; resume?: boolean }) {
    process.env.WF_T_DISP = "1";
    const m = fixture();
    const d = sid((await m.call("start", { workflow: "disp", reply: "id" })).text);
    const child = async (parent: string, task?: string): Promise<string> =>
      sid(
        (
          await m.call("start", {
            workflow: "task",
            reply: "id",
            parent_session_id: parent,
            ...(task ? { context: { task } } : {}),
          })
        ).text,
      );
    const ids = [d];
    if (o.left) {
      await m.call("transition", { session_id: d, transition: "ready" });
      const p = await child(d, "T1");
      const w = await child(p);
      const r = await child(d);
      await m.engine.linkAgent(p, "ab85aef08608180db");
      await m.engine.linkAgent(w, "aebad64149cc767ba");
      await m.engine.linkAgent(r, "a18ce5ff019d7aa48");
      await m.call("transition", {
        session_id: d,
        transition: "dispatched",
        set: { tasks: `T1=${p} driver=driver1` },
      });
      ids.push(p, w, r);
    }
    if (o.link) await m.engine.linkAgent(d, "a81977149348587ff");
    for (const id of ids)
      await m.storage.update(id, s => ({
        ...s!,
        claude_session_id: "conv",
        suspended_at: "2026-01-01T00:00:00.000Z",
      }));
    const text = o.resume
      ? formatResume(await m.engine.resume(d))
      : await pickupReport(m.storage, "conv", process.pid);
    return { ...m, d, text };
  }

  it("names the dispatcher's SendMessage and neither the task driver nor the worker below it", async () => {
    const { text, d } = await restarted({ link: true, left: true });
    expect(text).toContain(
      `DISPATCHER — a dispatcher agent drives ${d}: wake ONLY it; the 2 session(s) of its \`tasks\` key and below them`,
    );
    expect(text).toContain(
      `SendMessage({ to: "a81977149348587ff", message: "Continue — the run was restarted`,
    );
    expect(text).toContain(`key: '${DISPATCHER_CALL_KEY}'`);
    expect(text).not.toContain("ab85aef08608180db");
    expect(text).not.toContain("aebad64149cc767ba");
  });

  it("a sub-session `tasks` does not name is still named to the conversation, with today's lines", async () => {
    const { text } = await restarted({ link: true, left: true });
    expect(text).toContain("wake each sub-agent");
    expect(text).toContain(`SendMessage({ to: "a18ce5ff019d7aa48"`);
  });

  it("the `resume` reply wakes the dispatcher only, as the pickup does (ENG-DISPATCHER-FOLLOWUPS)", async () => {
    const { text, d } = await restarted({ link: true, left: true, resume: true });
    expect(text).toContain(
      `DISPATCHER — a dispatcher agent drives ${d}: wake ONLY it; the 2 session(s) of its \`tasks\` key and below them`,
    );
    expect(text).toContain(
      `SendMessage({ to: "a81977149348587ff", message: "Continue — the run was restarted`,
    );
    expect(text).not.toContain("ab85aef08608180db");
    expect(text).not.toContain("aebad64149cc767ba");
    // a sub-session `tasks` does not name stays listed
    expect(text).toContain(`SendMessage({ to: "a18ce5ff019d7aa48"`);
  });

  it("a task session with a driver started but not yet in `tasks` is the dispatcher's too; one without a driver stays listed to the conversation (ENG-DISPATCHER-FOLLOWUPS)", async () => {
    process.env.WF_T_DISP = "1";
    const m = fixture({
      ...FIXTURE,
      drv: {
        initial: "claim",
        driver: { model: "haiku", effort: "low", prompt_ref: "task-driver" },
        states: {
          claim: { prompt: "claim", transitions: { go: "done" } },
          done: { terminal: true, outcome: "complete" },
        },
      },
    });
    const d = sid((await m.call("start", { workflow: "disp", reply: "id" })).text);
    await m.call("transition", { session_id: d, transition: "ready" });
    const child = async (workflow: string, task: string) =>
      sid(
        (
          await m.call("start", {
            workflow,
            reply: "id",
            parent_session_id: d,
            context: { task },
          })
        ).text,
      );
    const p = await child("drv", "T9");
    const q = await child("task", "T8");
    await m.engine.linkAgent(p, "a566d9ee209f96256");
    await m.engine.linkAgent(q, "a21ba367184eb4adb");
    await m.engine.linkAgent(d, "a81977149348587ff");
    for (const id of [d, p, q])
      await m.storage.update(id, s => ({
        ...s!,
        claude_session_id: "conv",
        suspended_at: "2026-01-01T00:00:00.000Z",
      }));
    const text = await pickupReport(m.storage, "conv", process.pid);
    expect(m.storage.read(d)!.context.tasks).toBeUndefined();
    expect(text).toContain("wake ONLY it; the 1 session(s)");
    expect(text).not.toContain("a566d9ee209f96256");
    expect(text).toContain(`SendMessage({ to: "a21ba367184eb4adb"`);
  });

  it("past the `after` state with no agent linked: the call to spawn it from", async () => {
    const { text } = await restarted({ link: false, left: true });
    expect(text).toContain("no agent linked — spawn it from");
    expect(text).not.toContain("ab85aef08608180db");
  });

  it("a restart at the `after` state under the opt-in: no DISPATCHER line, no spawn instruction", async () => {
    const { text, d, storage } = await restarted({ link: false, left: false });
    expect(storage.read(d)!.context[DISPATCHER_CALL_KEY]).toBeTypeOf("string");
    expect(text).toContain(`picked up: ${d} @ disp @ plan`);
    expect(text).not.toContain("DISPATCHER");
    expect(text).not.toContain("spawn it from");
    expect(dispatcherHolds(storage.read(d)!)).toBe(false);
  });

  it("a root without the key keeps today's lines", async () => {
    const { storage, d } = await restarted({ link: true, left: true });
    const plain = { ...storage.read(d)!, context: {} };
    expect(dispatcherWakeLines(plain, "  ", 1)).toEqual([]);
  });

  it("the opt-in off: the drivers are listed to wake, as before", async () => {
    const m = fixture();
    const d = sid((await m.call("start", { workflow: "disp", reply: "id" })).text);
    const p = sid(
      (await m.call("start", { workflow: "task", reply: "id", parent_session_id: d })).text,
    );
    await m.engine.linkAgent(p, "ab85aef08608180db");
    for (const id of [d, p])
      await m.storage.update(id, s => ({
        ...s!,
        claude_session_id: "conv",
        suspended_at: "2026-01-01T00:00:00.000Z",
      }));
    const text = await pickupReport(m.storage, "conv", process.pid);
    expect(text).toContain("wake each sub-agent");
    expect(text).toContain(`SendMessage({ to: "ab85aef08608180db"`);
    expect(text).not.toContain("DISPATCHER");
  });
});
