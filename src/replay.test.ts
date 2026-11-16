import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fold, type EventKind, type WfEvent } from "./event-fold.js";
import { layout, scene, type SceneGroup } from "./map-layout.js";
import {
  advance,
  buildReplay,
  DEFAULT_SPEED,
  elapsed,
  expandReplay,
  followsBottom,
  renderReplay,
  REPLAY_QUEUE,
  rowsUntil,
  SPEEDS,
  type ReplayFile,
} from "./replay.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

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

const bytes = (text: string): number => Buffer.byteLength(text);
const QUEUE = "/Users/someone/dev/anyparse/.claude/batch/queue.yaml";

/** A pipeline of `project` with one recon child and `reviews` review children, from minute `a` to `b`. */
function pipeline(
  id: string,
  a: number,
  b: number,
  o: { project?: string; reviews?: number; moves?: string[]; task?: string; queue?: string } = {},
): WfEvent[] {
  const project = o.project ?? "anyparse";
  const out: WfEvent[] = [
    ev(a, "session_start", id, {
      workflow: "slice-pipeline",
      // the conversation that started it: not a session of the log
      parent: "dispatch0",
      task: o.task ?? `TASK-${id}`,
      difficulty: 5,
      project,
      queue: o.queue ?? QUEUE,
    }),
    ev(a, "agent_link", id, {
      agent: `agent-${id}`,
      role: "slice-recon",
      model: "sonnet",
      effort: "high",
      step: { state: "recon_spawn", workflow: "slice-pipeline", extra: "x" },
      parent: "p",
    }),
  ];
  for (const [i, to] of (o.moves ?? ["land"]).entries())
    out.push(
      ev(a + 1 + i, "transition", id, { from: "x", to, name: "go", workflow: "slice-pipeline" }),
    );
  for (let r = 0; r < (o.reviews ?? 0) + 1; r++) {
    const kid = `${id}-k${r}`;
    out.push(
      ev(a + 1, "session_start", kid, {
        workflow: r === 0 ? "slice-recon" : "slice-review",
        parent: id,
        task: null,
        // a child of a kept session is kept whatever directory it ran in
        project: "wf-worktree",
        queue: null,
      }),
      ev(a + 2, "ask", kid, { state: "review", text: "SECRET QUESTION TEXT" }),
      ev(a + 3, "session_end", kid, { outcome: "completed" }),
    );
  }
  out.push(ev(b, "session_end", id, { outcome: "completed" }));
  return out;
}

const OTHER = pipeline("zz999999", 5, 20, {
  project: "golf",
  task: "GOLF-PRIVATE-TASK",
  queue: "/Users/someone/dev/golf/.claude/batch/queue.yaml",
});
const workflows = {
  "slice-pipeline": {
    stations: [
      { name: "claim", script: true, terminal: false },
      { name: "land", script: false, terminal: true },
    ],
  },
  "slice-recon": { stations: [{ name: "orient", script: false, terminal: false }] },
};

describe("buildReplay keeps one project and nothing else", () => {
  const events = [
    ...pipeline("aaaa1111", 0, 30, { reviews: 2 }),
    ...pipeline("bbbb2222", 10, 40),
    ...OTHER,
  ];
  const file = buildReplay(events, { project: "anyparse", workflows, from: at(-1), hours: 2 });
  const text = JSON.stringify(file);

  it("drops every session, task, path and id of another project", () => {
    expect(
      file.sessions.filter(s => !s.startsWith("aaaa1111") && !s.startsWith("bbbb2222")),
    ).toEqual([]);
    for (const secret of ["zz999999", "GOLF-PRIVATE-TASK", "golf", "someone", "dispatch0"])
      expect(text).not.toContain(secret);
  });

  it("keeps the children of a kept session, whatever directory they ran in", () => {
    expect(file.sessions).toContain("aaaa1111-k2");
    expect(file.events.some(r => r[2] === file.sessions.indexOf("aaaa1111-k2"))).toBe(true);
  });

  it("writes the queue under a home-free path and leaves an ask's text out", () => {
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain("SECRET QUESTION TEXT");
    const starts = expandReplay(file).filter(
      e => e.kind === "session_start" && e.data.parent === undefined,
    );
    expect(starts.map(e => e.data.queue)).toEqual([REPLAY_QUEUE, REPLAY_QUEUE]);
  });

  it("keeps only the keys the map reads, and no null", () => {
    const link = expandReplay(file).find(e => e.kind === "agent_link");
    expect(link?.data).toEqual({
      agent: "agent-aaaa1111",
      role: "slice-recon",
      model: "sonnet",
      effort: "high",
      step: { workflow: "slice-pipeline", state: "recon_spawn" },
    });
    for (const e of expandReplay(file)) expect(Object.values(e.data)).not.toContain(null);
  });

  it("carries the workflows the kept sessions ran, and no other", () => {
    expect(Object.keys(file.workflows)).toEqual(["slice-pipeline", "slice-recon"]);
  });

  it("a project with no session is an error, not an empty file", () => {
    expect(() => buildReplay(events, { project: "nothing", workflows, from: at(-1) })).toThrow(
      /no finished session/,
    );
  });
});

