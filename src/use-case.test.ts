// Pins of ENG-SITE-USE-CASE-ANYPARSE, the data side: the path a queue line takes (`slicePath`), the facts read from
// the project's workflow files (`workflowFacts`), the ledger fold (`foldUseCase`) and the committed snapshot the
// site's use-case page draws (docs/use-case-anyparse.json).
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "./ledger.js";
import { chooseStages } from "./model-table.js";
import type { ModelTable } from "./types.js";
import {
  assertUseCaseClean,
  foldUseCase,
  workflowFacts,
  type UseCaseSnapshot,
} from "./use-case.js";
import {
  PATH_SCENARIOS,
  slicePath,
  stageRow,
  type PathFacts,
  type StageTable,
} from "./use-case-path.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SNAPSHOT_FILE = path.join(ROOT, "docs/use-case-anyparse.json");
const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8")) as UseCaseSnapshot;

const TABLE: StageTable = {
  recon: [{ upto: 10, model: "haiku", effort: "low" }],
  plan: [{ upto: 10, model: "sonnet", effort: "high" }],
  execute: [
    { upto: 3, model: "haiku", effort: "medium" },
    { upto: 6, model: "sonnet", effort: "high" },
    { upto: 10, model: "opus", effort: "xhigh" },
  ],
  review: [{ upto: 10, model: "opus", effort: "high" }],
};
const FACTS: PathFacts = {
  table: TABLE,
  driver: { model: "haiku", effort: "medium" },
  recon_from: 4,
  executor_scores: [7, 8],
  split_from: 9,
};
const nodes = (line: number, seen: number, premise = true): string[] =>
  slicePath(FACTS, { line, seen, premise }).steps.map(s => s.node);

