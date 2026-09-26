import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { formatStatus, registerTools, resetDeliveredPrompts } from "./tools.js";
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
    expect(out).toContain("already delivered earlier in this process");
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

describe("registerTools mutation serialization", () => {
  // Storage whose write yields before landing, like the real lockfile-backed one.
  class SlowStorage extends InMemoryStorage {
    override async write(sessionId: string, state: SessionState): Promise<void> {
      await new Promise(r => setTimeout(r, 5));
      await super.write(sessionId, state);
    }
  }

  let dir: string | undefined;
  afterEach(() => { if (dir) cleanupDir(dir); });

  function mountTools(workflows: Record<string, object>) {
    const storage = new SlowStorage();
    const result = createTestLoader(workflows);
    dir = result.dir;
    const engine = new Engine(storage, result.loader, new Executor());
    const handlers = new Map<string, (args: object) => Promise<{ isError?: boolean }>>();
    const server = { registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h) };
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
      call("transition", { session_id: a.sessionId, transition: "next" }).then(r => { finished.push("a"); return r; }),
      call("context_set", { session_id: b.sessionId, key: "k", value: "v" }).then(r => { finished.push("b"); return r; }),
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
      registerTool: (name: string, cfg: { annotations?: unknown }) => annotations.set(name, cfg.annotations),
    };
    registerTools(server as never, {} as never, {} as never, {} as never, {} as never);

    const readOnly = ["list", "start", "status", "transition", "context_set", "sessions"];
    // Mutating tools keep their confirmation prompt
    const confirmed = ["modify", "create", "delete", "abort"];
    expect([...annotations.keys()].sort()).toEqual([...readOnly, ...confirmed].sort());
    for (const name of readOnly) expect(annotations.get(name)).toEqual({ readOnlyHint: true });
    for (const name of confirmed) expect(annotations.get(name)).toBeUndefined();
  });
});
