import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WfEvent } from "./event-fold.js";
import { parseQueue, planPick, type PickBlock } from "./queue.js";
import { captureReplayQueue } from "./replay-queue.js";
import {
  assertReplayClean,
  buildReplay,
  REPLAY_QUEUE_NOTE,
  renderReplay,
  snapshotAt,
  type ReplayFile,
  type ReplayQueue,
} from "./replay.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const AP = "/w/anyparse";
const ENG = "/w/mcp-workflow-engine";
const PRIVATE = "/w/golf";

const line = (id: string, o: Record<string, string> = {}): string =>
  [
    `  - id: ${id}`,
    `    status: ${o.status ?? "pending"}`,
    `    difficulty: ${o.difficulty ?? "4"}`,
    `    repo: ${o.repo ?? AP}`,
    ...Object.entries(o)
      .filter(([k]) => !["status", "difficulty", "repo"].includes(k))
      .map(([k, v]) => `    ${k}: ${v}`),
    `    text: |-`,
    `      PRIVATE TEXT OF ${id} at /Users/someone/secret`,
  ].join("\n");

const queueText = (lines: string[]): string =>
  `batch_size: 2\noverlap: paths\ntasks:\n${lines.join("\n")}\n`;

describe("planPick reports what keeps each waiting line out, as ids", () => {
  it("fills `blocks` for an after wait, an overlap, a hold and a breaking line; a ready line has none", () => {
    const q = parseQueue(
      queueText([
        line("R", { touches: "[ src/a ]" }),
        line("A", { after: "[ R ]", touches: "[ src/b ]" }),
        line("B", { touches: "[ src/a/x ]" }),
        line("M", { after: "'prose only'", touches: "[ src/m ]" }),
        line("F", { status: "failed", touches: "[ src/f ]" }),
        line("G", { after: "[ F ]", touches: "[ src/g ]" }),
      ]),
      "/w/anyparse/.claude/batch/queue.yaml",
    );
    const blocks = new Map<string, PickBlock>();
    const plan = planPick(q, { ignoreWindow: true, blocks });
    expect(plan.admitted.map(a => a.id)).toEqual(["R"]);
    expect(blocks.get("A")).toEqual({ after: ["R"], stuck: false });
    expect(blocks.get("B")).toEqual({
      after: [],
      stuck: false,
      against: { how: "overlap", id: "R" },
    });
    expect(blocks.get("M")).toMatchObject({ after: [], stuck: true });
    expect(blocks.get("G")).toEqual({ after: ["F"], stuck: false });
    expect(blocks.has("R")).toBe(false);
    // the contract of `reasons` is unchanged: the reason text, nothing more
    expect(plan.reasons.find(r => r.id === "B")).toEqual({
      id: "B",
      why: "overlaps R (touches src/a/x ~ src/a)",
    });
  });
});

