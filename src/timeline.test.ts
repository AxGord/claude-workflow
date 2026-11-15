import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./dashboard.js";
import { Storage } from "./storage.js";
import { ledgerEntry, type LedgerEntry } from "./ledger.js";
import { buildTimeline, sessionSegments, stageGroupOf, dayStart } from "./timeline.js";
import type { Loader } from "./loader.js";
import type { SessionState } from "./types.js";

const T = (hms: string): string => new Date(`2026-11-08T${hms}`).toISOString();
const ms = (hms: string): number => Date.parse(T(hms));

function session(
  id: string,
  extra: Partial<SessionState> & Record<string, unknown> = {},
): SessionState {
  return {
    session_id: id,
    stack: [],
    active_frame: -1,
    started_at: T("10:00:00"),
    updated_at: T("10:30:00"),
    overrides: {},
    context: {},
    history: [],
    ...extra,
  };
}

const HISTORY = [
  { frame: 0, at: T("10:00:00"), event: "start", workflow: "engine-task" },
  { frame: 0, at: T("10:05:00"), from: "recon", to: "work", via: "go" },
  // gate ran 10:10:00..10:20:00 after 2 minutes waiting for a lease
  { frame: 0, at: T("10:20:00"), from: "work", to: "gate", via: "ok" },
  {
    frame: 0,
    at: T("10:30:00"),
    from: "gate",
    to: "land",
    event: "action",
    wait_ms: 120000,
    duration_ms: 480000,
  },
  { frame: 0, at: T("10:31:00"), event: "complete" },
];

describe("stageGroupOf", () => {
  it("maps slice-pipeline state names to groups, work by default, an override first", () => {
    const g = (s: string): string => stageGroupOf(s);
    expect(["recon", "plan", "work", "gate", "review", "land", "blocked"].map(g)).toEqual([
      "recon",
      "plan",
      "work",
      "gate",
      "review",
      "land",
      "wait",
    ]);
    expect(g("execute")).toBe("work");
    expect(stageGroupOf("execute", { execute: "gate" })).toBe("gate");
    expect(stageGroupOf("execute", { execute: "nonsense" })).toBe("work");
  });
});

describe("sessionSegments", () => {
  it("cuts a history into states, the first from the session start, waits inside the exec's state", () => {
    const segs = sessionSegments(
      {
        history: HISTORY,
        started_at: T("10:00:00"),
        updated_at: T("10:31:00"),
        stack: [],
      },
      ms("11:00:00"),
    );
    expect(segs.map(s => [s.state, s.group, s.start, s.end])).toEqual([
      ["recon", "recon", ms("10:00:00"), ms("10:05:00")],
      ["work", "work", ms("10:05:00"), ms("10:20:00")],
      ["gate", "gate", ms("10:20:00"), ms("10:30:00")],
      ["land", "land", ms("10:30:00"), ms("10:31:00")],
    ]);
    // the gate's wait ends where the run starts: at - duration, `wait_ms` long
    expect(segs[2]?.waits).toEqual([{ start: ms("10:20:00"), end: ms("10:22:00") }]);
  });

  it("a push entry's `to` opens the sub-workflow's first state; a live session runs to now", () => {
    const segs = sessionSegments(
      {
        history: [
          { frame: 0, at: T("10:00:00"), event: "start", workflow: "p" },
          { frame: 0, at: T("10:01:00"), from: "a", to: "sub" },
          {
            frame: 1,
            at: T("10:01:00"),
            event: "push",
            workflow: "child",
            to: "child_work",
          },
        ],
        started_at: T("10:00:00"),
        updated_at: T("10:01:00"),
        stack: [{}, {}],
      } as never,
      ms("10:09:00"),
    );
    expect(segs.map(s => [s.state, s.end])).toEqual([
      ["a", ms("10:01:00")],
      ["child_work", ms("10:09:00")],
    ]);
  });
});

