import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import {
  InMemoryStorage,
  createTestLoader,
  cleanupDir,
  SIMPLE_WORKFLOW,
  MULTI_STATE_WORKFLOW,
} from "./test-helpers.js";
import type { Loader } from "./loader.js";
import type { ActionResult } from "./types.js";

describe("Engine", () => {
  let storage: InMemoryStorage;
  let loader: Loader;
  let executor: Executor;
  let engine: Engine;
  let dir: string;

  function setup(workflows: Record<string, object>) {
    storage = new InMemoryStorage();
    const result = createTestLoader(workflows);
    loader = result.loader;
    dir = result.dir;
    executor = new Executor();
    engine = new Engine(storage, loader, executor);
  }

  afterEach(() => {
    if (dir) cleanupDir(dir);
  });

  describe("start", () => {
    it("creates session with initial state prompt", async () => {
      setup({ simple: SIMPLE_WORKFLOW });
      const result = await engine.start("simple");

      expect(result.sessionId).toHaveLength(8);
      expect(result.currentStateName).toBe("start");
      expect(result.currentWorkflow).toBe("simple");
      expect(result.prompt).toBe("Start state");
      expect(result.availableTransitions).toEqual({ next: "end" });
      expect(result.stack).toHaveLength(1);
    });

    it("throws for unknown workflow", async () => {
      setup({ simple: SIMPLE_WORKFLOW });
      await expect(engine.start("nonexistent")).rejects.toThrow("not found");
    });
  });

  describe("transition", () => {
    it("transitions A → B", async () => {
      setup({ multi: MULTI_STATE_WORKFLOW });
      const { sessionId } = await engine.start("multi");

      const result = await engine.transition(sessionId, "go_b");
      expect(result.currentStateName).toBe("b");
      expect(result.prompt).toBe("State B");
    });

    it("rejects unknown transition name", async () => {
      setup({ multi: MULTI_STATE_WORKFLOW });
      const { sessionId } = await engine.start("multi");

      await expect(engine.transition(sessionId, "nonexistent"))
        .rejects.toThrow("not available");
    });

    it("enforces max_transitions", async () => {
      setup({
        limited: {
          initial: "a",
          max_transitions: 2,
          states: {
            a: { prompt: "A", transitions: { go: "b" } },
            b: { prompt: "B", transitions: { go: "a" } },
            end: { terminal: true, prompt: "Done", outcome: "complete" },
          },
        },
      });

      const { sessionId } = await engine.start("limited");
      await engine.transition(sessionId, "go"); // a→b (1)
      await engine.transition(sessionId, "go"); // b→a (2)
      await expect(engine.transition(sessionId, "go"))
        .rejects.toThrow("Max transitions");
    });

    it("enforces max_visits", async () => {
      setup({
        visits: {
          initial: "a",
          states: {
            a: { prompt: "A", transitions: { go: "b" } },
            b: { prompt: "B", transitions: { back: "a" }, max_visits: 2 },
            end: { terminal: true, prompt: "Done", outcome: "complete" },
          },
        },
      });

      const { sessionId } = await engine.start("visits");
      await engine.transition(sessionId, "go");   // a→b (visit 1)
      await engine.transition(sessionId, "back");  // b→a
      await engine.transition(sessionId, "go");    // a→b (visit 2)
      await engine.transition(sessionId, "back");  // b→a
      await expect(engine.transition(sessionId, "go"))
        .rejects.toThrow("max_visits");
    });

    it("terminal state pops stack (single frame = complete)", async () => {
      setup({ simple: SIMPLE_WORKFLOW });
      const { sessionId } = await engine.start("simple");

      const result = await engine.transition(sessionId, "next");
      expect(result.stack).toHaveLength(0);
      expect(result.prompt).toContain("completed");
    });
  });

  describe("sub_workflow", () => {
    it("pushes sub_workflow on transition", async () => {
      setup({
        parent: {
          initial: "start",
          states: {
            start: {
              sub_workflow: "child",
              on_complete: "done",
              on_fail: "done",
            },
            done: { terminal: true, prompt: "Parent done", outcome: "complete" },
          },
        },
        child: {
          initial: "work",
          states: {
            work: { prompt: "Child work", transitions: { finish: "end" } },
            end: { terminal: true, prompt: "Child done", outcome: "complete" },
          },
        },
      });

      const result = await engine.start("parent");
      // Should auto-push into child workflow
      expect(result.stack).toHaveLength(2);
      expect(result.currentWorkflow).toBe("child");
      expect(result.currentStateName).toBe("work");
    });

    it("pops back to parent on child completion", async () => {
      setup({
        parent: {
          initial: "start",
          states: {
            start: {
              sub_workflow: "child",
              on_complete: "done",
              on_fail: "done",
            },
            done: { terminal: true, prompt: "Parent done", outcome: "complete" },
          },
        },
        child: {
          initial: "work",
          states: {
            work: { prompt: "Child work", transitions: { finish: "end" } },
            end: { terminal: true, prompt: "Child done", outcome: "complete" },
          },
        },
      });

      const { sessionId } = await engine.start("parent");
      // In child → transition to terminal
      const result = await engine.transition(sessionId, "finish");
      // Should pop child, move parent to "done" (terminal), then complete
      expect(result.stack).toHaveLength(0);
      expect(result.prompt).toContain("completed");
    });
  });

  describe("action states", () => {
    it("auto-executes and routes on_success", async () => {
      setup({
        act: {
          initial: "run",
          states: {
            run: {
              type: "exec",
              command: "echo hello",
              on_success: "ok",
              on_error: "fail",
            },
            ok: { prompt: "Success!", terminal: true, outcome: "complete" },
            fail: { prompt: "Failed!", terminal: true, outcome: "fail" },
          },
        },
      });

      const result = await engine.start("act");
      // Should auto-execute, route to "ok", then pop (terminal)
      expect(result.stack).toHaveLength(0);
      expect(result.prompt).toContain("completed");
    });

    it("routes on_error for failed command", async () => {
      setup({
        act: {
          initial: "run",
          states: {
            run: {
              type: "exec",
              command: "exit 1",
              on_success: "ok",
              on_error: "recover",
            },
            ok: { prompt: "Success!", terminal: true, outcome: "complete" },
            recover: { prompt: "Something went wrong", terminal: true, outcome: "fail" },
          },
        },
      });

      const result = await engine.start("act");
      // Should auto-execute, fail, route to "recover" which is terminal
      expect(result.stack).toHaveLength(0);
    });

    it("chains exec→exec→prompt", async () => {
      setup({
        chain: {
          initial: "step1",
          states: {
            step1: {
              type: "exec",
              command: "echo one",
              on_success: "step2",
              on_error: "fail",
            },
            step2: {
              type: "exec",
              command: "echo two",
              on_success: "done",
              on_error: "fail",
            },
            done: { prompt: "All steps done", transitions: { finish: "end" } },
            fail: { prompt: "Failed", terminal: true, outcome: "fail" },
            end: { terminal: true, prompt: "Ended", outcome: "complete" },
          },
        },
      });

      const result = await engine.start("chain");
      // step1 → step2 → done (prompt state, stops chain)
      expect(result.currentStateName).toBe("done");
      expect(result.prompt).toBe("All steps done");
    });

    it("routes using cases + default", async () => {
      setup({
        cases: {
          initial: "check",
          states: {
            check: {
              type: "exec",
              command: "exit 2",
              cases: { "0": "ok", "1": "warn" },
              default: "error",
            },
            ok: { prompt: "OK", terminal: true, outcome: "complete" },
            warn: { prompt: "Warning", terminal: true, outcome: "complete" },
            error: { prompt: "Error", terminal: true, outcome: "fail" },
          },
        },
      });

      const result = await engine.start("cases");
      // exit 2 → not in cases → default "error"
      expect(result.stack).toHaveLength(0);
    });

    it("errors on action chain depth > 20", async () => {
      // Build a chain of 25 exec states
      const states: Record<string, object> = {};
      for (let i = 0; i < 25; i++) {
        states[`step${i}`] = {
          type: "exec",
          command: "echo ok",
          on_success: i < 24 ? `step${i + 1}` : "end",
          on_error: "end",
        };
      }
      states.end = { terminal: true, prompt: "Done", outcome: "complete" };

      setup({ deep: { initial: "step0", states } });

      await expect(engine.start("deep")).rejects.toThrow("max depth");
    });
  });

  describe("template rendering", () => {
    it("renders {{context.X}} in prompts", async () => {
      setup({
        tpl: {
          initial: "start",
          states: {
            start: {
              prompt: "Working in {{context.cwd}}",
              transitions: { done: "end" },
            },
            end: { terminal: true, prompt: "Done", outcome: "complete" },
          },
        },
      });

      const result = await engine.start("tpl");
      // cwd is set to process.cwd() in engine.start()
      expect(result.prompt).toContain(process.cwd());
    });
  });

  describe("setContext", () => {
    it("updates context and persists", async () => {
      setup({ simple: SIMPLE_WORKFLOW });
      const { sessionId } = await engine.start("simple");

      await engine.setContext(sessionId, "foo", "bar");

      const status = engine.getStatus(sessionId);
      expect(status.context.foo).toBe("bar");
    });
  });

  describe("abort", () => {
    it("clears stack and sets outcome", async () => {
      setup({ multi: MULTI_STATE_WORKFLOW });
      const { sessionId } = await engine.start("multi");

      await engine.abort(sessionId);

      const status = engine.getStatus(sessionId);
      expect(status.stack).toHaveLength(0);
      expect(status.prompt).toContain("abandoned");
    });
  });

  describe("getStatus", () => {
    it("returns current state info", async () => {
      setup({ multi: MULTI_STATE_WORKFLOW });
      const { sessionId } = await engine.start("multi");
      await engine.transition(sessionId, "go_b");

      const status = engine.getStatus(sessionId);
      expect(status.currentStateName).toBe("b");
      expect(status.currentWorkflow).toBe("multi");
      expect(status.visitCount).toBe(1);
    });
  });
});
