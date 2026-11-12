import { describe, expect, it } from "vitest";
import { calibrate } from "./calibration.js";

describe("calibrate final band", () => {
  it("bands a raised slice by the final difficulty, not the claim", () => {
    const rows = calibrate(
      [
        {
          id: "x",
          workflow: "w",
          project: "/p",
          difficulty: 9,
          claim_difficulty: 5,
          ended_at: "2026-11-10T00:00:00Z",
          outcome: "completed",
        } as never,
      ],
      {},
    );
    expect(rows.map(r => r.band)).toEqual(["7-10"]);
  });
});
