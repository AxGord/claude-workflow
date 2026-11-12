import { describe, expect, it } from "vitest";
import {
  buildCost,
  calibrate,
  costStages,
  formatCalibration,
  PRICES_UPDATED,
} from "./calibration.js";
import { runCalibration } from "./calibration-cli.js";
import { ledgerEntry, type LedgerEntry } from "./ledger.js";
import type { SessionState } from "./types.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const base = {
  parent_session_id: null,
  transitions: 1,
  exec_ms_total: 0,
  wait_ms_total: 0,
  execs: [],
  started_at: "2026-11-01T00:00:00Z",
};
const line = (id: string, over: Partial<LedgerEntry>): LedgerEntry => ({
  ...base,
  session_id: id,
  root_session_id: id,
  workflow: "w",
  outcome: "completed",
  ended_at: "2026-11-05T00:00:00Z",
  ...over,
});

const ledger: LedgerEntry[] = [
  line("a", {
    project: "/p1",
    difficulty: 2,
    stages: {
      execute: { model: "sonnet", effort: "low" },
      review: { model: "opus", effort: "high" },
    },
    visits: { review: 2, review_route: 3, work: 1 },
    tokens: { worker: 10, review: 5 },
    escalations: 1,
    verdict: "pass",
    counts: { findings: 4 },
  }),
  line("b", {
    project: "/p1",
    difficulty: 5,
    model: "haiku",
    effort: "low",
    outcome: "failed",
  }),
  line("c", {
    project: "/p2",
    difficulty: 9,
    tokens: { total: 7 },
    ended_at: "2026-10-01T00:00:00Z",
  }),
  line("d", { workflow: null }),
];

describe("calibrate", () => {
  it("bands by the claim difficulty, not the final one", () => {
    const rows = calibrate([line("x", { project: "/p", difficulty: 9, claim_difficulty: 5 })], {});
    expect(rows.map(r => r.band)).toEqual(["4-6"]);
  });

  it("folds two projects and three bands into the exact table", () => {
    const rows = calibrate(ledger, { findingsKey: "findings" });
    expect(
      rows.map(r => [
        r.project,
        r.workflow,
        r.band,
        r.stage,
        `${r.model}/${r.effort}`,
        r.tasks,
        r.review_rounds,
        r.escalations,
        r.tokens,
        r.findings,
        r.outcomes,
        r.verdicts,
      ]),
    ).toEqual([
      ["-", "-", "-", "-", "-/-", 1, 0, 0, 0, 0, { completed: 1 }, {}],
      ["/p1", "w", "1-3", "execute", "sonnet/low", 1, 0, 1, 10, 0, { completed: 1 }, { pass: 1 }],
      ["/p1", "w", "1-3", "review", "opus/high", 1, 2, 0, 5, 4, { completed: 1 }, { pass: 1 }],
      ["/p1", "w", "4-6", "-", "haiku/low", 1, 0, 0, 0, 0, { failed: 1 }, {}],
      ["/p2", "w", "7-10", "-", "-/-", 1, 0, 0, 7, 0, { completed: 1 }, {}],
    ]);
  });

  it("filters by --since and --project", () => {
    expect(calibrate(ledger, { since: "2026-11-01" }).map(r => r.project)).not.toContain("/p2");
    expect(calibrate(ledger, { project: "/p2" })).toHaveLength(1);
    expect(calibrate(ledger, { project: "/p2/" })).toHaveLength(1);
  });

  it("prints a table and json from a ledger file", () => {
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), "cal-")), "l.jsonl");
    writeFileSync(f, ledger.map(l => JSON.stringify(l)).join("\n") + "\n{broken\n");
    const out = runCalibration(["--ledger", f, "--project", "/p2"], f);
    expect(out.split("\n")).toHaveLength(2);
    expect(JSON.parse(runCalibration(["--ledger", f, "--json"], f))).toHaveLength(5);
    expect(formatCalibration(calibrate(ledger), false).split("\n")[0]).toMatch(
      /^project\s+workflow/,
    );
  });
});

describe("wf-calibration bin", () => {
  it("runs through a symlink", () => {
    execFileSync("npx", ["tsc", "-p", "."], { cwd: process.cwd() });
    const dir = mkdtempSync(path.join(os.tmpdir(), "cal-bin-"));
    const f = path.join(dir, "l.jsonl");
    writeFileSync(f, JSON.stringify(ledger[0]) + "\n");
    const link = path.join(dir, "wf-calibration");
    symlinkSync(path.resolve("build/calibration-cli.js"), link);
    const out = execFileSync("node", [link, "--ledger", f], {
      encoding: "utf8",
    });
    expect(out).toContain("/p1");
  }, 60_000);
});