describe("sessionSegments edge cases", () => {
  it("a session that has not moved is on its initial state; its first exec keeps the pool-wait hatch", () => {
    const frame = { workflow: "w", current_state: "gate" };
    const base = {
      started_at: T("10:00:00"),
      updated_at: T("10:00:00"),
      active_frame: 0,
    };
    const idle = sessionSegments({ ...base, history: [], stack: [frame] } as never, ms("10:10:00"));
    expect(idle.map(x => [x.state, x.start, x.end])).toEqual([
      ["gate", ms("10:00:00"), ms("10:10:00")],
    ]);
    const first = sessionSegments(
      {
        ...base,
        stack: [],
        history: [
          {
            frame: 0,
            at: T("10:10:00"),
            from: "gate",
            to: "land",
            event: "action",
            wait_ms: 60000,
            duration_ms: 240000,
          },
        ],
      },
      ms("11:00:00"),
    );
    expect(first[0]?.waits).toEqual([{ start: ms("10:05:00"), end: ms("10:06:00") }]);
  });

  it("a session suspended before its first move ends at the suspend, not now", () => {
    const segs = sessionSegments(
      {
        started_at: T("10:00:00"),
        updated_at: T("10:10:00"),
        suspended_at: T("10:10:00"),
        active_frame: 0,
        stack: [{ workflow: "w", current_state: "work" }],
        history: [
          { frame: 0, at: T("10:00:00"), event: "start", workflow: "w" },
          { frame: 0, at: T("10:10:00"), event: "suspend" },
        ],
      } as never,
      ms("12:00:00"),
    );
    expect(segs.map(x => [x.state, x.end])).toEqual([["work", ms("10:10:00")]]);
  });

  it("a resume reopens the state the suspend closed", () => {
    const segs = sessionSegments(
      {
        started_at: T("10:00:00"),
        updated_at: T("10:40:00"),
        active_frame: 0,
        stack: [{ workflow: "w", current_state: "work" }],
        history: [
          { frame: 0, at: T("10:05:00"), from: "recon", to: "work" },
          { frame: 0, at: T("10:10:00"), event: "suspend" },
          { frame: 0, at: T("10:30:00"), event: "resume" },
        ],
      } as never,
      ms("10:40:00"),
    );
    expect(segs.map(x => [x.state, x.start, x.end])).toEqual([
      ["recon", ms("10:00:00"), ms("10:05:00")],
      ["work", ms("10:05:00"), ms("10:10:00")],
      ["work", ms("10:30:00"), ms("10:40:00")],
    ]);
  });

  it("buildTimeline skips the placeholder record of a session being created", () => {
    expect(
      buildTimeline({
        sessions: [{} as never],
        ledger: [],
        day: "2026-11-08",
        now: ms("12:00:00"),
      })?.bars,
    ).toEqual([]);
  });
});

describe("buildTimeline", () => {
  const root = session("root", { stack: [{}] as never, active_frame: 0 });
  const task = session("t1", {
    parent_session_id: "root",
    root_session_id: "root",
    history: HISTORY,
    updated_at: T("10:31:00"),
    context: { slice: "LINE-1" },
  });
  const sub = session("t1-agent", {
    parent_session_id: "t1",
    root_session_id: "root",
    history: [
      { frame: 0, at: T("10:06:00"), event: "start", workflow: "agent" },
      { frame: 0, at: T("10:07:00"), from: "review", to: "done" },
    ] as never,
  });
  const other = session("t2", {
    parent_session_id: "root",
    root_session_id: "root",
    started_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T11:00:00.000Z",
  });

  it("one bar per child of a root with children, a child session as a sub-row, the day's overlap only", () => {
    const tl = buildTimeline({
      sessions: [root, task, sub, other],
      ledger: [],
      day: "2026-11-08",
      now: ms("12:00:00"),
    })!;
    expect(tl.bars.map(b => [b.id, b.task, b.outcome, b.detailed])).toEqual([
      ["t1", "LINE-1", "completed", true],
    ]);
    expect(tl.bars[0]?.rows.map(r => [r.session, r.depth])).toEqual([
      ["t1", 0],
      ["t1-agent", 1],
    ]);
    expect(tl.bars[0]?.start).toBe(ms("10:00:00"));
    expect(tl.to - tl.from).toBeGreaterThanOrEqual(23 * 3600000);
  });

  it("clips a segment to the day, filters by root, and draws a pruned session from the ledger", () => {
    const led = ledgerEntry(
      session("gone", {
        parent_session_id: "root2",
        root_session_id: "root2",
        history: [],
      }),
    );
    const tl = buildTimeline({
      sessions: [root, task],
      ledger: [
        {
          ...led,
          workflow: "engine-task",
          started_at: T("09:00:00"),
          ended_at: T("09:20:00"),
        },
      ],
      day: "2026-11-08",
      now: ms("12:00:00"),
    })!;
    expect(tl.bars.map(b => [b.id, b.detailed])).toEqual([
      ["gone", false],
      ["t1", true],
    ]);
    const only = buildTimeline({
      sessions: [root, task],
      ledger: [],
      day: "2026-11-08",
      root: "nobody",
      now: ms("12:00:00"),
    })!;
    expect(only.bars).toEqual([]);
    const nextDay = buildTimeline({
      sessions: [root, task],
      ledger: [],
      day: "2026-11-09",
      now: ms("12:00:00"),
    })!;
    expect(nextDay.bars).toEqual([]);
  });

  it("a pruned session with recorded segments draws them; an old line stays one bar", () => {
    const base = ledgerEntry(
      session("gone2", {
        parent_session_id: "root2",
        root_session_id: "root2",
        history: [],
      }),
    );
    const mk = (id: string, segs?: LedgerEntry["segs"]): LedgerEntry => ({
      ...base,
      session_id: id,
      workflow: "engine-task",
      started_at: T("09:00:00"),
      ended_at: T("09:20:00"),
      ...(segs ? { segs } : {}),
    });
    const tl = buildTimeline({
      sessions: [],
      ledger: [
        mk("seg", [
          {
            s: "work",
            a: ms("09:00:00"),
            b: ms("09:10:00"),
            w: [ms("09:01:00"), ms("09:02:00")],
          },
          { s: "review", a: ms("09:10:00"), b: ms("09:20:00") },
        ]),
        mk("old"),
      ],
      day: "2026-11-08",
      now: ms("12:00:00"),
    })!;
    const seg = tl.bars.find(b => b.id === "seg")!;
    expect(seg.rows[0]?.segments.map(g => [g.state, g.group, g.waits.length])).toEqual([
      ["work", "work", 1],
      ["review", "review", 0],
    ]);
    expect(tl.bars.find(b => b.id === "old")!.rows[0]?.segments.map(g => g.state)).toEqual([
      "engine-task",
    ]);
  });

  it("ledgerEntry records the state segments", () => {
    const e = ledgerEntry(task);
    expect(e.segs?.map(g => g.s)).toContain("work");
  });

  it("a malformed day is no timeline", () => {
    expect(dayStart("2026-13-40")).toBeNull();
    expect(dayStart("today")).toBeNull();
    expect(buildTimeline({ sessions: [], ledger: [], day: "x", now: 0 })).toBeNull();
  });
});

