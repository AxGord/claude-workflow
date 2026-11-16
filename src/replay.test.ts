import { execFileSync, spawnSync } from "node:child_process";
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
  cameraTop,
  conversationAt,
  conversationTail,
  snapshotAt,
  fitView,
  renderReplay,
  REPLAY_QUEUE,
  REPLAY_QUEUE_NOTE,
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
  o: {
    project?: string;
    reviews?: number;
    moves?: string[];
    task?: string;
    queue?: string;
    alone?: boolean;
  } = {},
): WfEvent[] {
  const project = o.project ?? "anyparse";
  const out: WfEvent[] = [
    ev(a, "session_start", id, {
      workflow: o.alone === true ? "engine-task" : "slice-pipeline",
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
  for (let r = 0; r < (o.alone === true ? 0 : (o.reviews ?? 0) + 1); r++) {
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

describe("the map fits its frame: no scroll", () => {
  it("the view is the map's width (at least the frame's) at the frame's proportions", () => {
    expect(fitView(1920, 3000, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(fitView(3840, 500, 1920, 1080)).toEqual({ width: 3840, height: 2160 });
    expect(fitView(800, 500, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });

  it("the camera follows the running lanes when the map is taller than the view", () => {
    const lane = (y: number, status: "running" | "landed") => ({ y, height: 40, status }) as never;
    const map = (lanes: never[], height: number) =>
      ({ width: 1920, height, next: [], bands: [{ y: 100, lanes }] }) as never;
    // fits: no camera
    expect(cameraTop(map([lane(0, "running")], 900), 1080)).toBe(0);
    // the running lanes (y 1100..1340 absolute) centred in a 1080 view
    expect(
      cameraTop(map([lane(0, "landed"), lane(1000, "running"), lane(1200, "running")], 4000), 1080),
    ).toBe(1220 - 540);
    // nothing runs: the bottom
    expect(cameraTop(map([lane(0, "landed")], 4000), 1080)).toBe(4000 - 1080);
    // kept inside the map
    expect(cameraTop(map([lane(0, "running")], 2000), 1080)).toBe(0);
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

  it("keys every line of its conversation uniquely, and a line keeps its key as the window scrolls", () => {
    const all = conversationAt(file, file.durationMs);
    const keys = conversationTail(file, file.durationMs, all.length).map(t => t.key);
    expect(new Set(keys).size).toBe(all.length);
    // a line keeps its key as the window scrolls: the tail's keys are the whole conversation's indices
    const tail = conversationTail(file, file.durationMs, 5);
    expect(tail.map(t => t.key)).toEqual([0, 1, 2, 3, 4].map(i => all.length - 5 + i));
    expect(tail.map(t => t.line)).toEqual(all.slice(-5));
  });

  it("carries the ledger's spend of its landed tasks and the engine's own lanes on their stations", () => {
    const spend = file.spend ?? {};
    const landed = snapshotAt(file, file.durationMs).lands;
    expect(landed.length).toBeGreaterThan(0);
    // every landed row the scene draws shows $x.xx, and the Landed heading its sum
    for (const l of landed) expect(spend[l.slice]).toBeGreaterThan(0);
    expect(landed.every(l => typeof l.usd === "number")).toBe(true);
    expect(snapshotAt(file, file.durationMs).landedUsd).toBeGreaterThan(0);
    const engine = [...sessions.values()].filter(s => s.workflow === "engine-task");
    expect(engine.length).toBeGreaterThan(0);
    expect(engine.every(s => s.parent === null && s.project === "mcp-workflow-engine")).toBe(true);
    expect(engine.some(s => s.outcome === "completed" && typeof s.task === "string")).toBe(true);
    expect(file.workflows["engine-task"]?.stations?.length).toBeGreaterThan(0);
    // the task ids of the spend are the replay's own tasks only
    const tasks = new Set([...sessions.values()].map(s => s.task));
    for (const id of Object.keys(spend)) expect(tasks.has(id)).toBe(true);
  });

  it("carries the queue as the engine's pick sees it: lines with reasons, and a Waiting count above zero at some moment", () => {
    expect(file.queue?.lines.length).toBeGreaterThan(0);
    const blocked =
      file.queue?.lines.filter(l => l.after !== undefined || l.against !== undefined) ?? [];
    expect(blocked.length).toBeGreaterThan(0);
    const step = 60_000;
    const waiting: number[] = [];
    for (let at = 0; at <= file.durationMs; at += step) {
      waiting.push(snapshotAt(file, at).queue?.waiting.length ?? 0);
    }
    expect(Math.max(...waiting)).toBeGreaterThan(0);
    // Waiting drains as the sessions that block its lines end, so the lines do not all wait for the whole window
    expect(Math.min(...waiting)).toBeLessThan(Math.max(...waiting));
  });

  it("is under 300 KB", () => {
    expect(Buffer.byteLength(raw)).toBeLessThan(300_000);
  });

  it("is the open-source projects' sessions only: no other project, home path or private name", () => {
    expect(file.project).toBe("anyparse");
    for (const bad of ["/Users/", "/home/", "golf", "playtechstudios", "TM-Haxe4", "ask_parent"])
      expect(raw).not.toContain(bad);
    const roots = [...sessions.values()].filter(s => s.parent === null);
    expect(roots.length).toBeGreaterThan(0);
    for (const r of roots) expect(file.projects ?? [file.project]).toContain(r.project);
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

  /** The export script run over a temp event log, ledger and a project whose queue file is `queueYaml`: its output file, text and stderr. */
  function exportWith(queueYaml: string): { file: ReplayFile; text: string; stderr: string } {
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
    // the engine's own workflow lives in ITS project directory, not in the replay's project's
    fs.mkdirSync(path.join(dir, "engine", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "engine", "workflows", "engine-task.yaml"),
      "name: engine-task\ndescription: test\ninitial: claim\nstates:\n  claim:\n    type: prompt\n    prompt: go\n    transitions:\n      go: done\n  done:\n    terminal: true\n    outcome: complete\n",
    );
    fs.writeFileSync(path.join(dir, "project", ".claude", "batch", "queue.yaml"), queueYaml);
    const lines = [
      ...pipeline("aaaa1111", 0, 30, { reviews: 1 }),
      ...pipeline("eeee5555", 5, 35, {
        project: "mcp-workflow-engine",
        task: "ENG-X",
        alone: true,
      }),
      ...OTHER,
    ].map(e => JSON.stringify(e));
    const row = (task: string, usd: number): string =>
      JSON.stringify({ task, workflow: "slice-pipeline", ended_at: at(30), spend: { usd } });
    fs.writeFileSync(
      path.join(dir, "ledger.jsonl"),
      [row("TASK-aaaa1111", 1.25), row("ENG-X", 0.5), row("GOLF-PRIVATE-TASK", 99), "{torn"].join(
        "\n",
      ),
    );
    fs.writeFileSync(path.join(dir, "events", "run-a.jsonl"), `${lines.join("\n")}\n{"torn`);
    const out = path.join(dir, "out", "replay.json");
    const run = spawnSync(
      "node",
      [
        "scripts/export-replay.mjs",
        "--events",
        path.join(dir, "events"),
        "--project-dir",
        path.join(dir, "project"),
        "--ledger",
        path.join(dir, "ledger.jsonl"),
        "--workflows",
        path.join(dir, "engine", "workflows"),
        "--from",
        at(-1),
        "--out",
        out,
      ],
      {
        cwd: ROOT,
        // the default ledger and event log are the state directory's: never the real one
        env: { ...process.env, WORKFLOW_DIR: path.join(dir, "global"), STATE_DIR: dir },
        encoding: "utf8",
      },
    );
    if (run.status !== 0) throw new Error(`export-replay failed: ${run.stderr}`);
    const text = fs.readFileSync(out, "utf8");
    return { file: JSON.parse(text) as ReplayFile, text, stderr: run.stderr };
  }

  it("writes the replay of one project from an event log directory", () => {
    const { file, text, stderr } = exportWith(
      "tasks:\n  - id: TASK-aaaa1111\n    kind: bug\n  - id: GOLF-PRIVATE-TASK\n    kind: feature\n",
    );
    expect(file.sessions).toEqual(["aaaa1111", "aaaa1111-k0", "aaaa1111-k1", "eeee5555"]);
    expect(file.projects).toEqual(["anyparse", "mcp-workflow-engine"]);
    expect(file.spend).toEqual({ "ENG-X": 0.5, "TASK-aaaa1111": 1.25 });
    expect(file.taskKinds).toEqual({ "TASK-aaaa1111": "bug" });
    expect(Object.keys(file.workflows)).toContain("slice-pipeline");
    // --workflows: the engine lane's workflow has the stations the map draws it on
    expect(file.workflows["engine-task"]?.stations?.map(st => st.name)).toEqual(["claim", "done"]);
    for (const secret of ["golf", "GOLF", "someone", "/Users/"]) expect(text).not.toContain(secret);
    // a queue file the pick cannot read (no header) writes no queue section
    expect(file.queue).toBeUndefined();
    expect(stderr).toContain("no queue section");
  }, 120_000);

  it("writes the queue the engine's pick sees, rolled back to the window's start, for the replay's projects only", () => {
    const line = (id: string, o: string): string =>
      `  - id: ${id}\n    difficulty: 4\n    text: PRIVATE TEXT OF ${id}\n${o}`;
    const { file, text } = exportWith(
      [
        "batch_size: 2",
        "tasks:",
        line(
          "TASK-aaaa1111",
          "    status: done\n    kind: bug\n    repo: /anyparse\n    touches: [ src/a ]",
        ),
        line("ENG-X", "    status: done\n    repo: /mcp-workflow-engine\n    touches: [ src/e ]"),
        line(
          "NEXT-ONE",
          "    repo: /anyparse\n    after: [ TASK-aaaa1111 ]\n    touches: [ src/n ]",
        ),
        line("GOLF-PRIVATE-TASK", "    repo: /golf\n    touches: [ src/g ]"),
      ].join("\n"),
    );
    expect(file.queue?.lines.map(l => l.id)).toEqual(["TASK-aaaa1111", "ENG-X", "NEXT-ONE"]);
    expect(file.queue?.lines.find(l => l.id === "NEXT-ONE")?.after).toEqual(["TASK-aaaa1111"]);
    expect(file.queue?.note).toBe(REPLAY_QUEUE_NOTE);
    for (const secret of ["golf", "GOLF", "PRIVATE TEXT", "/Users/"])
      expect(text).not.toContain(secret);
    // played back: before the first task lands the line that waits for it is Waiting, after it Next
    const t0 = Date.parse(file.start);
    const sec = (min: number): number => min * 60_000 - (Date.parse(at(0)) - t0);
    expect(snapshotAt(file, sec(10)).queue?.waiting.map(w => `${w.id}: ${w.why}`)).toEqual([
      "NEXT-ONE: after: TASK-aaaa1111 (running)",
    ]);
    expect(snapshotAt(file, sec(31)).queue?.ready.map(l => l.id)).toEqual(["NEXT-ONE"]);
  }, 120_000);
});
