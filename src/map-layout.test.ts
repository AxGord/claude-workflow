import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fold, seedEvents, type EventKind, type SeedSession, type WfEvent } from "./event-fold.js";
import {
  queueGraph,
  G,
  layout,
  placeSteps,
  scene,
  type MapLane,
  type MapLayout,
  type MapWorkflow,
  type SceneEl,
  type SceneGroup,
  difficultyBar,
  kindMark,
} from "./map-layout.js";

// --- a fixture event log: a dispatcher, a landed lane with a review loop, a stop and a land; an older
// landed lane; a running lane with a live branch; a running lane that asked its parent twice ---

const DAY = "2026-11-08T";
const at = (hhmm: string): string => `${DAY}${hhmm}:00.000Z`;
const NOW = Date.parse(at("11:30"));

let seq = 0;
const log: WfEvent[] = [];
function ev(kind: EventKind, session: string, hhmm: string, data: Record<string, unknown> = {}) {
  log.push({ seq: ++seq, run: "r1", ts: at(hhmm), kind, session, data });
}
function start(id: string, workflow: string, hhmm: string, parent: string | null, extra = {}) {
  ev("session_start", id, hhmm, { workflow, parent, task: null, difficulty: null, ...extra });
}
function move(id: string, workflow: string, hhmm: string, from: string, to: string, name = "next") {
  ev("transition", id, hhmm, { from, to, name, workflow });
}
function agent(id: string, hhmm: string, model: string, effort: string, agentId = `ag-${id}`) {
  ev("agent_link", id, hhmm, { agent: agentId, role: "", model, effort, step: null });
}
/** A child session walking its states one minute apart, then ending. */
function child(
  id: string,
  workflow: string,
  parent: string,
  hhmm: string,
  states: string[],
  end: string | null,
) {
  start(id, workflow, hhmm, parent);
  agent(id, hhmm, workflow.endsWith("review") ? "opus" : "sonnet", "high");
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  for (let k = 1; k < states.length; k++) {
    const t = h * 60 + m + k;
    const hm = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
    move(id, workflow, hm, states[k - 1], states[k]);
  }
  if (end) ev("session_end", id, end, { outcome: "completed" });
}

const P = "pipe";
start("D", "dispatch", "09:00", null);
// A: the whole story
start("A", P, "10:00", "D", { task: "LOOP-1", difficulty: 6 });
agent("A", "10:00", "haiku", "low");
move("A", P, "10:01", "queue", "recon");
child("A-r", "pipe-recon", "A", "10:01", ["brief", "owner", "score", "finish"], "10:04");
move("A", P, "10:05", "recon", "work");
child(
  "A-w1",
  "pipe-worker",
  "A",
  "10:05",
  ["orient", "edit", "check", "commit", "finish"],
  "10:20",
);
move("A", P, "10:21", "work", "gate");
ev("exec_end", "A", "10:31", { state: "gate", exit_code: 0, duration_ms: 600_000 });
move("A", P, "10:31", "gate", "review");
child("A-v1", "pipe-review", "A", "10:31", ["read", "probe", "verdict", "finish"], "10:40");
move("A", P, "10:41", "review", "work", "fixes");
start("A-w2", "pipe-worker", "10:41", "A");
agent("A-w2", "10:41", "sonnet", "high");
move("A-w2", "pipe-worker", "10:42", "orient", "edit");
ev("agent_respawn", "A-w2", "10:45", {
  agent: "ag-A-w2-2",
  role: "",
  model: "sonnet",
  effort: "high",
});
move("A-w2", "pipe-worker", "10:50", "edit", "commit");
move("A-w2", "pipe-worker", "10:50", "commit", "finish");
ev("session_end", "A-w2", "10:50", { outcome: "completed" });
move("A", P, "10:51", "work", "gate");
ev("exec_end", "A", "10:55", { state: "gate", exit_code: 0, duration_ms: 240_000 });
move("A", P, "10:55", "gate", "review");
child("A-v2", "pipe-review", "A", "10:55", ["read", "verdict", "finish"], "11:00");
move("A", P, "11:01", "review", "land");
ev("exec_end", "A", "11:02", { state: "land", exit_code: 0, duration_ms: 60_000 });
move("A", P, "11:02", "land", "done");
ev("session_end", "A", "11:02", { outcome: "completed" });
// B: landed long ago — folds into `landed earlier:`
start("B", P, "08:00", "D", { task: "OLD-1", difficulty: 2 });
move("B", P, "08:10", "queue", "done");
ev("session_end", "B", "08:30", { outcome: "completed" });
// C: running, its recon branch live at `owner`
start("C", P, "11:10", "D", { task: "LIVE-1", difficulty: 3 });
agent("C", "11:10", "haiku", "low");
move("C", P, "11:11", "queue", "recon");
child("C-r", "pipe-recon", "C", "11:11", ["brief", "owner"], null);
// E: running, asked its parent (answered after 5 min), asks again
start("E", P, "11:15", "D", { task: "ASKS-1", difficulty: 9 });
move("E", P, "11:16", "queue", "recon");
move("E", P, "11:17", "recon", "work");
move("E", P, "11:20", "work", "question", "stuck");
ev("ask", "E", "11:20", { state: "question" });
move("E", P, "11:25", "question", "work", "answered");
ev("answer", "E", "11:25", { state: "question" });
move("E", P, "11:28", "work", "question", "stuck");
ev("ask", "E", "11:28", { state: "question" });
// the dispatcher passed a question to the user
move("D", "dispatch", "11:00", "dispatch", "ask_user");
ev("ask", "D", "11:00", { state: "ask_user" });

const st = (name: string, script = false, terminal = false) => ({ name, script, terminal });
const WORKFLOWS: Record<string, MapWorkflow> = {
  pipe: {
    stations: [
      st("queue"),
      st("recon"),
      st("work"),
      st("gate", true),
      st("review"),
      st("land", true),
      st("done", false, true),
    ],
    driver: { model: "haiku", effort: "low" },
  },
  "pipe-recon": { stations: [st("brief"), st("owner"), st("score"), st("finish", false, true)] },
  "pipe-worker": {
    stations: [st("orient"), st("edit"), st("check"), st("commit"), st("finish", false, true)],
  },
  "pipe-review": {
    stations: [st("read"), st("probe"), st("verdict"), st("finish", false, true)],
  },
};

// the fixture's columns are as wide as its content needs (`columnNeed`), not `G.col`
const X = (i: number): number => G.left + i * colOf(M);
const COL = { queue: 0, recon: 1, work: 2, gate: 3, review: 4, land: 5, done: 6 } as const;
const x = (s: keyof typeof COL): number => X(COL[s]);

function map(events: readonly WfEvent[] = log, extra = {}): MapLayout {
  return layout(fold(events), WORKFLOWS, {
    now: NOW,
    clock: () => "hh:mm",
    next: [
      { id: "N-1", difficulty: 4 },
      ...Array.from({ length: 7 }, (_, i) => ({ id: `N-${i + 2}` })),
    ],
    ...extra,
  });
}

const M = map();
function colOf(m: MapLayout): number {
  const xs = m.bands[0].stations.map(s => s.x);
  return xs[1] - xs[0];
}
const band = M.bands[0];
const lane = (id: string): MapLane => band.lanes.find(l => l.session === id)!;