describe("the path of a queue line (slicePath)", () => {
  it("below the recon's threshold the plan stage is the first reader and its agent writes the code", () => {
    const p = slicePath(FACTS, { line: 3, seen: 3, premise: true });
    expect(p.recon).toBe(false);
    expect(p.scoredBy).toBe("plan");
    expect(nodes(3, 3)).toEqual(["claim", "prepare", "route", "plan", "execute", "next"]);
    expect(p.execute).toBe("plan-agent");
    expect(p.steps.find(s => s.node === "execute")).toMatchObject({
      stage: "plan",
      model: "sonnet",
    });
  });

  it("from the threshold a recon runs on the recon row of the line's difficulty", () => {
    const p = slicePath(FACTS, { line: 4, seen: 4, premise: true });
    expect(p.recon).toBe(true);
    expect(nodes(4, 4)).toEqual([
      "claim",
      "prepare",
      "route",
      "recon",
      "verdict",
      "plan",
      "execute",
      "next",
    ]);
    expect(p.steps.find(s => s.node === "recon")).toMatchObject({
      actor: "agent",
      stage: "recon",
      model: "haiku",
      effort: "low",
    });
    expect(slicePath({ ...FACTS, recon_from: 6 }, { line: 5, seen: 5, premise: true }).recon).toBe(
      false,
    );
  });

  it("the recon's score replaces the line's: the stages after it run on the score's rows", () => {
    const up = slicePath(FACTS, { line: 5, seen: 7, premise: true });
    expect(up.rescored).toBe("up");
    expect(up.difficulty).toBe(7);
    expect(up.plan).toBe("skipped");
    expect(up.execute).toBe("executor");
    expect(up.steps.find(s => s.node === "execute")).toMatchObject({
      stage: "execute",
      model: "opus",
      effort: "xhigh",
    });
    const down = slicePath(FACTS, { line: 6, seen: 3, premise: true });
    expect(down.rescored).toBe("down");
    expect(down.difficulty).toBe(3);
    expect(down.plan).toBe("run");
    expect(down.execute).toBe("plan-agent");
    expect(slicePath(FACTS, { line: 5, seen: 5, premise: true }).rescored).toBe("kept");
  });

  it("a recon score that is the plan skips the plan stage only at the executor's scores", () => {
    expect(slicePath(FACTS, { line: 5, seen: 6, premise: true }).plan).toBe("run");
    expect(slicePath(FACTS, { line: 5, seen: 8, premise: true }).plan).toBe("skipped");
    const moved = { ...FACTS, executor_scores: [6] };
    expect(slicePath(moved, { line: 5, seen: 6, premise: true }).plan).toBe("skipped");
    expect(slicePath(moved, { line: 5, seen: 7, premise: true }).plan).toBe("run");
  });

  it("a score at the split threshold is never run: the line is split by its first reader", () => {
    const byRecon = slicePath(FACTS, { line: 6, seen: 9, premise: true });
    expect(byRecon).toMatchObject({ outcome: "split", stoppedBy: "recon", execute: "unreached" });
    expect(nodes(6, 9)).toEqual(["claim", "prepare", "route", "recon", "split"]);
    const byPlan = slicePath(FACTS, { line: 2, seen: 10, premise: true });
    expect(byPlan).toMatchObject({ outcome: "split", stoppedBy: "plan", plan: "run" });
    expect(nodes(2, 10)).toEqual(["claim", "prepare", "route", "plan", "split"]);
    expect(slicePath(FACTS, { line: 6, seen: 8, premise: true }).outcome).toBe("review");
  });

  it("a premise that fails closes the line at its first reader, whatever the score", () => {
    expect(slicePath(FACTS, { line: 5, seen: 9, premise: false })).toMatchObject({
      outcome: "closed",
      stoppedBy: "recon",
      plan: "unreached",
    });
    expect(nodes(5, 5, false)).toEqual(["claim", "prepare", "route", "recon", "closed"]);
    expect(slicePath(FACTS, { line: 2, seen: 2, premise: false })).toMatchObject({
      outcome: "closed",
      stoppedBy: "plan",
    });
  });

  it("without a recon a plan that scores an executor's score hands its plan on", () => {
    const p = slicePath(FACTS, { line: 3, seen: 8, premise: true });
    expect(p).toMatchObject({ recon: false, plan: "run", execute: "executor", difficulty: 8 });
    expect(nodes(3, 8)).toEqual([
      "claim",
      "prepare",
      "route",
      "plan",
      "verdict",
      "execute",
      "next",
    ]);
    expect(p.steps.find(s => s.node === "plan")).toMatchObject({ stage: "plan", model: "sonnet" });
    expect(p.steps.find(s => s.node === "execute")).toMatchObject({
      stage: "execute",
      model: "opus",
    });
  });

  it("the driver's row is the facts' own, and every scenario the page offers takes a different way", () => {
    expect(slicePath(FACTS, { line: 1, seen: 1, premise: true }).steps[0]).toMatchObject({
      node: "claim",
      actor: "driver",
      model: "haiku",
      effort: "medium",
    });
    const ways = PATH_SCENARIOS.map(s => {
      const p = slicePath(FACTS, s);
      return [p.recon, p.rescored, p.plan, p.execute, p.outcome, p.stoppedBy].join();
    });
    expect(new Set(ways).size).toBe(PATH_SCENARIOS.length);
    expect(new Set(PATH_SCENARIOS.map(s => s.id)).size).toBe(PATH_SCENARIOS.length);
  });
});

describe("a stage's row at a difficulty (stageRow) is the engine's own lookup", () => {
  for (const [name, table] of [
    ["a three-row table", TABLE],
    ["the snapshot's table", snapshot.workflow.table],
  ] as const)
    it(`${name}: every stage, every difficulty`, () => {
      const stages = Object.keys(table);
      expect(stages.length).toBeGreaterThan(0);
      for (let d = 1; d <= 10; d++) {
        const engine = chooseStages({ stages: table } as unknown as ModelTable, d, {});
        for (const stage of stages)
          expect(stageRow(table, stage, d), `${stage} at ${d}`).toEqual({
            model: engine[stage].model,
            effort: engine[stage].effort,
          });
      }
      expect(stageRow(table, "no-such-stage", 5)).toBeUndefined();
    });
});

