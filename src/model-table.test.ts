import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import {
  applyModelTable,
  chooseModel,
  chooseStages,
  modelTableErrors,
  parseDifficulty,
} from "./model-table.js";
import { InMemoryStorage, cleanupDir, createFixtureDir, createTestEngine } from "./test-helpers.js";
import type { LedgerEntry } from "./ledger.js";
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

/** The same table with every stage: execute and fix escalate, plan / review / review_verify do not. */
const STAGED: ModelTable = {
  stages: {
    plan: [
      { upto: 3, model: "sonnet", effort: "high" },
      { upto: 10, model: "opus", effort: "xhigh" },
    ],
    execute: [
      { upto: 3, model: "haiku", effort: "low" },
      { upto: 7, model: "sonnet", effort: "high" },
      { upto: 10, model: "opus", effort: "high" },
    ],
    review: [
      { upto: 7, model: "opus", effort: "high" },
      { upto: 10, model: "opus", effort: "xhigh" },
    ],
    review_verify: [{ upto: 10, model: "sonnet", effort: "high" }],
    fix: [
      { upto: 5, model: "sonnet", effort: "high" },
      { upto: 10, model: "opus", effort: "high" },
    ],
  },
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
      transitions: {
        fix: "fixes",
        block: "blocked",
        review: "scope",
        done: "done",
      },
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
    expect(chooseModel(TABLE, 4, { fixes: 1 })).toMatchObject({
      model: "sonnet",
      step: 1,
    });
    expect(chooseModel(TABLE, 3, { fixes: 2 })).toMatchObject({
      step: 1,
      escalations: 1,
    });
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
    expect(up?.context).toMatchObject({
      model: "opus",
      model_step: 3,
      escalations: 1,
    });
    expect(up?.note).toBe("escalated from row 2 → opus/high (row 3 of 3, +1)");
    const light = applyModelTable(
      { ...set!.context, review_class: "light" },
      TABLE,
      {},
      new Set(["review_class"]),
    );
    expect(light?.context).toMatchObject({
      review_model: "sonnet",
      review_effort: "medium",
    });
    const code = applyModelTable(
      { ...set!.context, review_class: "code" },
      TABLE,
      {},
      new Set(["review_class"]),
    );
    expect(code?.context).toMatchObject({
      review_model: "sonnet",
      review_effort: "high",
    });
    expect(code?.note).toBe("review code → sonnet/high (the task's own)");
  });
});

