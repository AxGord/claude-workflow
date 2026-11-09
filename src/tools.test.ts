import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  formatContext,
  formatStatus,
  registerTools,
  resetDeliveredPrompts,
  setContextEpochFile,
} from "./tools.js";
import { Engine, type StatusResult } from "./engine.js";
import { Executor } from "./executor.js";
import { InMemoryStorage, createTestLoader, cleanupDir, SIMPLE_WORKFLOW } from "./test-helpers.js";
import type { SessionState } from "./types.js";

function makeStatus(overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    sessionId: "s1",
    stack: [{ workflow: "master", current_state: "route", state_visits: {} } as never],
    activeFrame: 0,
    currentState: { prompt: "FULL ROUTING RULES", digest_on_repeat: true },
    currentStateName: "route",
    currentWorkflow: "master",
    availableTransitions: { chat: "chat" },
    prompt: "FULL ROUTING RULES",
    history: [],
    context: {},
    taskOps: [],
    visitCount: 1,
    ...overrides,
  } as StatusResult;
}

describe("formatStatus digest_on_repeat", () => {
  beforeEach(() => resetDeliveredPrompts());

  it("delivers the full prompt on first delivery in the process", () => {
    const out = formatStatus(makeStatus());
    expect(out).toContain("FULL ROUTING RULES");
  });

  it("delivers a digest on the second delivery of the same state", () => {
    formatStatus(makeStatus());
    const out = formatStatus(makeStatus({ sessionId: "s2" }));
    expect(out).not.toContain("FULL ROUTING RULES");
    expect(out).toContain("already delivered earlier in this context");
    expect(out).toContain("TRANSITIONS: chat");
  });

  it("forceFullPrompt (status tool) always returns the full text", () => {
    formatStatus(makeStatus());
    const out = formatStatus(makeStatus(), { forceFullPrompt: true });
    expect(out).toContain("FULL ROUTING RULES");
  });

  it("states without the flag always get the full prompt", () => {
    const plain = makeStatus({
      currentState: { prompt: "PLAIN" },
      currentStateName: "chat",
      prompt: "PLAIN",
    });
    formatStatus(plain);
    const out = formatStatus(plain);
    expect(out).toContain("PLAIN");
  });

  it("same-session revisit abbreviation still wins over the digest", () => {
    formatStatus(makeStatus());
    const out = formatStatus(makeStatus({ visitCount: 2 }));
    expect(out).toContain("Revisit #2");
    expect(out).not.toContain("FULL ROUTING RULES");
  });

  it("full_on_revisit delivers the prompt on a revisit", () => {
    const out = formatStatus(
      makeStatus({
        visitCount: 2,
        currentState: { prompt: "FULL ROUTING RULES", full_on_revisit: true },
      }),
    );
    expect(out).not.toContain("Revisit #2");
    expect(out).toContain("FULL ROUTING RULES");
  });

  it("revisit_prompt replaces the generic revisit line", () => {
    const out = formatStatus(makeStatus({ visitCount: 2, revisitPrompt: "Admitted: A1" }));
    expect(out).toContain("Admitted: A1");
    expect(out).not.toContain("Revisit #2");
  });

  it("without revisit_prompt a revisit shows the generic line", () => {
    expect(formatStatus(makeStatus({ visitCount: 2 }))).toContain("Revisit #2");
  });

  it("a forced full prompt wins over revisit_prompt", () => {
    const out = formatStatus(makeStatus({ visitCount: 2, revisitPrompt: "R" }), {
      forceFullPrompt: true,
    });
    expect(out).toContain("FULL ROUTING RULES");
    expect(out).not.toContain("\nR");
  });

  it("full_on_revisit wins over revisit_prompt", () => {
    const out = formatStatus(
      makeStatus({
        visitCount: 2,
        revisitPrompt: "R-PROMPT",
        currentState: { prompt: "FULL ROUTING RULES", full_on_revisit: true },
      }),
    );
    expect(out).toContain("FULL ROUTING RULES");
    expect(out).not.toContain("R-PROMPT");
  });

  it("digest keys are per workflow:state — a different state is unaffected", () => {
    formatStatus(makeStatus());
    const other = makeStatus({
      currentStateName: "doc_sync",
      currentState: { prompt: "DOC SYNC RULES", digest_on_repeat: true },
      prompt: "DOC SYNC RULES",
    });
    const out = formatStatus(other);
    expect(out).toContain("DOC SYNC RULES");
  });
});