const PIPELINE = `
name: slice-pipeline
model_table:
  stages:
    recon:
      - { upto: 10, model: sonnet, effort: medium }
    execute:
      - { upto: 6, model: sonnet, effort: high }
      - { upto: 10, model: opus, effort: high }
driver:
  model: haiku
  effort: medium
states:
  recon_route:
    type: exec
    command: |-
      [ "$D" -ge 4 ] || exit 0
  recon_end:
    type: exec
    command: |-
      [ "$s" -ge 9 ] && exit 12
  plan_route:
    type: exec
    command: |-
      case "$SCORE" in 7|8) exit 10;; esac
  fixes:
    max_visits: 3
    prompt: fix
  land:
    type: exec
    command: land
    resource: { priority: 1, locks: ["anyparse-land"] }
`;
const WORKER = `
name: slice-worker
states:
  orient:
    prompt: |-
      Score ≤6 → you are the right worker: carry on. Score 7 or 8 → the execution needs opus.
  gate:
    type: exec
    command: |-
      if [ "$rc" -ne 0 ] && [ "\${FIX_ROUNDS:-0}" -ge 3 ]; then exit 90; fi
`;

describe("the facts of the project's workflow files (workflowFacts)", () => {
  const facts = (pipeline = PIPELINE, worker = WORKER) =>
    workflowFacts(YAML.parse(pipeline), YAML.parse(worker));

  it("reads the table, the driver and every threshold out of the files", () => {
    expect(facts()).toEqual({
      table: {
        recon: [{ upto: 10, model: "sonnet", effort: "medium" }],
        execute: [
          { upto: 6, model: "sonnet", effort: "high" },
          { upto: 10, model: "opus", effort: "high" },
        ],
      },
      driver: { model: "haiku", effort: "medium" },
      recon_from: 4,
      executor_scores: [7, 8],
      split_from: 9,
      gate_fix_rounds: 3,
      land_lock: "anyparse-land",
      fix_rounds: 3,
    });
  });

  it("takes the model table from a dated copy when one is named, and everything else from today's files", () => {
    const dated: unknown = YAML.parse(
      PIPELINE.replace("model: opus", "model: fable").replace("-ge 4", "-ge 8"),
    );
    const f = workflowFacts(YAML.parse(PIPELINE), YAML.parse(WORKER), dated);
    expect(f.table.execute?.at(-1)?.model).toBe("fable");
    expect(f.recon_from).toBe(4);
    expect(() => workflowFacts(YAML.parse(PIPELINE), YAML.parse(WORKER), { name: "x" })).toThrow(
      /model_table/,
    );
  });

  it("follows the files when a threshold moves", () => {
    const moved = facts(
      PIPELINE.replace('"$D" -ge 4', '"$D" -ge 5').replace('"$s" -ge 9', '"$s" -ge 10'),
    );
    expect(moved.recon_from).toBe(5);
    expect(moved.split_from).toBe(10);
  });

  it("refuses a file that no longer says a threshold, never guessing one", () => {
    expect(() => facts(PIPELINE.replace('[ "$D" -ge 4 ] || exit 0', "exit 0"))).toThrow(
      /the recon threshold/,
    );
    expect(() => facts(PIPELINE.replace("max_visits: 3", "max_visits: many"))).toThrow(
      /max_visits/,
    );
    expect(() => facts(PIPELINE.replace("driver:", "drover:"))).toThrow(/driver/);
    expect(() => facts(PIPELINE.replace("locks:", "lacks:"))).toThrow(/land holds no lock/);
    expect(() => facts(PIPELINE, WORKER.replace("FIX_ROUNDS", "ROUNDS"))).toThrow(
      /the gate's fix rounds/,
    );
    expect(() => facts(PIPELINE.replace("model_table:", "table:"))).toThrow(/model_table/);
  });

  it("refuses when the plan stage and the pipeline name different executor scores", () => {
    expect(() => facts(PIPELINE, WORKER.replace("Score 7 or 8", "Score 8"))).toThrow(
      /hands off at 8 but plan_route skips the plan at 7,8/,
    );
  });
});

const T0 = Date.parse("2026-11-10T00:00:00.000Z");
const at = (hours: number): string => new Date(T0 + hours * 3_600_000).toISOString();

