import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Loader } from "./loader.js";
import { cleanupDir, createFixtureDir, trustStoreFor } from "./test-helpers.js";

// A project's task workflow `extends: batch-task` and replaces the `work` and `review` states with its
// own prompts (a same-named state is replaced whole): the engine's protocol rules the bundled prompts
// carry (Waits, the DELIVERED hand-back line) must still reach the heir's loaded prompts.
const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const WORK = "Sibling worker prompt: do the task in {{context.wt}}, then answer DONE.";
const REVIEW = "Sibling reviewer prompt: read the diff, answer a verdict.";

function heir(work: string, review: string, name = "sibling-task") {
  return {
    [name]: {
      extends: "batch-task",
      states: {
        work: { prompt: work, transitions: { done: "work_check", blocked: "blocked" } },
        review: { prompt: review, transitions: { pass: "project_land", fixes: "work" } },
      },
    },
  };
}

function loaderOf(files: Record<string, unknown>) {
  const project = createFixtureDir(files as Record<string, object>);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wf-heir-"));
  dirs.push(project, empty);
  const approved = fs.readdirSync(project).map(f => path.join(project, f));
  return new Loader(TEMPLATES, empty, project, trustStoreFor(...approved));
}

const count = (text: string, part: string) => text.split(part).length - 1;

describe("a heir of batch-task that overrides work and review", () => {
  const loader = loaderOf(heir(WORK, REVIEW));
  const baseGlobal = fs.mkdtempSync(path.join(os.tmpdir(), "wf-heir-"));
  dirs.push(baseGlobal);
  const base = new Loader(TEMPLATES, baseGlobal, null);

  it("control: the bundled work and review prompts carry the Waits rules", () => {
    for (const s of ["work", "review"]) {
      expect(base.get("batch-task")!.states[s].prompt).toContain("Waits:");
    }
  });

  it("the heir's own prompts are the ones loaded (the override took effect)", () => {
    const wf = loader.get("sibling-task")!;
    expect(wf.states.work.prompt).toContain("Sibling worker prompt");
    expect(wf.states.review.prompt).toContain("Sibling reviewer prompt");
  });

  it("the heir's work prompt still carries the engine's Waits rules", () => {
    expect(loader.get("sibling-task")!.states.work.prompt).toContain("Waits:");
  });

  it("the heir's review prompt still carries the engine's Waits rules", () => {
    expect(loader.get("sibling-task")!.states.review.prompt).toContain("Waits:");
  });
});

describe("how an heir places, drops or misnames the engine's rules", () => {
  const WAITS = "Waits: a command you wait for runs in the FOREGROUND";
  const RWAITS = "Waits: every command you run is in the FOREGROUND";

  it("the rules arrive once, with the marker expanded away", () => {
    const wf = loaderOf(heir(WORK, REVIEW)).get("sibling-task")!;
    expect(count(wf.states.work.prompt!, WAITS)).toBe(1);
    expect(count(wf.states.review.prompt!, RWAITS)).toBe(1);
    expect(wf.states.work.prompt).not.toContain("{{rules.");
  });

  it("a marker the heir places itself is not carried a second time", () => {
    const wf = loaderOf(heir(`${WORK}\nMy spot: {{rules.worker_waits}}`, REVIEW)).get(
      "sibling-task",
    )!;
    expect(count(wf.states.work.prompt!, WAITS)).toBe(1);
    expect(wf.states.work.prompt).toContain("My spot: Waits:");
  });

  it("{{rules.none}} drops the rules of that state only", () => {
    const wf = loaderOf(heir(`${WORK} {{rules.none}}`, REVIEW)).get("sibling-task")!;
    expect(wf.states.work.prompt).not.toContain("Waits:");
    expect(wf.states.review.prompt).toContain(RWAITS);
  });

  it("an unknown block fails the heir's load and names the block", () => {
    const loader = loaderOf(heir(`${WORK} {{rules.nope}}`, REVIEW));
    expect(loader.get("sibling-task")).toBeUndefined();
    expect(
      loader
        .broken()
        .map(b => b.reason)
        .join(" "),
    ).toContain('unknown rules block "nope"');
  });

  it("an heir of an heir keeps the rules through a second replacement", () => {
    const loader = loaderOf({
      ...heir(WORK, REVIEW),
      "grandchild-task": {
        extends: "sibling-task",
        states: { work: { prompt: "Grandchild prompt.", transitions: { done: "work_check" } } },
      },
    });
    expect(count(loader.get("grandchild-task")!.states.work.prompt!, WAITS)).toBe(1);
  });

  it("the engine's own task workflow carries the worker and the reviewer rules once each", () => {
    const dir = path.resolve(TEMPLATES, "..", ".claude", "workflows");
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wf-heir-"));
    dirs.push(empty);
    const loader = new Loader(
      TEMPLATES,
      empty,
      dir,
      trustStoreFor(path.join(dir, "engine-task.yaml")),
    );
    const wf = loader.get("engine-task")!;
    expect(count(wf.states.work.prompt!, WAITS)).toBe(1);
    expect(count(wf.states.review.prompt!, RWAITS)).toBe(1);
    expect(count(wf.states.review.prompt!, "Waits:")).toBe(1);
    expect(wf.states.work.prompt).not.toContain("{{rules.");
    expect(wf.states.review.prompt).not.toContain("{{rules.");
  });
});