describe("formatStatus digest_on_repeat across a context reset", () => {
  let dir: string;
  let marker: string;
  beforeEach(() => {
    resetDeliveredPrompts();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-epoch-"));
    marker = path.join(dir, "context-epoch-1");
    setContextEpochFile(marker);
  });
  afterEach(() => {
    setContextEpochFile(null);
    cleanupDir(dir);
  });

  it("a rewritten marker (/clear, /compact) re-delivers the full prompt once", () => {
    expect(formatStatus(makeStatus())).toContain("FULL ROUTING RULES");
    expect(formatStatus(makeStatus())).not.toContain("FULL ROUTING RULES");

    fs.writeFileSync(marker, "1000.1\n");
    expect(formatStatus(makeStatus())).toContain("FULL ROUTING RULES");
    expect(formatStatus(makeStatus())).not.toContain("FULL ROUTING RULES");

    fs.writeFileSync(marker, "1001.2\n");
    expect(formatStatus(makeStatus())).toContain("FULL ROUTING RULES");
  });

  it("an existing marker at boot does not re-deliver after the first digest", () => {
    fs.writeFileSync(marker, "999.1\n");
    expect(formatStatus(makeStatus())).toContain("FULL ROUTING RULES");
    expect(formatStatus(makeStatus())).not.toContain("FULL ROUTING RULES");
  });
});

describe("registerTools mutation serialization", () => {
  // Storage whose write yields before landing, like the real lockfile-backed one.
  class SlowStorage extends InMemoryStorage {
    override async write(sessionId: string, state: SessionState): Promise<void> {
      await new Promise(r => setTimeout(r, 5));
      await super.write(sessionId, state);
    }
  }

  let dir: string | undefined;
  afterEach(() => {
    if (dir) cleanupDir(dir);
  });

  function mountTools(workflows: Record<string, object>) {
    const storage = new SlowStorage();
    const result = createTestLoader(workflows);
    dir = result.dir;
    const engine = new Engine(storage, result.loader, new Executor());
    const handlers = new Map<string, (args: object) => Promise<{ isError?: boolean }>>();
    const server = {
      registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h),
    };
    registerTools(server as never, engine, {} as never, result.loader, storage);
    return { storage, engine, call: (name: string, args: object) => handlers.get(name)!(args) };
  }

  // The plan pane reads `<workflow> @ <state>` off these replies (hooks/plan-pane.test.tsx draws the
  // tool-group chain from the recorded copy): a change of the reply's shape fails here, not on the screen.
  // WF_RECORD_REPLIES=1 writes the copy afresh.
  it("the plan pane's recorded start / transition replies are what the engine answers", async () => {
    const { call } = mountTools({
      pipe: {
        initial: "plan",
        states: {
          plan: { prompt: "Plan it", transitions: { go: "work" } },
          work: { prompt: "Work", transitions: { done: "end" } },
          end: { terminal: true, outcome: "complete" },
        },
      },
    });
    const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
    const started = text(await call("start", { workflow: "pipe" }));
    const sid = /^SESSION: (\S+)/m.exec(started)?.[1] ?? "";
    const moved = text(await call("transition", { session_id: sid, transition: "go" }));
    const norm = (t: string) => t.split(sid).join("SID");
    const file = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "hooks",
      "fixtures",
      "engine-replies.ts",
    );
    if (process.env.WF_RECORD_REPLIES === "1")
      fs.writeFileSync(
        file,
        `// Recorded engine replies (src/tools.test.ts checks them; WF_RECORD_REPLIES=1 re-records).\n` +
          `export const START_REPLY = ${JSON.stringify(norm(started))};\n` +
          `export const TRANSITION_REPLY = ${JSON.stringify(norm(moved))};\n`,
      );
    const rec = await import("../hooks/fixtures/engine-replies.js");
    expect(sid).not.toBe("");
    expect(norm(started)).toBe(rec.START_REPLY);
    expect(norm(moved)).toBe(rec.TRANSITION_REPLY);
  });

  it("parallel context_set + transition keep both changes", async () => {
    const { storage, engine, call } = mountTools({ simple: SIMPLE_WORKFLOW });

    const { sessionId } = await engine.start("simple");
    await Promise.all([
      call("context_set", { session_id: sessionId, key: "k", value: "v" }),
      call("transition", { session_id: sessionId, transition: "next" }),
    ]);

    const session = storage.read(sessionId)!;
    expect(session.context.k).toBe("v");
    expect(session.stack.length === 0 || session.stack[0].current_state === "end").toBe(true);
  });

  it("a slow mutation on one session does not hold back another session", async () => {
    const { engine, call } = mountTools({
      simple: SIMPLE_WORKFLOW,
      slow: {
        initial: "start",
        states: {
          start: { prompt: "go", transitions: { next: "wait" } },
          wait: { type: "exec", command: "sleep 0.3", on_success: "work", on_error: "work" },
          work: { prompt: "working", transitions: { done: "end" } },
          end: { terminal: true, outcome: "complete" },
        },
      },
    });

    const a = await engine.start("slow");
    const b = await engine.start("simple", undefined, a.sessionId);
    const finished: string[] = [];
    const [ra, rb] = await Promise.all([
      call("transition", { session_id: a.sessionId, transition: "next" }).then(r => {
        finished.push("a");
        return r;
      }),
      call("context_set", { session_id: b.sessionId, key: "k", value: "v" }).then(r => {
        finished.push("b");
        return r;
      }),
    ]);

    expect(ra.isError).toBeUndefined();
    expect(rb.isError).toBeUndefined();
    expect(finished).toEqual(["b", "a"]);
  });
});

