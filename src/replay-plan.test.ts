import { describe, expect, it } from "vitest";
import { nodeText, paneTree, type PaneEl, type PaneNode } from "../hooks/pane-view.js";
import { conversationAt, snapshotAt, type ReplayFile } from "./replay.js";

const file: ReplayFile = {
  version: 1,
  project: "p",
  start: "2026-01-01T00:00:00.000Z",
  durationMs: 1000,
  sessions: ["aaaa", "bbbb", "cccc", "dddd", "eeee"],
  workflows: {
    "slice-pipeline": { stations: [{ name: "claim", script: false, terminal: false }] },
  },
  taskKinds: { A: "bug" },
  events: [
    [0, "session_start", 0, { workflow: "slice-pipeline", task: "A", difficulty: "7" }],
    [5, "agent_link", 0, { agent: "ag1", role: "slice-pipeline", model: "opus" }],
    [10, "transition", 0, { from: "claim", to: "work", name: "a", workflow: "slice-pipeline" }],
    [20, "session_start", 1, { workflow: "slice-review", parent: "aaaa" }],
    [22, "ask", 0, { state: "work" }],
    [24, "answer", 0, { state: "work", to: "work" }],
    [30, "session_end", 1, { outcome: "completed" }],
    [40, "transition", 0, { from: "work", to: "land", name: "a", workflow: "slice-pipeline" }],
    [50, "session_end", 0, { outcome: "completed" }],
    [100, "session_start", 2, { workflow: "slice-pipeline", task: "B", difficulty: "3" }],
    [110, "rescore", 2, { from: "3", to: 9 }],
    [120, "transition", 2, { from: "claim", to: "closed", name: "a", workflow: "slice-pipeline" }],
    [130, "session_end", 2, { outcome: "completed" }],
    [140, "session_start", 4, { workflow: "slice-pipeline", task: "D", difficulty: "5" }],
    [150, "session_end", 4, { outcome: "aborted" }],
    [200, "session_start", 3, { workflow: "slice-pipeline", task: "C", difficulty: "9" }],
  ],
};

/** Every text element of a tree whose text matches. */
function texts(n: PaneNode, re: RegExp): string[] {
  if (n === null || typeof n === "string") return [];
  if (Array.isArray(n)) return (n as readonly PaneNode[]).flatMap(c => texts(c, re));
  const el = n as PaneEl;
  if (el.el === "link") return [];
  const own = el.el === "text" && re.test(nodeText(el)) ? [nodeText(el)] : [];
  return [...own, ...el.children.flatMap(c => texts(c, re))];
}

describe("snapshotAt builds the plan pane's Snapshot from the replay's events", () => {
  it("a root session with a task is a queue line: Next before it starts, Running until it ends", () => {
    const s = snapshotAt(file, 25);
    expect(s.queue?.running.map(l => l.id)).toEqual(["A"]);
    expect(s.queue?.ready.map(l => l.id)).toEqual(["B", "D", "C"]);
    expect(s.queue?.marks).toMatchObject({ A: "※", B: "◆" });
    expect(s.at).toBe(Date.parse(file.start) + 25);
  });
  it("the live sessions: the pipeline at its state with its agent, the review under it", () => {
    const s = snapshotAt(file, 25);
    expect(s.sessions.map(r => [r.id, r.parent, r.workflow, r.state, r.tag])).toEqual([
      ["aaaa", "", "slice-pipeline", "work", "A"],
      ["bbbb", "aaaa", "slice-review", "", ""],
    ]);
    expect(s.sessions[0]).toMatchObject({ agent: "ag1", isWorking: true, visit: 1 });
  });
  it("a pipeline that moved through land is a land; one that did not complete is failed", () => {
    const s = snapshotAt(file, 160);
    expect(s.lands.map(l => [l.slice, l.sha, l.difficulty])).toEqual([["A", "", "7"]]);
    expect(s.queue?.failedLines.map(l => l.id)).toEqual(["D"]);
    expect(s.queue?.done).toBe(2);
    expect(s.sessions).toEqual([]);
  });
  it("a rescore moves the line's difficulty; events after the position are not read", () => {
    expect(snapshotAt(file, 115).queue?.running[0]?.difficulty).toBe("9");
    expect(snapshotAt(file, 35).lands).toEqual([]);
  });
  it("the window is the most pipelines that ran at once", () => {
    expect(snapshotAt(file, 0).queue?.window).toBe(1);
  });
});

describe("the site draws the replay with the mod's own pane code (hooks/pane-view.ts)", () => {
  const draw = (at: number) =>
    paneTree({
      snapshot: snapshotAt(file, at),
      tab: "plan",
      expanded: "",
      folded: [],
      now: Date.parse(file.start) + at,
      columns: 60,
      rows: 30,
      poolCounts: null,
      pool: null,
    });
  it("the Running, Next and Landed sections with the mod's bars and kind marks", () => {
    expect(texts(draw(25), /^▾ ▶ Running 1\/1$/)).toHaveLength(1);
    expect(texts(draw(25), /▰▰▰▰▱ ※ A {2}work/)).toHaveLength(1);
    expect(texts(draw(25), /^▾ ⏭ Next \(3\)$/)).toHaveLength(1);
    expect(texts(draw(160), /^▾ ✓ Landed · 14d \(1\)$/)).toHaveLength(1);
    expect(texts(draw(160), /✗ Failed \(1\)/)).toHaveLength(1);
  });
});

describe("conversationAt: the parent's own lines, from the events", () => {
  it("starts, spawns, a question and its answer, a land, an end that did not complete", () => {
    expect(conversationAt(file, 1000).map(l => [l.kind, l.label])).toEqual([
      ["move", "A"],
      ["spawn", "A"],
      ["needs", "A"],
      ["move", "A"],
      ["landed", "A"],
      ["move", "B"],
      ["ended", "B"],
      ["move", "D"],
      ["ended", "D"],
      ["move", "C"],
    ]);
    expect(conversationAt(file, 1000)[0]).toMatchObject({
      name: "start slice-pipeline",
      to: "claim",
    });
    expect(conversationAt(file, 1000)[8]).toMatchObject({ failed: true });
    expect(conversationAt(file, 30)).toHaveLength(4);
  });
});
