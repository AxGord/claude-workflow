import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { applyModelTable, chooseModel, modelTableErrors, parseDifficulty } from "./model-table.js";
import { InMemoryStorage, cleanupDir, createFixtureDir, createTestEngine } from "./test-helpers.js";
import type { ModelTable } from "./types.js";

const TABLE: ModelTable = {
  rows: [
    { upto: 3, model: "haiku", effort: "low" },
    { upto: 7, model: "sonnet", effort: "high" },
    { upto: 10, model: "opus", effort: "high" },
  ],
  escalate: { fixes: 2, blocked: 2 },
  review: { light: { model: "sonnet", effort: "medium" } },
};

/** A task workflow: claim → work ⇄ fixes, work → blocked → work, review exec, done. */
const TASK = {
  initial: "claim",
  model_table: TABLE,
  states: {
    claim: { prompt: "claim", transitions: { go: "work" } },
    work: {
      prompt: "work {{context.model}}/{{context.effort}}",
      transitions: { fix: "fixes", block: "blocked", review: "scope", done: "done" },
    },
    fixes: { prompt: "fixes", transitions: { back: "work" } },
    blocked: { prompt: "blocked", transitions: { retry: "work" } },
    scope: {
      type: "exec",
      command: 'printf %s "$CLS"',
      env: { CLS: "{{context.cls}}" },
      context_set: { review_class: "{{stdout}}" },
      on_success: "work",
      on_error: "work",
    },
    done: { terminal: true, outcome: "complete" },
  },
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

describe("model_table (pure)", () => {
  it("parseDifficulty takes a whole 1..10 as a number or its string, nothing else", () => {
    expect([1, "10", " 4 ", 7].map(parseDifficulty)).toEqual([1, 10, 4, 7]);
    expect([0, 11, "2.5", "hard", "", null, undefined, 3.5].map(parseDifficulty)).toEqual(
      Array(8).fill(null),
    );
  });

  it("a difficulty takes its row; each escalate entry reached moves one row up, capped by the last", () => {
    expect(chooseModel(TABLE, 1, {})).toEqual({
      model: "haiku",
      effort: "low",
      step: 0,
      escalations: 0,
    });
    expect(chooseModel(TABLE, 4, { fixes: 1 })).toMatchObject({ model: "sonnet", step: 1 });
    expect(chooseModel(TABLE, 3, { fixes: 2 })).toMatchObject({ step: 1, escalations: 1 });
    expect(chooseModel(TABLE, 3, { fixes: 3, blocked: 2 })).toMatchObject({
      model: "opus",
      step: 2,
      escalations: 2,
    });
    // the last row caps: what took effect is counted, not what was reached
    expect(chooseModel(TABLE, 9, { fixes: 2, blocked: 2 })).toMatchObject({
      step: 2,
      escalations: 0,
    });
  });

  it("names rows out of order, a last row short of 10 and an escalate state that does not exist", () => {
    const bad: ModelTable = {
      rows: [
        { upto: 5, model: "a", effort: "low" },
        { upto: 5, model: "b", effort: "low" },
        { upto: 9, model: "c", effort: "high" },
      ],
      escalate: { nowhere: 1 },
    };
    expect(modelTableErrors(bad, new Set(["work"]))).toEqual([
      "model_table row 2: upto 5 is not above 5",
      "model_table: the last row's upto is 9, not 10",
      'model_table escalate → unknown state "nowhere"',
    ]);
    expect(modelTableErrors(TABLE, new Set(["fixes", "blocked"]))).toEqual([]);
  });

  it("writes model/effort when difficulty is set or the row moved, review_* when review_class is set", () => {
    const set = applyModelTable({ difficulty: "5" }, TABLE, {}, new Set(["difficulty"]));
    expect(set?.context).toMatchObject({
      model: "sonnet",
      effort: "high",
      model_step: 2,
      escalations: 0,
    });
    expect(set?.note).toBe("difficulty 5 → sonnet/high (row 2 of 3)");
    // nothing moved: unchanged, so an agent's own model stays
    expect(applyModelTable({ ...set!.context, model: "mine" }, TABLE, {}, new Set())).toBeNull();
    const up = applyModelTable(set!.context, TABLE, { fixes: 2 }, new Set());
    expect(up?.context).toMatchObject({ model: "opus", model_step: 3, escalations: 1 });
    expect(up?.note).toBe("escalated from row 2 → opus/high (row 3 of 3, +1)");
    const light = applyModelTable(
      { ...set!.context, review_class: "light" },
      TABLE,
      {},
      new Set(["review_class"]),
    );
    expect(light?.context).toMatchObject({ review_model: "sonnet", review_effort: "medium" });
    const code = applyModelTable(
      { ...set!.context, review_class: "code" },
      TABLE,
      {},
      new Set(["review_class"]),
    );
    expect(code?.context).toMatchObject({ review_model: "sonnet", review_effort: "high" });
    expect(code?.note).toBe("review code → sonnet/high (the task's own)");
  });
});

describe("model_table (loader)", () => {
  function load(workflows: Record<string, object>): Loader {
    const dir = createFixtureDir(workflows);
    dirs.push(dir);
    return new Loader(null, dir, null);
  }

  it("a table the schema or the checks refuse fails the workflow's load; a typo names the nearest key", () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    try {
      const loader = load({
        typo: { ...TASK, model_table: { ...TABLE, escalte: { fixes: 2 } } },
        rowtypo: {
          ...TASK,
          model_table: { rows: [{ upto: 10, modle: "x", effort: "low" }] },
        },
        effort: {
          ...TASK,
          model_table: { rows: [{ upto: 10, model: "x", effort: "huge" }] },
        },
        order: {
          ...TASK,
          model_table: {
            rows: [
              { upto: 7, model: "a", effort: "low" },
              { upto: 3, model: "b", effort: "low" },
            ],
          },
        },
        ok: TASK,
      });
      expect(loader.names().sort()).toEqual(["ok"]);
    } finally {
      console.error = orig;
    }
    const all = errors.join("\n");
    expect(all).toContain('model_table: unknown key "escalte" — did you mean "escalate"?');
    expect(all).toContain('model_table.rows.0: unknown key "modle" — did you mean "model"?');
    expect(all).toContain("model_table.rows.0.effort");
    expect(all).toContain("model_table: the last row's upto is 3, not 10");
  });

  it("a heir keeps its base's table unless it sets its own", () => {
    const own: ModelTable = { rows: [{ upto: 10, model: "x", effort: "max" }] };
    const loader = load({
      base: TASK,
      heir: { extends: "base", states: { claim: { prompt: "mine", transitions: { go: "work" } } } },
      heir2: { extends: "base", model_table: own },
    });
    expect(loader.get("heir")?.model_table).toEqual(TABLE);
    expect(loader.get("heir2")?.model_table).toEqual(own);
  });
});