describe("buildReplay trims to a window of whole pipelines", () => {
  const events = [
    ...pipeline("early000", 0, 20),
    ...pipeline("middle00", 100, 130),
    ...pipeline("late0000", 400, 430),
    // still running: no end, so never in a replay
    ...pipeline("running0", 105, 500).filter(
      e => !(e.kind === "session_end" && e.session === "running0"),
    ),
  ];

  it("takes the pipelines that start and end inside the window", () => {
    const file = buildReplay(events, { project: "anyparse", workflows, from: at(90), hours: 1 });
    expect(file.sessions.filter(s => !s.includes("-k"))).toEqual(["middle00"]);
    expect(file.start).toBe(at(100));
    expect(file.durationMs).toBe(30 * 60_000);
    expect(file.events[0]?.[0]).toBe(0);
    expect(file.events.at(-1)?.[0]).toBe(file.durationMs);
  });

  it("without a start picks the window with a land, a split, review rounds and several lanes at once", () => {
    const busy = [
      ...pipeline("quiet000", 0, 20, { moves: ["close"] }),
      ...pipeline("land0000", 300, 330, { reviews: 2, moves: ["land"] }),
      ...pipeline("split000", 305, 335, { moves: ["mark_split"] }),
      ...pipeline("third000", 310, 340, { moves: ["land"] }),
    ];
    const file = buildReplay(busy, { project: "anyparse", workflows, hours: 1 });
    expect(file.start).toBe(at(300));
    expect(file.sessions.filter(s => !s.includes("-k"))).toEqual([
      "land0000",
      "split000",
      "third000",
    ]);
  });

  it("measures the text that is written, in bytes: compact JSON that fits is not enough", () => {
    const events = pipeline("land0000", 300, 330, { reviews: 2 });
    const opts = { project: "anyparse", workflows, hours: 1 } as const;
    const file = buildReplay(events, opts);
    const compact = bytes(JSON.stringify(file));
    const written = bytes(renderReplay(file));
    expect(written).toBeGreaterThan(compact);
    expect(() => buildReplay(events, { ...opts, maxBytes: compact })).toThrow(/fits/);
    expect(() => buildReplay(events, { ...opts, from: at(299), maxBytes: compact })).toThrow(
      /over/,
    );
    expect(buildReplay(events, { ...opts, maxBytes: written })).toEqual(file);
    // bytes, not characters: a multi-byte task name counts its UTF-8 length
    const wide = buildReplay(
      pipeline("wide0000", 300, 330, { task: "TASK-\u00e9\u00e9\u00e9" }),
      opts,
    );
    expect(bytes(renderReplay(wide))).toBeGreaterThan(renderReplay(wide).length);
    expect(() =>
      buildReplay(pipeline("wide0000", 300, 330, { task: "TASK-\u00e9\u00e9\u00e9" }), {
        ...opts,
        maxBytes: renderReplay(wide).length,
      }),
    ).toThrow(/fits/);
  });

  it("holds the file to its size limit", () => {
    const busy = [
      ...pipeline("land0000", 300, 330, { reviews: 2 }),
      ...pipeline("small000", 0, 5, { moves: ["close"] }),
    ];
    const small = buildReplay(busy, { project: "anyparse", workflows, hours: 1, maxBytes: 3000 });
    expect(bytes(renderReplay(small))).toBeLessThanOrEqual(3000);
    expect(() =>
      buildReplay(busy, { project: "anyparse", workflows, hours: 1, maxBytes: 100 }),
    ).toThrow(/fits 100 bytes/);
  });
});