describe("registerTools annotations", () => {
  it("readOnlyHint marks exactly the engine-state tools", () => {
    const annotations = new Map<string, unknown>();
    const server = {
      registerTool: (name: string, cfg: { annotations?: unknown }) =>
        annotations.set(name, cfg.annotations),
    };
    registerTools(server as never, {} as never, {} as never, {} as never, {} as never);

    const readOnly = [
      "list",
      "start",
      "status",
      "transition",
      "context_set",
      "sessions",
      "pool_status",
      "resume",
      "suspended",
      "link_agent",
    ];
    // Mutating tools keep their confirmation prompt; the queue tools write a project file
    const confirmed = [
      "modify",
      "create",
      "delete",
      "abort",
      "set_priority",
      "queue_next",
      "queue_mark",
      "queue_add",
      "queue_edit",
      "queue_header",
    ];
    expect([...annotations.keys()].sort()).toEqual([...readOnly, ...confirmed].sort());
    for (const name of readOnly) expect(annotations.get(name)).toEqual({ readOnlyHint: true });
    for (const name of confirmed) expect(annotations.get(name)).toBeUndefined();
  });
});

describe("ENG-1a: status context, failed outcome, start cwd", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) cleanupDir(dir);
    dir = undefined;
  });

  function mount(workflows: Record<string, object>) {
    const storage = new InMemoryStorage();
    const result = createTestLoader(workflows);
    dir = result.dir;
    const engine = new Engine(storage, result.loader, new Executor());
    const handlers = new Map<
      string,
      (args: object) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
    >();
    const server = {
      registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h),
    };
    registerTools(server as never, engine, {} as never, result.loader, storage);
    const call = async (name: string, args: object) => {
      const r = await handlers.get(name)!(args);
      return { isError: r.isError, text: r.content[0].text };
    };
    return { storage, engine, call };
  }

  it("queue_add creates a missing queue addressed by name and says so; a missing full path is an error", async () => {
    const { call } = mount({ w: SIMPLE_WORKFLOW });
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "wf-qadd-"));
    fs.mkdirSync(path.join(proj, ".git"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(proj);
    try {
      const made = await call("queue_add", { queue: "n", task: { id: "A", touches: ["a"] } });
      expect(made.isError).toBeUndefined();
      expect(made.text).toContain("the queue did not exist — created");
      const file = path.join(proj, ".claude", "batch", "n.yaml");
      expect(fs.existsSync(file)).toBe(true);
      // every queue tool on the YAML queue
      await call("queue_add", {
        queue: "n",
        task: { id: "B", after: ["A"], touches: "b", text: "Do B." },
      });
      expect((await call("queue_header", { queue: "n", batch_size: 2, reason: "two" })).text).toBe(
        "batch_size 1 → 2  # two",
      );
      const next = await call("queue_next", { queue: "n" });
      expect(next.text).toContain("ADMITTED (running) A |");
      expect(
        (
          await call("queue_mark", {
            queue: "n",
            id: "A",
            to: "done",
            note: "landed x",
            from: "land",
          })
        ).text,
      ).toBe("A: running → done");
      const edited = await call("queue_edit", {
        queue: "n",
        id: "B",
        set: { difficulty: 4, parked: true },
        append_note: "wait",
      });
      expect(edited.text).toContain("difficulty: 4\n");
      expect(edited.text).toContain("parked: true\n");
      const text = fs.readFileSync(file, "utf8");
      expect(text).toContain("reason: two\n");
      expect(text).toMatch(
        /- id: A\n {4}status: done\n {4}touches: \[ a \]\n {4}ended: \d{4}-\d\d-\d\d\n {4}notes:\n {6}- from: land\n/,
      );
      expect((await call("queue_next", { queue: "n", dry_run: true })).text).toContain(
        "admitted 0",
      );
      const typo = path.join(proj, "typo.yaml");
      const bad = await call("queue_add", { file: typo, task: { id: "B" } });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain(typo);
      expect(fs.existsSync(typo)).toBe(false);
    } finally {
      cwd.mockRestore();
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  it("formatContext cuts long values and folds keys past the limit", () => {
    const ctx: Record<string, unknown> = {
      long: "x".repeat(500),
      obj: { a: [1, 2] },
      multi: "a\nb",
    };
    for (let i = 0; i < 45; i++) ctx[`k${i}`] = i;
    const lines = formatContext(ctx);
    expect(lines[0]).toBe("CONTEXT:");
    expect(lines[1]).toBe(`  long: ${"x".repeat(200)}… [500 chars; status key="long" for all]`);
    expect(lines[2]).toBe('  obj: {"a":[1,2]}');
    expect(lines[3]).toBe("  multi: a\\nb");
    expect(lines.at(-1)).toBe("  … 8 more: k37, k38, k39, k40, k41, k42, k43, k44");
    expect(formatContext({})).toEqual([]);
  });

  it("status(session_id) shows a finished child's context", async () => {
    const { engine, call } = mount({ simple: SIMPLE_WORKFLOW });
    const parent = await engine.start("simple");
    const child = await engine.start("simple", undefined, parent.sessionId);
    await engine.setContext(child.sessionId, "verdict", "GREEN: 12 tests");
    await engine.transition(child.sessionId, "next");
    const r = await call("status", { session_id: child.sessionId });
    expect(r.text).toContain("CONTEXT:");
    expect(r.text).toContain("  verdict: GREEN: 12 tests");
  });

  it("status({ key }) returns one context value whole, of a finished child too", async () => {
    const { engine, call } = mount({ simple: SIMPLE_WORKFLOW });
    const parent = await engine.start("simple");
    const child = await engine.start("simple", undefined, parent.sessionId);
    const table = Array.from({ length: 20 }, (_, i) => `| row ${i} | ${"y".repeat(30)} |`).join(
      "\n",
    );
    await engine.setContext(child.sessionId, "gate", table);
    await engine.setContext(child.sessionId, "edits", { files: ["a.ts", "b.ts"], lines: 42 });
    await engine.transition(child.sessionId, "next");
    expect((await call("status", { session_id: child.sessionId })).text).toContain(
      'chars; status key="gate" for all]',
    );
    const gate = await call("status", { session_id: child.sessionId, key: "gate" });
    expect(gate.isError).toBeUndefined();
    expect(gate.text).toBe(table);
    expect((await call("status", { session_id: child.sessionId, key: "edits" })).text).toBe(
      JSON.stringify({ files: ["a.ts", "b.ts"], lines: 42 }, null, 2),
    );
    const missing = await call("status", { session_id: child.sessionId, key: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/^ERROR: Context key "nope" is not set\. Keys: .*gate, edits$/);
  });

  it("status and sessions show a failed root as (failed)", async () => {
    const { engine, call } = mount({
      f: {
        initial: "start",
        states: {
          start: { prompt: "go", transitions: { give_up: "bad" } },
          bad: { terminal: true, outcome: "fail" },
        },
      },
    });
    const { sessionId } = await engine.start("f");
    await engine.transition(sessionId, "give_up");
    expect((await call("status", { session_id: sessionId })).text).toContain("(failed)");
    expect((await call("sessions", { all: true })).text).toContain(`${sessionId}: (failed)`);
  });

  it("start tool passes cwd to the session and rejects a bad one", async () => {
    const { storage, call } = mount({ simple: SIMPLE_WORKFLOW });
    const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-wt-")));
    try {
      const ok = await call("start", { workflow: "simple", parent_session_id: "p", cwd: wt });
      expect(ok.isError).toBeUndefined();
      const sid = /SESSION: (\w+)/.exec(ok.text)![1];
      expect(storage.read(sid)!.context.cwd).toBe(wt);
      const bad = await call("start", {
        workflow: "simple",
        parent_session_id: "p",
        cwd: "relative",
      });
      expect(bad.isError).toBe(true);
    } finally {
      cleanupDir(wt);
    }
  });

  it("start with reply: id answers the session id and state without the prompt or the rules", async () => {
    const { storage, call } = mount({
      simple: SIMPLE_WORKFLOW,
      task: {
        initial: "claim",
        driver: { model: "haiku", effort: "low", prompt_ref: "task-driver" },
        states: {
          claim: { prompt: "claim {{context.task}} body", transitions: { go: "done" } },
          done: { terminal: true, outcome: "complete" },
        },
      },
    });
    const full = await call("start", { workflow: "simple", parent_session_id: "p" });
    const short = await call("start", { workflow: "simple", parent_session_id: "p", reply: "id" });
    expect(short.isError).toBeUndefined();
    const sid = /^SESSION: (\w+) @ (\w+)$/.exec(short.text)!;
    expect(sid).not.toBeNull();
    expect(storage.read(sid[1])!.stack.at(-1)!.current_state).toBe(sid[2]);
    expect(short.text).not.toContain("WORKFLOW RULES");
    expect(short.text).not.toContain("TRANSITIONS");
    expect(full.text).toContain("WORKFLOW RULES");
    const driven = await call("start", {
      workflow: "task",
      parent_session_id: "p",
      context: { task: "T1" },
      reply: "id",
    });
    const dsid = /^SESSION: (\w+) @ claim\n\n/.exec(driven.text)!;
    expect(dsid).not.toBeNull();
    expect(driven.text).not.toContain("body");
    expect(driven.text.endsWith(String(storage.read(dsid[1])!.context.driver_call))).toBe(true);
  });

  it("start with a context on a driver: workflow stores the keys, ends with the DRIVER block, refuses cwd", async () => {
    const { storage, call } = mount({
      task: {
        initial: "claim",
        driver: { model: "haiku", effort: "low", prompt_ref: "task-driver" },
        states: {
          claim: { prompt: "claim {{context.task}}", transitions: { go: "done" } },
          done: { terminal: true, outcome: "complete" },
        },
      },
    });
    const ok = await call("start", {
      workflow: "task",
      parent_session_id: "p",
      context: { task: "T9", queue_file: "/q/queue.md", difficulty: "4" },
    });
    expect(ok.isError).toBeUndefined();
    const sid = /SESSION: (\w+)/.exec(ok.text)![1];
    const ctx = storage.read(sid)!.context;
    expect(ctx).toMatchObject({ task: "T9", queue_file: "/q/queue.md", difficulty: "4" });
    expect(ok.text).toContain("claim T9");
    const block = String(ctx.driver_call);
    expect(block.startsWith("---\nDRIVER — this workflow is driven by an agent")).toBe(true);
    expect(block).toContain("task T9 of the queue /q/queue.md");
    expect(ok.text.endsWith(`\n\n${block}`)).toBe(true);
    const bad = await call("start", {
      workflow: "task",
      parent_session_id: "p",
      context: { task: "T9", cwd: "/x" },
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toBe(
      'ERROR: start context: "cwd" is the engine\'s (pass cwd as its own argument)',
    );
  });
});

describe("abort tool kills before queueing", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) cleanupDir(dir);
    dir = undefined;
  });

  it("abort of a session whose transition is running a foreground exec kills that exec at once", async () => {
    const storage = new InMemoryStorage();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "wf-abort-"));
    const pidFile = path.join(work, "pid");
    const result = createTestLoader({
      fg: {
        initial: "start",
        states: {
          start: { prompt: "go", transitions: { next: "run" } },
          run: {
            type: "exec",
            timeout: 60_000,
            command: `sleep 30 & echo $! > "${pidFile}"; wait`,
            on_success: "end",
            on_error: "end",
          },
          end: { terminal: true, outcome: "complete" },
        },
      },
    });
    dir = result.dir;
    const engine = new Engine(storage, result.loader, new Executor());
    const handlers = new Map<string, (args: object) => Promise<{ isError?: boolean }>>();
    const server = {
      registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h),
    };
    registerTools(server as never, engine, {} as never, result.loader, storage);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const { sessionId } = await engine.start("fg");
    const transition = handlers.get("transition")!({ session_id: sessionId, transition: "next" });
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++)
      await new Promise(r => setTimeout(r, 10));
    const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
    try {
      const abort = handlers.get("abort")!({ session_id: sessionId });
      for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise(r => setTimeout(r, 20));
      expect(alive(grandchild)).toBe(false);
      expect((await abort).isError).toBeUndefined();
      expect((await transition).isError).toBe(true);
      expect(storage.read(sessionId)!.outcome).toBe("abandoned");
    } finally {
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {
        /* gone */
      }
      cleanupDir(work);
    }
  }, 5000);
});

