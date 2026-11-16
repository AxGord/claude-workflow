import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { conversationAt, type ReplayFile } from "./replay.js";
import { InMemoryStorage, cleanupDir, createTestLoader } from "./test-helpers.js";

// A dispatcher (no `driver:`) whose `dispatch` state reads no stage, and a task workflow with `driver:` haiku.
const DISPATCH = {
  initial: "dispatch",
  states: {
    dispatch: { prompt: "dispatch", transitions: { end: "fin" } },
    fin: { terminal: true },
  },
};
const TASK = {
  initial: "work",
  driver: { model: "haiku", effort: "medium", prompt_ref: "task-driver" },
  states: { work: { prompt: "work", transitions: { end: "fin" } }, fin: { terminal: true } },
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

describe("the driver's link records the driver's model", () => {
  it("a dispatcher-linked task session's agent_link carries the driver spec, not the task's execute model", async () => {
    const storage = new InMemoryStorage();
    const { loader, dir } = createTestLoader({ dispatch: DISPATCH, task: TASK });
    dirs.push(dir);
    const engine = new Engine(storage, loader, new Executor());
    const d = await engine.start("dispatch");
    // the task's own context holds its EXECUTE model (from its difficulty), as the dispatcher seeds it
    const t = await engine.start("task", undefined, d.sessionId, undefined, undefined, {
      model: "opus",
      effort: "high",
    });
    await engine.linkAgent(t.sessionId, "driver-agent-1");
    const link = storage.events
      .since(0)
      .find(e => e.kind === "agent_link" && e.session === t.sessionId);
    expect(link, "agent_link logged").toBeDefined();
    // the replay labels this `driver · <model>`; the driver runs on haiku/medium
    expect(link!.data).toMatchObject({ role: "task", model: "haiku", effort: "medium" });
  });

  it("a replay of an old event (the task's execute model) reads the workflow's driver spec: `driver · haiku`", () => {
    const file: ReplayFile = {
      version: 1,
      project: "p",
      start: "2026-11-16T00:00:00Z",
      durationMs: 100,
      sessions: ["t1"],
      workflows: {
        task: {
          stations: [{ name: "work", script: false, terminal: false }],
          driver: { model: "haiku", effort: "medium" },
        },
      },
      taskKinds: {},
      events: [
        [0, "session_start", 0, { workflow: "task", task: "T" }],
        [5, "agent_link", 0, { role: "task", model: "opus", effort: "high" }],
      ],
    };
    expect(conversationAt(file, 100).find(l => l.kind === "spawn")).toMatchObject({
      role: "driver",
      model: "haiku",
    });
  });
});