describe("model_table (engine)", () => {
  it("context_set difficulty sets model/effort and answers them; outside 1..10 is refused under a table only", async () => {
    const { engine, storage } = createTestEngine({ task: TASK, plain: TASK_WITHOUT_TABLE() });
    const s = await engine.start("task");
    expect(await engine.setContext(s.sessionId, "difficulty", 2)).toBe(
      "difficulty 2 → haiku/low (row 1 of 3)",
    );
    await expect(engine.setContext(s.sessionId, "difficulty", "eleven")).rejects.toThrow(
      'difficulty "eleven" is not a whole number 1..10',
    );
    const ctx = storage.read(s.sessionId)!.context;
    expect(ctx).toMatchObject({ difficulty: 2, model: "haiku", effort: "low", model_step: 1 });
    expect(storage.read(s.sessionId)!.history.at(-1)).toMatchObject({ event: "model" });
    const moved = await engine.transition(s.sessionId, "go");
    expect(moved.prompt).toContain("work haiku/low");

    const p = await engine.start("plain", undefined, s.sessionId);
    expect(await engine.setContext(p.sessionId, "difficulty", "eleven")).toBeUndefined();
    expect(storage.read(p.sessionId)!.context.model).toBeUndefined();
  });

  it("escalates one row when a listed state's visits reach the number, through any entry", async () => {
    const { engine, storage } = createTestEngine({ task: TASK });
    const s = await engine.start("task");
    const sid = s.sessionId;
    await engine.setContext(sid, "difficulty", "3");
    await engine.transition(sid, "go");
    await engine.transition(sid, "fix");
    await engine.transition(sid, "back");
    expect(storage.read(sid)!.context.model).toBe("haiku");
    await engine.transition(sid, "fix"); // fixes visit 2
    expect(storage.read(sid)!.context).toMatchObject({
      model: "sonnet",
      effort: "high",
      model_step: 2,
      escalations: 1,
    });
    const back = await engine.transition(sid, "back");
    expect(back.prompt).toContain("work sonnet/high");
    await engine.transition(sid, "block");
    await engine.transition(sid, "retry");
    await engine.transition(sid, "block"); // blocked visit 2
    expect(storage.read(sid)!.context).toMatchObject({ model: "opus", escalations: 2 });
    const notes = storage
      .read(sid)!
      .history.filter(h => h.event === "model")
      .map(h => h.detail);
    expect(notes).toEqual([
      "difficulty 3 → haiku/low (row 1 of 3)",
      "escalated from row 1 → sonnet/high (row 2 of 3, +1)",
      "escalated from row 2 → opus/high (row 3 of 3, +2)",
    ]);
  });

  it("an exec's context_set of review_class picks the reviewer; the ledger keeps model, effort, review and tokens", async () => {
    const { engine, storage } = createTestEngine({ task: TASK });
    const s = await engine.start("task");
    const sid = s.sessionId;
    await engine.setContext(sid, "difficulty", 8);
    await engine.setContext(sid, "cls", "light");
    await engine.transition(sid, "go");
    await engine.transition(sid, "review");
    expect(storage.read(sid)!.context).toMatchObject({
      review_class: "light",
      review_model: "sonnet",
      review_effort: "medium",
    });
    await engine.setContext(sid, "tokens_worker", "120000");
    await engine.setContext(sid, "tokens_review", 30000);
    await engine.setContext(sid, "tokens_other", "n/a");
    await engine.transition(sid, "done");
    expect(storage.ledger.at(-1)).toMatchObject({
      workflow: "task",
      difficulty: 8,
      model: "opus",
      effort: "high",
      escalations: 0,
      review_model: "sonnet",
      review_effort: "medium",
      tokens: { worker: 120000, review: 30000 },
    });
  });

  it("a sub-workflow without a table runs under the frame below that has one", async () => {
    const { engine, storage } = createTestEngine({
      task: {
        ...TASK,
        states: {
          ...TASK.states,
          claim: { sub_workflow: "child", on_complete: "work" },
        },
      },
      child: TASK_WITHOUT_TABLE(),
    });
    const s = await engine.start("task");
    expect(await engine.setContext(s.sessionId, "difficulty", 10)).toBe(
      "difficulty 10 → opus/high (row 3 of 3)",
    );
    expect(storage.read(s.sessionId)!.stack).toHaveLength(2);
  });

  it("the bundled batch-task maps a difficulty and escalates on the third work visit", async () => {
    const templates = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wf-mt-"));
    dirs.push(empty);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, new Loader(templates, empty, null), new Executor());
    const table = new Loader(templates, empty, null).get("batch-task")!.model_table!;
    expect(chooseModel(table, 5, {})).toMatchObject({ model: "sonnet", effort: "high" });
    expect(chooseModel(table, 5, { work: 3 })).toMatchObject({ model: "opus", effort: "high" });
    expect(table.review?.light).toEqual({ model: "sonnet", effort: "medium" });
    const s = await engine.start("batch-task");
    expect(await engine.setContext(s.sessionId, "difficulty", "9")).toBe(
      "difficulty 9 → opus/xhigh (row 5 of 5)",
    );
  });
});

function TASK_WITHOUT_TABLE(): object {
  return { initial: TASK.initial, states: TASK.states };
}