/** A finished run of the pipeline: its hours, its visits, and what its agents spent. */
function run(o: {
  from: number;
  to: number;
  visits: Record<string, number>;
  usd?: number;
  by_agent?: { stage?: string; state?: string; usd?: number; model?: string }[];
  difficulty?: number;
  claim?: number;
  outcome?: string;
  project?: string;
  workflow?: string;
}): LedgerEntry {
  return {
    session_id: "s",
    parent_session_id: null,
    root_session_id: "s",
    workflow: o.workflow ?? "slice-pipeline",
    outcome: o.outcome ?? "completed",
    started_at: at(o.from),
    ended_at: at(o.to),
    transitions: 1,
    exec_ms_total: 0,
    wait_ms_total: 0,
    execs: [],
    task: "T",
    project: o.project ?? "/somewhere/anyparse",
    visits: o.visits,
    difficulty: o.difficulty,
    claim_difficulty: o.claim ?? o.difficulty,
    spend:
      o.usd === undefined
        ? undefined
        : {
            agents: 1,
            usd: o.usd,
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            by_agent: o.by_agent?.map(a => ({
              agent: "a",
              input: 0,
              output: 0,
              cache_read: 0,
              cache_write: 0,
              ...a,
            })),
          },
  };
}

const LANDED = { mark_landed: 1, bookkeeping: 1, land: 1 };
const RUNS: LedgerEntry[] = [
  // a landed line the recon scored up, one review
  run({
    from: 0,
    to: 2,
    visits: { ...LANDED, recon_end: 1, recon_scored: 1, review: 1 },
    usd: 4,
    by_agent: [
      { stage: "recon", usd: 0.5 },
      { stage: "execute", usd: 2 },
      { stage: "review", usd: 1.25 },
      { state: "dispatch", usd: 0.25 },
    ],
    difficulty: 7,
    claim: 5,
  }),
  // a landed line the recon kept, two reviews, the second on the verify row
  run({
    from: 1,
    to: 4,
    visits: { ...LANDED, recon_end: 1, recon_scored: 1, review: 2, fixes: 1 },
    usd: 10,
    by_agent: [
      { stage: "plan", usd: 4, model: "claude-sonnet-5-5" },
      { stage: "fix", usd: 2, model: "claude-sonnet-5-5" },
      { stage: "review", usd: 2, model: "claude-opus-5-5" },
      { stage: "review_verify", usd: 1, model: "claude-sonnet-5-5" },
      { usd: 1 },
    ],
    difficulty: 5,
  }),
  // a landed line with no recon and no measured spend
  run({ from: 1, to: 3, visits: { ...LANDED, review: 1 }, difficulty: 2 }),
  // a landed line the recon scored down, measured without a per-agent record
  run({
    from: 30,
    to: 31,
    visits: { ...LANDED, recon_end: 1, recon_scored: 1, review: 2 },
    usd: 6,
    difficulty: 3,
    claim: 6,
  }),
  // stopped by the recon: split, closed, and one the parent overrode and that landed
  run({ from: 5, to: 6, visits: { recon_end: 1, recon_blocked: 1, mark_split: 1 }, usd: 0.4 }),
  run({ from: 5, to: 6, visits: { recon_end: 1, recon_blocked: 1, mark_closed: 1 }, usd: 0.6 }),
  run({
    from: 6,
    to: 8,
    visits: { ...LANDED, recon_end: 1, recon_blocked: 1, work: 1, review: 1 },
    usd: 8,
    difficulty: 6,
  }),
  // split by a worker, a plan handed on and then rejected, an abandoned run
  run({ from: 8, to: 9, visits: { work: 1, blocked: 1, mark_split: 1 } }),
  run({ from: 8, to: 9, visits: { work: 1, rescored: 1, review: 1, reject: 1, closed: 1 } }),
  run({ from: 9, to: 10, visits: { work: 1 }, outcome: "abandoned" }),
  // not this pipeline's, not this project's
  run({ from: 0, to: 50, visits: LANDED, usd: 99, workflow: "slice-worker" }),
  run({ from: 0, to: 50, visits: LANDED, usd: 99, project: "/somewhere/private" }),
  run({ from: 0, to: 50, visits: LANDED, usd: 99, project: "/somewhere/anyparse-fork" }),
];
const fold = (rows: readonly LedgerEntry[] = RUNS) =>
  foldUseCase(rows, { project: "anyparse", workflow: "slice-pipeline", every: 2 });