describe("model_table stages (pure)", () => {
  const SET = new Set(["difficulty"]);

  it("every stage writes its own row per band; model/effort stay the execute row", () => {
    const bands: Record<number, Record<string, string>> = {
      2: {
        plan: "sonnet/high",
        execute: "haiku/low",
        review: "opus/high",
        review_verify: "sonnet/high",
        fix: "sonnet/high",
      },
      5: {
        plan: "opus/xhigh",
        execute: "sonnet/high",
        review: "opus/high",
        review_verify: "sonnet/high",
        fix: "sonnet/high",
      },
      9: {
        plan: "opus/xhigh",
        execute: "opus/high",
        review: "opus/xhigh",
        review_verify: "sonnet/high",
        fix: "opus/high",
      },
    };
    for (const [d, want] of Object.entries(bands)) {
      const r = applyModelTable({ difficulty: Number(d) }, STAGED, {}, SET)!.context;
      for (const [stage, me] of Object.entries(want)) {
        expect(`${String(r[`model_${stage}`])}/${String(r[`effort_${stage}`])}`).toBe(me);
      }
      expect(`${String(r.model)}/${String(r.effort)}`).toBe(want.execute);
      expect(r.review_model).toBe(r.model_review);
    }
  });

  it("escalation moves execute and fix only", () => {
    const base = applyModelTable({ difficulty: 3 }, STAGED, {}, SET)!;
    const up = applyModelTable(base.context, STAGED, { fixes: 2 }, new Set())!;
    expect(up.context).toMatchObject({
      model: "sonnet",
      model_execute: "sonnet",
      model_fix: "opus",
      model_plan: "sonnet",
      model_review: "opus",
      effort_review: "high",
      model_review_verify: "sonnet",
      model_reached: 1,
    });
    expect(chooseStages(STAGED, 9, { fixes: 2, blocked: 2 })).toMatchObject({
      execute: { step: 2, escalations: 0 },
      fix: { step: 1 },
      plan: { step: 1 },
    });
    // difficulty 7 sits on the last row of execute and fix: the escalation has nowhere to go
    const top = applyModelTable({ difficulty: 7 }, STAGED, { fixes: 2 }, SET)!;
    expect(top.context).toMatchObject({
      model_execute: "opus",
      model_fix: "opus",
    });
    // nothing moved: unchanged, so an agent's own value stays
    expect(
      applyModelTable({ ...base.context, model_plan: "mine" }, STAGED, {}, new Set()),
    ).toBeNull();
  });

  it("a review_class entry overrides the review stage and survives an escalation; a class without one keeps the stage", () => {
    const base = applyModelTable({ difficulty: 9 }, STAGED, {}, SET)!.context;
    const light = applyModelTable(
      { ...base, review_class: "light" },
      STAGED,
      {},
      new Set(["review_class"]),
    )!;
    expect(light.context).toMatchObject({
      review_model: "sonnet",
      model_review: "sonnet",
      effort_review: "medium",
    });
    const moved = applyModelTable(light.context, STAGED, { fixes: 2 }, new Set())!;
    expect(moved.context).toMatchObject({
      model_review: "sonnet",
      effort_review: "medium",
      model_fix: "opus",
    });
    const code = applyModelTable(
      { ...base, review_class: "code" },
      STAGED,
      {},
      new Set(["review_class"]),
    )!;
    expect(code.context).toMatchObject({
      model_review: "opus",
      effort_review: "xhigh",
    });
    expect(code.note).toBe("review code → opus/xhigh (the review stage)");
  });

  it("a table without stages writes no stage key", () => {
    const r = applyModelTable({ difficulty: 5 }, TABLE, {}, SET)!.context;
    expect(Object.keys(r).filter(k => /^(model|effort)_/.test(k) && k !== "model_step")).toEqual(
      [],
    );
    expect(r).not.toHaveProperty("model_reached");
  });

  it("refuses a malformed or reserved stage name, rows given twice, no execute rows and a stage short of 10", () => {
    const bad = {
      rows: [{ upto: 10, model: "a", effort: "low" }],
      stages: {
        execute: [{ upto: 10, model: "a", effort: "low" }],
        Planning: [{ upto: 10, model: "a", effort: "low" }],
        model: [{ upto: 10, model: "a", effort: "low" }],
        step: [{ upto: 10, model: "a", effort: "low" }],
        short: [{ upto: 4, model: "a", effort: "low" }],
      },
    } as ModelTable;
    expect(modelTableErrors(bad, new Set())).toEqual([
      "model_table: `rows` and `stages.execute` both set — give the execute rows once",
      'model_table stages: stage name "Planning" does not match ^[a-z][a-z_]*$',
      'model_table stages: "model" is not a stage name (it collides with the table\'s own keys)',
      'model_table stages: "step" is not a stage name (it collides with the table\'s own keys)',
      'model_table stage "short": the last row\'s upto is 4, not 10',
    ]);
    const recon = {
      stages: {
        ...STAGED.stages!,
        recon: [{ upto: 10, model: "haiku", effort: "low" }],
      },
    };
    expect(modelTableErrors(recon as ModelTable, new Set(["fixes", "blocked"]))).toEqual([]);
    expect(modelTableErrors({ stages: { plan: STAGED.stages!.plan } }, new Set())).toEqual([
      "model_table: needs `rows` or `stages.execute`",
    ]);
    expect(modelTableErrors(STAGED, new Set(["fixes", "blocked"]))).toEqual([]);
  });

  it("refuses a state reading a stage the table does not declare", () => {
    const states = {
      a: {
        prompt: "{{context.model_plan}} {{context.effort_wizard}} {{context.model_step}}",
      },
    };
    expect(modelTableErrors(STAGED, new Set(["fixes", "blocked"]), states)).toEqual([
      'model_table: a state reads the stage "wizard", which stages does not declare (declared: plan, execute, review, review_verify, fix)',
    ]);
    expect(modelTableErrors(TABLE, new Set(["fixes", "blocked"]), states)).toEqual([]);
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

  it("a workflow reading a stage its table lacks fails the load; one reading a declared stage loads", () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    let names: string[];
    try {
      const staged = (prompt: string): object => ({
        ...TASK,
        model_table: STAGED,
        states: {
          ...TASK.states,
          claim: { prompt, transitions: { go: "work" } },
        },
      });
      names = load({
        bad: staged("{{context.model_wizard}}"),
        good: staged("{{context.model_fix}}/{{context.effort_plan}}"),
      })
        .names()
        .sort();
    } finally {
      console.error = orig;
    }
    expect(names).toEqual(["good"]);
    expect(errors.join("\n")).toContain('a state reads the stage "wizard"');
  });

  it("a table declaring recon loads, writes model_recon / effort_recon and the ledger keeps the pair; `model` as a stage is refused", async () => {
    const recon = {
      ...STAGED,
      stages: {
        ...STAGED.stages!,
        recon: [{ upto: 10, model: "haiku", effort: "low" }],
      },
    };
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    let loader: Loader;
    try {
      loader = load({
        good: {
          ...TASK,
          model_table: recon,
          states: {
            ...TASK.states,
            claim: {
              prompt: "{{context.model_recon}}/{{context.effort_recon}}",
              transitions: { go: "work" },
            },
          },
        },
        bad: {
          ...TASK,
          model_table: {
            ...STAGED,
            stages: {
              ...STAGED.stages!,
              model: [{ upto: 10, model: "x", effort: "low" }],
            },
          },
        },
      });
    } finally {
      console.error = orig;
    }
    expect(loader.names().sort()).toEqual(["good"]);
    expect(errors.join("\n")).toContain('"model" is not a stage name');
    const dir = createFixtureDir({ good: loader.get("good")! });
    dirs.push(dir);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, new Loader(null, dir, null), new Executor());
    const s = await engine.start("good");
    await engine.setContext(s.sessionId, "difficulty", 3);
    expect(storage.read(s.sessionId)!.context).toMatchObject({
      model_recon: "haiku",
      effort_recon: "low",
    });
    await engine.abort(s.sessionId);
    expect(storage.ledger.at(-1)).toMatchObject({
      stages: { recon: { model: "haiku", effort: "low" } },
    });
  });

  it("a heir keeps its base's table unless it sets its own", () => {
    const own: ModelTable = { rows: [{ upto: 10, model: "x", effort: "max" }] };
    const loader = load({
      base: TASK,
      heir: {
        extends: "base",
        states: { claim: { prompt: "mine", transitions: { go: "work" } } },
      },
      heir2: { extends: "base", model_table: own },
    });
    expect(loader.get("heir")?.model_table).toEqual(TABLE);
    expect(loader.get("heir2")?.model_table).toEqual(own);
  });
});

