import { describe, expect, it } from "vitest";
import { buildCost, PRICES_USD_PER_MTOK, TURN_RATES_USD_PER_MTOK } from "./calibration.js";
import type { LedgerEntry } from "./ledger.js";

// The blended table is one estimate over the stated 75% input / 25% output mix of the per-turn rates.
const blended = (family: string): number =>
  0.75 * TURN_RATES_USD_PER_MTOK[family].input + 0.25 * TURN_RATES_USD_PER_MTOK[family].output;

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

describe("Cost tab blended rates follow the per-turn rates", () => {
  it.each(["opus", "sonnet", "haiku"])(
    "%s: 1M tokens of the Cost tab cost the blend of the current per-turn rate",
    family => {
      const r = buildCost([entry(family)], "2026-11-08", "2026-11-08");
      expect(r.tasks[0].usd).toBeCloseTo(blended(family), 6);
      expect(r.prices.usd_per_mtok[family]).toBeCloseTo(blended(family), 6);
      expect(PRICES_USD_PER_MTOK[family]).toBeCloseTo(blended(family), 6);
    },
  );
});