describe("layout of the fixture event log", () => {
  it("one band per workflow kind; a dispatcher draws as the rail, not a lane", () => {
    expect(M.bands.map(b => b.workflow)).toEqual(["pipe"]);
    expect(band.stations.map(s => [s.name, s.x])).toEqual(
      Object.entries(COL).map(([name, i]) => [name, X(i)]),
    );
    expect(band.plaqueX).toBe(x("done") + G.plaqueGap);
    expect(band.lanes.map(l => l.session)).toEqual(["A", "C", "E"]);
    expect(band.rail?.session).toBe("D");
  });

  it("landed on top, the parent rail, running below (oldest first), next at the bottom", () => {
    const [a, c, e] = [lane("A"), lane("C"), lane("E")];
    expect(band.landedY).not.toBeNull();
    expect(band.landedY!).toBeLessThan(band.earlier!.y);
    expect(band.earlier!.y).toBeLessThan(a.y);
    expect(a.y + a.height).toBeLessThan(band.runningY!);
    expect(band.runningY!).toBeLessThan(band.rail!.y);
    expect(band.rail!.y).toBeLessThan(c.y);
    expect(c.y + c.height).toBeLessThan(e.y);
    expect(M.next[0].y).toBeGreaterThanOrEqual(band.y + band.height);
    expect([a.status, c.status, e.status]).toEqual(["landed", "running", "running"]);
  });

  it("a lane landed over an hour ago folds into `landed earlier:`; the next row shows six +N", () => {
    expect(band.earlier).toMatchObject({
      lead: "landed earlier:",
      items: [{ id: "OLD-1" }],
      more: 0,
    });
    expect(band.lanes.some(l => l.session === "B")).toBe(false);
    expect(M.next[0].items.map(i => i.id)).toEqual(["N-1", "N-2", "N-3", "N-4", "N-5", "N-6"]);
    expect(M.next[0].more).toBe(2);
    expect(M.next[0].items[0].c).toBe("--diff-4");
  });

  it("a review verdict loops the line back: a second pass from work, below the first", () => {
    const a = lane("A");
    expect(a.passes.map(p => p.stops.map(s => s.station))).toEqual([
      ["queue", "recon", "work", "gate", "review"],
      ["work", "gate", "review", "land", "done"],
    ]);
    expect(a.passes[1].y).toBeGreaterThan(a.passes[0].y);
    expect(a.passes[0].segments.map(s => [s.x1, s.x2])).toEqual([
      [x("queue"), x("recon")],
      [x("recon"), x("work")],
      [x("work"), x("gate")],
      [x("gate"), x("review")],
    ]);
    const reviewer = a.branches.find(b => b.session === "A-v1")!;
    expect(a.loops).toEqual([
      {
        key: "A:loop0",
        x1: reviewer.x2,
        y1: reviewer.stepY,
        yBack: expect.any(Number) as number,
        x2: x("work"),
        y2: a.passes[1].y,
        label: "↺ fixes",
      },
    ]);
    expect(a.loops[0].yBack).toBeGreaterThan(reviewer.stepY);
    expect(a.loops[0].yBack).toBeLessThan(a.passes[1].y);
  });

  it("whoever ran a station hangs under it, in the pass it ran in, with model + effort", () => {
    const a = lane("A");
    expect(a.branches.map(b => [b.session, b.station, b.pass, b.x1, b.x2])).toEqual([
      ["A-r", "recon", 0, x("recon"), x("work") - G.branchInset],
      ["A-w1", "work", 0, x("work"), x("gate") - G.branchInset],
      ["A-v1", "review", 0, x("review"), x("land") - G.branchInset],
      ["A-w2", "work", 1, x("work"), x("gate") - G.branchInset],
      ["A-v2", "review", 1, x("review"), x("land") - G.branchInset],
    ]);
    expect(a.branches.map(b => b.chip.text)).toEqual([
      "sonnet ▮▮▮▯ high · recon",
      "sonnet ▮▮▮▯ high · worker",
      "opus ▮▮▮▯ high · review",
      "sonnet ▮▮▮▯ high · worker",
      "opus ▮▮▮▯ high · review",
    ]);
    expect(a.branches.map(b => b.c)).toEqual([
      "--model-sonnet",
      "--model-sonnet",
      "--model-opus",
      "--model-sonnet",
      "--model-opus",
    ]);
    const recon = a.branches[0];
    expect(recon.stepY).toBe(recon.y + G.branchDrop);
    expect(recon.steps.map(s => [s.name, s.kind])).toEqual([
      ["brief", "done"],
      ["owner", "done"],
      ["score", "done"],
    ]);
    // steps spread between the station and the next one's inset
    expect(recon.steps[0].x).toBe(recon.x1 + G.stepPad);
    expect(recon.steps[2].x).toBe(recon.x2 - G.stepPad);
    expect(a.branches.every(b => b.joined)).toBe(true);
  });

  it("a respawned agent is a red stop on its branch, and the branch goes on", () => {
    const w2 = lane("A").branches.find(b => b.session === "A-w2")!;
    expect(w2.steps.map(s => [s.name, s.kind])).toEqual([
      ["orient", "done"],
      ["edit", "done"],
      ["respawn", "stop"],
      ["commit", "done"],
    ]);
    expect(w2.steps[2].detail).toBe("hh:mm");
  });

  it("an exec station carries its verdict; a landed line ends in its plaque", () => {
    const a = lane("A");
    const gate = a.passes[0].stops.find(s => s.station === "gate")!;
    expect(gate).toMatchObject({ script: true, kind: "done", label: "gate ✓ 10m" });
    expect(a.passes[1].stops.find(s => s.station === "gate")!.label).toBe("gate ✓ 4m");
    expect(a.end).toEqual({ x1: x("done"), x2: band.plaqueX, y: a.passes[1].y, faint: false });
    expect(a.ahead).toEqual([]);
    expect(a.plaque).toMatchObject({
      x: band.plaqueX,
      y: a.passes[1].y,
      title: "LOOP-1",
      sub: "✓ hh:mm",
      cls: "st-done",
    });
    expect(a.c).toBe("--diff-6");
    expect(a.start).toEqual({ x: x("queue"), y: a.passes[0].y });
    expect(a.driver).toBeNull();
  });

  it("a running lane: a live station, a faint tail over the stations ahead, the driver chip", () => {
    const c = lane("C");
    expect(c.passes).toHaveLength(1);
    expect(c.passes[0].stops.map(s => [s.station, s.kind])).toEqual([
      ["queue", "done"],
      ["recon", "live"],
    ]);
    expect(c.end).toEqual({ x1: x("recon"), x2: band.plaqueX, y: c.passes[0].y, faint: true });
    expect(c.ahead.map(a => [a.x, a.script])).toEqual([
      [x("work"), false],
      [x("gate"), true],
      [x("review"), false],
      [x("land"), true],
      [x("done"), false],
    ]);
    const recon = c.branches[0];
    expect(recon.joined).toBe(false);
    expect(recon.steps.map(s => [s.name, s.kind, s.detail])).toEqual([
      ["brief", "done", undefined],
      ["owner", "live", "18m"],
      ["score", "ahead", undefined],
    ]);
    expect(c.plaque).toMatchObject({ title: "LIVE-1", sub: "recon 19m", cls: "", c: "--diff-3" });
    expect(c.driver).toMatchObject({
      x: band.plaqueX,
      text: "driver · haiku ▮▯▯▯ low · waits on the recon",
      c: "--model-haiku",
    });
  });

  it("a question is a round trip to the parent rail; an open one turns the plaque yellow", () => {
    const e = lane("E");
    expect(e.plaque.cls).toBe("st-wait");
    expect(e.plaque.sub).toBe("question 2m · asks the parent");
    const asks = band.rail!.asks;
    expect(asks.map(a => [a.key, a.x, a.label, a.answer])).toEqual([
      ["E:ask0", x("work"), "? question", "→ work · 5m"],
      ["E:ask1", x("work"), "? question", null],
    ]);
    for (const a of asks) {
      expect(a.y1).toBe(band.rail!.y);
      expect(a.y2).toBe(e.y + e.passes[0].y);
    }
    expect(band.rail!.user?.label).toBe("⏸ ask_user · asked the user · open 30m");
    expect(band.rail!.label).toBe("parent agent · dispatch · D");
  });

  it("highlight marks one lane; the pool turns a plaque pink", () => {
    const m = map(log, { highlight: "C", pool: ["C"] });
    const c = m.bands[0].lanes.find(l => l.session === "C")!;
    expect(c.highlight).toBe(true);
    expect(c.plaque.cls).toBe("st-pool");
    expect(c.driver!.text).toContain("waits on the pool");
    expect(m.bands[0].lanes.filter(l => l.highlight)).toHaveLength(1);
  });

  it("with many running lanes the landed ones drop their step labels first", () => {
    expect(lane("A").labels).toBe(true);
    const more = [...log];
    for (const id of ["R1", "R2"]) {
      more.push({
        seq: ++seq,
        run: "r1",
        ts: at("11:20"),
        kind: "session_start",
        session: id,
        data: { workflow: P, parent: "D" },
      });
    }
    const m = map(more);
    expect(m.bands[0].lanes.find(l => l.session === "A")!.labels).toBe(false);
    expect(m.bands[0].lanes.find(l => l.session === "C")!.labels).toBe(true);
  });

  it("columns shrink to the room, never below the minimum", () => {
    const narrow = map(log, { width: 900 });
    const xs = narrow.bands[0].stations.map(s => s.x);
    expect(xs[1] - xs[0]).toBe(G.minCol);
    const wide = map(log, { width: 1500 });
    const ws = wide.bands[0].stations.map(s => s.x);
    expect(ws[1] - ws[0]).toBe(Math.floor((1500 - G.left - G.plaqueGap - G.plaqueMax) / 6));
  });

  it("a column is as wide as its content needs: narrower than the old fixed width, wide enough for every chip", () => {
    const col = colOf(M);
    expect(col).toBeLessThan(G.col);
    expect(col).toBeGreaterThanOrEqual(G.minCol);
    expect(M.width).toBeLessThan(G.left + 6 * G.col + 80 + G.plaqueMax + 20);
    expect(M.width).toBe(band.plaqueX + G.plaqueMax + 20);
    // a branch chip is never cut, nor a station label
    for (const l of band.lanes) for (const b of l.branches) expect(b.chip.title).toBeUndefined();
    for (const st of band.stations) expect(st.title).toBeUndefined();
  });

  it("a long station name widens every column of its band, up to the cap", () => {
    const flows = {
      ...WORKFLOWS,
      pipe: {
        ...WORKFLOWS.pipe,
        stations: WORKFLOWS.pipe.stations!.map((st, i) =>
          i === 1 ? { ...st, name: "a_station_with_a_very_long_name_indeed" } : st,
        ),
      },
    };
    const m = layout(fold([...log]), flows, { now: NOW });
    expect(colOf(m)).toBe(G.col);
  });

  it("a plaque never passes 340 px: a long id is cut with an ellipsis", () => {
    const long = [...log];
    long.push({
      seq: ++seq,
      run: "r1",
      ts: at("11:29"),
      kind: "session_start",
      session: "L",
      data: { workflow: P, parent: "D", task: "X".repeat(80) },
    });
    const p = map(long).bands[0].lanes.find(l => l.session === "L")!.plaque;
    expect(p.width).toBeLessThanOrEqual(G.plaqueMax);
    expect(p.title.endsWith("…")).toBe(true);
  });
});