describe("model_table (engine)", () => {
  it("context_set difficulty sets model/effort and answers them; outside 1..10 is refused under a table only", async () => {
    const { engine, storage } = createTestEngine({
      task: TASK,
      plain: TASK_WITHOUT_TABLE(),
    });
    const s = await engine.start("task");
    expect(await engine.setContext(s.sessionId, "difficulty", 2)).toBe(
      "difficulty 2 → haiku/low (row 1 of 3)",
    );
    await expect(engine.setContext(s.sessionId, "difficulty", "eleven")).rejects.toThrow(
      'difficulty "eleven" is not a whole number 1..10',
    );
    const ctx = storage.read(s.sessionId)!.context;
    expect(ctx).toMatchObject({
      difficulty: 2,
      model: "haiku",
      effort: "low",
      model_step: 1,
    });
    expect(storage.read(s.sessionId)!.history.at(-1)).toMatchObject({
      event: "model",
    });
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
    expect(storage.read(sid)!.context).toMatchObject({
      model: "opus",
      escalations: 2,
    });
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
    expect(chooseModel(table, 5, {})).toMatchObject({
      model: "sonnet",
      effort: "high",
    });
    expect(chooseModel(table, 5, { work: 3 })).toMatchObject({
      model: "opus",
      effort: "high",
    });
    expect(table.review?.light).toEqual({ model: "sonnet", effort: "medium" });
    const s = await engine.start("batch-task");
    expect(await engine.setContext(s.sessionId, "difficulty", "9")).toBe(
      "difficulty 9 → opus/xhigh (row 4 of 4) [plan opus/xhigh, execute opus/xhigh, review opus/xhigh, review_verify sonnet/high, fix opus/high]",
    );
    expect(storage.read(s.sessionId)!.context).toMatchObject({
      model: "opus",
      effort: "xhigh",
      review_model: "opus",
      review_effort: "xhigh",
    });
  });

  it("the bundled coding and bug-fix take a difficulty (3 and 8 spawn the stage rows); without one the keys stay empty", async () => {
    const templates = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wf-mt-"));
    dirs.push(empty);
    for (const wf of ["coding", "bug-fix"]) {
      const storage = new InMemoryStorage();
      const engine = new Engine(storage, new Loader(templates, empty, null), new Executor());
      const none = await engine.start(wf);
      expect(storage.read(none.sessionId)!.context.model_execute).toBeUndefined();
      await engine.abort(none.sessionId);
      const picks = [] as string[];
      for (const d of [3, 8]) {
        const s = await engine.start(wf);
        await engine.setContext(s.sessionId, "difficulty", d);
        const ctx = storage.read(s.sessionId)!.context;
        picks.push(
          `${String(ctx.model_execute)}/${String(ctx.effort_execute)} ${String(ctx.model_review)}/${String(ctx.effort_review)}`,
        );
        await engine.abort(s.sessionId);
      }
      expect(picks).toEqual(["sonnet/high opus/high", "opus/high opus/high"]);
      // no difficulty: the added lines are the only change to the prose rule, and they render empty
      const plain = await engine.start(wf);
      const def = new Loader(templates, empty, null).get(wf)!;
      for (const [name, rule] of [
        ["execute", "ALWAYS pass an explicit `model`"],
        ["review", "ALWAYS pass an explicit `model`"],
      ] as const) {
        const st =
          wf === "coding"
            ? name === "execute"
              ? "delegate"
              : "review_delegate"
            : name === "execute"
              ? "fix_delegate"
              : "review_delegate";
        const text = def.states[st].prompt!;
        expect(text).toContain(rule);
        expect(text).toContain(`{{context.model_${name}}}`);
      }
      await engine.abort(plain.sessionId);
      // a difficulty-4 session: the spawn keys and the ledger line
      const four = await engine.start(wf);
      await engine.setContext(four.sessionId, "difficulty", 4);
      await engine.abort(four.sessionId);
      expect(storage.ledger.at(-1)).toMatchObject({
        difficulty: 4,
        stages: {
          execute: { model: "sonnet", effort: "high" },
          review: { model: "opus", effort: "high" },
        },
      });
    }
  });

  it("the ledger records each stage as run: a rescore after the plan keeps the plan row, a review_class override shows", async () => {
    const AS_RUN = {
      ...TASK,
      initial: "plan",
      model_table: STAGED,
      states: {
        ...TASK.states,
        plan: {
          prompt: "{{context.model_plan}}/{{context.effort_plan}}",
          transitions: { go: "work" },
        },
        work: {
          prompt: "{{context.model_execute}} {{context.model_fix}}",
          transitions: { fix: "fixes", review: "scope", done: "done" },
        },
        fixes: { prompt: "fixes", transitions: { back: "work" } },
        scope: {
          type: "exec",
          command: 'printf %s "$CLS"',
          env: { CLS: "{{context.cls}}" },
          context_set: { review_class: "{{stdout}}" },
          on_success: "rev",
          on_error: "rev",
        },
        rev: { prompt: "{{context.model_review}}", transitions: { done: "done" } },
      },
    };
    const { engine, storage } = createTestEngine({ task: AS_RUN });
    const s = await engine.start("task");
    const sid = s.sessionId;
    await engine.setContext(sid, "difficulty", 3);
    await engine.setContext(sid, "difficulty", 7);
    await engine.setContext(sid, "cls", "light");
    await engine.transition(sid, "go");
    await engine.transition(sid, "fix");
    await engine.transition(sid, "back");
    await engine.transition(sid, "fix");
    await engine.transition(sid, "back");
    await engine.transition(sid, "review");
    await engine.transition(sid, "done");
    const line = storage.ledger.at(-1) as LedgerEntry;
    expect(line.difficulty).toBe(7);
    expect(line.claim_difficulty).toBe(3);
    expect(line.stages?.plan).toEqual({ model: "sonnet", effort: "high" });
    expect(line.stages?.execute).toEqual({ model: "sonnet", effort: "high" });
    expect(line.stages?.review).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("a write under a frame whose workflow is gone does not throw", async () => {
    const { engine, storage } = createTestEngine({ task: TASK });
    const s = await engine.start("task");
    const session = storage.read(s.sessionId)!;
    await storage.write(s.sessionId, {
      ...session,
      stack: [...session.stack, { ...session.stack[0], workflow: "ghost" }],
      active_frame: 1,
    });
    await expect(engine.setContext(s.sessionId, "difficulty", 4)).resolves.not.toThrow();
  });

  it("the bundled batch-task at difficulty 5 writes every stage key, and the ledger keeps the stages", async () => {
    const templates = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wf-mt-"));
    dirs.push(empty);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, new Loader(templates, empty, null), new Executor());
    const s = await engine.start("batch-task");
    await engine.setContext(s.sessionId, "difficulty", 5);
    const ctx = storage.read(s.sessionId)!.context;
    const stages = Object.fromEntries(
      ["plan", "execute", "review", "review_verify", "fix"].map(n => [
        n,
        `${String(ctx[`model_${n}`])}/${String(ctx[`effort_${n}`])}`,
      ]),
    );
    expect(stages).toEqual({
      plan: "opus/high",
      execute: "sonnet/high",
      review: "opus/high",
      review_verify: "sonnet/high",
      fix: "sonnet/high",
    });
    expect(ctx).toMatchObject({
      model: "sonnet",
      effort: "high",
      model_step: 2,
    });
    await engine.abort(s.sessionId);
    expect(storage.ledger.at(-1)?.stages).toEqual({
      plan: { model: "opus", effort: "high" },
      execute: { model: "sonnet", effort: "high" },
      review: { model: "opus", effort: "high" },
      review_verify: { model: "sonnet", effort: "high" },
      fix: { model: "sonnet", effort: "high" },
    });
  });

  it("a batch-task heir's ledger line lists execute and review only once their spawns were entered", async () => {
    const templates = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-mt-"));
    dirs.push(dir);
    // project_prepare is batch-task's extension point; review_scope is replaced to keep the run off git.
    fs.writeFileSync(
      path.join(dir, "bt-heir.yaml"),
      [
        "name: bt-heir",
        "description: batch-task with its execs stubbed",
        "extends: batch-task",
        "states:",
        "  project_prepare:",
        "    type: exec",
        "    command: printf %s /tmp/wt",
        "    context_set: { wt: '{{stdout}}' }",
        "    on_success: work",
        "    on_error: prepare_failed",
        "  review_scope:",
        "    type: exec",
        "    command: printf light",
        "    context_set: { review_class: '{{stdout}}' }",
        "    on_success: review",
        "    on_error: review",
        "",
      ].join("\n"),
    );
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, new Loader(templates, dir, null), new Executor());
    const run = async (upTo: "claim" | "work" | "review"): Promise<LedgerEntry> => {
      const s = await engine.start("bt-heir");
      await engine.setContext(s.sessionId, "task", "T1");
      await engine.setContext(s.sessionId, "difficulty", 5);
      if (upTo !== "claim") await engine.transition(s.sessionId, "prepare");
      if (upTo === "review") await engine.transition(s.sessionId, "review");
      if (upTo === "claim") expect(storage.read(s.sessionId)!.context.stages_first).toBeUndefined();
      await engine.abort(s.sessionId);
      return storage.ledger.at(-1) as LedgerEntry;
    };
    await run("claim");
    const atWork = await run("work");
    expect(atWork.stages?.execute).toEqual({ model: "sonnet", effort: "high" });
    expect(atWork.stages?.review).toBeUndefined();
    expect(atWork.stages?.plan).toBeUndefined();
    const atReview = await run("review");
    expect(atReview.stages?.execute).toEqual({ model: "sonnet", effort: "high" });
    expect(atReview.stages?.review).toEqual({ model: "sonnet", effort: "medium" });
  });
});

function TASK_WITHOUT_TABLE(): object {
  return { initial: TASK.initial, states: TASK.states };
}
