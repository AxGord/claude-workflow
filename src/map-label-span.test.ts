import { describe, expect, it } from "vitest";
import { fold, type EventKind, type WfEvent } from "./event-fold.js";
import { layout, type MapWorkflow } from "./map-layout.js";

const T = (m: number): string => `2026-11-08T11:${String(m).padStart(2, "0")}:00.000Z`;
const NOW = Date.parse(T(50));
const st = (name: string, script = false, terminal = false) => ({ name, script, terminal });
const WF: Record<string, MapWorkflow> = {
  loopy: { stations: [st("a"), st("b"), st("c"), st("d"), st("e", false, true)] },
};

function run(loopName: string): {
  label: string;
  title?: string;
  col: number;
  span: number;
  short: boolean;
} {
  let seq = 0;
  const log: WfEvent[] = [];
  const ev = (kind: EventKind, session: string, m: number, data: Record<string, unknown>) =>
    log.push({ seq: ++seq, run: "r1", ts: T(m), kind, session, data });
  ev("session_start", "S", 0, { workflow: "loopy", parent: null, task: null, difficulty: null });
  const mv = (m: number, from: string, to: string, name: string) =>
    ev("transition", "S", m, { from, to, name, workflow: "loopy" });
  mv(1, "a", "b", "next");
  mv(2, "b", "c", "next");
  mv(3, "c", "d", "next");
  mv(4, "d", "b", loopName); // loop back across two columns (d -> b)
  mv(5, "b", "c", "next");
  const m = layout(fold(log), WF, { now: NOW, clock: () => "hh:mm" });
  const lane = m.bands[0].lanes[0];
  const loop = lane.loops[0];
  const col = (lane.loops[0].x1 - lane.loops[0].x2) / 2;
  const full = `↺ ${loopName}`;
  return {
    label: loop.label,
    ...(loop.title ? { title: loop.title } : {}),
    col,
    span: loop.x1 - loop.x2,
    short: loop.label !== full,
  };
}

describe("a loop label that spans several columns", () => {
  it("is counted across the columns it spans, not against one column", () => {
    const name = "rescore the whole slice after the regate failed twice";
    const r = run(name);
    const one = run("x"); // a short label: the column the stations alone need
    // the label is ~325px wide: one column would take all of it (capped at 230), two share it
    expect(r.label).toBe(`↺ ${name}`);
    expect(r.col).toBeLessThan(230);
    expect(r.col).toBeGreaterThan(one.col);
    expect(r.span).toBeGreaterThanOrEqual(r.label.length * 6);
  });
});