describe("buildTimeline: a bar per task pipeline", () => {
  const hist = (workflow: string, moves: [string, string, string][], end?: string) => [
    { frame: 0, at: T("10:00:00"), event: "start", workflow },
    ...moves.map(([at, from, to]) => ({ frame: 0, at: T(at), from, to })),
    ...(end ? [{ frame: 0, at: T(end), event: "complete" }] : []),
  ];
  const child = (
    id: string,
    parent: string,
    workflow: string,
    start: string,
    end: string,
    ctx: Record<string, unknown> = {},
  ): SessionState =>
    session(id, {
      parent_session_id: parent,
      root_session_id: "top",
      started_at: T(start),
      updated_at: T(end),
      context: ctx,
      history: [
        { frame: 0, at: T(start), event: "start", workflow },
        { frame: 0, at: T(end), from: "run", to: "done" },
      ] as never,
    });
  const pipeline = (id: string, task: string, end: string, extra: Partial<SessionState> = {}) =>
    session(id, {
      parent_session_id: "disp",
      root_session_id: "top",
      started_at: T("10:00:00"),
      updated_at: T(end),
      context: { slice: task },
      history: hist(
        "slice-pipeline",
        [
          ["10:10:00", "claim", "work"],
          ["10:30:00", "work", "review"],
          ["10:40:00", "review", "work"],
          ["10:50:00", "work", "review"],
          ["11:00:00", "review", "land"],
        ],
        end,
      ),
      ...extra,
    });
  const top = session("top", { stack: [{}] as never, active_frame: 0 });
  const disp = session("disp", {
    parent_session_id: "top",
    root_session_id: "top",
    stack: [{ workflow: "slice-dispatch", current_state: "dispatch" }] as never,
    active_frame: 0,
    started_at: T("09:50:00"),
    updated_at: T("11:30:00"),
    history: hist("slice-dispatch", []),
  });
  const p1 = pipeline("p1", "LINE-1", "11:05:00");
  const p2 = pipeline("p2", "LINE-2", "11:20:00", { outcome: "failed" });
  const kids = [
    child("p1-recon", "p1", "slice-recon", "10:01:00", "10:09:00", { model: "claude-sonnet-4-5" }),
    child("p1-w1", "p1", "slice-worker", "10:11:00", "10:29:00", { model: "claude-opus-4-5" }),
    child("p1-w2", "p1", "slice-worker", "10:41:00", "10:49:00", { model: "claude-opus-4-5" }),
    child("p1-rev", "p1", "slice-review", "10:31:00", "10:39:00"),
    // a helper that inherited the task id is a row of the pipeline, not a bar
    child("p1-helper", "p1", "slice-recon", "10:02:00", "10:04:00", { slice: "LINE-1" }),
    // ran another day: no segment in this one, so no row
    {
      ...child("p1-old", "p1", "slice-probe", "10:00:00", "10:01:00"),
      started_at: "2026-11-01T10:00:00.000Z",
      updated_at: "2026-11-01T10:01:00.000Z",
      history: [
        { frame: 0, at: "2026-11-01T10:00:00.000Z", event: "start", workflow: "slice-probe" },
        { frame: 0, at: "2026-11-01T10:01:00.000Z", from: "run", to: "done" },
      ] as never,
    },
  ];
  const led = (s: SessionState, over: Partial<LedgerEntry>): LedgerEntry => ({
    ...ledgerEntry(s),
    ...over,
  });
  const spend = (usd: number) => ({
    agents: 1,
    usd,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
  });
  const run = (sessions: SessionState[], ledger: LedgerEntry[] = []) =>
    buildTimeline({ sessions, ledger, day: "2026-11-08", now: ms("12:00:00") })!;

  it("a pipeline under a dispatcher is its own bar named by its task; the dispatcher is one row at the bottom", () => {
    const tl = run([top, disp, p1, p2, ...kids]);
    expect(tl.bars.map(b => [b.id, b.kind, b.label])).toEqual([
      ["p1", "task", "LINE-1"],
      ["p2", "task", "LINE-2"],
      ["disp", "parent", "parent · slice-dispatch"],
    ]);
    expect(tl.bars.at(-1)?.rows.map(r => r.session)).toEqual(["disp"]);
    // the session above the dispatcher is no bar
    expect(tl.bars.some(b => b.id === "top")).toBe(false);
  });

  it("the same pipelines with no dispatcher are the same bars, one per task", () => {
    const loose = [p1, p2].map(p => ({
      ...p,
      parent_session_id: undefined,
      root_session_id: undefined,
    }));
    const tl = run([...loose, ...kids]);
    expect(tl.bars.map(b => [b.id, b.kind])).toEqual([
      ["p1", "task"],
      ["p2", "task"],
    ]);
  });

  it("a bar's rows are the pipeline and its agent sessions, named by role, model and round; a row with no segment in the day is dropped", () => {
    const tl = run([top, disp, p1, p2, ...kids]);
    const p = tl.bars.find(b => b.id === "p1")!;
    expect(p.rows.map(r => [r.session, r.depth, r.name])).toEqual([
      ["p1", 0, "LINE-1"],
      ["p1-recon", 1, "recon r1 · sonnet"],
      ["p1-helper", 1, "recon r2"],
      ["p1-w1", 1, "worker r1 · opus"],
      ["p1-rev", 1, "review"],
      ["p1-w2", 1, "worker r2 · opus"],
    ]);
    expect(p.rows.slice(1).map(r => [r.role, r.model, r.round])).toEqual([
      ["recon", "sonnet", 1],
      ["recon", null, 2],
      ["worker", "opus", 1],
      ["review", null, 1],
      ["worker", "opus", 2],
    ]);
    expect(p.rows.some(r => r.session === "p1-old")).toBe(false);
  });

  it("each bar carries its duration, review rounds, spend, project and how it ended", () => {
    const ledger = [
      led(p1, {
        project: "/work/anyparse",
        spend: spend(1.25),
        parent_spend: { usd: 0.5 } as never,
      }),
      led(p2, { project: "/work/other" }),
      // a same-task child adds its own parent turns, not its spend (the head's already covers the subtree)
      led(kids[4], { spend: spend(9), parent_spend: { usd: 0.25 } as never }),
    ];
    const tl = run([top, disp, p1, p2, ...kids], ledger);
    const [a, b] = tl.bars;
    expect(a).toMatchObject({
      id: "p1",
      duration_ms: ms("11:05:00") - ms("10:00:00"),
      rounds: 2,
      usd: 2,
      project: "anyparse",
      result: "landed",
    });
    // no spend recorded is not $0; a failed run is failed
    expect(b).toMatchObject({ id: "p2", usd: null, project: "other", result: "failed" });
  });

  it("review rounds are entries into `review`, not the segments of its spawn and route states", () => {
    const moves: [string, string, string][] = [
      ["10:10:00", "claim", "work"],
      ["10:20:00", "work", "review_spawn"],
      ["10:21:00", "review_spawn", "review"],
      ["10:30:00", "review", "review_route"],
      ["10:31:00", "review_route", "work"],
      ["10:40:00", "work", "review_spawn"],
      ["10:41:00", "review_spawn", "review"],
      ["10:50:00", "review", "review_route"],
      ["10:51:00", "review_route", "land"],
    ];
    const rr = session("r1", {
      context: { task: "LINE-5" },
      history: hist("engine-task", moves, "11:00:00"),
    });
    expect(run([rr]).bars[0]?.rounds).toBe(2);
    // a pruned session: the ledger line's visits say it
    const old = led(rr, { visits: { review: 3 } });
    expect(run([], [old]).bars[0]?.rounds).toBe(3);
  });

  it("only a state named land (or <x>_land) lands a pipeline: land_failed does not", () => {
    const via = (id: string, state: string) =>
      session(id, {
        context: { task: `L-${id}` },
        history: hist("engine-task", [["10:10:00", "work", state]], "10:20:00"),
      });
    const tl = run([via("a", "project_land"), via("b", "land_failed"), via("c", "land")]);
    expect(tl.bars.map(b => [b.id, b.result])).toEqual([
      ["a", "landed"],
      ["b", "closed"],
      ["c", "landed"],
    ]);
  });

  it("a completed pipeline that never reached land is closed; one still on the stack is running", () => {
    const noLand = session("n1", {
      context: { task: "LINE-3" },
      history: hist("engine-task", [["10:10:00", "claim", "work"]], "10:20:00"),
    });
    const live = session("n2", {
      context: { task: "LINE-4" },
      stack: [{ workflow: "engine-task", current_state: "work" }] as never,
      active_frame: 0,
      history: hist("engine-task", []),
    });
    const tl = run([noLand, live]);
    expect(tl.bars.map(b => [b.id, b.result])).toEqual([
      ["n1", "closed"],
      ["n2", "running"],
    ]);
    expect(tl.bars[1]?.duration_ms).toBe(ms("12:00:00") - ms("10:00:00"));
  });

  it("the older rule still holds where no task hangs under a session: a child of a root is a bar", () => {
    const tl = run([top, child("c1", "top", "w", "10:00:00", "10:10:00")]);
    expect(tl.bars.map(b => [b.id, b.kind, b.task])).toEqual([["c1", "task", null]]);
    // no task: the label is the workflow
    expect(tl.bars[0]?.label).toBe("w");
    expect(tl.bars[0]?.rows[0]?.name).toBe("w");
  });
});