describe("the ledger folded for the use-case page (foldUseCase)", () => {
  const s = fold();

  it("reads only the named project's runs of the named workflow", () => {
    expect(s.runs).toEqual({ total: 10, landed: 5, split: 2, closed: 2, other: 1 });
    expect(s.cost.usd).toBe(28);
    expect(s.from).toBe(at(0));
    expect(s.to).toBe(at(31));
    expect(() => foldUseCase(RUNS, { project: "nobody", workflow: "slice-pipeline" })).toThrow(
      /no finished slice-pipeline run of nobody/,
    );
  });

  it("counts a landed line's cost over the measured ones, with the median and the mean", () => {
    expect(s.cost).toEqual({ lands: 5, measured: 4, median: 7, mean: 7, usd: 28 });
    expect(s.rounds).toEqual([
      { rounds: 1, lands: 3, measured: 2, median: 6, mean: 6 },
      { rounds: 2, lands: 2, measured: 2, median: 8, mean: 8 },
    ]);
    expect(s.difficulty.map(d => [d.difficulty, d.lands, d.median])).toEqual([
      [2, 1, null],
      [3, 1, 6],
      [5, 1, 10],
      [6, 1, 8],
      [7, 1, 4],
    ]);
  });

  it("splits the cost by stage: the verify row is the review, the dispatcher's link the driver, the rest other", () => {
    expect(s.stages.lands).toBe(2);
    expect(s.stages.usd).toBe(14);
    expect(Object.fromEntries(s.stages.rows.map(r => [r.stage, r.usd]))).toEqual({
      recon: 0.5,
      plan: 4,
      execute: 2,
      fix: 2,
      review: 4.25,
      driver: 0.25,
      other: 1,
    });
  });

  it("says what the recon did with the lines it read, and what a run it stopped cost", () => {
    expect(s.recon).toEqual({
      ran: 6,
      kept: 1,
      up: 1,
      down: 1,
      split: 1,
      closed: 1,
      overridden: 1,
      stopped: { measured: 2, median: 0.5 },
    });
    expect(s.plan).toEqual({ handoffs: 1, splits: 1 });
  });

  it("counts lands per day over every day of the window, and the hours by pipelines open at once", () => {
    expect(s.days).toEqual([
      { day: "2026-11-10", lands: 4 },
      { day: "2026-11-11", lands: 1 },
    ]);
    // 0-1h one open, 1-2h three, 2-3h two, 3-4h one, 4-5h none, 5-6h two, 6-8h one, 8-9h two, 9-10h one, 10-30h none, 30-31h one
    expect(s.slots).toEqual([
      { open: 0, hours: 21 },
      { open: 1, hours: 6 },
      { open: 2, hours: 3 },
      { open: 3, hours: 1 },
    ]);
  });

  it("bands the landed lines by the difficulty their stages ran on, with each stage's cost and models", () => {
    expect(s.bands).toEqual([
      {
        band: "1-3",
        lands: 2,
        measured: 1,
        median: 6,
        mean: 6,
        rounds: 1.5,
        moved: 1,
        stages: [],
      },
      {
        band: "4-6",
        lands: 2,
        measured: 2,
        median: 9,
        mean: 9,
        rounds: 1.5,
        moved: 0,
        stages: [
          { stage: "plan", usd: 4, models: ["sonnet"] },
          { stage: "fix", usd: 2, models: ["sonnet"] },
          // the verify row is the review's: the costlier model first
          { stage: "review", usd: 3, models: ["opus", "sonnet"] },
          { stage: "other", usd: 1, models: [] },
        ],
      },
      {
        band: "7-10",
        lands: 1,
        measured: 1,
        median: 4,
        mean: 4,
        rounds: 1,
        moved: 1,
        stages: [
          { stage: "recon", usd: 0.5, models: [] },
          { stage: "execute", usd: 2, models: [] },
          { stage: "review", usd: 1.25, models: [] },
          { stage: "driver", usd: 0.25, models: [] },
        ],
      },
    ]);
  });

  it("cuts the lands, in the order they ended, into the windows between two curator runs", () => {
    // ended at 2h ($4, 1 review), 3h (unmeasured, 1), 4h ($10, 2), 8h ($8, 1), 31h ($6, 2)
    expect(s.windows).toEqual({
      every: 2,
      rows: [
        { measured: 1, median: 4, rounds: 1 },
        { measured: 2, median: 9, rounds: 1.5 },
      ],
      rest: 1,
    });
    expect(foldUseCase(RUNS, { project: "anyparse", workflow: "slice-pipeline" }).windows).toEqual({
      every: 20,
      rows: [],
      rest: 5,
    });
  });

  it("is the same text whatever order the ledger's lines come in", () => {
    expect(JSON.stringify(fold([...RUNS].reverse()))).toBe(JSON.stringify(s));
  });
});

