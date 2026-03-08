import { describe, it, expect, afterEach } from "vitest";
import { createTestLoader, cleanupDir } from "./test-helpers.js";

describe("Loader", () => {
  const dirs: string[] = [];
  const make = (workflows: Record<string, object>) => {
    const { loader, dir } = createTestLoader(workflows);
    dirs.push(dir);
    return loader;
  };

  afterEach(() => {
    for (const d of dirs) cleanupDir(d);
    dirs.length = 0;
  });

  it("loads valid workflow", () => {
    const loader = make({
      test: {
        initial: "start",
        states: {
          start: { prompt: "Go", transitions: { done: "end" } },
          end: { terminal: true, prompt: "Done", outcome: "complete" },
        },
      },
    });
    const wf = loader.get("test");
    expect(wf).toBeDefined();
    expect(wf!.initial).toBe("start");
    expect(wf!.states.start.prompt).toBe("Go");
  });

  it("rejects missing initial state", () => {
    const loader = make({
      bad: {
        initial: "nonexistent",
        states: {
          start: { prompt: "Go", transitions: { done: "end" } },
          end: { terminal: true, prompt: "Done", outcome: "complete" },
        },
      },
    });
    expect(loader.get("bad")).toBeUndefined();
  });

  it("rejects workflow with no terminal state", () => {
    const loader = make({
      bad: {
        initial: "start",
        states: {
          start: { prompt: "Go", transitions: { next: "middle" } },
          middle: { prompt: "Mid", transitions: { back: "start" } },
        },
      },
    });
    expect(loader.get("bad")).toBeUndefined();
  });

  it("rejects exec state without command", () => {
    const loader = make({
      bad: {
        initial: "start",
        states: {
          start: { type: "exec", on_success: "end", on_error: "end" },
          end: { terminal: true, prompt: "Done", outcome: "complete" },
        },
      },
    });
    expect(loader.get("bad")).toBeUndefined();
  });

  it("rejects action state without routing", () => {
    const loader = make({
      bad: {
        initial: "start",
        states: {
          start: { type: "exec", command: "echo hi" },
          end: { terminal: true, prompt: "Done", outcome: "complete" },
        },
      },
    });
    expect(loader.get("bad")).toBeUndefined();
  });

  it("rejects action state with transitions", () => {
    const loader = make({
      bad: {
        initial: "start",
        states: {
          start: {
            type: "exec",
            command: "echo hi",
            on_success: "end",
            on_error: "end",
            transitions: { foo: "end" },
          },
          end: { terminal: true, prompt: "Done", outcome: "complete" },
        },
      },
    });
    expect(loader.get("bad")).toBeUndefined();
  });

  it("rejects action state with sub_workflow", () => {
    const loader = make({
      bad: {
        initial: "start",
        states: {
          start: {
            type: "exec",
            command: "echo hi",
            on_success: "end",
            on_error: "end",
            sub_workflow: "other",
          },
          end: { terminal: true, prompt: "Done", outcome: "complete" },
        },
      },
    });
    expect(loader.get("bad")).toBeUndefined();
  });

  it("rejects cases without default", () => {
    const loader = make({
      bad: {
        initial: "start",
        states: {
          start: {
            type: "exec",
            command: "echo hi",
            cases: { "0": "end" },
          },
          end: { terminal: true, prompt: "Done", outcome: "complete" },
        },
      },
    });
    expect(loader.get("bad")).toBeUndefined();
  });

  it("rejects transition to unknown state", () => {
    const loader = make({
      bad: {
        initial: "start",
        states: {
          start: { prompt: "Go", transitions: { done: "nowhere" } },
          end: { terminal: true, prompt: "Done", outcome: "complete" },
        },
      },
    });
    expect(loader.get("bad")).toBeUndefined();
  });

  it("lists workflow names", () => {
    const loader = make({
      alpha: {
        initial: "s",
        states: { s: { terminal: true, prompt: "Done", outcome: "complete" } },
      },
      beta: {
        initial: "s",
        states: { s: { terminal: true, prompt: "Done", outcome: "complete" } },
      },
    });
    expect(loader.names().sort()).toEqual(["alpha", "beta"]);
  });
});