describe("follow mode", () => {
  it("holds at the bottom and ends when the reader scrolls up", () => {
    expect(followsBottom(1000, 400, 600)).toBe(true);
    expect(followsBottom(1000, 396, 600)).toBe(true);
    expect(followsBottom(1000, 300, 600)).toBe(false);
    expect(followsBottom(500, 0, 600)).toBe(true);
  });
});

describe("the replay clock", () => {
  const file = buildReplay(pipeline("clock000", 0, 30, { reviews: 1 }), {
    project: "anyparse",
    workflows,
    from: at(-1),
  });

  it("offers 1x to 60x, 30x by default", () => {
    expect(SPEEDS[0]).toBe(1);
    expect(SPEEDS.at(-1)).toBe(60);
    expect(SPEEDS).toContain(DEFAULT_SPEED);
  });

  it("advances by real time times the speed and holds at the end", () => {
    expect(advance(1000, 100, 30, 1e9)).toEqual({ at: 4000, ended: false });
    expect(advance(1000, 100, 30, 3000)).toEqual({ at: 3000, ended: true });
    expect(advance(0, 50, 1, 1e9)).toEqual({ at: 50, ended: false });
  });

  it("counts the rows at or before a position (a scrub)", () => {
    expect(rowsUntil(file, -1)).toBe(0);
    expect(rowsUntil(file, 0)).toBeGreaterThan(0);
    expect(rowsUntil(file, file.durationMs)).toBe(file.events.length);
    const mid = rowsUntil(file, 60_000);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(file.events.length);
    expect(file.events.slice(0, mid).every(r => r[0] <= 60_000)).toBe(true);
  });

  it("names a position as h:mm:ss", () => {
    expect(elapsed(0)).toBe("0:00:00");
    expect(elapsed(3_723_000)).toBe("1:02:03");
  });

  it("feeds the dashboard's own fold and layout: lanes appear as the clock moves", () => {
    const events = expandReplay(file);
    const lanesAt = (ms: number): number => {
      const sessions = fold(events.slice(0, rowsUntil(file, ms)));
      return layout(sessions, file.workflows, { now: Date.parse(file.start) + ms, width: 1000 })
        .bands.length;
    };
    expect(lanesAt(-1)).toBe(0);
    expect(lanesAt(60_000)).toBeGreaterThan(0);
  });
});

