// Pins of ENG-PANE-COST-TAILS: the plan pane's Landed days (hooks/plan-pane.tsx), the parts that need no render.
import { describe, expect, it, vi } from "vitest";
vi.mock("claude-code", () => ({ atom: () => ({}), read: () => ({}), update: () => ({}) }));

interface Land {
  at: string;
  slice: string;
  usd?: number;
  sha: string;
  start: string;
}
interface Spend {
  usd?: number;
  endedAt: number;
  outcome: "failed" | "closed" | "landed";
}
interface DaySpend {
  usd: number;
  lines: number;
  measured: number;
  failed: number;
  closed: number;
}
interface PaneModule {
  daySpends: (lands: Land[], spends: Map<string, Spend>, now?: number) => Record<string, DaySpend>;
  dayOf: (ms: number) => string;
  landDayOpen: (folded: string[], key: string, today: string) => boolean;
  landDayToggled: (folded: string[], key: string, today: string) => string[];
  recentLand: (lands: Land[], label: string, at: number, now: number) => Land | undefined;
  pruneLandFolds: (folded: string[], liveDays: Set<string>) => string[];
}
const pane = async (): Promise<PaneModule> =>
  (await import("../hooks/plan-pane.tsx")) as PaneModule;

describe("ENG-PANE-COST-TAILS", () => {
  it("a failed row of the same DD.MM a year ago is not summed into today", async () => {
    const { daySpends, dayOf } = await pane();
    const now = new Date(2026, 10, 9, 12, 0).getTime();
    const yearAgo = new Date(2025, 10, 9, 12, 0).getTime();
    const lands: Land[] = [{ at: "09.11 12:00", slice: "A", usd: 1, sha: "x", start: "11:00" }];
    const spends = new Map<string, Spend>([
      ["OLD", { usd: 50, endedAt: yearAgo, outcome: "failed" }],
    ]);
    const days = daySpends(lands, spends, now);
    expect(dayOf(now)).toBe("09.11");
    expect(days["09.11"]?.usd).toBe(1);
    expect(days["09.11"]?.lines).toBe(1);
  });

  it("a failed row of the same day this year is still summed", async () => {
    const { daySpends } = await pane();
    const now = new Date(2026, 10, 9, 12, 0).getTime();
    const lands: Land[] = [{ at: "09.11 12:00", slice: "A", usd: 1, sha: "x", start: "11:00" }];
    const spends = new Map<string, Spend>([
      ["F", { usd: 5, endedAt: new Date(2026, 10, 9, 9, 0).getTime(), outcome: "failed" }],
    ]);
    expect(daySpends(lands, spends, now)["09.11"]).toMatchObject({ usd: 6, lines: 2, failed: 1 });
  });

  it("a day folded while it was today stays folded tomorrow; an opened old day stays open", async () => {
    const { landDayOpen, landDayToggled } = await pane();
    const folded = landDayToggled([], "lands-09.11", "lands-09.11");
    expect(landDayOpen(folded, "lands-09.11", "lands-09.11")).toBe(false);
    expect(landDayOpen(folded, "lands-09.11", "lands-10.11")).toBe(false);
    const opened = landDayToggled([], "lands-08.11", "lands-09.11");
    expect(landDayOpen(opened, "lands-08.11", "lands-10.11")).toBe(true);
    expect(landDayOpen([], "lands-09.11", "lands-09.11")).toBe(true);
    expect(landDayOpen([], "lands-09.11", "lands-10.11")).toBe(false);
    expect(landDayToggled(folded, "lands-09.11", "lands-10.11")).toEqual(["+lands-09.11"]);
  });

  it("the notification row finds a land of the last two days and never reads a slice of an older day", async () => {
    const { recentLand } = await pane();
    const now = new Date(2026, 10, 9, 12, 0).getTime();
    const seen: string[] = [];
    const row = (at: string, slice: string): Land => ({
      at,
      sha: slice,
      start: "",
      get slice() {
        seen.push(slice);
        return slice;
      },
    });
    const lands = [
      row("09.11 11:00", "NEW"),
      row("08.11 10:00", "YEST"),
      row("02.11 10:00", "OLD"),
      row("01.11 10:00", "OLDER"),
    ];
    expect(recentLand(lands, "YEST", now, now)?.sha).toBe("YEST");
    expect(recentLand(lands, "OLD", now, now)).toBeUndefined();
    expect(seen).not.toContain("OLD");
    expect(seen).not.toContain("OLDER");
    // anchored on the agent's own time: a notification drawn days later still finds its land
    const then = new Date(2026, 10, 2, 12, 0).getTime();
    expect(recentLand(lands, "OLD", then, now)?.sha).toBe("OLD");
  });

  it("a signed fold key of a day gone from the window leaves on refresh, one of a live day stays, and a failed git read prunes nothing", async () => {
    const { pruneLandFolds } = await pane();
    const keys = [
      "-lands-01.01",
      "+lands-02.02",
      "-lands-09.11",
      "+lands-08.11",
      "running",
      "failed",
    ];
    expect(pruneLandFolds(keys, new Set(["09.11", "08.11"]))).toEqual([
      "-lands-09.11",
      "+lands-08.11",
      "running",
      "failed",
    ]);
    expect(pruneLandFolds(keys, new Set())).toBe(keys);
  });
});
