import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, cleanupDir, createFixtureDir } from "./test-helpers.js";
import { registerTools } from "./tools.js";

// ENG-ENDED-TASK-FREES-SLOT: a curator / research child of a dispatcher whose session has ended
// holds its slot in `tasks` until the parent answers; the engine's collect must free it by itself.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const FIXTURE = {
  disp: {
    initial: "collect",
    states: {
      collect: {
        prompt: "collect",
        transitions: { slot_free: "pick", refill: "pick", end: "fin" },
      },
      pick: { type: "exec", command: "true", on_success: "collect", on_error: "collect" },
      fin: { terminal: true, outcome: "complete" },
    },
  },
  task: {
    initial: "claim",
    states: {
      claim: { prompt: "claim", transitions: { go: "done", fail: "failed" } },
      done: { terminal: true, outcome: "complete" },
      failed: { terminal: true, outcome: "fail" },
    },
  },
};

function setup() {
  const dir = createFixtureDir(FIXTURE);
  dirs.push(dir);
  const loader = new Loader(null, dir, null);
  const storage = new InMemoryStorage();
  const engine = new Engine(storage, loader, new Executor());
  const handlers = new Map<
    string,
    (args: object) => Promise<{ content: Array<{ text: string }> }>
  >();
  const server = {
    registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h),
  };
  registerTools(server as never, engine, {} as never, loader, storage);
  const call = async (name: string, args: object): Promise<string> =>
    (await handlers.get(name)!(args)).content[0].text;
  const sid = (t: string): string => /SESSION: (\w+)/.exec(t)![1];
  const child = async (d: string, label: string): Promise<string> =>
    sid(
      await call("start", {
        workflow: "task",
        reply: "id",
        parent_session_id: d,
        context: { task: label },
      }),
    );
  return { storage, call, sid, child };
}

describe("a completed curator child under a dispatcher frees its slot with no parent message", () => {
  it("its `tasks` entry is gone once the child's session ended, and the next pick runs", async () => {
    const { storage, call, sid, child } = setup();
    const d = sid(await call("start", { workflow: "disp", reply: "id" }));
    const a = await child(d, "CURATOR-2026-11-28-2");
    const b = await child(d, "SLICE-B");
    await call("context_set", {
      session_id: d,
      key: "tasks",
      value: `CURATOR-2026-11-28-2=${a} driver=drv1 SLICE-B=${b} driver=drv2`,
    });
    // the curator child ends: its line is done, nothing to route; no message of the parent was sent
    await call("transition", { session_id: a, transition: "go" });
    expect(storage.read(a)!.stack).toHaveLength(0);

    // the engine dropped only the ended entry, and the dispatcher's own `slot_free` is not refused
    expect(storage.read(d)!.context.tasks).toBe(`SLICE-B=${b} driver=drv2`);
    await call("transition", {
      session_id: d,
      transition: "slot_free",
      set: { tasks: `SLICE-B=${b} driver=drv2` },
    });
    const at = storage.read(d)!;
    expect(at.stack[at.active_frame].current_state).toBe("collect");
    expect(at.history.some(h => h.to === "pick")).toBe(true);
  });

  it("a completed child whose last line never arrives still lets the dispatcher reach the pick", async () => {
    const { storage, call, sid, child } = setup();
    const d = sid(await call("start", { workflow: "disp", reply: "id" }));
    const a = await child(d, "CURATOR-2026-11-28-3");
    await call("context_set", {
      session_id: d,
      key: "tasks",
      value: `CURATOR-2026-11-28-3=${a} driver=drv1`,
    });
    await call("transition", { session_id: a, transition: "go" });
    expect(storage.read(d)!.context.tasks).toBe("");
    // no REPORT / LANDED line reached the dispatcher (a restart): its one `refill` runs the pick
    await call("transition", { session_id: d, transition: "refill" });
    expect(storage.read(d)!.history.some(h => h.to === "pick")).toBe(true);
  });

  it("a task that ended failed keeps its entry: it is the parent's to route", async () => {
    const { storage, call, sid, child } = setup();
    const d = sid(await call("start", { workflow: "disp", reply: "id" }));
    const a = await child(d, "SLICE-A");
    await call("context_set", { session_id: d, key: "tasks", value: `SLICE-A=${a} driver=drv1` });
    await call("transition", { session_id: a, transition: "fail" });
    expect(storage.read(d)!.context.tasks).toBe(`SLICE-A=${a} driver=drv1`);
  });
});

describe("the curator and the dispatcher's instructions hand the report as a notice", () => {
  const read = (f: string): string => fs.readFileSync(path.join(process.cwd(), f), "utf8");

  it("the curator's last line is a REPORT, not a NEEDS-PARENT the parent must answer", () => {
    const yaml = read("templates/curator.yaml");
    expect(yaml).toContain(
      "REPORT task={{context.task}} session={{session_id}} see={{context.present}}",
    );
    expect(yaml).not.toContain(
      "NEEDS-PARENT task={{context.task}} session={{session_id}} reason=curator report ready",
    );
  });

  it("the dispatcher frees the slot on a REPORT itself and tells the parent as a notice", () => {
    const md = read("templates/drivers/dispatch-driver.md");
    expect(md).toContain("**`REPORT task=<ID> session=<P> see=<file>`**");
    expect(md).toContain("the only seven things main gets");
    expect(md).not.toContain("reason=curator report ready");
    expect(md).toContain("only when D stands at `collect`, take ONE `refill`");
    expect(md).toContain("a `refill` the engine refuses is never handed back as `refill refused`");
    expect(md).toContain("only at `collect` (§ After a restart, § Context reset)");
    const batch = read("templates/batch.yaml");
    expect(batch).toContain("`REPORT task=<ID> session=<P> see=<file>`");
    expect(read("src/driver.ts")).toContain("`REPORT task=<ID> session=<P> see=<file>`");
  });
});
