import { describe, expect, it } from "vitest";
import { buildCost, priceOf, turnUsd } from "./calibration.js";
import type { LedgerEntry } from "./ledger.js";

const entry = (model: string): LedgerEntry => ({
  parent_session_id: null,
  transitions: 1,
  exec_ms_total: 0,
  wait_ms_total: 0,
  execs: [],
  started_at: "2026-11-08T00:00:00Z",
  session_id: "s",
  root_session_id: "s",
  workflow: "w",
  outcome: "completed",
  ended_at: "2026-11-08T12:00:00",
  task: "T",
  model,
  visits: { project_land: 1 },
  tokens: { total: 1_000_000 },
});

describe("Cost tab estimate blends by the row's full model id", () => {
  it("claude-opus-4-1 ($15/$75, blend 30) without spend is priced at 30 per MTok, as turnUsd does for its input", () => {
    // 0.75 * 15 + 0.25 * 75 = 30; turnUsd prices 750k input + 250k output tokens of the same id at that blend.
    const perTurn = turnUsd("claude-opus-4-1", {
      input: 750_000,
      output: 250_000,
      cache_read: 0,
      cache_write_5m: 0,
      cache_write_1h: 0,
    });
    expect(perTurn).toBeCloseTo(30, 6);
    const r = buildCost([entry("claude-opus-4-1")], "2026-11-08", "2026-11-08");
    expect(r.tasks[0].usd).toBeCloseTo(30, 6);
  });

  it("a family name and an unknown id of a family fall back to the family blend, a dated id takes its own", () => {
    expect(priceOf("opus")).toBe(8);
    expect(priceOf("claude-opus-9-9")).toBe(8);
    expect(priceOf("claude-opus-4-1-20250805")).toBe(30);
    expect(priceOf("claude-opus-5-5")).toBe(8);
    expect(priceOf("claude-opus-5")).toBe(10);
    expect(priceOf("gpt-x")).toBeUndefined();
  });
});
