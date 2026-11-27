// Pins of ENG-SITE-USE-CASE-ANYPARSE, the scenes' own data (src/use-case-scenes.ts): the queue line's fields are the
// engine's task keys, the small queue's pick is the engine's pick, the lane of review rounds follows the facts of the
// workflow files, and every place a lesson can go has its row.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { parseQueue, planPick, TASK_KEYS } from "./queue.js";
import {
  ANCHORS,
  EXAMPLE_LINES,
  LESSON_PLACE_NAMES,
  LESSON_PLACES,
  LESSONS,
  LINE_FIELDS,
  maxFixes,
  READERS,
  roundsLane,
  TOY_QUEUE,
  TOY_WINDOWS,
  toyPick,
  toyStart,
  toyStep,
  type ToyLine,
  type ToyState,
} from "./use-case-scenes.js";
import type { StageTable } from "./use-case-path.js";

describe("a queue line's fields (LINE_FIELDS) and the difficulty ruler (ANCHORS)", () => {
  it("every field is a task key of the engine's queue, in the queue's own order, read by a known part", () => {
    const keys = LINE_FIELDS.map(f => f.key);
    for (const key of keys) expect(TASK_KEYS as readonly string[], key).toContain(key);
    const order = keys.map(k => (TASK_KEYS as readonly string[]).indexOf(k));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of LINE_FIELDS) {
      expect(f.readers.length, f.key).toBeGreaterThan(0);
      for (const r of f.readers) expect(READERS, `${f.key}: ${r}`).toContain(r);
    }
    // what the pick, the table and the recon read is on the card
    for (const key of ["difficulty", "priority", "after", "touches", "owner", "exclusive", "text"])
      expect(keys).toContain(key);
  });

  it("the anchors run from 2 to 10 with no gap, each with an example line", () => {
    expect(ANCHORS[0].from).toBe(2);
    expect(ANCHORS.at(-1)?.to).toBe(10);
    for (let i = 1; i < ANCHORS.length; i++) expect(ANCHORS[i].from).toBe(ANCHORS[i - 1].to + 1);
    for (const a of ANCHORS) expect(EXAMPLE_LINES[a.example], `anchor ${a.from}`).toBeDefined();
    // the top anchor's example is the whole-tree line that runs alone
    expect(EXAMPLE_LINES[ANCHORS.at(-1)?.example ?? 0].exclusive).toBe(true);
  });
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-toy-queue-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The engine's pick over the same lines: the queue file's text, read by the engine's own parser. */
function enginePick(
  lines: readonly ToyLine[],
  window: number,
  ignoreWindow: boolean,
  hold: boolean,
): { admitted: string[]; reasons: Record<string, string> } {
  const text = YAML.stringify({
    batch_size: window,
    overlap: "files",
    ...(hold ? {} : { exclusive_hold: "no" }),
    tasks: lines.map(l => ({
      id: l.id,
      status: l.status,
      difficulty: l.difficulty,
      priority: l.priority,
      ...(l.after ? { after: [...l.after] } : {}),
      touches: [...l.touches],
      ...(l.exclusive ? { exclusive: true } : {}),
      text: "an example line",
    })),
  });
  const pick = planPick(parseQueue(text, path.join(dir, "queue.yaml")), { ignoreWindow });
  return {
    admitted: pick.admitted.map(a => a.id),
    reasons: Object.fromEntries(pick.reasons.map(r => [r.id, r.why])),
  };
}

const keyOf = (s: ToyState): string =>
  `${s.hold ? "hold" : "free"}|${s.window}|${s.lines.map(l => l.status[0]).join("")}`;

describe("the pick over the small queue (toyPick) is the engine's pick (planPick)", () => {
  it("answers as the engine does in every state the scene can reach, with the exclusive hold on and off", () => {
    // every window to start from, then every land, promote and window change, until no new state appears
    const seen = new Map<string, ToyState>();
    const todo: ToyState[] = [true, false].flatMap(hold => TOY_WINDOWS.map(w => toyStart(w, hold)));
    let picks = 0;
    while (todo.length > 0) {
      const state = todo.pop() as ToyState;
      if (seen.has(keyOf(state))) continue;
      seen.set(keyOf(state), state);
      for (const ignoreWindow of [false, true]) {
        const toy = toyPick(state.lines, state.window, { hold: state.hold, ignoreWindow });
        const engine = enginePick(state.lines, state.window, ignoreWindow, state.hold);
        expect(toy.admitted, `${keyOf(state)} admitted`).toEqual(engine.admitted);
        expect(toy.reasons, `${keyOf(state)} reasons`).toEqual(engine.reasons);
        picks++;
      }
      for (const l of state.lines) {
        if (l.status === "running") todo.push(toyStep(state, { land: l.id }));
        if (l.status === "backlog") todo.push(toyStep(state, { promote: l.id }));
      }
      for (const w of TOY_WINDOWS) if (w !== state.window) todo.push(toyStep(state, { window: w }));
    }
    expect(seen.size).toBeGreaterThan(80);
    expect(picks).toBe(seen.size * 2);
    expect(new Set([...seen.values()].map(s => s.hold))).toEqual(new Set([true, false]));
    // and from the queue before any pick
    for (const hold of [true, false])
      for (const w of TOY_WINDOWS)
        expect(toyPick(TOY_QUEUE, w, { hold })).toEqual(enginePick(TOY_QUEUE, w, false, hold));
  }, 120_000);

  it("the scene opens on a window of three: the high line first, then file order, and each wait has its reason", () => {
    const s = toyStart(3, true);
    expect(s.admitted).toEqual(["WRITER-CHAIN-BREAK", "LINT-UNUSED-LOCAL", "CLI-HELP-FLAG"]);
    expect(s.reasons).toEqual({
      "LINT-UNUSED-LOCAL-FIX": "after: LINT-UNUSED-LOCAL (running)",
      "WRITER-CHAIN-TESTS":
        "overlaps WRITER-CHAIN-BREAK (touches src/format/Chain.hx ~ src/format/Chain.hx)",
      "FMT-SWEEP": "overlaps LINT-UNUSED-LOCAL (exclusive FMT-SWEEP)",
      "DOC-GUIDE-PAGE": "held for exclusive FMT-SWEEP",
    });
    expect(s.lines.find(l => l.id === "IDEA-PARSE-CACHE")?.status).toBe("backlog");
    // with the header's hold off the exclusive line holds nothing: the line behind it only waits for a slot
    const off = toyStart(3, false);
    expect(off.admitted).toEqual(s.admitted);
    expect(off.reasons).toEqual({ ...s.reasons, "DOC-GUIDE-PAGE": "window full" });
    expect(toyStart(5, false).admitted).toContain("DOC-GUIDE-PAGE");
    expect(toyStart(5, true).admitted).not.toContain("DOC-GUIDE-PAGE");
  });

  it("a land frees a slot and the pick runs again; a line that only the window keeps out says so", () => {
    const one = toyStart(1, true);
    expect(one.admitted).toEqual(["WRITER-CHAIN-BREAK"]);
    expect(one.reasons["LINT-UNUSED-LOCAL"]).toBe("window full");
    const next = toyStep(one, { land: "WRITER-CHAIN-BREAK" });
    expect(next.lines.find(l => l.id === "WRITER-CHAIN-BREAK")?.status).toBe("done");
    expect(next.admitted).toEqual(["LINT-UNUSED-LOCAL"]);
    expect(next.hold).toBe(true);
    // the exclusive line starts only in an empty repository, hold or no hold
    for (const hold of [true, false]) {
      let s = toyStart(5, hold);
      while (s.lines.some(l => l.status === "running" && l.id !== "FMT-SWEEP"))
        s = toyStep(s, {
          land: s.lines.find(l => l.status === "running" && l.id !== "FMT-SWEEP")?.id ?? "",
        });
      expect(s.lines.find(l => l.id === "FMT-SWEEP")?.status, `hold ${hold}`).toBe("running");
      // held, the low line is still waiting, now on the running exclusive line; not held, it ran long ago
      expect(s.reasons["DOC-GUIDE-PAGE"]).toBe(
        hold ? "overlaps FMT-SWEEP (exclusive FMT-SWEEP)" : undefined,
      );
      expect(s.lines.find(l => l.id === "DOC-GUIDE-PAGE")?.status).toBe(hold ? "pending" : "done");
    }
    // a promoted backlog line is a pending line like any other
    const promoted = toyStep(toyStart(5, true), { promote: "IDEA-PARSE-CACHE" });
    expect(promoted.lines.find(l => l.id === "IDEA-PARSE-CACHE")?.status).not.toBe("backlog");
  });
});

const TABLE: StageTable = {
  plan: [{ upto: 10, model: "sonnet", effort: "high" }],
  execute: [
    { upto: 6, model: "sonnet", effort: "high" },
    { upto: 10, model: "opus", effort: "high" },
  ],
  review: [{ upto: 10, model: "opus", effort: "high" }],
  review_verify: [{ upto: 10, model: "sonnet", effort: "medium" }],
  fix: [
    { upto: 6, model: "haiku", effort: "low" },
    { upto: 10, model: "opus", effort: "xhigh" },
  ],
};
const FACTS = {
  table: TABLE,
  driver: { model: "haiku", effort: "medium" },
  recon_from: 4,
  executor_scores: [7, 8],
  split_from: 9,
  fix_rounds: 3,
  gate_fix_rounds: 3,
  land_lock: "the-land",
};
const ids = (difficulty: number, fixes: number, gateFail = false): string[][] =>
  roundsLane(FACTS, { difficulty, fixes, gateFail }).rows.map(row => row.map(s => s.id));

describe("the lane of review rounds (roundsLane)", () => {
  it("MERGE at once: the worker's row, then the land under the pipeline's lock", () => {
    const lane = roundsLane(FACTS, { difficulty: 5, fixes: 0, gateFail: false });
    expect(ids(5, 0)).toEqual([["work", "commit", "gate", "review"], ["land"]]);
    expect(lane.reviews).toBe(1);
    expect(lane.outcome).toBe("landed");
    expect(lane.rows[0][3]).toMatchObject({ stage: "review", model: "opus", verdict: "MERGE" });
    expect(lane.rows[1][0].says).toContain("the-land");
  });

  it("every FIXES adds a fix round on the fix row and a re-check on the verify row", () => {
    const lane = roundsLane(FACTS, { difficulty: 5, fixes: 2, gateFail: false });
    expect(ids(5, 2)).toEqual([
      ["work", "commit", "gate", "review"],
      ["fix", "commit", "gate", "review"],
      ["fix", "commit", "gate", "review"],
      ["land"],
    ]);
    expect(lane.reviews).toBe(3);
    expect(lane.rows.slice(0, 3).map(row => row[3].verdict)).toEqual(["FIXES", "FIXES", "MERGE"]);
    expect(lane.rows[1][0]).toMatchObject({ stage: "fix", model: "haiku", effort: "low" });
    expect(lane.rows[1][3]).toMatchObject({ stage: "review_verify", model: "sonnet" });
    // the rows follow the difficulty: an executor's score takes the execute and the upper fix row
    const hard = roundsLane(FACTS, { difficulty: 7, fixes: 1, gateFail: false });
    expect(hard.rows[0][0]).toMatchObject({ stage: "execute", model: "opus" });
    expect(hard.rows[1][0]).toMatchObject({ stage: "fix", model: "opus", effort: "xhigh" });
    expect(
      roundsLane(FACTS, { difficulty: 5, fixes: 0, gateFail: false }).rows[0][0],
    ).toMatchObject({
      stage: "plan",
    });
  });

  it("a FIXES past the pipeline's fix rounds rejects the line, and the bound is the facts'", () => {
    expect(maxFixes(FACTS)).toBe(4);
    const lane = roundsLane(FACTS, { difficulty: 5, fixes: 4, gateFail: false });
    expect(lane.outcome).toBe("rejected");
    expect(lane.reviews).toBe(4);
    expect(lane.rows.at(-1)?.map(s => s.id)).toEqual(["reject"]);
    expect(lane.rows.slice(0, -1).every(row => row.at(-1)?.verdict === "FIXES")).toBe(true);
    const short = { ...FACTS, fix_rounds: 1 };
    expect(maxFixes(short)).toBe(2);
    expect(roundsLane(short, { difficulty: 5, fixes: 2, gateFail: false }).outcome).toBe(
      "rejected",
    );
    expect(roundsLane(short, { difficulty: 5, fixes: 1, gateFail: false }).outcome).toBe("landed");
  });

  it("a red gate is the worker's own loop: one more fix and gate, no review round", () => {
    expect(ids(5, 0, true)[0]).toEqual([
      "work",
      "commit",
      "gate",
      "gate-fix",
      "commit",
      "gate",
      "review",
    ]);
    // the gate judges a commit: one stands before every gate of every row
    for (const row of roundsLane(FACTS, { difficulty: 5, fixes: 2, gateFail: true }).rows)
      row.forEach((step, i) => {
        if (step.id === "gate") expect(row[i - 1]?.id).toBe("commit");
      });
    const lane = roundsLane(FACTS, { difficulty: 5, fixes: 0, gateFail: true });
    expect(lane.reviews).toBe(1);
    expect(lane.rows[0][3].says).toContain("up to 3 times");
  });
});

describe("where a lesson goes (LESSONS)", () => {
  it("has a row for every place the rule can send one to, each with its rule", () => {
    expect(new Set(LESSONS.map(l => l.to))).toEqual(new Set(LESSON_PLACES));
    for (const l of LESSONS) {
      expect(l.says.length).toBeGreaterThan(10);
      expect(l.rule.length).toBeGreaterThan(10);
    }
    expect(LESSONS.find(l => l.to === "backlog")?.rule).toContain("never picked until promoted");
  });

  it("sends no lesson a tool can hold to memory: the gate lesson is a queue line against the tool", () => {
    expect(LESSON_PLACES as readonly string[]).not.toContain("note");
    for (const name of Object.values(LESSON_PLACE_NAMES)) expect(name).not.toMatch(/memory/i);
    for (const l of LESSONS) expect(l.rule).not.toMatch(/memory/i);
    const gate = LESSONS.find(l => l.says.includes("the gate must lint the whole scope"));
    expect(gate?.to).toBe("tool");
    expect(gate?.rule).toContain("queue line against the tool's owner");
  });
});