describe("the committed replay (docs/public/replay/anyparse.json)", () => {
  const raw = read("docs/public/replay/anyparse.json");
  const file = JSON.parse(raw) as ReplayFile;
  const events = expandReplay(file);
  const sessions = fold(events);

  it("is under 300 KB", () => {
    expect(Buffer.byteLength(raw)).toBeLessThan(300_000);
  });

  it("is the open-source project's sessions only: no other project, home path or private name", () => {
    expect(file.project).toBe("anyparse");
    for (const bad of [
      "/Users/",
      "/home/",
      "golf",
      "playtechstudios",
      "TM-Haxe4",
      "mcp-workflow-engine",
      "ask_parent",
    ])
      expect(raw).not.toContain(bad);
    const roots = [...sessions.values()].filter(s => s.parent === null);
    expect(roots.length).toBeGreaterThan(0);
    for (const r of roots) expect(r.project).toBe("anyparse");
    // an ask carries no text
    expect(events.filter(e => e.kind === "ask").every(e => e.data.text === undefined)).toBe(true);
  });

  it("covers a few hours of several pipelines with review rounds, a land and a split", () => {
    expect(file.durationMs).toBeGreaterThan(2 * 3600_000);
    expect(file.durationMs).toBeLessThan(8 * 3600_000);
    const pipelines = [...sessions.values()].filter(s => s.workflow === "slice-pipeline");
    expect(pipelines.length).toBeGreaterThanOrEqual(5);
    const kids = (id: string) => [...sessions.values()].filter(s => s.parent === id);
    expect(
      pipelines.some(p => p.transitions.some(t => t.to === "land") && p.outcome === "completed"),
    ).toBe(true);
    expect(pipelines.some(p => p.transitions.some(t => t.to === "mark_split"))).toBe(true);
    expect(
      pipelines.some(p => kids(p.id).filter(k => k.workflow === "slice-review").length >= 2),
    ).toBe(true);
    // several lanes at the same time
    const spans = pipelines.map(
      p => [Date.parse(p.started as string), Date.parse(p.ended as string)] as const,
    );
    const peak = Math.max(...spans.map(([s]) => spans.filter(([a, b]) => a <= s && s < b).length));
    expect(peak).toBeGreaterThanOrEqual(3);
  });

  it("every session is a row's session and every workflow has its stations", () => {
    for (const r of file.events) expect(file.sessions[r[2]]).toBeDefined();
    for (const s of sessions.values())
      expect(file.workflows[s.workflow as string]?.stations?.length).toBeGreaterThan(0);
  });

  it("lays out the way the dashboard does: the final picture draws lanes and a fold of the landed", () => {
    const end = Date.parse(file.start) + file.durationMs;
    const mid = rowsUntil(file, file.durationMs / 2);
    const map = layout(fold(events.slice(0, mid)), file.workflows, {
      now: Date.parse(file.start) + file.durationMs / 2,
      width: 1100,
      kinds: file.taskKinds,
    });
    const laneKeys = (g: SceneGroup): string[] => [
      ...(g.key.startsWith("lane:") ? [g.key] : []),
      ...g.groups.flatMap(laneKeys),
    ];
    expect(laneKeys(scene(map)).length).toBeGreaterThanOrEqual(2);
    const last = layout(sessions, file.workflows, { now: end, width: 1100, kinds: file.taskKinds });
    expect(last.bands.length).toBeGreaterThan(0);
  });
});

describe("scripts/export-replay.mjs", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("writes the replay of one project from an event log directory", () => {
    // the script runs from build/, as `npm run build && node scripts/export-replay.mjs` does
    execFileSync("node", ["node_modules/typescript7/bin/tsc", "-p", "."], { cwd: ROOT });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-replay-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, "events"));
    fs.mkdirSync(path.join(dir, "project", ".claude", "batch"), { recursive: true });
    fs.mkdirSync(path.join(dir, "project", ".claude", "workflows"));
    fs.writeFileSync(
      path.join(dir, "project", ".claude", "workflows", "slice-pipeline.yaml"),
      "name: slice-pipeline\ndescription: test\ninitial: claim\nstates:\n  claim:\n    type: prompt\n    prompt: go\n    transitions:\n      go: done\n  done:\n    terminal: true\n    outcome: complete\n",
    );
    fs.writeFileSync(
      path.join(dir, "project", ".claude", "batch", "queue.yaml"),
      "tasks:\n  - id: TASK-aaaa1111\n    kind: bug\n  - id: GOLF-PRIVATE-TASK\n    kind: feature\n",
    );
    const lines = [...pipeline("aaaa1111", 0, 30, { reviews: 1 }), ...OTHER].map(e =>
      JSON.stringify(e),
    );
    fs.writeFileSync(path.join(dir, "events", "run-a.jsonl"), `${lines.join("\n")}\n{"torn`);
    const out = path.join(dir, "out", "replay.json");
    execFileSync(
      "node",
      [
        "scripts/export-replay.mjs",
        "--events",
        path.join(dir, "events"),
        "--project-dir",
        path.join(dir, "project"),
        "--from",
        at(-1),
        "--out",
        out,
      ],
      {
        cwd: ROOT,
        env: { ...process.env, WORKFLOW_DIR: path.join(dir, "global") },
      },
    );
    const text = fs.readFileSync(out, "utf8");
    const file = JSON.parse(text) as ReplayFile;
    expect(file.sessions).toEqual(["aaaa1111", "aaaa1111-k0", "aaaa1111-k1"]);
    expect(file.taskKinds).toEqual({ "TASK-aaaa1111": "bug" });
    expect(Object.keys(file.workflows)).toContain("slice-pipeline");
    for (const secret of ["golf", "GOLF", "someone", "/Users/"]) expect(text).not.toContain(secret);
  }, 120_000);
});
