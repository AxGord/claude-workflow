import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./dashboard.js";
import { Storage } from "./storage.js";
import { ledgerEntry } from "./ledger.js";
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
    const base = { started_at: T("10:00:00"), updated_at: T("10:00:00"), active_frame: 0 };
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
      buildTimeline({ sessions: [{} as never], ledger: [], day: "2026-11-08", now: ms("12:00:00") })
        ?.bars,
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

  it("a malformed day is no timeline", () => {
    expect(dayStart("2026-13-40")).toBeNull();
    expect(dayStart("today")).toBeNull();
    expect(buildTimeline({ sessions: [], ledger: [], day: "x", now: 0 })).toBeNull();
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