describe("seeding from session files", () => {
  const session = (over: Partial<SeedSession>): SeedSession => ({
    session_id: "S",
    stack: [{ workflow: P, current_state: "work" }],
    started_at: at("10:00"),
    updated_at: at("10:05"),
    history: [
      { frame: 0, at: at("10:00"), event: "start", workflow: P },
      { frame: 0, at: at("10:01"), from: "queue", to: "recon", via: "go" },
      { frame: 0, at: at("10:05"), from: "recon", to: "work", via: "go" },
    ],
    context: { slice: "SEEDED-1", difficulty: 5 },
    ...over,
  });

  it("a session from before a restart is a lane with its whole recorded story", () => {
    const f = fold(seedEvents([session({ parent_session_id: undefined })]));
    const s = f.get("S")!;
    expect(s).toMatchObject({ workflow: P, task: "SEEDED-1", difficulty: 5, state: "work" });
    expect(s.transitions.map(t => t.to)).toEqual(["recon", "work"]);
    const m = layout(f, WORKFLOWS, { now: NOW });
    expect(m.bands[0].lanes[0].passes[0].stops.map(st => st.station)).toEqual([
      "queue",
      "recon",
      "work",
    ]);
  });

  it("a move both seeded and logged counts once; the logged ones after it are applied", () => {
    const logged: WfEvent[] = [
      {
        seq: 1,
        run: "r",
        ts: at("10:05"),
        kind: "transition",
        session: "S",
        data: { from: "recon", to: "work", name: "go", workflow: P },
      },
      {
        seq: 2,
        run: "r",
        ts: at("10:09"),
        kind: "transition",
        session: "S",
        data: { from: "work", to: "gate", name: "go", workflow: P },
      },
      {
        seq: 3,
        run: "r",
        ts: at("10:09"),
        kind: "session_start",
        session: "S",
        data: { workflow: P, task: null, difficulty: 7 },
      },
    ];
    const s = fold([...seedEvents([session({})]), ...logged]).get("S")!;
    expect(s.transitions.map(t => t.to)).toEqual(["recon", "work", "gate"]);
    expect(s.state).toBe("gate");
    expect(s.task).toBe("SEEDED-1");
    expect(s.difficulty).toBe(5);
  });

  it("an ended session seeds its end, its exec verdicts and its agent", () => {
    const f = fold(
      seedEvents([
        session({
          stack: [],
          outcome: "completed",
          agent_id: "ag",
          history: [
            { frame: 0, at: at("10:00"), event: "start", workflow: P },
            {
              frame: 0,
              at: at("10:03"),
              event: "action",
              from: "gate",
              to: "review",
              exit_code: 0,
              duration_ms: 1000,
            },
          ],
        }),
      ]),
    );
    const s = f.get("S")!;
    expect(s).toMatchObject({ workflow: P, outcome: "completed", ended: at("10:05") });
    expect(s.execs).toMatchObject([{ state: "gate", exit_code: 0, duration_ms: 1000 }]);
    expect(s.agents.map(a => a.agent)).toEqual(["ag"]);
  });

  const logged = (
    n: number,
    hhmm: string,
    kind: EventKind,
    session: string,
    data = {},
  ): WfEvent => ({
    seq: n,
    run: "r",
    ts: at(hhmm),
    kind,
    session,
    data,
  });

  it("an answer names the state it moved to, not the session's state now", () => {
    const asked = session({
      stack: [{ workflow: P, current_state: "gate" }],
      history: [
        { frame: 0, at: at("10:00"), event: "start", workflow: P },
        { frame: 0, at: at("10:05"), from: "recon", to: "work", via: "go" },
        { frame: 0, at: at("10:06"), from: "work", to: "question", via: "stuck" },
        { frame: 0, at: at("10:08"), from: "question", to: "work", via: "answered" },
        { frame: 0, at: at("10:10"), from: "work", to: "gate", via: "go" },
      ],
    });
    // the answer event carries `to`; an older log's answer (no `to`) reads the move out of the asking state
    for (const answer of [{ state: "question", to: "work" }, { state: "question" }]) {
      const s = fold([
        ...seedEvents([asked]),
        logged(1, "10:06", "ask", "S", { state: "question" }),
        logged(2, "10:08", "answer", "S", answer),
      ]).get("S")!;
      expect(s.state).toBe("gate");
      expect(s.asks).toEqual([
        { state: "question", at: at("10:06"), answered: at("10:08"), to: "work" },
      ]);
    }
  });

  it("a respawn logged after the seed replaces the old agent: a red step, the new agent's chip", () => {
    const seeds = seedEvents([
      session({
        session_id: "D",
        stack: [{ workflow: "dispatch", current_state: "x" }],
        history: [],
        context: {},
      }),
      session({ session_id: "L", parent_session_id: "D" }),
      session({
        session_id: "K",
        parent_session_id: "L",
        stack: [{ workflow: "pipe-worker", current_state: "commit" }],
        started_at: at("10:05"),
        agent_id: "NEW",
        context: {},
        history: [
          { frame: 0, at: at("10:05"), event: "start", workflow: "pipe-worker" },
          { frame: 0, at: at("10:06"), from: "orient", to: "edit", via: "go" },
          { frame: 0, at: at("10:09"), from: "edit", to: "commit", via: "go" },
        ],
      }),
    ]);
    const f = fold([
      ...seeds,
      logged(1, "10:05", "agent_link", "K", { agent: "OLD", model: "sonnet", effort: "high" }),
      logged(2, "10:07", "agent_respawn", "K", {
        agent: "NEW",
        model: "opus",
        effort: "high",
        previous: "OLD",
      }),
    ]);
    const k = f.get("K")!;
    expect(k.agents.map(a => [a.agent, a.status, a.model])).toEqual([
      ["OLD", "respawned", "sonnet"],
      ["NEW", "running", "opus"],
    ]);
    expect(k.agents[0].endedAt?.ts).toBe(at("10:07"));
    const branch = layout(f, WORKFLOWS, { now: NOW, clock: () => "hh:mm" })
      .bands[0].lanes.find(l => l.session === "L")!
      .branches.find(b => b.session === "K")!;
    expect(branch.steps.filter(st => st.kind !== "ahead").map(st => [st.name, st.kind])).toEqual([
      ["orient", "done"],
      ["edit", "done"],
      ["respawn", "stop"],
      ["commit", "live"],
    ]);
    expect(branch.chip.text).toBe("opus ▮▮▮▯ high · worker");
    expect(branch.c).toBe("--model-opus");
  });
});

