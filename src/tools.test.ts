import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
    // Mutating tools keep their confirmation prompt
    const confirmed = ["modify", "create", "delete", "abort", "set_priority"];
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
        adoptOrphanedExec: () => Promise.resolve(null),
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
