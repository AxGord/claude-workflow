import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import type { LedgerEntry } from "./ledger.js";
import { InMemoryStorage, cleanupDir, trustStoreFor } from "./test-helpers.js";

// ENG-LEDGER-ENGINE-TASK-ROWS: an engine-task session's ledger line lists the stages it ran on, so a
// session that reached review shows the review row beside execute (it read only the bare model once).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(ROOT, "templates");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

// engine-task as-is plus a heir whose execs are stubbed, so the run stays off git and the pool.
function project(): { wf: string; cwd: string } {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-et-stages-")));
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
      "states:",
      "  project_prepare:",
      "    type: exec",
      "    command: printf %s /tmp/wt",
      "    context_set: { wt: '{{stdout}}' }",
      "    on_success: work",
      "    on_error: prepare_failed",
      "  work_check:",
      "    type: exec",
      "    command: printf ok",
      "    cwd: /tmp",
      "    on_success: review",
      "    on_error: work_unready",
      "",
    ].join("\n"),
  );
  return { wf, cwd: d };
}

describe("engine-task ledger stages", () => {
  const run = async (upTo: "claim" | "work" | "review"): Promise<LedgerEntry> => {
    const { wf, cwd } = project();
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wf-et-global-"));
    dirs.push(empty);
    const trust = trustStoreFor(
      path.join(wf, "engine-task.yaml"),
      path.join(wf, "local-task.yaml"),
    );
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, new Loader(TEMPLATES, empty, wf, trust), new Executor());
    const s = await engine.start("local-task", undefined, undefined, cwd);
    await engine.setContext(s.sessionId, "task", "T1");
    await engine.setContext(s.sessionId, "difficulty", 5);
    if (upTo !== "claim") await engine.transition(s.sessionId, "prepare");
    if (upTo === "review") await engine.transition(s.sessionId, "check");
    await engine.abort(s.sessionId);
    return storage.ledger.at(-1) as LedgerEntry;
  };

  it("lists execute once work was entered and review once review was entered", async () => {
    const atWork = await run("work");
    expect(atWork.stages?.execute).toBeDefined();
    expect(atWork.stages?.review).toBeUndefined();
    const atReview = await run("review");
    expect(atReview.stages?.execute).toBeDefined();
    expect(atReview.stages?.review).toBeDefined();
    expect(Object.keys(atReview.stages ?? {}).sort()).toEqual(["execute", "review"]);
  });
});