describe("the committed snapshot (docs/use-case-anyparse.json)", () => {
  const text = fs.readFileSync(SNAPSHOT_FILE, "utf8");
  const s = snapshot.stats;

  it("names no path, no session and no task, and the check refuses a text that does", () => {
    expect(() => assertUseCaseClean(text)).not.toThrow();
    expect(text).not.toMatch(/Users|workflow-state|session/);
    expect(() => assertUseCaseClean('{"project": "/Users/someone/anyparse"}')).toThrow(/path/);
    expect(() => assertUseCaseClean('{"task": "X"}')).toThrow(/task key/);
    expect(() => assertUseCaseClean('{"a": "a96e747d87dd95c4e"}')).toThrow(/an id/);
  });

  it("is anyparse's slice pipeline, and its counts add up", () => {
    expect(snapshot.project).toBe("anyparse");
    expect(snapshot.task_workflow).toBe("slice-pipeline");
    // the table shown is the one the window's costs were made on
    expect(snapshot.table_of).toBe("window");
    expect(snapshot.exclusive_hold).toBeTypeOf("boolean");
    expect(s.windows.rows.length * s.windows.every + s.windows.rest).toBe(s.runs.landed);
    expect(s.bands.map(b => b.band)).toEqual(["1-3", "4-6", "7-10"]);
    expect(s.bands.reduce((n, b) => n + b.lands, 0)).toBeLessThanOrEqual(s.runs.landed);
    expect(s.runs.landed + s.runs.split + s.runs.closed + s.runs.other).toBe(s.runs.total);
    expect(s.runs.landed).toBeGreaterThan(100);
    expect(s.rounds.reduce((n, r) => n + r.lands, 0)).toBe(s.runs.landed);
    expect(s.days.reduce((n, d) => n + d.lands, 0)).toBe(s.runs.landed);
    expect(s.cost.lands).toBe(s.runs.landed);
    expect(s.cost.measured).toBeLessThanOrEqual(s.cost.lands);
    expect(Math.abs(s.stages.rows.reduce((n, r) => n + r.usd, 0) - s.stages.usd)).toBeLessThan(
      0.05,
    );
    const r = s.recon;
    expect(r.kept + r.up + r.down + r.split + r.closed + r.overridden).toBeLessThanOrEqual(r.ran);
    expect(Date.parse(s.from)).toBeLessThan(Date.parse(s.to));
  });

  it("carries the facts the path is drawn from: a table with the stages the pipeline spawns on, and the thresholds", () => {
    const w = snapshot.workflow;
    for (const stage of ["recon", "plan", "execute", "review", "fix"])
      expect(w.table[stage]?.at(-1)?.upto, stage).toBe(10);
    expect(w.recon_from).toBeGreaterThanOrEqual(1);
    expect(w.split_from).toBeGreaterThan(Math.max(...w.executor_scores));
    expect(Math.min(...w.executor_scores)).toBeGreaterThanOrEqual(w.recon_from);
    expect(w.fix_rounds).toBeGreaterThanOrEqual(1);
    expect(w.gate_fix_rounds).toBeGreaterThanOrEqual(1);
    expect(w.land_lock).toMatch(/^[a-z-]+$/);
    // every scenario of the page still takes its own way over the real facts
    const ways = PATH_SCENARIOS.map(sc => {
      const p = slicePath(w, sc);
      return [p.recon, p.rescored, p.plan, p.execute, p.outcome, p.stoppedBy].join();
    });
    expect(new Set(ways).size).toBe(PATH_SCENARIOS.length);
  });
});
