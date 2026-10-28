import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestLoader, cleanupDir } from "./test-helpers.js";
import { Loader } from "./loader.js";

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

describe("Loader strict schema", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) cleanupDir(d); vi.restoreAllMocks(); });

  function loadWithErrors(workflows: Record<string, object>) {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(" ")); });
    const { loader, dir } = createTestLoader(workflows);
    dirs.push(dir);
    return { loader, errors: errors.join("\n"), dir };
  }

  it("an unknown state key fails the load and names file, state, key and the nearest known key", () => {
    const { loader, errors, dir } = loadWithErrors({
      typo: {
        initial: "run",
        states: {
          run: { type: "exec", comand: "true", command: "true", on_success: "end", on_error: "end" },
          end: { terminal: true, outcome: "complete" },
        },
      },
    });
    expect(loader.get("typo")).toBeUndefined();
    expect(errors).toContain(`${dir}/typo.yaml: state "run": unknown key "comand" — did you mean "command"?`);
  });

  it("an unknown workflow key and an unknown retry key are errors too", () => {
    const { loader, errors } = loadWithErrors({
      top: {
        intial: "x",
        initial: "x",
        states: { x: { terminal: true } },
      },
      retry: {
        initial: "f",
        states: {
          f: { type: "fetch", url: "http://x", retry: { max: 2, intervall: 5 }, on_success: "e", on_error: "e" },
          e: { terminal: true },
        },
      },
    });
    expect(loader.get("top")).toBeUndefined();
    expect(loader.get("retry")).toBeUndefined();
    expect(errors).toContain('workflow: unknown key "intial" — did you mean "initial"?');
    expect(errors).toContain('state "f" (retry): unknown key "intervall" — did you mean "interval"?');
  });

  it("resource: is strict, exec-only and never on a background exec", () => {
    const exec = (resource: object, extra: object = {}) => ({
      initial: "r",
      states: {
        r: { type: "exec", command: "true", resource, on_success: "e", on_error: "e", ...extra },
        e: { terminal: true },
      },
    });
    const { loader, errors } = loadWithErrors({
      ok: exec({ threads: 4, priority: 1, wait_timeout: 30 }),
      typo: exec({ threads: 4, wait_timout: 30 }),
      bg: exec({ threads: 4 }, { background: true }),
      zero: exec({ threads: 0 }),
      budget: exec({ threads: "budget" }),
      all: exec({ threads: "all" }),
      locks: exec({ locks: ["port:3000"] }),
      both: exec({ threads: 2, locks: ["sim", "port:3000"] }),
      none: exec({ priority: 1 }),
      emptyLocks: exec({ locks: [] }),
      spaced: exec({ locks: ["a b"] }),
      fetch: {
        initial: "f",
        states: {
          f: { type: "fetch", url: "http://x", resource: { threads: 1 }, on_success: "e", on_error: "e" },
          e: { terminal: true },
        },
      },
    });
    expect(loader.get("ok")!.states.r.resource).toEqual({ threads: 4, priority: 1, wait_timeout: 30 });
    expect(loader.get("budget")!.states.r.resource).toEqual({ threads: "budget" });
    expect(loader.get("locks")!.states.r.resource).toEqual({ locks: ["port:3000"] });
    expect(loader.get("both")!.states.r.resource).toEqual({ threads: 2, locks: ["sim", "port:3000"] });
    for (const name of ["typo", "bg", "zero", "all", "fetch", "none", "emptyLocks", "spaced"]) expect(loader.get(name)).toBeUndefined();
    expect(errors).toMatch(/states\.r\.resource: resource needs threads, locks, or both/);
    expect(errors).toMatch(/states\.r\.resource\.locks\.0: a lock name is one word/);
    expect(errors).toContain('state "r" (resource): unknown key "wait_timout" — did you mean "wait_timeout"?');
    expect(errors).toContain('state "r" resource cannot hold a lease for a background exec');
    expect(errors).toContain('state "f" resource is for exec states');
  });

  it("resource: threads { min, max } with wait_full; wait_full only beside it", () => {
    const exec = (resource: object) => ({
      initial: "r",
      states: { r: { type: "exec", command: "true", resource, on_success: "e", on_error: "e" }, e: { terminal: true } },
    });
    const { loader, errors } = loadWithErrors({
      flex: exec({ threads: { min: 2, max: 8 }, wait_full: 30, priority: 1 }),
      flexBudget: exec({ threads: { min: 4, max: "budget" } }),
      inverted: exec({ threads: { min: 8, max: 2 } }),
      noMin: exec({ threads: { max: 8 } }),
      waitFixed: exec({ threads: 4, wait_full: 30 }),
      extraKey: exec({ threads: { min: 1, max: 2, avg: 1 } }),
    });
    expect(loader.get("flex")!.states.r.resource).toEqual({ threads: { min: 2, max: 8 }, wait_full: 30, priority: 1 });
    expect(loader.get("flexBudget")!.states.r.resource).toEqual({ threads: { min: 4, max: "budget" } });
    for (const name of ["inverted", "noMin", "waitFixed", "extraKey"]) expect(loader.get(name)).toBeUndefined();
    expect(errors).toMatch(/states\.r\.resource: wait_full needs threads: \{ min, max \}/);
  });

  it("on_exhausted must name a known state and needs max_visits", () => {
    const wf = (b: object) => ({
      initial: "a",
      states: { a: { prompt: "A", transitions: { go: "b" } }, b: { prompt: "B", transitions: { back: "a" }, ...b }, e: { terminal: true } },
    });
    const { loader, errors } = loadWithErrors({
      ok: wf({ max_visits: 2, on_exhausted: "e" }),
      unknown: wf({ max_visits: 2, on_exhausted: "nope" }),
      bare: wf({ on_exhausted: "e" }),
    });
    expect(loader.get("ok")!.states.b.on_exhausted).toBe("e");
    expect(loader.get("unknown")).toBeUndefined();
    expect(loader.get("bare")).toBeUndefined();
    expect(errors).toContain('state "b" on_exhausted → unknown state "nope"');
    expect(errors).toContain('state "b" on_exhausted needs max_visits');
  });

  it("every bundled template loads under the strict schema", () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(" ")); });
    const templates = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wf-empty-"));
    dirs.push(empty);
    const loader = new Loader(templates, empty, null);
    const yamls = fs.readdirSync(templates).filter(f => /\.ya?ml$/.test(f));
    expect(errors).toEqual([]);
    expect(loader.names().length).toBe(yamls.length);
  });
});
