import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { render } from "./template.js";
import { InMemoryStorage, cleanupDir, trustStoreFor } from "./test-helpers.js";

// ENG-TASK-REVIEWER-MODEL-FROM-TABLE: engine-task's `review` state names the round-1 reviewer's model
// by hand (opus / high), so the model_table's review row never reaches it.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(ROOT, "templates");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

// A project that carries engine-task as-is plus a heir `local-task` replacing the model_table: the
// review row is sonnet/low at every difficulty, which the inherited table never yields.
function project(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-rev-table-")));
  dirs.push(d);
  const wf = path.join(d, ".claude", "workflows");
  fs.mkdirSync(wf, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, ".claude/workflows/engine-task.yaml"),
    path.join(wf, "engine-task.yaml"),
  );
  fs.writeFileSync(
    path.join(wf, "local-task.yaml"),
    [
      "name: local-task",
      "extends: engine-task",
      "model_table:",
      "  stages:",
      "    execute:",
      "      - { upto: 10, model: haiku, effort: low }",
      "    review:",
      "      - { upto: 10, model: sonnet, effort: low }",
      "    review_verify:",
      "      - { upto: 10, model: haiku, effort: low }",
      "",
    ].join("\n"),
  );
  return wf;
}

describe("engine-task round-1 reviewer follows the model_table review row", () => {
  it("the rendered review prompt names the table's review row, not opus / high", async () => {
    const wf = project();
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wf-rev-global-"));
    dirs.push(empty);
    const trust = trustStoreFor(
      path.join(wf, "engine-task.yaml"),
      path.join(wf, "local-task.yaml"),
    );
    const loader = new Loader(TEMPLATES, empty, wf, trust);
    const engine = new Engine(new InMemoryStorage(), loader, new Executor());
    const s = await engine.start(
      "local-task",
      undefined,
      undefined,
      path.dirname(path.dirname(wf)),
      undefined,
      {
        task: "T1",
        difficulty: "5",
      },
    );
    // the session carries the table's review row
    expect(s.context).toMatchObject({ model_review: "sonnet", effort_review: "low" });

    const review = loader.get("local-task")!.states.review;
    const prompt = render(review.prompt!, {
      context: s.context,
      visits: { review: 1 },
    });
    const first = prompt.slice(prompt.indexOf("First entry"));
    const spawn = first.slice(0, first.indexOf("prompt:"));
    expect(spawn).toContain("sonnet");
    expect(spawn).toContain("low");
    expect(spawn).not.toMatch(/model opus, effort high/);
  });

  it("an agent linked while the session is at review records stage review, not execute", async () => {
    const wf = project();
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wf-rev-global-"));
    dirs.push(empty);
    const trust = trustStoreFor(
      path.join(wf, "engine-task.yaml"),
      path.join(wf, "local-task.yaml"),
    );
    const loader = new Loader(TEMPLATES, empty, wf, trust);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, loader, new Executor());
    const cwd = path.dirname(path.dirname(wf));
    const parent = await engine.start("local-task", undefined, undefined, cwd, undefined, {
      task: "T1",
      difficulty: "5",
    });
    await storage.update(parent.sessionId, cur => {
      if (!cur) return null;
      const stack = cur.stack.map((f, i) =>
        i === cur.active_frame ? { ...f, current_state: "review" } : f,
      );
      return { ...cur, stack };
    });
    const child = await engine.start("local-task", undefined, parent.sessionId, cwd);
    await engine.linkAgent(child.sessionId, "a6ce19528a40dde95");
    const links = storage.read(child.sessionId)?.agent_links ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ state: "review", stage: "review" });
  });
});