describe("the ledger does not count a push as a move", () => {
  it("transitions and visits ignore the `to` a push carries", () => {
    const e = ledgerEntry(
      session("s", {
        history: [
          { frame: 0, at: T("10:00:00"), event: "start", workflow: "w" },
          { frame: 0, at: T("10:01:00"), from: "a", to: "sub" },
          {
            frame: 1,
            at: T("10:01:00"),
            event: "push",
            workflow: "c",
            to: "c0",
          },
        ] as never,
      }),
    );
    expect(e.transitions).toBe(1);
    expect(e.visits).toEqual({ sub: 1 });
  });
});

describe("GET /api/timeline", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  async function up(): Promise<{
    base: string;
    dir: string;
    storage: Storage;
  }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-tl-"));
    dirs.push(dir);
    const storage = new Storage(path.join(dir, "state"));
    await storage.write("root", session("root", { stack: [{}] as never, active_frame: 0 }));
    await storage.write(
      "t1",
      session("t1", {
        parent_session_id: "root",
        root_session_id: "root",
        history: HISTORY,
      }),
    );
    const server = buildApp(storage, {} as Loader).listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise(r => server.once("listening", r));
    return {
      base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      dir,
      storage,
    };
  }

  it("answers the day's bars; the operator's groups file recolours a state; a bad day is 400", async () => {
    const { base, dir } = await up();
    const get = (q: string): Promise<Response> => fetch(`${base}/api/timeline?${q}`);
    const body = (await (await get("day=2026-11-08")).json()) as {
      bars: {
        id: string;
        rows: { segments: { state: string; group: string }[] }[];
      }[];
    };
    expect(body.bars.map(b => b.id)).toEqual(["t1"]);
    expect(body.bars[0]?.rows[0]?.segments.map(s => [s.state, s.group])).toEqual([
      ["recon", "recon"],
      ["work", "work"],
      ["gate", "gate"],
      ["land", "land"],
    ]);
    fs.writeFileSync(path.join(dir, "state", "timeline-groups.conf"), '{"work":"review"}');
    const again = (await (await get("day=2026-11-08")).json()) as typeof body;
    expect(again.bars[0]?.rows[0]?.segments[1]?.group).toBe("review");
    expect((await get("day=nope")).status).toBe(400);
    // the file sits in the state dir without being read as a session
    expect(((await (await fetch(`${base}/api/sessions`)).json()) as unknown[]).length).toBe(2);
  });
});
