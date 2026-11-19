import { describe, expect, it } from "vitest";
import { buildCost, calibrate } from "./calibration.js";
import type { LedgerEntry } from "./ledger.js";

const entry: LedgerEntry = {
  session_id: "r",
  root_session_id: "r",
  parent_session_id: null,
  task: "T",
  project: "/p",
  workflow: "w",
  outcome: "completed",
  difficulty: 2,
  transitions: 1,
  exec_ms_total: 0,
  wait_ms_total: 0,
  execs: [],
  started_at: "2026-11-05T12:00:00Z",
  ended_at: "2026-11-05T12:00:00Z",
  stages: {
    execute: { model: "sonnet", effort: "low" },
    review: { model: "opus", effort: "high" },
  },
  tokens: { worker: 10, review: 5 },
  visits: { review: 2, review_spawn: 2, review_warm: 1, review_route: 3 },
};

describe("review rounds", () => {
  it("the calibration table row counts 2 rounds", () => {
    const rows = calibrate([entry], {});
    expect(rows.find(r => r.stage === "review")?.review_rounds).toBe(2);
  });
  it("the per-entry rounds of the cost report is 2 too", () => {
    const r = buildCost([entry], "2026-11-05", "2026-11-05");
    expect(r.tasks[0].rounds).toBe(2);
  });
});