describe("the scene", () => {
  const groups = (g: SceneGroup): SceneGroup[] => [g, ...g.groups.flatMap(groups)];
  const all = groups(scene(M));
  const els = all.flatMap(g => g.els);

  it("is keyed: every key unique, one group per band and lane", () => {
    const keys = [...all.map(g => g.key), ...els.map(e => e.key)];
    expect(new Set(keys).size).toBe(keys.length);
    expect(all.map(g => g.key)).toEqual(["map", "band:pipe", "lane:A", "lane:C", "lane:E"]);
    expect(all.find(g => g.key === "lane:C")!.y).toBe(lane("C").y);
  });

  it("two lanes of one task id (a failed run, then its retry) keep their keys apart", () => {
    const more = [...log];
    for (const [id, outcome] of [
      ["R-fail", "failed"],
      ["R-retry", "completed"],
    ] as const) {
      more.push(
        {
          seq: ++seq,
          run: "r1",
          ts: at("08:00"),
          kind: "session_start",
          session: id,
          data: { workflow: P, parent: "D", task: "DUP-1" },
        },
        {
          seq: ++seq,
          run: "r1",
          ts: at("08:20"),
          kind: "session_end",
          session: id,
          data: { outcome },
        },
      );
    }
    const m = map(more);
    expect(m.bands[0].earlier!.items.filter(i => i.id === "DUP-1")).toHaveLength(2);
    const keyed = groups(scene(m));
    const keys = [...keyed.map(g => g.key), ...keyed.flatMap(g => g.els).map(e => e.key)];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("colours only through tokens; a new segment of the main line draws itself", () => {
    for (const e of els) if (e.c !== undefined) expect(e.c).toMatch(/^--[\w-]+$/);
    const seg = els.find(e => e.key === "A:p0:s0")!;
    expect(seg).toMatchObject({ tag: "path", cls: "m-main", c: "--diff-6", draw: true });
    expect(seg.attrs.d).toBe(`M${x("queue")},${lane("A").passes[0].y}H${x("recon")}`);
    expect(els.find(e => e.key === "C:end")!.cls).toBe("m-tail");
    expect(els.find(e => e.key === "A:loop0")!.cls).toBe("m-loop");
  });

  it("every class is a component of components.css, every colour a token of tokens.css", () => {
    const dash = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dashboard");
    const css = fs.readFileSync(path.join(dash, "components.css"), "utf8");
    const tokens = fs.readFileSync(path.join(dash, "tokens.css"), "utf8");
    const defined = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map(m => m[1]));
    const classes = new Set(
      [...all.map(g => g.cls), ...els.map(e => e.cls)].flatMap(c => c.split(/\s+/)),
    );
    expect([...classes].filter(c => c && !defined.has(c))).toEqual([]);
    const colours = new Set(els.flatMap(e => (e.c ? [e.c] : [])));
    expect([...colours].filter(c => !tokens.includes(`${c}:`))).toEqual([]);
  });
});

// --- no two text rectangles of a band intersect ---

interface Box {
  readonly key: string;
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/** Font size in px by class: what components.css gives the text a class names. */
const FONT: Readonly<Record<string, number>> = {
  "m-title": 14,
  "m-station": 12,
  "m-section": 10,
  "m-label": 10,
  "m-detail": 10,
  "m-ask-label": 10,
  "m-answer-label": 10,
  "m-rail-label": 10,
  "m-lead": 11,
};

/** The width of a text at `px`, from the layout's own glyph widths (G.chipW at 10 px, G.charW at 12 px). */
function widthAt(text: string, px: number): number {
  const w = px <= 10 ? G.chipW : px >= 12 ? (G.charW * px) / 12 : (G.charW + G.chipW) / 2;
  return Math.ceil([...text].length * w);
}

/**
 * The rectangles a band draws, in band coordinates: each free text by its anchor, font and baseline;
 * a chip, a plaque or a strip item as its rounded box (the text inside it is the box's own).
 */
function boxesOf(group: SceneGroup, dy = 0, out: Box[] = []): Box[] {
  const y = dy + group.y;
  for (const e of group.els) {
    const a = e.attrs;
    if (e.tag === "rect" && /(^| )m-(chip|plaque)( |$)/.test(e.cls)) {
      const x0 = Number(a.x);
      const y0 = y + Number(a.y);
      out.push({ key: e.key, x0, x1: x0 + Number(a.width), y0, y1: y0 + Number(a.height) });
    } else if (e.tag === "text") {
      const font = e.cls.split(/\s+/).find(c => FONT[c] !== undefined);
      if (font === undefined) continue;
      const px = FONT[font];
      const w = widthAt(e.text ?? "", px);
      const x = Number(a.x);
      const x0 = / m-mid( |$)/.test(e.cls) ? x - w / 2 : / m-end( |$)/.test(e.cls) ? x - w : x;
      const base = y + Number(a.y);
      out.push({ key: e.key, x0, x1: x0 + w, y0: base - 0.8 * px, y1: base + 0.2 * px });
    }
  }
  for (const g of group.groups) boxesOf(g, y, out);
  return out;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 - 0.5 && b.x0 < a.x1 - 0.5 && a.y0 < b.y1 - 0.5 && b.y0 < a.y1 - 0.5;
}

/** Every pair of boxes of one band that intersect, by key. */
function collisions(m: MapLayout): string[] {
  const root = scene(m);
  const found: string[] = [];
  for (const g of root.groups) {
    const boxes = boxesOf(g);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++)
        if (overlaps(boxes[i], boxes[j])) found.push(`${g.key}: ${boxes[i].key} x ${boxes[j].key}`);
  }
  return found;
}

/** A log built by `build` with the shared helpers, leaving `log` as it was. */
function scenario(build: () => void): WfEvent[] {
  const saved = log.splice(0);
  build();
  const out = log.splice(0);
  log.push(...saved);
  return out;
}

const LONG: Record<string, MapWorkflow> = {
  ...WORKFLOWS,
  "pipe-verification": {
    stations: [
      st("reconciliation"),
      st("implementation"),
      st("verification"),
      st("finish", false, true),
    ],
  },
};

/** Lanes whose branches share a station, long roles and state names, repeated and branch asks. */
function crowded(running: number): WfEvent[] {
  return scenario(() => {
    start("CD", "dispatch", "09:00", null);
    for (let k = 0; k < running; k++) {
      const id = `X${k}`;
      start(id, P, "11:00", "CD", { task: `CROWD-${k}`, difficulty: 5 });
      agent(id, "11:00", "haiku", "low");
      move(id, P, "11:01", "queue", "recon");
      child(
        `${id}-r`,
        "pipe-verification",
        id,
        "11:01",
        ["reconciliation", "implementation"],
        null,
      );
      move(id, P, "11:05", "recon", "work");
      child(`${id}-w`, "pipe-worker", id, "11:06", ["orient", "edit", "check", "commit"], null);
      child(`${id}-v`, "pipe-review", id, "11:07", ["read", "probe", "verdict"], null);
      child(
        `${id}-u`,
        "pipe-verification",
        id,
        "11:08",
        ["reconciliation", "implementation"],
        null,
      );
      move(id, P, "11:10", "work", "gate");
      move(id, P, "11:12", "gate", "review");
      move(id, P, "11:14", "review", "work", "needs more work");
      move(id, P, "11:16", "work", "gate");
      move(id, P, "11:18", "gate", "review");
      ev("ask", id, "11:19", { state: "review" });
      ev("ask", id, "11:21", { state: "review" });
      ev("answer", id, "11:22", { state: "review" });
      ev("ask", `${id}-w`, "11:20", { state: "edit" });
    }
    // landed lanes beside four or more running ones draw without step labels
    for (const id of ["L0", "L1"]) {
      start(id, P, "10:00", "CD", { task: `DONE-${id}`, difficulty: 4 });
      move(id, P, "10:01", "queue", "work");
      child(`${id}-w`, "pipe-worker", id, "10:02", ["orient", "edit", "check", "commit"], "10:20");
      child(`${id}-v`, "pipe-review", id, "10:03", ["read", "probe", "verdict"], "10:20");
      move(id, P, "10:30", "work", "done");
      ev("session_end", id, "10:40", { outcome: "completed" });
    }
    move("CD", "dispatch", "11:00", "dispatch", "ask_user");
    ev("ask", "CD", "11:00", { state: "ask_user" });
  });
}

describe("no two text rectangles of a band intersect", () => {
  const cases: [string, WfEvent[]][] = [
    ["the fixture log", log],
    ["a crowded lane, labels on", crowded(1)],
    ["crowded lanes, landed ones without labels", crowded(5)],
  ];
  it("the labels-off case really has lanes without step labels", () => {
    const m = layout(fold(crowded(5)), LONG, { now: NOW, clock: () => "hh:mm" });
    const lanes = m.bands[0].lanes;
    expect(lanes.filter(l => l.status === "landed").map(l => l.labels)).toEqual([false, false]);
    expect(lanes.filter(l => l.status === "running").every(l => l.labels)).toBe(true);
  });

  for (const [name, events] of cases)
    for (const width of [undefined, 640, 900, 1500])
      it(`${name}, ${width === undefined ? "the normal" : width + " px"} width`, () => {
        const m = layout(fold(events), LONG, {
          now: NOW,
          clock: () => "hh:mm",
          ...(width !== undefined ? { width } : {}),
        });
        expect(collisions(m)).toEqual([]);
      });
});

describe("the difficulty bar", () => {
  it("is five cells, filled by difficulty, a five-wide placeholder when unknown", () => {
    expect(difficultyBar(1)).toEqual({ text: "▰▱▱▱▱", token: "--diff-1" });
    expect(difficultyBar(6)).toEqual({ text: "▰▰▰▱▱", token: "--diff-6" });
    expect(difficultyBar(10)).toEqual({ text: "▰▰▰▰▰", token: "--diff-10" });
    expect(difficultyBar(undefined)).toEqual({ text: "?????", token: "--text-4" });
  });

  it("starts every item of the next: row", () => {
    const m = layout(
      fold([]),
      {},
      { now: NOW, next: [{ id: "N-1", difficulty: 4 }, { id: "N-2" }] },
    );
    const bars = scene(m).els.filter(e => e.cls === "m-bar");
    expect(bars.map(e => e.text)).toEqual(["▰▰▱▱▱", "?????"]);
    expect(bars[0]?.c).toBe("--diff-4");
  });

  it("draws every bar exactly into its room, so the kind mark after it never sits on it", () => {
    const m = layout(
      fold([]),
      {},
      { now: NOW, next: [{ id: "N-1", difficulty: 4, kind: "feature" }] },
    );
    const els = scene(m).els;
    const bar = els.find(e => e.cls === "m-bar")!;
    const kind = els.find(e => e.cls === "m-kind")!;
    expect(bar.attrs).toMatchObject({ lengthAdjust: "spacingAndGlyphs" });
    // the bar ends at its own textLength; the kind mark starts past it
    expect(Number(kind.attrs.x)).toBeGreaterThan(
      Number(bar.attrs.x) + Number(bar.attrs.textLength),
    );
    for (const p of ["A", "C"].map(id => plaqueOf(M, lane(id).key)))
      expect(Number(p.kind?.attrs.x ?? Infinity)).toBeGreaterThan(
        Number(p.bar.attrs.x) + Number(p.bar.attrs.textLength),
      );
  });

  /** Every element of a scene, flattened with the group keys dropped. */
  const allEls = (g: SceneGroup): SceneEl[] => [...g.els, ...g.groups.flatMap(allEls)];
  const plaqueOf = (m: MapLayout, session: string): Record<string, SceneEl> => {
    const k = `${session}:plaque`;
    const found = allEls(scene(m)).filter(e => e.key.includes(`${k}:`));
    return Object.fromEntries(found.map(e => [e.key.slice(e.key.lastIndexOf(":") + 1), e]));
  };

  it("leads every lane plaque, in the difficulty colour whatever the plaque's own colour", () => {
    for (const [id, text, token, cls] of [
      ["A", "▰▰▰▱▱", "--diff-6", "st-done"],
      ["C", "▰▰▱▱▱", "--diff-3", ""],
      ["E", "▰▰▰▰▰", "--diff-9", "st-wait"],
    ] as const) {
      const l = lane(id);
      expect(l.plaque).toMatchObject({ bar: text, barC: token, cls });
      const p = plaqueOf(M, l.key);
      expect(p.bar).toMatchObject({ cls: "m-bar", text, c: token });
      expect(Number(p.bar.attrs.x)).toBe(l.plaque.x + 10);
      // the id starts after the bar, inside the box
      expect(Number(p.text.attrs.x)).toBeGreaterThan(Number(p.bar.attrs.x) + textWidthOf(text));
      // the state text follows the id by its width and a gap, so it moves with the bar's room too
      expect(Number(p.sub.attrs.x)).toBe(
        Number(p.text.attrs.x) + Math.ceil([...l.plaque.title].length * G.titleW) + 10,
      );
      expect(Number(p.box.attrs.x) + Number(p.box.attrs.width)).toBeGreaterThanOrEqual(
        Number(p.sub.attrs.x) + textWidthOf(l.plaque.sub),
      );
    }
  });

  it("a lane without a known difficulty draws no bar and keeps its width blank", () => {
    const events = scenario(() => {
      start("U1", "bare", "10:00", null, { task: "SAME-1" });
      start("U2", "bare", "10:00", null, { task: "SAME-2", difficulty: 4 });
    });
    const m = layout(fold(events), {}, { now: NOW, clock: () => "hh:mm" });
    const [u1, u2] = ["U1", "U2"].map(id => m.bands[0].lanes.find(l => l.session === id)!);
    expect(u1.plaque.bar).toBe("");
    expect(plaqueOf(m, "U1").bar).toBeUndefined();
    expect(plaqueOf(m, "U2").bar).toBeDefined();
    expect(plaqueOf(m, "U1").text.attrs.x).toBe(plaqueOf(m, "U2").text.attrs.x);
    expect(u1.plaque.width).toBe(u2.plaque.width);
  });

  it("a long id is cut so the bar and the id stay inside the plaque's limit", () => {
    const events = scenario(() => {
      start("W1", "bare", "10:00", null, { task: "X".repeat(80), difficulty: 5 });
    });
    const m = layout(fold(events), {}, { now: NOW, clock: () => "hh:mm" });
    const p = m.bands[0].lanes[0].plaque;
    expect(p.width).toBeLessThanOrEqual(G.plaqueMax);
    const els = plaqueOf(m, "W1");
    expect(Number(els.sub.attrs.x) + textWidthOf(p.sub)).toBeLessThanOrEqual(p.x + p.width);
  });
});

describe("the kind mark", () => {
  it("is one text glyph per kind, none an emoji; an absent or unknown kind reads as feature, no line is blank", () => {
    expect(kindMark({ kind: "bug" })).toBe("※");
    expect(kindMark({ kind: "research" })).toBe("⚑");
    expect(kindMark({ kind: "feature" })).toBe("◆");
    expect(kindMark({})).toBe("◆");
    expect(kindMark({ kind: undefined })).toBe("◆");
    expect(kindMark({ kind: "nonsense" })).toBe("◆");
    // a name on the object prototype is not a kind
    for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty"])
      expect(kindMark({ kind: k }), k).toBe("◆");
    expect(kindMark(undefined)).toBe(" ");
    for (const k of ["bug", "research", "feature"])
      expect(kindMark({ kind: k })).not.toMatch(/\p{Emoji_Presentation}/u);
  });

  const KINDS = { "BUG-1": "bug", "RES-1": "research", "FEA-1": "feature" };
  const events = scenario(() => {
    start("K1", "bare", "10:00", null, { task: "BUG-1", difficulty: 4 });
    start("K2", "bare", "10:00", null, { task: "RES-1: text", difficulty: 4 });
    start("K3", "bare", "10:00", null, { task: "FEA-1", difficulty: 4 });
    start("K4", "bare", "10:00", null, { task: "NO-L1", difficulty: 4 });
    start("K5", "bare", "10:00", null, { task: "__proto__", difficulty: 4 });
  });
  const m = layout(fold(events), {}, { now: NOW, clock: () => "hh:mm", kinds: KINDS });
  const plaque = (id: string) => m.bands[0].lanes.find(l => l.session === id)!.plaque;
  const els = (id: string) => {
    const k = `${id}:plaque`;
    return Object.fromEntries(
      flatEls(scene(m))
        .filter(e => e.key.includes(`${k}:`))
        .map(e => [e.key.slice(e.key.lastIndexOf(":") + 1), e]),
    );
  };
  const flatEls = (g: SceneGroup): SceneEl[] => [...g.els, ...g.groups.flatMap(flatEls)];

  it("follows the difficulty bar on every lane plaque, from the queue line the lane's task names", () => {
    expect([plaque("K1").kind, plaque("K2").kind, plaque("K3").kind]).toEqual(["※", "⚑", "◆"]);
    const e = els("K1");
    expect(e.kind).toMatchObject({ cls: "m-kind", text: "※" });
    expect(Number(e.kind.attrs.x)).toBeGreaterThan(
      Number(e.bar.attrs.x) + textWidthOf("▰▰▰▱▱") - 1,
    );
    expect(Number(e.text.attrs.x)).toBeGreaterThan(Number(e.kind.attrs.x));
  });

  it("a lane with no known task line keeps a blank of the same width, so the ids stay in one column", () => {
    expect(plaque("K4").kind).toBe(" ");
    expect(plaque("K5").kind).toBe(" ");
    expect(els("K4").kind).toBeUndefined();
    expect(els("K4").text.attrs.x).toBe(els("K1").text.attrs.x);
    expect(plaque("K4").width).toBe(plaque("K3").width);
  });

  it("starts the id of a long plaque after the bar and the mark, inside the limit", () => {
    for (let n = 30; n <= 60; n++) {
      const task = "X".repeat(n);
      const long = scenario(() => start("W1", "bare", "10:00", null, { task, difficulty: 5 }));
      const lm = layout(
        fold(long),
        {},
        { now: NOW, clock: () => "hh:mm", kinds: { [task]: "bug" } },
      );
      const p = lm.bands[0].lanes[0].plaque;
      expect(p.kind).toBe("※");
      expect(p.width).toBeLessThanOrEqual(G.plaqueMax);
      const els = flatEls(scene(lm));
      const sub = els.find(e => e.key === "W1:plaque:sub")!;
      expect(Number(sub.attrs.x) + textWidthOf(p.sub)).toBeLessThanOrEqual(p.x + p.width);
      // the cut reserved the room of everything before the id (bar and mark), so the uncut width fits the limit
      const lead = Number(els.find(e => e.key === "W1:plaque:text")!.attrs.x) - p.x - 10;
      const titleW = Math.ceil([...p.title].length * G.titleW);
      const subW = Math.ceil([...p.sub].length * G.charW);
      expect(lead + titleW + subW + 3 * 10).toBeLessThanOrEqual(G.plaqueMax);
    }
  });

  it("leads the items of the next: row and the landed earlier: row after their bars", () => {
    const nm = layout(
      fold([]),
      {},
      {
        now: NOW,
        next: [
          { id: "N-1", difficulty: 4, kind: "research" },
          { id: "N-2", difficulty: 4 },
        ],
      },
    );
    expect(nm.next[0].items.map(i => i.kind)).toEqual(["⚑", "◆"]);
    const els = flatEls(scene(nm));
    const marks = els.filter(e => e.cls === "m-kind");
    expect(marks.map(e => e.text)).toEqual(["⚑", "◆"]);
    // the plaque box starts after the mark's cell, not under it
    const box = els.find(e => e.key.endsWith(":box") && e.key.includes("next"))!;
    expect(Number(box.attrs.x)).toBeGreaterThanOrEqual(Number(marks[0].attrs.x) + 7);
    // the landed earlier: row: a lane folded away keeps the glyph of the line its task names, a blank if none
    const old = scenario(() => {
      for (const [id, task] of [
        ["O1", "BUG-1"],
        ["O2", "NO-L1"],
      ] as const) {
        start(id, "bare", "08:00", null, { task, difficulty: 2 });
        ev("session_end", id, "08:30", { outcome: "completed" });
      }
    });
    const om = layout(fold(old), {}, { now: NOW, clock: () => "hh:mm", kinds: KINDS });
    expect(om.bands[0].earlier!.items.map(i => [i.id, i.kind])).toEqual([
      ["NO-L1", " "],
      ["BUG-1", "※"],
    ]);
    expect(
      flatEls(scene(om))
        .filter(e => e.cls === "m-kind")
        .map(e => e.text),
    ).toEqual(["※"]);
  });
});

describe("what is cut or moved to avoid a collision keeps its full text", () => {
  const m = layout(fold(crowded(1)), LONG, { now: NOW, clock: () => "hh:mm", width: 900 });
  const x0 = m.bands[0].lanes.find(l => l.session === "X0")!;
  const rail = m.bands[0].rail!;

  it("a second branch under one station takes the row below the first one's step labels", () => {
    const [w, v, u] = ["X0-w", "X0-v", "X0-u"].map(id => x0.branches.find(b => b.session === id)!);
    expect([w.stepY, v.stepY, u.stepY]).toEqual([
      w.y + G.branchDrop,
      w.y + G.branchDrop + G.branchRow,
      w.y + G.branchDrop + 2 * G.branchRow,
    ]);
    // the chip clears the row above (its detail line ends 31 px under the steps) and its own steps
    expect(v.chip.y - 8).toBeGreaterThan(w.stepY + 31);
    expect(v.chip.y + 8).toBeLessThan(v.stepY - 6);
  });

  it("a chip is cut to its branch and keeps the whole text as a tooltip", () => {
    const r = x0.branches.find(b => b.session === "X0-r")!;
    expect(r.chip.text.endsWith("…")).toBe(true);
    expect(r.chip.title).toContain("· verification");
    expect(r.chip.x + textWidthOf(r.chip.text) + 16).toBeLessThanOrEqual(r.x2);
    const el = scene(m)
      .groups[0].groups.flatMap(g => g.els)
      .find(e => e.key === `${r.key}:chip:text`)!;
    expect(el.title).toBe(r.chip.title);
  });

  it("a step name too long for its room is cut; `…` names the steps it hides", () => {
    const steps = x0.branches.flatMap(b => b.steps);
    const cut = steps.filter(s => s.label !== s.name && s.name !== "…");
    for (const s of cut) expect(s.title).toBe(s.name);
    const gap = steps.find(s => s.name === "…");
    if (gap) expect(gap.title).not.toBe("");
  });

  it("asks and answers at one place stack on rows above the rail", () => {
    const rows = rail.asks.map(a => [a.key, a.qRow]);
    expect(rows.filter(([k]) => String(k).startsWith("X0:ask")).map(([, r]) => r)).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
    const both = rail.asks.filter(a => a.x === rail.asks[0].x);
    expect(new Set(both.map(a => a.qRow)).size).toBe(both.length);
  });
});

function textWidthOf(s: string): number {
  return widthAt(s, 10);
}

describe("a cut text's tooltip can be reached", () => {
  it("the page turns pointer events back on for a text that carries a title", () => {
    const dash = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dashboard");
    const css = fs.readFileSync(path.join(dash, "components.css"), "utf8");
    expect(css).toMatch(/svg text \{[^}]*pointer-events: none/);
    expect(css).toMatch(/\.map-wrap svg text:has\(> title\) \{ pointer-events: auto; \}/);
  });

  it("every cut text of the crowded lanes is a scene element with a title", () => {
    const m = layout(fold(crowded(1)), LONG, { now: NOW, clock: () => "hh:mm", width: 900 });
    const titled = scene(m)
      .groups.flatMap(function walk(g: SceneGroup): SceneEl[] {
        return [...g.els, ...g.groups.flatMap(walk)];
      })
      .filter(e => e.tag === "text" && e.title !== undefined);
    expect(titled.length).toBeGreaterThan(0);
    for (const e of titled) expect(e.text).not.toBe(e.title);
  });
});

describe("a question asked from a state no workflow tags", () => {
  // C stands at `recon` and passed a question with its hand-back; E's `ask` log is untouched
  const asked = (answered: boolean): MapLayout =>
    map([
      ...log,
      {
        seq: 900,
        run: "r1",
        ts: at("11:22"),
        kind: "ask",
        session: "C",
        data: { state: "recon", text: "gate regate: which base?" },
      },
      ...(answered
        ? [
            {
              seq: 901,
              run: "r1",
              ts: at("11:26"),
              kind: "answer" as const,
              session: "C",
              data: { state: "recon", to: "work" },
            },
          ]
        : []),
    ]);
  const ask = (m: MapLayout) => m.bands[0].rail!.asks.find(a => a.key.startsWith("C:"))!;

  it("is a line to the parent rail from the lane, lit while open, carrying the question", () => {
    const m = asked(false);
    const a = ask(m);
    expect([a.x, a.label, a.answer, a.text]).toEqual([
      x("recon"),
      "? recon",
      null,
      "gate regate: which base?",
    ]);
    expect(a.title).toBe("? recon: gate regate: which base?");
    expect(m.bands[0].lanes.find(l => l.session === "C")!.plaque.sub).toContain("asks the parent");
    const els = scene(m).groups[0].els.filter(e => e.key.startsWith("C:ask0"));
    expect(els.map(e => [e.tag, e.cls])).toEqual([
      ["path", "m-ask m-open"],
      ["text", "m-ask-label m-end"],
    ]);
  });

  it("the answer draws the line back, no longer lit", () => {
    const m = asked(true);
    expect(ask(m).answer).toBe("→ work · 4m");
    const els = scene(m).groups[0].els.filter(e => e.key.startsWith("C:ask0"));
    expect(els.map(e => e.cls)).toEqual([
      "m-ask",
      "m-ask-label m-end",
      "m-answer",
      "m-answer-label",
    ]);
  });
});

describe("which sessions are bands", () => {
  const WF: Record<string, MapWorkflow> = {
    chat: { map: false, stations: [st("talk"), st("end", false, true)] },
    work: { stations: [st("a"), st("b", false, true)] },
  };
  const run = (events: WfEvent[], now = NOW): MapLayout =>
    layout(fold(events), WF, { now, clock: () => "hh:mm" });
  const mk = (build: () => void): WfEvent[] => {
    log.length = 0;
    seq = 0;
    build();
    return [...log];
  };

  it("a childless root of a `map: false` workflow stays off the map", () => {
    const m = run(
      mk(() => {
        start("C1", "chat", "10:00", null, { project: "other" });
        start("W1", "work", "10:00", null, { project: "other" });
      }),
    );
    expect(m.bands.map(b => b.title)).toEqual(["other › no queue · work"]);
  });

  it("a `map: false` workflow with children is a dispatcher and stays", () => {
    const m = run(
      mk(() => {
        start("C1", "chat", "10:00", null);
        start("W1", "work", "10:01", "C1");
      }),
    );
    expect(m.bands.map(b => b.title)).toEqual(["? › no queue · work"]);
    expect(m.bands[0].rail).not.toBeNull();
  });

  it("one workflow in two projects is two bands titled with the project", () => {
    const m = run(
      mk(() => {
        start("W1", "work", "10:00", null, { project: "alpha" });
        start("W2", "work", "10:00", null, { project: "beta" });
      }),
    );
    expect(m.bands.map(b => b.title)).toEqual([
      "alpha › no queue · work",
      "beta › no queue · work",
    ]);
  });

  it("sessions in worktrees of one repo are one band: the session files carry the main checkout's name", () => {
    const base = {
      stack: [{ workflow: "work", current_state: "a" }],
      started_at: "2026-01-01T10:00:00Z",
      updated_at: "2026-01-01T10:00:00Z",
      history: [],
    };
    const events = seedEvents([
      { ...base, session_id: "W1", context: { cwd: "/x/repo" }, project: "repo" },
      { ...base, session_id: "W2", context: { cwd: "/x/wf-W2" }, project: "repo" },
    ]);
    expect(run(events).bands.map(b => b.title)).toEqual(["repo › no queue · work"]);
  });

  it("one project is one band, whose heading names it", () => {
    const m = run(
      mk(() => {
        start("W1", "work", "10:00", null, { project: "alpha" });
        start("W2", "work", "10:00", null, { project: "alpha" });
      }),
    );
    expect(m.bands.map(b => b.title)).toEqual(["alpha › no queue · work"]);
  });
});

describe("project, then queue", () => {
  const q = (name: string) => `/repo/owner/.claude/batch/${name}.yaml`;
  const build = (extra: () => void): MapLayout => {
    const events = scenario(extra);
    return layout(fold(events), {}, { now: Date.parse("2026-01-01T12:00:00Z") });
  };
  const titles = (m: MapLayout) => m.bands.map(b => b.title);

  it("two projects read one after the other, each heading naming its project and queue", () => {
    const m = build(() => {
      start("B", "work", "10:00", null, { project: "beta", queue: q("q") });
      start("A", "work", "10:00", null, { project: "alpha", queue: q("q") });
    });
    expect(titles(m)).toEqual(["alpha › owner/q.yaml · work", "beta › owner/q.yaml · work"]);
    expect(m.bands.map(b => b.project)).toEqual(["alpha", "beta"]);
  });

  it("two queues of one project are two bands, and its sessions with no queue come last", () => {
    const m = build(() => {
      start("N", "work", "10:00", null, { project: "p" });
      start("Y", "work", "10:00", null, { project: "p", queue: q("y") });
      start("X", "work", "10:00", null, { project: "p", queue: q("x") });
    });
    expect(titles(m)).toEqual([
      "p › owner/x.yaml · work",
      "p › owner/y.yaml · work",
      "p › no queue · work",
    ]);
    expect(m.bands[2].queue).toBeNull();
  });

  it("a dispatcher started under a conversation gives each queue line its own lane", () => {
    const m = build(() => {
      start("R", "chat", "10:00", null, { project: "p" });
      start("D", "disp", "10:00", "R", { project: "p", queue: q("x") });
      start("L1", "work", "10:01", "D", { project: "p", task: "LINE-1" });
      start("L2", "work", "10:02", "D", { project: "p", task: "LINE-2" });
    });
    expect(titles(m)).toEqual(["p › owner/x.yaml · work"]);
    expect(m.bands[0].lanes.map(l => l.plaque.title)).toEqual(["LINE-1", "LINE-2"]);
  });

  it("a line's child session hangs under its lane, in its queue, and draws no lane of its own", () => {
    const m = build(() => {
      start("D", "disp", "10:00", null, { project: "p", queue: q("x") });
      start("L", "work", "10:01", "D", { project: "p", task: "LINE-1" });
      start("C", "review", "10:02", "L", { project: "p" });
    });
    expect(titles(m)).toEqual(["p › owner/x.yaml · work"]);
    const lanes = m.bands[0].lanes;
    expect(lanes.map(l => l.session)).toEqual(["L"]);
    expect(lanes[0].plaque.title).toBe("LINE-1");
  });
});

describe("bands without declared stations", () => {
  const run = (build: () => void): MapLayout => {
    log.length = 0;
    seq = 0;
    build();
    return layout(fold([...log]), { quiet: { map: false } }, { now: NOW, clock: () => "hh:mm" });
  };

  it("a lane that has not moved still draws, in one column", () => {
    const m = run(() => start("N1", "bare", "10:00", null));
    expect(m.bands.map(b => b.title)).toEqual(["? › no queue · bare"]);
    expect(m.bands[0].stations.map(s => s.name)).toEqual(["start"]);
    expect(m.bands[0].lanes).toHaveLength(1);
  });

  it("undeclared stations are the states the lanes visited, in order", () => {
    const m = run(() => {
      start("N1", "bare", "10:00", null);
      move("N1", "bare", "10:01", "a", "b");
    });
    expect(m.bands[0].stations.map(s => s.name)).toEqual(["a", "b"]);
  });

  it("a dispatcher's child of a `map: false` workflow is left off, the dispatcher stays", () => {
    const m = run(() => {
      start("D1", "disp", "10:00", null);
      start("K1", "quiet", "10:01", "D1");
      start("K2", "bare", "10:01", "D1");
    });
    expect(m.bands.map(b => b.title)).toEqual(["? › no queue · bare"]);
  });
});

describe("the steps of a crowded branch", () => {
  const steps = Array.from({ length: 8 }, (_, i) => ({
    name: `step-number-${i}`,
    kind: "done" as const,
  }));

  it("the count shrinks until every name fits whole between its neighbours, `…` for the hidden", () => {
    const placed = placeSteps("b", steps, 0, 600);
    expect(placed.length).toBeLessThan(steps.length);
    expect(placed.some(s => s.name === "…")).toBe(true);
    for (const [k, s] of placed.entries()) {
      if (k === 0 || k === placed.length - 1) continue;
      const gap = (placed[k + 1].x - s.x) / 1;
      expect(textWidthOf(s.label)).toBeLessThanOrEqual(gap);
    }
  });

  it("every step stays when they all fit: the count shrinks only as far as it must", () => {
    const few = steps.slice(0, 5).map(s => ({ ...s, name: s.name.replace("step-number-", "s") }));
    const placed = placeSteps("b", few, 0, 600);
    expect(placed.map(s => s.name)).toEqual(few.map(s => s.name));
  });

  it("shows as many as fit: the widest count whose middle names clear their neighbours", () => {
    // short ends (the edge budget is 52 px) and 13-character middle names (77 px each)
    const mixed = [
      { name: "a", kind: "done" as const },
      ...Array.from({ length: 8 }, (_, i) => ({ name: `middle-step-${i}`, kind: "done" as const })),
      { name: "z", kind: "live" as const },
    ];
    // n shown need (width - 2 * stepPad) / (n - 1) - 4 >= 77: 300 px -> 4, 400 -> 5, 500 -> 6, 600 -> 7, 700 -> 9
    for (const [width, count] of [
      [300, 4],
      [400, 5],
      [500, 6],
      [600, 7],
      [700, 9],
    ] as const)
      expect(placeSteps("b", mixed, 0, width), `${width} px`).toHaveLength(count);
    expect(
      placeSteps("b", mixed, 0, 600).map(s => s.name),
      "the first, `…`, then the latest",
    ).toEqual(["a", "…", ...[4, 5, 6, 7].map(k => `middle-step-${k}`), "z"]);
  });

  it("never more than the cap, even when every name is short enough for more", () => {
    // 20 one-letter names would all fit by width alone at 11 steps; the cap is room / stepMin + 1
    const tiny = Array.from({ length: 20 }, (_, i) => ({
      name: String.fromCharCode(97 + i),
      kind: "done" as const,
    }));
    // width 200: room 160, cap floor(160 / 40) + 1 = 5; width 120: room 80, cap 3
    for (const [width, count] of [
      [200, 5],
      [120, 3],
    ] as const)
      expect(placeSteps("b", tiny, 0, width), `${width} px`).toHaveLength(count);
  });
});

describe("station names", () => {
  const WF: Record<string, MapWorkflow> = {
    long: {
      stations: [
        st("reconciliation-of-everything-and-all-its-parts"),
        st("implementation-of-everything-and-all-its-parts"),
        st("finish", false, true),
      ],
    },
  };
  const events = scenario(() => {
    start("L1", "long", "10:00", null, { task: "T", difficulty: 3 });
  });
  for (const width of [undefined, 640])
    it(`are cut to their column and keep the whole name as a tooltip, ${width ?? "normal"} width`, () => {
      const m = layout(fold(events), WF, {
        now: NOW,
        clock: () => "hh:mm",
        ...(width !== undefined ? { width } : {}),
      });
      const cut = m.bands[0].stations.filter(s => s.label !== s.name);
      expect(cut.length).toBeGreaterThan(0);
      for (const s of cut) {
        expect(s.label.endsWith("…")).toBe(true);
        expect(s.title).toBe(s.name);
      }
      const el = scene(m).groups[0].els.find(
        e => e.key === "band:long:station:reconciliation-of-everything-and-all-its-parts",
      );
      expect(el?.title).toBe("reconciliation-of-everything-and-all-its-parts");
      expect(collisions(m)).toEqual([]);
    });
});

describe("the Plan tab's queue graph", () => {
  const lines = [
    { id: "A", status: "done" },
    { id: "B", status: "running", afterIds: ["A"] },
    { id: "C", status: "pending", reason: "ready", afterIds: ["A", "B"] },
    { id: "D", status: "pending", reason: "after: C", afterIds: ["C"] },
    { id: "E", status: "failed" },
    { id: "F", status: "pending", reason: "after: C", afterIds: ["C", "D"] },
  ];
  it("holds the line, what it waits for and what waits for it, each by state", () => {
    const g = queueGraph(lines, "C");
    expect(g.nodes.map(n => [n.id, n.kind, n.self])).toEqual([
      ["C", "ready", true],
      ["A", "done", false],
      ["B", "running", false],
      ["D", "waiting", false],
      ["F", "waiting", false],
    ]);
    expect(g.edges).toEqual([
      { from: "A", to: "C" },
      { from: "B", to: "C" },
      { from: "C", to: "D" },
      { from: "C", to: "F" },
    ]);
  });
  it("a line with no neighbours is one node, an unknown id none, a failed line is failed", () => {
    expect(queueGraph(lines, "E")).toEqual({
      nodes: [{ id: "E", kind: "failed", self: true }],
      edges: [],
    });
    expect(queueGraph(lines, "nope")).toEqual({ nodes: [], edges: [] });
  });
});

describe("repeated rounds of a lane fold into one drawn round with a count", () => {
  /** a lane that loops work -> gate -> work `rounds` times; `red` lists the pass numbers whose gate fails */
  function rounds(n: number, red: number[] = [], minutes = 2): WfEvent[] {
    const out: WfEvent[] = [];
    let q = 0;
    const put = (kind: EventKind, session: string, min: number, data: Record<string, unknown>) =>
      out.push({
        seq: ++q,
        run: "r2",
        ts: new Date(Date.parse(at("08:00")) + min * 60_000).toISOString(),
        kind,
        session,
        data,
      });
    put("session_start", "R", 0, {
      workflow: "pipe",
      parent: null,
      task: "T-1",
      difficulty: 3,
    });
    put("transition", "R", 0, {
      from: "queue",
      to: "work",
      name: "go",
      workflow: "pipe",
    });
    let t = 0;
    for (let k = 0; k < n; k++) {
      t += 1;
      put("transition", "R", t, {
        from: "work",
        to: "gate",
        name: "next",
        workflow: "pipe",
      });
      const bad = red.includes(k);
      put("exec_end", "R", t, {
        state: "gate",
        exit_code: bad ? 10 : 0,
        duration_ms: k % 2 === 0 ? 60_000 : 120_000,
      });
      t += k % 2 === 0 ? 1 : minutes;
      put("transition", "R", t, {
        from: "gate",
        to: "work",
        name: "slot_free",
        workflow: "pipe",
      });
    }
    return out;
  }
  const lay = (events: WfEvent[], open: string[] = []) =>
    layout(fold(events), WORKFLOWS, { now: NOW, clock: () => "hh:mm", open }).bands[0].lanes[0];

  it("5 identical rounds draw one, with x5 and the range of their durations", () => {
    const l = lay(rounds(6));
    // pass 0 (the queue), five identical rounds, the running round
    expect(l.passes.map(p => p.index)).toEqual([0, 1, 6]);
    const folded = l.loops.filter(x => x.group !== undefined);
    expect(folded).toHaveLength(1);
    expect(folded[0].label).toContain("×5");
    expect(folded[0].label).toMatch(/×5 · 2m–3m/);
    expect(folded[0].group).toBe("R:g1");
  });

  it("a red round in the middle gives two groups around it", () => {
    const l = lay(rounds(8, [4]));
    expect(l.passes.map(p => p.index)).toEqual([0, 1, 4, 5, 8]);
    expect(l.loops.filter(x => x.group !== undefined).map(x => x.label.match(/×\d+/)![0])).toEqual([
      "×3",
      "×3",
    ]);
    expect(l.passes.find(p => p.index === 4)!.stops.some(s => s.kind === "stop")).toBe(true);
  });

  it("the running round is never folded into the group", () => {
    const l = lay(rounds(3));
    expect(l.passes.at(-1)!.index).toBe(3);
    expect(l.status).toBe("running");
    expect(l.passes.at(-1)!.stops.at(-1)!.kind).toBe("live");
  });

  it("an open group draws its rounds; the open state is the key, so a live update keeps it", () => {
    const closed = lay(rounds(6));
    const open = lay(rounds(6), ["R:g1"]);
    expect(open.passes).toHaveLength(7);
    expect(open.loops.filter(x => x.group !== undefined)).toHaveLength(5);
    expect(open.loops.filter(x => x.label.includes("▾"))).toHaveLength(1);
    // one more round arrives: the same key still names the group, still open
    const more = lay(rounds(7), ["R:g1"]);
    expect(more.passes).toHaveLength(8);
    expect(more.loops.find(x => x.label.includes("▾"))!.label).toContain("×6");
    expect(more.loops.find(x => x.group)!.group).toBe("R:g1");
    expect(lay(rounds(7)).passes).toHaveLength(3);
    expect(open.height).toBeGreaterThan(closed.height);
  });

  it("the height of the lane falls", () => {
    expect(lay(rounds(12)).height).toBeLessThan(lay(rounds(12), ["R:g1"]).height / 2);
  });

  it("the click target rides on the loop's path and label in the scene", () => {
    const m = layout(fold(rounds(6)), WORKFLOWS, {
      now: NOW,
      clock: () => "hh:mm",
    });
    const els: SceneEl[] = [];
    const walkG = (g: SceneGroup): void => {
      els.push(...g.els);
      g.groups.forEach(walkG);
    };
    walkG(scene(m));
    expect(els.filter(e => e.attrs["data-group"] === "R:g1")).toHaveLength(2);
  });
});
