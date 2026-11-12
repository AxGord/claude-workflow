import { describe, expect, it } from "vitest";
import { calibrate, formatCalibration } from "./calibration.js";
import { runCalibration } from "./calibration-cli.js";
import type { LedgerEntry } from "./ledger.js";

// Shape of a real landed slice-pipeline line (RUN-LEDGER-STATIC-DELETE-C2): 2 review rounds, per-role tokens.
const entry = {
  session_id: "e55b2888",
  parent_session_id: null,
  root_session_id: "e55b2888",
  workflow: "slice-pipeline",
  outcome: "completed",
  started_at: "2026-11-12T08:52:47Z",
  ended_at: "2026-11-12T10:42:59Z",
  transitions: 25,
  exec_ms_total: 0,
  wait_ms_total: 0,
  execs: [],
  project: "/p",
  difficulty: 5,
  claim_difficulty: 5,
  verdict: "MERGE",
  escalations: 0,
  visits: {
    recon: 1,
    plan_spawn: 1,
    review: 2,
    review_route: 2,
    review_spawn: 1,
    fixes: 1,
  },
  tokens: { worker: 151934, review: 119707 },
  stages: {
    recon: { model: "sonnet", effort: "medium" },
    plan: { model: "sonnet", effort: "high" },
    review: { model: "opus", effort: "high" },
    fix: { model: "sonnet", effort: "high" },
  },
} as LedgerEntry;

describe("calibration of a staged pipeline", () => {
  it("puts review rounds and review tokens on the review stage row", () => {
    const rows = calibrate([entry], {});
    const review = rows.find(r => r.stage === "review")!;
    expect(review.review_rounds).toBe(2);
    expect(review.tokens).toBe(119707);
    expect(rows.reduce((s, r) => s + r.tokens, 0)).toBe(151934 + 119707);
  });
});

describe("calibration columns", () => {
  const multi = {
    ...entry,
    escalations: 1,
    counts: { findings: 3 },
    spend: {
      agents: 3,
      usd: 4,
      input: 1,
      output: 1,
      cache_read: 1,
      cache_write: 1,
    },
    agent_ids: { plan: "a1", fix: "a2", review: "a3" },
    tokens: { worker: 100, review: 50 },
  } as LedgerEntry;
  const unmeasured = {
    ...entry,
    session_id: "u",
    spend: { agents: 1, input: 0, output: 0, cache_read: 0, cache_write: 0 },
  } as LedgerEntry;

  it("esc stays on the first row; findings go to the review row; worker tokens go to fix", () => {
    const rows = calibrate([multi], { findingsKey: "findings" });
    const by = (s: string) => rows.find(r => r.stage === s)!;
    expect(by("fix").tokens).toBe(100);
    expect(by("review").tokens).toBe(50);
    expect(by("review").findings).toBe(3);
    expect(rows.map(r => [r.stage, r.escalations, r.findings])).toEqual([
      ["fix", 0, 0],
      ["plan", 0, 0],
      ["recon", 1, 0],
      ["review", 0, 3],
    ]);
  });

  it("$ is - on a row no agent spend is recorded for: never a task total, never 0", () => {
    const text = formatCalibration(calibrate([unmeasured, multi], {}), false);
    expect(text).toContain("$/task");
    expect(text).not.toMatch(/\d\.\d\d/);
  });

  it("--help prints the usage and reads no ledger", () => {
    expect(runCalibration(["--help"], "/nonexistent")).toMatchInlineSnapshot(`
      "usage: wf-calibration [--ledger FILE] [--since DATE] [--project PATH] [--findings-key KEY] [--json]
        rounds = review visits (on the review row), tokens split per stage row, findings on the review row, $ and $/task = USD of the agents linked at that stage (- none on record, >= an agent unmeasured; an agent linked at no stage is on a - row), claim = tasks off their claim by >=2, esc/verdicts per task"
    `);
  });
});