describe("captureReplayQueue: the engine's pick over the queue rolled back to the window's start", () => {
  const file = "/w/anyparse/.claude/batch/queue.yaml";
  const q = parseQueue(
    queueText([
      line("RUN", { status: "done", touches: "[ src/a ]", kind: "bug", priority: "high" }),
      line("AFT", { after: "[ RUN ]", touches: "[ src/b ]" }),
      line("OVR", { touches: "[ src/a/x ]" }),
      line("ENGL", { repo: ENG, touches: "[ src/e ]" }),
      line("PRK", { parked: "true", touches: "[ src/p ]" }),
      line("EXT", { repo: PRIVATE, touches: "[ x ]" }),
      line("OFF", { after: "[ EXT ]", touches: "[ src/o ]" }),
      line("PAR", { model: "—", touches: "[ src/q ]" }),
      line("PRO", { after: "'once the maintainer agrees'", touches: "[ src/r ]" }),
      line("BAD", { status: "failed", touches: "[ src/f ]" }),
      line("AFB", { after: "[ BAD ]", touches: "[ src/g ]" }),
      line("LOW", { priority: "low", touches: "[ src/l ]" }),
    ]),
    file,
  );
  const tasks = new Set(["RUN", "AFT"]);
  const cap = captureReplayQueue(q, tasks, ["anyparse", "mcp-workflow-engine"]);
  const by = (id: string) => cap.lines.find(l => l.id === id);

  it("the lines that ran in the window are pending again, in the pick's visiting order (priority, then file)", () => {
    expect(cap.lines.map(l => l.id)).toEqual([
      "RUN",
      "AFT",
      "OVR",
      "ENGL",
      "PRK",
      "OFF",
      "PAR",
      "PRO",
      "AFB",
      "LOW",
    ]);
    expect(by("RUN")).toEqual({ id: "RUN", difficulty: "4", priority: "high", kind: "bug" });
  });
  it("each wait is ids and enums: after, against, hold, and the waits no end clears", () => {
    expect(by("AFT")).toMatchObject({ after: ["RUN"] });
    expect(by("OVR")).toMatchObject({ against: ["overlap", "RUN"] });
    expect(by("PRK")).toMatchObject({ hold: "parked" });
    expect(by("PAR")).toMatchObject({ hold: "parent-run (model —)" });
    expect(by("AFB")).toMatchObject({ fixed: ["BAD (failed)"] });
    expect(by("AFB")?.after).toBeUndefined();
    expect(by("PRO")).toMatchObject({ fixed: ["manual condition"] });
    expect(JSON.stringify(cap)).not.toContain("maintainer");
  });
  it("a line of another project is left out and a wait on it is a fixed text", () => {
    expect(by("EXT")).toBeUndefined();
    expect(by("OFF")).toMatchObject({ fixed: ["manual condition"] });
    expect(JSON.stringify(cap)).not.toMatch(/EXT|golf|PRIVATE|secret|\/w\//);
  });
  it("never a line's text, note or path, and the clean check accepts it", () => {
    const f = { ...fileOf(cap) };
    expect(() => assertReplayClean(f, ["/Users/someone"])).not.toThrow();
    expect(cap.note).toBe(REPLAY_QUEUE_NOTE);
  });
  it("the queue the caller passed is not changed", () => {
    expect(q.lines.find(l => l.id === "RUN")?.status).toBe("done");
  });
});

function fileOf(queue: ReplayQueue, events: ReplayFile["events"] = []): ReplayFile {
  return {
    version: 1,
    project: "anyparse",
    start: "2026-01-01T00:00:00.000Z",
    durationMs: 1000,
    sessions: [],
    workflows: {},
    taskKinds: {},
    queue,
    events,
  };
}

describe("assertReplayClean refuses a queue section that holds more than ids and enums", () => {
  const ok: ReplayQueue = {
    note: REPLAY_QUEUE_NOTE,
    lines: [
      { id: "A", difficulty: "4", priority: "", kind: "bug" },
      {
        id: "B",
        difficulty: "",
        priority: "high",
        kind: "feature",
        after: ["A"],
        fixed: ["X (failed)"],
      },
    ],
  };
  const bad =
    (lines: unknown[], note = REPLAY_QUEUE_NOTE) =>
    () =>
      assertReplayClean(fileOf({ note, lines: lines as ReplayQueue["lines"] }));
  it("accepts the shapes the export writes", () => {
    expect(() => assertReplayClean(fileOf(ok))).not.toThrow();
  });
  it("refuses a free-form text field, a path in an id and a made-up reason", () => {
    expect(bad([{ ...ok.lines[0], text: "x" }])).toThrow(/field the export does not write/);
    expect(bad([{ ...ok.lines[0], id: "a b/c" }])).toThrow(/not a plain id/);
    expect(bad([{ ...ok.lines[0], fixed: ['manual: "do the thing"'] }])).toThrow(/fixed wait/);
    expect(bad([{ ...ok.lines[0], hold: "waiting for Bob" }])).toThrow(/hold/);
    expect(bad([{ ...ok.lines[0], kind: "secret" }])).toThrow(/kind/);
  });
  it("refuses a wait on a line the queue does not list and another note", () => {
    expect(bad([{ ...ok.lines[0], after: ["GHOST"] }])).toThrow(/does not list/);
    expect(bad([{ ...ok.lines[0], against: ["overlap", "GHOST"] }])).toThrow(/does not list/);
    expect(bad(ok.lines as unknown[], "anything")).toThrow(/note/);
  });
});

describe("snapshotAt plays the queue: Waiting -> Next -> Running as the lines' sessions start and end", () => {
  const events: ReplayFile["events"] = [
    [0, "session_start", 0, { workflow: "slice-pipeline", task: "R", difficulty: "5" }],
    [10, "session_start", 1, { workflow: "slice-pipeline", task: "N", difficulty: "5" }],
    [50, "transition", 0, { from: "claim", to: "land", name: "a", workflow: "slice-pipeline" }],
    [60, "session_end", 0, { outcome: "completed" }],
    [70, "session_start", 2, { workflow: "slice-pipeline", task: "A", difficulty: "6" }],
    [90, "session_end", 2, { outcome: "completed" }],
    [100, "session_start", 3, { workflow: "slice-pipeline", task: "O", difficulty: "3" }],
    [120, "session_end", 3, { outcome: "completed" }],
    [130, "session_end", 1, { outcome: "completed" }],
  ];
  const queue: ReplayQueue = {
    note: REPLAY_QUEUE_NOTE,
    lines: [
      { id: "R", difficulty: "5", priority: "", kind: "feature" },
      { id: "N", difficulty: "5", priority: "", kind: "bug" },
      { id: "A", difficulty: "6", priority: "high", kind: "feature", after: ["R"] },
      { id: "O", difficulty: "3", priority: "", kind: "feature", against: ["overlap", "N"] },
      { id: "P", difficulty: "2", priority: "", kind: "research", hold: "parked" },
      { id: "Z", difficulty: "2", priority: "", kind: "feature", fixed: ["manual condition"] },
      { id: "Y", difficulty: "2", priority: "low", kind: "feature", after: ["R", "A"] },
      { id: "W", difficulty: "2", priority: "low", kind: "feature", against: ["overlap", "A"] },
    ],
  };
  const file: ReplayFile = {
    ...fileOf(queue, events),
    durationMs: 200,
    sessions: ["s0", "s1", "s2", "s3"],
    workflows: {
      "slice-pipeline": { stations: [{ name: "claim", script: false, terminal: false }] },
    },
    taskKinds: { R: "feature", N: "bug", A: "feature", O: "feature" },
  };
  const view = (at: number) => {
    const q = snapshotAt(file, at).queue;
    return {
      running: q?.running.map(l => l.id),
      ready: q?.ready.map(l => l.id),
      waiting: q?.waiting.map(w => `${w.id}: ${w.why}`),
      pending: q?.pending,
    };
  };

  it("before anything starts: the line the pick would admit is Next, the others Waiting with the pick's reason, a parked line only counts", () => {
    expect(view(0)).toEqual({
      running: ["R"],
      ready: ["N"],
      waiting: [
        "A: after: R (running)",
        "O: overlaps N",
        "Z: after: manual condition",
        "Y: after: R (running), A (pending)",
        "W: overlaps A",
      ],
      pending: 7,
    });
  });
  it("a line waiting for a landed line moves to Next when it lands, then to Running", () => {
    expect(view(65)).toMatchObject({ running: ["N"], ready: ["A"], pending: 6 });
    expect(snapshotAt(file, 65).queue?.waiting.map(w => w.id)).toEqual(["O", "Z", "Y", "W"]);
    expect(view(75)).toMatchObject({ running: ["N", "A"], ready: [] });
    expect(snapshotAt(file, 75).queue?.waiting.find(w => w.id === "Y")?.why).toBe(
      "after: A (running)",
    );
  });
  it("an overlap wait ends when the other line ends, whatever its outcome", () => {
    expect(snapshotAt(file, 95).queue?.waiting.find(w => w.id === "O")?.why).toBe("overlaps N");
    expect(view(131)).toMatchObject({ ready: ["Y", "W"], pending: 4 });
  });
  it("with nothing admittable, Next lists what the running lines unblock, in the pick's order", () => {
    const s = snapshotAt(file, 75).queue;
    expect(s?.ready).toEqual([]);
    expect(s?.unblocked.map(l => l.id)).toEqual(["O", "Y", "W"]);
    // a line that waits for one that has not started is not unblocked by the lines running
    expect(snapshotAt(file, 55).queue?.unblocked.map(l => l.id)).toEqual(["A", "O"]);
  });
  it("a line the queue does not list is Next from the start, in the order it starts, as before", () => {
    const bare: ReplayFile = { ...file, queue: { note: REPLAY_QUEUE_NOTE, lines: [] } };
    expect(snapshotAt(bare, 0).queue?.ready.map(l => l.id)).toEqual(["N", "A", "O"]);
    const none: ReplayFile = { ...file, queue: undefined };
    expect(snapshotAt(none, 0).queue?.waiting).toEqual([]);
    expect(snapshotAt(none, 0).queue?.ready.map(l => l.id)).toEqual(["N", "A", "O"]);
  });
  it("the pane's marks cover a line that never starts in the window", () => {
    expect(snapshotAt(file, 0).queue?.marks).toMatchObject({ P: "⚑", Z: "◆" });
  });
});

describe("buildReplay writes the queue of the chosen window's tasks", () => {
  const T0 = Date.parse("2026-11-13T06:00:00.000Z");
  const ev = (
    sec: number,
    kind: WfEvent["kind"],
    session: string,
    data: Record<string, unknown>,
  ): WfEvent => ({
    seq: sec,
    run: "r",
    ts: new Date(T0 + sec * 1000).toISOString(),
    kind,
    session,
    data,
  });
  const events = [
    ev(0, "session_start", "aaaa1111", {
      workflow: "slice-pipeline",
      task: "T1",
      project: "anyparse",
      queue: "/Users/x/anyparse/.claude/batch/queue.yaml",
    }),
    ev(5, "session_start", "aaaa1111-k", { workflow: "slice-recon", parent: "aaaa1111" }),
    ev(8, "session_end", "aaaa1111-k", { outcome: "completed" }),
    ev(30, "session_end", "aaaa1111", { outcome: "completed" }),
  ];
  it("calls the capture with the window's tasks and renders what it returns, once", () => {
    let seen: string[] = [];
    const file = buildReplay(events, {
      project: "anyparse",
      workflows: {},
      from: new Date(T0 - 1000).toISOString(),
      queue: tasks => {
        seen = [...tasks];
        return {
          note: REPLAY_QUEUE_NOTE,
          lines: [{ id: "T1", difficulty: "", priority: "", kind: "bug" }],
        };
      },
    });
    expect(seen).toEqual(["T1"]);
    expect(file.queue?.lines.map(l => l.id)).toEqual(["T1"]);
    expect(renderReplay(file)).toContain(`\n "queue": {`);
  });
  const later = [
    // before the window: not pending at its start
    ev(-3600, "session_start", "bbbb0000", {
      workflow: "slice-pipeline",
      task: "T0",
      project: "anyparse",
    }),
    ev(-3000, "session_end", "bbbb0000", { outcome: "completed" }),
    // after the window (4 h long): pending at its start, ran and landed later
    ev(6 * 3600, "session_start", "cccc2222", {
      workflow: "slice-pipeline",
      task: "T2",
      project: "anyparse",
    }),
    ev(6 * 3600 + 60, "session_end", "cccc2222", { outcome: "completed" }),
    ev(6 * 3600, "session_start", "dddd3333", {
      workflow: "engine-task",
      task: "ENG-Z",
      project: "mcp-workflow-engine",
    }),
    ev(7 * 3600, "session_start", "eeee4444", {
      workflow: "slice-pipeline",
      task: "GOLF-1",
      project: "golf",
    }),
  ];
  it("rolls back every kept root session that started at or after the window's start, not the window's tasks alone", () => {
    let seen: string[] = [];
    buildReplay([...events, ...later], {
      project: "anyparse",
      also: ["mcp-workflow-engine"],
      workflows: {},
      from: new Date(T0 - 1000).toISOString(),
      queue: ranSince => {
        seen = [...ranSince].sort();
        return undefined;
      },
    });
    expect(seen).toEqual(["ENG-Z", "T1", "T2"]);
  });
  it("a line that ran and landed after the window is pending again in the captured queue", () => {
    const q = parseQueue(
      queueText([
        line("T0", { status: "done", touches: "[ src/z ]" }),
        line("T1", { status: "done", touches: "[ src/a ]" }),
        line("T2", { status: "done", touches: "[ src/b ]", after: "[ T1 ]" }),
      ]),
      "/w/anyparse/.claude/batch/queue.yaml",
    );
    const file = buildReplay([...events, ...later], {
      project: "anyparse",
      workflows: {},
      from: new Date(T0 - 1000).toISOString(),
      queue: ranSince => captureReplayQueue(q, ranSince, ["anyparse"]),
    });
    expect(file.queue?.lines.map(l => l.id)).toEqual(["T1", "T2"]);
    expect(file.queue?.lines[1]).toMatchObject({ after: ["T1"] });
  });
  it("without a capture the file has no queue section", () => {
    const file = buildReplay(events, {
      project: "anyparse",
      workflows: {},
      from: new Date(T0 - 1000).toISOString(),
    });
    expect(file.queue).toBeUndefined();
    expect(renderReplay(file)).not.toContain(`\n "queue": {`);
  });
});

describe("the export script captures the queue through the engine's own pick", () => {
  const script = read("scripts/export-replay.mjs");
  it("reads the queue file and passes the allowlist of projects to captureReplayQueue", () => {
    expect(script).toContain('load("replay-queue.js")');
    expect(script).toContain("captureReplayQueue(queue, ranSince, [project, ...also])");
    expect(script).toContain('args.queue === "none"');
  });
  it("the check still runs on the finished file before anything is written", () => {
    expect(script.indexOf("assertReplayClean(file")).toBeLessThan(
      script.indexOf("fs.writeFileSync(out"),
    );
  });
});