describe("ledgerEntry fields", () => {
  it("records project, visits, verdict, agent_ids, plan_handoff and counts", () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cal-repo-")));
    execFileSync("git", ["init", "-q", repo]);
    const at = "2026-11-05T00:00:00Z";
    const session = {
      session_id: "s",
      stack: [],
      active_frame: -1,
      started_at: at,
      updated_at: at,
      overrides: {},
      context: {
        cwd: repo,
        slice: "LINE-1",
        review_verdict: "pass",
        agent_id_execute: "ag1",
        plan_handoff: "true",
        items: ["a", "b", "c"],
      },
      history: [
        { frame: 0, at, event: "start", workflow: "w", to: "work" },
        { frame: 0, at, from: "work", to: "review" },
        { frame: 0, at, from: "review", to: "work" },
        { frame: 0, at, from: "work", to: "review" },
      ],
    } as unknown as SessionState;
    const e = ledgerEntry(session);
    expect(e.project).toBe(repo);
    expect(e.task).toBe("LINE-1");
    expect(
      ledgerEntry({ ...session, context: { task: "free text with spaces" } }).task,
    ).toBeUndefined();
    expect(e.visits).toEqual({ work: 2, review: 2 });
    expect(e.verdict).toBe("pass");
    expect(e.agent_ids).toEqual({ execute: "ag1" });
    expect(e.plan_handoff).toBe(true);
    expect(e.counts).toEqual({ items: 3 });
  });

  it("stages lists only the rows a state read when stages_first exists", () => {
    const at = "2026-11-05T00:00:00Z";
    const withContext = (context: Record<string, unknown>): SessionState => ({
      session_id: "s",
      stack: [],
      active_frame: -1,
      started_at: at,
      updated_at: at,
      overrides: {},
      history: [],
      context,
    });
    const ctx = {
      model_plan: "sonnet",
      effort_plan: "high",
      model_execute: "opus",
      effort_execute: "high",
      model_review: "opus",
      effort_review: "high",
    };
    const closedAtPlan = ledgerEntry(
      withContext({ ...ctx, stages_first: { plan: { model: "sonnet", effort: "high" } } }),
    );
    expect(closedAtPlan.stages).toEqual({ plan: { model: "sonnet", effort: "high" } });
    const noRecord = ledgerEntry(withContext(ctx));
    expect(Object.keys(noRecord.stages ?? {}).sort()).toEqual(["execute", "plan", "review"]);
  });
});

describe("buildCost", () => {
  const staged = (id: string, over: Partial<LedgerEntry>): LedgerEntry =>
    line(id, {
      ended_at: "2026-11-08T12:00:00",
      task: `T-${id}`,
      model: "opus",
      stages: {
        recon: { model: "sonnet", effort: "high" },
        execute: { model: "opus", effort: "high" },
        review: { model: "opus", effort: "high" },
      },
      visits: { review: 1, project_land: 1 },
      ...over,
    });

  it("a worker count is one unsplit row at the task's model; a stage key at that stage's", () => {
    const stages = costStages(
      staged("x", { tokens: { total: 3_000_000, worker: 2_000_000, review: 500_000 } }),
    );
    expect(stages.map(s => [s.stage, s.model, s.tokens, s.usd])).toEqual([
      ["worker", "opus", 2_000_000, 60],
      ["review", "opus", 500_000, 15],
      ["-", "opus", 500_000, 15],
    ]);
  });

  it("the real spend is the task's cost; an unmeasured spend is not $0 and not the old estimate", () => {
    const sp = { agents: 2, input: 1, output: 2, cache_read: 3, cache_write: 4 };
    const r = buildCost(
      [
        staged("m", { tokens: { total: 1_000_000 }, spend: { ...sp, usd: 1.5 } }),
        staged("u", { tokens: { total: 1_000_000 }, spend: { ...sp, unmeasured: ["x"] } }),
      ],
      "2026-11-08",
      "2026-11-08",
    );
    const by = Object.fromEntries(r.tasks.map(t => [t.session_id, t]));
    expect([by.m.measured, by.m.usd, by.m.tokens]).toEqual([true, 1.5, 10]);
    expect([by.u.measured, by.u.usd, by.u.stages]).toEqual([false, 0, []]);
    expect(r.totals.usd).toBe(1.5);
  });

  it("totals, outcomes and $ per landed over the range; the trend is 14 days to `to`", () => {
    const r = buildCost(
      [
        staged("a", { tokens: { total: 2_000_000 } }),
        staged("b", { tokens: { total: 1_000_000 }, visits: { review: 2 } }),
        staged("c", { tokens: { total: 1_000_000 }, outcome: "abandoned" }),
        staged("old", {
          tokens: { total: 9 },
          ended_at: "2026-11-01T12:00:00",
          visits: { work: 1 },
        }),
        line("none", { ended_at: "2026-11-08T12:00:00" }),
      ],
      "2026-11-08",
      "2026-11-08",
    );
    expect(r.tasks.map(t => [t.session_id, t.outcome, t.rounds])).toEqual([
      ["a", "landed", 1],
      ["b", "closed", 2],
      ["c", "failed", 1],
    ]);
    expect(r.totals.landed).toBe(1);
    expect(r.totals.usd_per_landed).toBe(r.totals.usd);
    expect(r.trend).toHaveLength(14);
    expect(r.trend[13].day).toBe("2026-11-08");
    expect(r.trend[6]).toMatchObject({ day: "2026-11-01", tasks: 1, usd_per_landed: null });
    expect(r.prices.updated).toBe(PRICES_UPDATED);
  });

  it("a landed line without tokens is unmeasured: out of the $/landed denominator", () => {
    const r = buildCost(
      [staged("m", { tokens: { total: 1_000_000 } }), staged("u", {})],
      "2026-11-08",
      "2026-11-08",
    );
    expect(r.tasks.map(t => [t.session_id, t.measured])).toEqual([
      ["m", true],
      ["u", false],
    ]);
    expect(r.totals).toMatchObject({ landed: 2, measured_landed: 1, usd_per_landed: 30 });
    expect(r.trend[13]).toMatchObject({ measured_landed: 1, usd_per_landed: 30 });
  });

  it("no visits is unknown, land_failed is not a landing, a line without a task is no pipeline", () => {
    const r = buildCost(
      [
        staged("v", { tokens: { total: 1 }, visits: undefined }),
        staged("f", { tokens: { total: 1 }, visits: { land_failed: 1 } }),
        staged("n", { tokens: { total: 1 }, task: undefined }),
      ],
      "2026-11-08",
      "2026-11-08",
    );
    expect(r.tasks.map(t => [t.session_id, t.outcome])).toEqual([
      ["v", "unknown"],
      ["f", "closed"],
    ]);
  });
});
