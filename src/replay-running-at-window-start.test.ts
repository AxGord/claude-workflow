import { describe, expect, it } from "vitest";
import type { EventKind, WfEvent } from "./event-fold.js";
import { parseQueue } from "./queue.js";
import { buildReplay, snapshotAt } from "./replay.js";
import { captureReplayQueue } from "./replay-queue.js";

const T0 = Date.parse("2026-11-13T06:00:00.000Z");
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
let seq = 0;
const ev = (
  min: number,
  kind: EventKind,
  session: string,
  data: Record<string, unknown>,
): WfEvent => ({
  seq: ++seq,
  run: "r",
  ts: at(min),
  kind,
  session,
  data,
});

const QFILE = "/w/anyparse/.claude/batch/queue.yaml";
const line = (id: string, status: string, extra: string): string =>
  `  - id: ${id}\n    status: ${status}\n    difficulty: 4\n    repo: /w/anyparse\n${extra}    text: |-\n      t\n`;

/** RUN is claimed at minute 0, before the window (minute 5), and lands at minute 30 inside it. */
const events: WfEvent[] = [
  ev(0, "session_start", "aaaa1111", {
    workflow: "slice-pipeline",
    parent: "dispatch0",
    task: "RUN",
    difficulty: 4,
    project: "anyparse",
    queue: QFILE,
  }),
  ev(1, "transition", "aaaa1111", {
    from: "x",
    to: "land",
    name: "go",
    workflow: "slice-pipeline",
  }),
  ev(6, "session_start", "bbbb2222", {
    workflow: "slice-pipeline",
    parent: "dispatch0",
    task: "OTHER",
    difficulty: 4,
    project: "anyparse",
    queue: QFILE,
  }),
  ev(30, "session_end", "aaaa1111", { outcome: "completed" }),
  ev(40, "session_end", "bbbb2222", { outcome: "completed" }),
];

describe("replay queue at the window start", () => {
  it("a line claimed before the window and landed in it is running at the window start: its dependent waits on it", () => {
    const queue = parseQueue(
      `batch_size: 2\noverlap: paths\ntasks:\n${[
        line("RUN", "done", "    touches: [ src/a ]\n"),
        line("OTHER", "done", "    touches: [ src/o ]\n"),
        line("DEP", "pending", "    after: [ RUN ]\n    touches: [ src/b ]\n"),
      ].join("")}`,
      QFILE,
    );
    const file = buildReplay(events, {
      project: "anyparse",
      workflows: {},
      from: at(5),
      hours: 2,
      queue: (ranSince, running) => captureReplayQueue(queue, ranSince, ["anyparse"], running),
    });
    const snap = snapshotAt(file, 0);
    // at the window start RUN is running, so DEP must be Waiting on it, not Next
    expect(snap.queue?.waiting.map(w => `${w.id}: ${w.why}`)).toEqual([
      "DEP: after: RUN (running)",
    ]);
    expect(snap.queue?.ready.map(l => l.id)).not.toContain("DEP");
  });
  it("the callback gets the tasks claimed before the window and not ended at it, apart from those that started in it", () => {
    let seen: { since: string[]; running: string[] } = { since: [], running: [] };
    buildReplay(events, {
      project: "anyparse",
      workflows: {},
      from: at(5),
      hours: 2,
      queue: (since, running) => {
        seen = { since: [...since].sort(), running: [...running].sort() };
        return undefined;
      },
    });
    expect(seen).toEqual({ since: ["OTHER"], running: ["RUN"] });
  });
});
