import { describe, expect, it } from "vitest";
import { PRICES_UPDATED, PRICES_USD_PER_MTOK, priceOf } from "./calibration.js";

describe("Cost tab blended price", () => {
  it("prices a Fable model id like the other families", () => {
    expect(priceOf("claude-opus-5-5")).toBeDefined();
    expect(priceOf("claude-fable-5-2")).toBeDefined();
  });

  it("blends Fable 5.2 at 75% of $8 input and 25% of $40 output", () => {
    expect(PRICES_USD_PER_MTOK.fable).toBe(16);
    expect(priceOf("claude-fable-5-2")).toBe(16);
    expect(priceOf("fable")).toBe(16);
  });

  it("dates the rates the day Fable 5.2 and Sonnet 5.5 were taken", () => {
    expect(PRICES_UPDATED).toBe("2026-11-18");
  });
});