describe("per-session serialization queue", () => {
  it("a task that rejects reaches its caller and does not stall the session's queue", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let calls = 0;
      // A rejection with no Error makes the handler's own catch throw, so the queued task rejects.
      const engine = {
        resolveSessionId: (sid: string) => sid,
        assertNotSuspended: () => {},
        assertOwnership: () => undefined,
        orphanedStep: () => undefined,
        transition: () =>
          ++calls === 1
            ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error reason is the point
              Promise.reject(undefined)
            : Promise.resolve(makeStatus()),
      };
      const handlers = new Map<
        string,
        (args: object) => Promise<{ content: Array<{ text: string }> }>
      >();
      const server = {
        registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h),
      };
      registerTools(server as never, engine as never, {} as never, {} as never, {} as never);
      const transition = handlers.get("transition")!;
      const first = transition({ session_id: "s1", transition: "go" });
      const second = transition({ session_id: "s1", transition: "go" });
      await expect(first).rejects.toThrow(TypeError);
      const out = await Promise.race([
        second,
        new Promise<"stalled">(res => setTimeout(() => res("stalled"), 1000)),
      ]);
      expect(out).not.toBe("stalled");
      expect((out as { content: Array<{ text: string }> }).content[0].text).toContain("route");
      await new Promise(res => setTimeout(res, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
