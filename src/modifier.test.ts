import { describe, it, expect, afterEach } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Modifier } from "./modifier.js";
import {
  InMemoryStorage,
  createTestLoader,
  cleanupDir,
  MULTI_STATE_WORKFLOW,
} from "./test-helpers.js";
import type { Loader } from "./loader.js";

describe("Modifier", () => {
  let storage: InMemoryStorage;
  let loader: Loader;
  let engine: Engine;
  let modifier: Modifier;
  let dir: string;

  function setup(workflows: Record<string, object>) {
    storage = new InMemoryStorage();
    const result = createTestLoader(workflows);
    loader = result.loader;
    dir = result.dir;
    const executor = new Executor();
    engine = new Engine(storage, loader, executor);
    modifier = new Modifier(storage, loader);
    modifier.setEngine(engine);
  }

  afterEach(() => {
    if (dir) cleanupDir(dir);
  });

  it("add_state adds state accessible via engine", async () => {
    setup({ multi: MULTI_STATE_WORKFLOW });
    const { sessionId } = await engine.start("multi");

    const msgs = await modifier.modify(sessionId, {
      add_state: {
        name: "new_state",
        prompt: "New state prompt",
        transitions: { done: "c" },
      },
    });

    expect(msgs).toContain('Added state "new_state"');

    // Add transition to reach the new state
    await modifier.modify(sessionId, {
      add_transition: { from: "a", name: "go_new", to: "new_state" },
    });

    const result = await engine.transition(sessionId, "go_new");
    expect(result.currentStateName).toBe("new_state");
    expect(result.prompt).toBe("New state prompt");
  });

  it("add_transition makes new transition available", async () => {
    setup({ multi: MULTI_STATE_WORKFLOW });
    const { sessionId } = await engine.start("multi");

    await modifier.modify(sessionId, {
      add_transition: { from: "a", name: "shortcut", to: "c" },
    });

    const status = engine.getStatus(sessionId);
    expect(status.availableTransitions).toHaveProperty("shortcut", "c");
  });

  it("remove_transition removes a transition", async () => {
    setup({ multi: MULTI_STATE_WORKFLOW });
    const { sessionId } = await engine.start("multi");

    await modifier.modify(sessionId, {
      remove_transition: { from: "a", name: "go_b" },
    });

    const status = engine.getStatus(sessionId);
    expect(status.availableTransitions).not.toHaveProperty("go_b");
    expect(status.availableTransitions).toHaveProperty("go_c");
  });

  it("create writes YAML and loader picks it up", async () => {
    setup({ multi: MULTI_STATE_WORKFLOW });

    const filePath = await modifier.create("new_wf", {
      initial: "s",
      states: {
        s: { prompt: "Start", transitions: { done: "e" } },
        e: { terminal: true, prompt: "End", outcome: "complete" },
      },
    });

    expect(filePath).toContain("new_wf.yaml");
    expect(loader.get("new_wf")).toBeDefined();
  });
});
