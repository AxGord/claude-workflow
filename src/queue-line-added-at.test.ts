import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventKind, WfEvent } from "./event-fold.js";
import { addQueueLine, editQueueLine, parseQueue, readQueue } from "./queue.js";
import { buildReplay, REPLAY_QUEUE_NOTE, snapshotAt } from "./replay.js";
import { captureReplayQueue } from "./replay-queue.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("a queue line records when it was added", () => {
  it("queue_add writes added: as an ISO time; setting it by hand is refused on add and edit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-queue-added-"));
    dirs.push(dir);
    const file = path.join(dir, "q.yaml");
    fs.writeFileSync(file, "batch_size: 2\ntasks: []\n");
    const before = Date.now();
    await addQueueLine(file, { id: "A", difficulty: 3, text: "t" });
    const added = readQueue(file).lines[0].meta.added;
    expect(added).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/);
    expect(Date.parse(added)).toBeGreaterThanOrEqual(before - 1000);
    await expect(
      addQueueLine(file, {
        id: "B",
        difficulty: 3,
        text: "t",
        added: "2026-01-01T00:00:00Z",
      }),
    ).rejects.toThrow(/added is written/);
    await expect(editQueueLine(file, "A", { added: "2026-01-01T00:00:00Z" })).rejects.toThrow(
      /added is written/,
    );
    await editQueueLine(file, "A", { priority: "high" });
    expect(readQueue(file).lines[0].meta.added).toBe(added);
  });
});

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

describe("the replay hides a line before its added time", () => {
  const events: WfEvent[] = [
    ev(0, "session_start", "aaaa1111", {
      workflow: "slice-pipeline",
      parent: "dispatch0",
      task: "RUN",
      difficulty: 4,
      project: "anyparse",
      queue: QFILE,
    }),
    ev(60, "session_end", "aaaa1111", { outcome: "completed" }),
  ];
  const queue = parseQueue(
    `batch_size: 2\noverlap: paths\ntasks:\n${[
      line("RUN", "done", "    touches: [ src/a ]\n"),
      line("LATE", "pending", `    added: ${at(30)}\n    touches: [ src/b ]\n`),
      line("OLD", "pending", "    touches: [ src/c ]\n"),
    ].join("")}`,
    QFILE,
  );
  const file = buildReplay(events, {
    project: "anyparse",
    workflows: {},
    from: at(0),
    hours: 2,
    queue: (ranSince, running) => captureReplayQueue(queue, ranSince, ["anyparse"], running),
  });
  const ids = (min: number): string[] => {
    const q = snapshotAt(file, min * 60_000).queue;
    return [...(q?.ready ?? []).map(l => l.id), ...(q?.waiting ?? []).map(w => w.id)].sort();
  };
  it("a line added at minute 30 is absent before it, present from it; a line with no added shows from the start", () => {
    expect(ids(10)).toContain("OLD");
    expect(ids(10)).not.toContain("LATE");
    expect(ids(40)).toContain("LATE");
    expect(file.queue?.lines.find(l => l.id === "LATE")?.added).toBe(at(30));
    expect(file.queue?.lines.find(l => l.id === "OLD")?.added).toBeUndefined();
  });
  it("the note no longer says a later line cannot be rebuilt", () => {
    expect(REPLAY_QUEUE_NOTE).not.toMatch(/cannot be rebuilt/);
    expect(REPLAY_QUEUE_NOTE).toMatch(/added/);
  });
});
