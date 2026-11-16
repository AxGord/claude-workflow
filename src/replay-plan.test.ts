import { describe, expect, it } from "vitest";
import { difficultyCells, planAt, type ReplayFile } from "./replay.js";

const file: ReplayFile = {
  version: 1,
  project: "p",
  start: "2026-01-01T00:00:00.000Z",
  durationMs: 1000,
  sessions: ["aaaa", "bbbb", "cccc", "dddd"],
  workflows: {},
  taskKinds: {},
  events: [
    [0, "session_start", 0, { workflow: "slice-pipeline", task: "A", difficulty: "7" }],
    [5, "agent_link", 0, { role: "slice-pipeline", model: "opus" }],
    [10, "transition", 0, { from: "claim", to: "work", name: "a", workflow: "slice-pipeline" }],
    [20, "session_start", 1, { workflow: "slice-review", parent: "aaaa" }],
    [30, "session_end", 1, { outcome: "completed" }],
    [40, "transition", 0, { from: "work", to: "land", name: "a", workflow: "slice-pipeline" }],
    [50, "session_end", 0, { outcome: "completed" }],
    [100, "session_start", 2, { workflow: "slice-pipeline", task: "B", difficulty: "3" }],
    [120, "transition", 2, { from: "claim", to: "closed", name: "a", workflow: "slice-pipeline" }],
    [130, "session_end", 2, { outcome: "completed" }],
    [200, "session_start", 3, { workflow: "slice-pipeline", task: "C", difficulty: "9" }],
  ],
};

describe("planAt sorts the replay's pipelines into the plan pane's sections", () => {
  it("before anything starts, every pipeline after the first is Next", () => {
    const v = planAt(file, 5);
    expect(v.running.map(r => r.task)).toEqual(["A"]);
    expect(v.next.map(r => r.task)).toEqual(["B", "C"]);
    expect(v.running[0].model).toBe("opus");
  });
  it("a running pipeline shows its state and the review rounds started under it", () => {
    const v = planAt(file, 25);
    expect(v.running[0]).toMatchObject({ task: "A", state: "work", rounds: 1 });
  });
  it("a pipeline that moved through land is Landed, one that did not is Closed", () => {
    const v = planAt(file, 150);
    expect(v.landed.map(r => r.task)).toEqual(["A"]);
    expect(v.closed.map(r => r.task)).toEqual(["B"]);
    expect(v.running).toEqual([]);
    expect(v.next.map(r => r.task)).toEqual(["C"]);
  });
  it("events after the position are not read", () => {
    expect(planAt(file, 35).landed).toEqual([]);
  });
  it("the difficulty bar is n/2 rounded, 1 to 5 cells, none when unknown", () => {
    expect([
      difficultyCells("1"),
      difficultyCells("7"),
      difficultyCells("10"),
      difficultyCells(""),
    ]).toEqual([1, 4, 5, 0]);
  });
});
