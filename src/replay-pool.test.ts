import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nodeText, paneTree, type PaneEl, type PaneNode } from "../hooks/pane-view.js";
import type { WfEvent } from "./event-fold.js";
import {
  assertReplayClean,
  buildPool,
  buildReplay,
  POOL_UNNAMED,
  poolCountsAt,
  poolLabelAllowed,
  poolLogSpan,
  poolStateAt,
  poolStrip,
  poolWaiting,
  renderReplay,
  snapshotAt,
  type PoolFrame,
  type ReplayFile,
} from "./replay.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const T0 = Date.parse("2026-11-13T06:00:00.000Z");
const iso = (sec: number): string => new Date(T0 + sec * 1000).toISOString();
const NAMES = {
  tasks: new Set(["SLICE-A"]),
  sessions: new Set(["aaaa1111"]),
};
const opts = {
  project: "anyparse",
  from: T0,
  to: T0 + 600_000,
  ...NAMES,
  threshold: 2,
};

const sample = (
  sec: number,
  held: number,
  leases: number,
  asks: string[],
  total = asks.length,
): string =>
  `${iso(sec)} sample: load 9.5 external 1.0 held ${held}/14 runs 5.0 leases ${leases} waiting ${total}${asks.length > 0 ? ` [${asks.join(", ")}]` : ""}`;

describe("buildPool cuts the machine's pool log down to what the replay may name", () => {
  const lines = [
    sample(30, 8, 3, ["4-8 + lock anyparse-land", "2", "2 + lock someone-else-land"]),
    `${iso(50)} overrun: pid 4242 holds 3 threads, runs ~7 — slice-gate SLICE-A infra4`,
    `${iso(51)} overrun: pid 4243 holds 2 threads, runs ~5 — slice-gate ELSEWHERE-TASK unit`,
    `${iso(52)} starved: pid 4244 queued 15m for 2-3 threads (starve_after 15m): held 14/14 — slice-gate SLICE-A suite,corpus`,
    `${iso(54)} underuse: pid 4246 holds 4 threads, runs ~0 — slice-gate SLICE-A unit`,
    `${iso(55)} underuse: pid 4247 holds 4 threads, runs ~1 — slice-gate ELSEWHERE-TASK unit`,
    `${iso(53)} backfill: pid 4245 takes 1 threads ahead of 99-aa (est 14s) — cd /Users/someone/dev/elsewhere && make SLICE-A`,
    sample(90, 14, 4, ["6", "+3"], 5),
    sample(1000, 2, 1, []),
  ];
  const pool = buildPool(lines, opts);

  it("a sample is a frame at its offset: held of budget, load, leases, the waiters' asks", () => {
    expect(pool.threshold).toBe(2);
    expect(pool.frames.map(f => f[0])).toEqual([30_000, 90_000]);
    expect(pool.frames[0].slice(1, 7)).toEqual([8, 14, 9.5, 1, 3, 3]);
    expect(pool.frames[1][7]).toEqual(["6", "+3"]);
    expect(pool.frames[1][6]).toBe(5);
  });

  it("every lock but the project's own land lock is made anonymous", () => {
    expect(pool.frames[0][7]).toEqual(["4-8 + lock anyparse-land", "2", "2 + lock"]);
  });

  it("a label is kept only when it names a slice or session of the replay; a mark lands on the first sample after it", () => {
    const seen = pool.frames[1][8];
    expect(seen).toEqual([
      ["overrun", 3, "slice-gate SLICE-A infra4", 7],
      ["starved", 2, "slice-gate SLICE-A suite,corpus", 0],
      ["underuse", 4, "slice-gate SLICE-A unit", 0],
    ]);
    const all = JSON.stringify(pool);
    for (const gone of ["ELSEWHERE", "someone", "4242", "pid", "/Users"])
      expect(all).not.toContain(gone);
  });

  it("the allowlist: plain words, one of them a slice or session of the replay", () => {
    const names = new Set(["SLICE-A", "aaaa1111"]);
    expect(poolLabelAllowed("slice-gate SLICE-A lint", names)).toBe(true);
    expect(poolLabelAllowed("slice-gate aaaa1111", names)).toBe(true);
    expect(poolLabelAllowed("slice-gate OTHER lint", names)).toBe(false);
    expect(poolLabelAllowed("SLICE-A /Users/x/dev", names)).toBe(false);
    expect(poolLabelAllowed("SLICE-A $(pwd)", names)).toBe(false);
    expect(poolLabelAllowed("", names)).toBe(false);
  });

  it("the log's span is its first and last line", () => {
    expect(poolLogSpan(lines)).toEqual({ from: T0 + 30_000, to: T0 + 1_000_000 });
    expect(poolLogSpan(["no timestamp here"])).toBeUndefined();
  });
});

const frame = (
  at: number,
  held: number,
  leases: number,
  asks: string[],
  seen: PoolFrame[8] = [],
  waiting = asks.length,
): PoolFrame => [at, held, 14, 7.5, 1, leases, waiting, asks, seen];

/** A small replay: a pipeline (aaaa1111, task SLICE-A) with a worker whose exec waits 60 s for a lease, and a pool beside it. */
function replay(frames: PoolFrame[]): ReplayFile {
  return {
    version: 1,
    project: "anyparse",
    start: iso(0),
    durationMs: 600_000,
    sessions: ["aaaa1111", "bbbb2222"],
    workflows: {},
    taskKinds: {},
    pool: { threshold: 2, frames },
    events: [
      [0, "session_start", 0, { workflow: "slice-pipeline", task: "SLICE-A", difficulty: "5" }],
      [10_000, "session_start", 1, { workflow: "slice-worker", parent: "aaaa1111" }],
      [100_000, "exec_start", 1, { state: "check" }],
      [
        190_000,
        "exec_end",
        1,
        { state: "check", exit_code: 0, duration_ms: 30_000, wait_ms: 60_000 },
      ],
      [300_000, "exec_start", 1, { state: "gate" }],
      [301_000, "exec_end", 1, { state: "gate", exit_code: 0, duration_ms: 900 }],
      [590_000, "session_end", 0, { outcome: "completed" }],
    ],
  };
}

describe("poolStateAt: the Pool tab's read at a moment of the replay", () => {
  const file = replay([
    frame(
      60_000,
      14,
      4,
      ["4-8 + lock anyparse-land", "2", "+2"],
      [
        ["overrun", 3, "slice-gate SLICE-A infra4", 7],
        ["backfill", 1, "slice-gate aaaa1111 lint", 0],
        ["underuse", 4, "slice-gate SLICE-A unit", 0],
        ["starved", 2, "slice-gate SLICE-A suite", 0],
      ],
      4,
    ),
    frame(120_000, 4, 1, []),
  ]);
  const at = poolStateAt(file, 70_000).pool;

  it("budget, threads held, load, external load, the threshold", () => {
    expect(at).toMatchObject({ budget: 14, held: 14, load: 7.5, external: 1, threshold: 2 });
  });

  it("the leases the log named, with their session, and one row for the rest of the threads", () => {
    expect(at?.leases.map(l => [l.request, l.label, l.session, l.overrun, l.underuse])).toEqual([
      ["3 threads", "slice-gate SLICE-A infra4", "aaaa1111", 7, null],
      ["1 threads", "slice-gate aaaa1111 lint", "aaaa1111", null, null],
      ["4 threads", "slice-gate SLICE-A unit", "aaaa1111", null, 0],
      ["6 threads", `${POOL_UNNAMED}: 1`, "", null, null],
    ]);
    expect(at?.leases[3]).toMatchObject({ project: "", session: "", step: "" });
  });

  it("the waiters in the log's order with their asks, the unlisted ones as one row that counts them, the land lock", () => {
    expect(at?.waiting.map(w => w.request)).toEqual([
      "4-8 threads + lock anyparse-land",
      "2 threads",
      "+2 more waiting",
    ]);
    expect(at?.locks).toEqual(["anyparse-land"]);
  });

  it("the log carries no priority and no age: a row has none, and the pane leaves them out", () => {
    for (const l of [...(at?.leases ?? []), ...(at?.waiting ?? [])])
      expect([l.priority, l.ageMs]).toEqual(["", -1]);
    const tree = paneTree({
      snapshot: snapshotAt(file, 70_000),
      tab: "pool",
      expanded: "",
      folded: [],
      now: Date.parse(file.start) + 70_000,
      columns: 100,
      rows: 30,
      poolCounts: poolCountsAt(file, 70_000),
      pool: poolStateAt(file, 70_000),
    });
    const lines: string[] = [];
    const walk = (n: PaneNode): void => {
      if (n === null || typeof n === "string") return;
      if (Array.isArray(n)) return void (n as readonly PaneNode[]).forEach(walk);
      const el = n as PaneEl;
      if (el.el === "link") return;
      if (el.el === "text") lines.push(nodeText(el));
      else el.children.forEach(walk);
    };
    walk(tree);
    expect(lines.some(l => /Pool 14\/14/.test(l))).toBe(true);
    expect(lines).toContain("  1. 4-8 threads + lock anyparse-land");
    expect(lines.some(l => /OVERRUN ~7/.test(l))).toBe(true);
    expect(lines.some(l => /UNDERUSE ~0/.test(l))).toBe(true);
    expect(lines.some(l => /prio|·\s*\d+s/.test(l) && /threads/.test(l))).toBe(false);
    expect(lines.some(l => l.includes("STARVED: slice-gate SLICE-A suite"))).toBe(true);
  });

  it("a pool that logged nothing for a while was empty; no pool in the file is said so", () => {
    expect(poolStateAt(file, 400_000)).toMatchObject({
      pool: null,
      error: expect.stringContaining("idle") as string,
    });
    expect(poolCountsAt(file, 400_000)).toEqual({ held: 0, budget: 14, waiting: 0 });
    expect(poolCountsAt(file, 130_000)).toEqual({ held: 4, budget: 14, waiting: 0 });
    const bare: ReplayFile = { ...file, pool: undefined };
    expect(poolStateAt(bare, 70_000).error).toContain("no pool");
    expect(poolCountsAt(bare, 70_000)).toBeNull();
  });
});

describe("poolWaiting: the lanes that wait for the pool", () => {
  const file = replay([]);
  it("an exec waits from its start for its wait_ms, and the pipeline it runs under waits with it", () => {
    expect(poolWaiting(file, 50_000)).toEqual([]);
    expect(poolWaiting(file, 100_000)).toEqual(["bbbb2222", "aaaa1111"]);
    expect(poolWaiting(file, 159_999)).toEqual(["bbbb2222", "aaaa1111"]);
    expect(poolWaiting(file, 160_000)).toEqual([]);
  });
  it("an exec that did not wait is not marked", () => {
    expect(poolWaiting(file, 300_500)).toEqual([]);
  });
});

describe("poolStrip: the pool's occupancy as paths", () => {
  it("none without a pool; threads held under the budget, the waiters along the top, a pool that logged nothing was empty", () => {
    expect(poolStrip({ ...replay([]), pool: undefined }, 600, 60)).toBeNull();
    const strip = poolStrip(
      replay([frame(60_000, 14, 2, ["2", "2"]), frame(400_000, 7, 1, [])]),
      600,
      60,
    );
    expect(strip?.budgetY).toBe(0);
    // the first sample holds until the idle limit (150 s), the second until the next
    expect(strip?.other).toContain("M60,0H");
    expect(strip?.other).toContain("M400,30");
    expect(strip?.other.split("M")).toHaveLength(3);
    expect(strip?.waiting).toContain("M60,");
  });
});

describe("a replay carries its pool, and a window the pool log does not cover is not chosen", () => {
  const ev = (
    sec: number,
    kind: WfEvent["kind"],
    session: string,
    data: Record<string, unknown>,
  ): WfEvent => ({
    seq: sec,
    run: "r",
    ts: iso(sec),
    kind,
    session,
    data,
  });
  const events = (offset: number, id = ""): WfEvent[] => [
    ev(offset, "session_start", `p1${id}`, {
      workflow: "wf",
      parent: "d0",
      task: "SLICE-A",
      project: "anyparse",
    }),
    ev(offset + 5, "session_start", `k1${id}`, {
      workflow: "wf",
      parent: `p1${id}`,
      task: null,
      project: "x",
    }),
    ev(offset + 10, "exec_start", `k1${id}`, { state: "check" }),
    ev(offset + 20, "exec_end", `k1${id}`, {
      state: "check",
      exit_code: 0,
      duration_ms: 100,
      wait_ms: 4000,
    }),
    ev(offset + 21, "exec_start", `k1${id}`, { state: "gate" }),
    ev(offset + 22, "exec_end", `k1${id}`, {
      state: "gate",
      exit_code: 0,
      duration_ms: 100,
      wait_ms: 40,
    }),
    ev(offset + 30, "session_end", `k1${id}`, { outcome: "completed" }),
    ev(offset + 40, "session_end", `p1${id}`, { outcome: "completed" }),
  ];
  const log = [
    sample(60, 6, 2, []),
    sample(100, 6, 2, ["2"]),
    `${iso(110)} overrun: pid 7 holds 2 threads, runs ~4 — slice-gate SLICE-A lint`,
    sample(125, 6, 2, []),
    sample(1000, 1, 1, []),
  ];
  const base = { project: "anyparse", workflows: {}, hours: 1, pool: { lines: log, threshold: 2 } };

  it("the pool is cut to the window and the exec's wait is kept only when a lane could show it", () => {
    const file = buildReplay(events(90), base);
    expect(file.pool?.frames.map(f => f[0])).toEqual([10_000, 35_000]);
    expect(file.pool?.frames[1][8]).toEqual([["overrun", 2, "slice-gate SLICE-A lint", 4]]);
    const waits = file.events.filter(e => e[1] === "exec_end").map(e => e[3]?.wait_ms);
    expect(waits).toEqual([4000, undefined]);
    expect(renderReplay(file)).toContain('"pool"');
    expect(() => assertReplayClean(file)).not.toThrow();
  });

  it("a window the log does not cover is refused, and the default pick skips it", () => {
    expect(() => buildReplay(events(5000), { ...base, from: iso(5000) })).toThrow(/pool log/);
    const both = [...events(5000, "late"), ...events(90)];
    expect(buildReplay(both, base).start).toBe(iso(90));
  });

  it("without a pool log there is no pool in the file", () => {
    expect(
      buildReplay(events(90), { project: "anyparse", workflows: {}, hours: 1 }).pool,
    ).toBeUndefined();
  });
});

describe("the export refuses a file that carries what it must not", () => {
  const clean = replay([
    frame(
      60_000,
      14,
      2,
      ["2 + lock anyparse-land"],
      [["overrun", 3, "slice-gate SLICE-A infra4", 7]],
    ),
  ]);
  const withSeen = (m: PoolFrame[8]): ReplayFile => replay([frame(60_000, 14, 2, ["2"], m)]);

  it("a clean file passes", () => {
    expect(() => assertReplayClean(clean, ["/Users/someone"])).not.toThrow();
  });

  it("a lease label that names nothing of the replay is refused", () => {
    expect(() =>
      assertReplayClean(withSeen([["backfill", 1, "slice-gate FOREIGN-THING unit", 0]])),
    ).toThrow(/allowlist.*FOREIGN-THING/s);
  });

  it("a label that carries a path is refused, though it names a slice of the replay", () => {
    expect(() =>
      assertReplayClean(withSeen([["overrun", 1, "SLICE-A /Users/someone/dev/elsewhere", 3]])),
    ).toThrow(/not clean/);
  });

  it("an absolute path anywhere, a pid field and a foreign lock are refused", () => {
    expect(() => assertReplayClean({ ...clean, project: "/Users/someone/dev/x" })).toThrow(
      /\/Users\//,
    );
    expect(() => assertReplayClean({ ...clean, workflows: { w: { pid: 7 } as never } })).toThrow(
      /pid field/,
    );
    expect(() =>
      assertReplayClean(replay([frame(60_000, 14, 2, ["2 + lock elsewhere-land"])])),
    ).toThrow(/not a thread count/);
    expect(() => assertReplayClean(clean, ["anyparse"])).toThrow(/"anyparse"/);
  });

  it("the export script runs the check on the finished file before it writes anything", () => {
    const script = read("scripts/export-replay.mjs");
    const check = script.indexOf("assertReplayClean(file");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(script.indexOf("fs.writeFileSync(out"));
    expect(script).toContain("pool.log.1");
  });
});

describe("the committed replay's pool (docs/public/replay/anyparse.json)", () => {
  const raw = read("docs/public/replay/anyparse.json");
  const file = JSON.parse(raw) as ReplayFile;

  it("is there, over the replay's own window, and passes the export's own check", () => {
    expect(file.pool?.frames.length).toBeGreaterThan(50);
    for (const f of file.pool?.frames ?? []) {
      expect(f[0]).toBeGreaterThanOrEqual(0);
      expect(f[0]).toBeLessThanOrEqual(file.durationMs);
    }
    expect(() => assertReplayClean(file)).not.toThrow();
  });

  it("names nothing but this project: no path, no pid, no lock but its own, every label a slice or session of the replay", () => {
    const strings = JSON.stringify(file.pool).match(/"[^"]*"/g) ?? [];
    for (const s of strings) expect(s).not.toContain("/");
    expect(raw).not.toMatch(/"pid"/);
    const locks = (file.pool?.frames ?? []).flatMap(f =>
      f[7].flatMap(a => a.match(/lock \S*/g) ?? []),
    );
    expect(locks.length).toBeGreaterThan(0);
    for (const l of locks) expect(["lock anyparse-land", "lock"]).toContain(l);
    expect((file.pool?.frames ?? []).some(f => f[8].length > 0)).toBe(true);
  });

  it("shows something: waiters, a land-lock ask, and lanes that wait for the pool", () => {
    const frames = file.pool?.frames ?? [];
    expect(frames.some(f => f[6] > 0)).toBe(true);
    expect(frames.some(f => f[7].some(a => a.includes("lock anyparse-land")))).toBe(true);
    const waiting = frames.filter(f => poolWaiting(file, f[0]).length > 0);
    expect(waiting.length).toBeGreaterThan(0);
  });
});

describe("the scene and the docs draw the pool from that one read", () => {
  const window = read("docs/.vitepress/theme/TerminalWindow.vue");
  const scene = read("docs/.vitepress/theme/Scene.vue");
  const map = read("docs/.vitepress/theme/MapReplay.vue");
  const strip = read("docs/.vitepress/theme/PoolStrip.vue");
  const demo = read("docs/.vitepress/theme/PoolDemo.vue");
  const theme = read("docs/.vitepress/theme/index.ts");
  const config = read("docs/.vitepress/config.mts");
  const page = read("docs/pool.md");

  it("the Pool tab is the mod's own, fed the replay's pool, not a stub that says it records none", () => {
    expect(window).toContain("pool: poolStateAt(shared.file, shared.at)");
    expect(window).toContain("poolCounts: poolCountsAt(shared.file, shared.at)");
    expect(window).not.toContain("records no pool");
    expect(read("hooks/plan-pane.tsx")).toContain("paneTree({");
  });

  it("a thin strip under the map shows the occupancy on the scene's clock", () => {
    expect(scene).toContain('<PoolStrip :file="shared.file" :at="shared.at" />');
    expect(scene).toContain("<MapReplay />");
    expect(scene).toContain("const STRIP_H = 96;");
    expect(strip).toContain("poolStrip(props.file, PLOT_W, PLOT_H)");
    expect(strip).not.toContain("requestAnimationFrame");
    // a sample lists no holders, so the unnamed remainder is never called another project's work
    expect(strip).toContain("leases the log does not name");
    expect(strip).not.toContain("other work");
    expect(page).not.toContain("other work on this machine");
  });

  it("a lane that waits for the pool carries the map's own mark", () => {
    expect(map).toContain("pool: poolWaiting(file, shared.at)");
  });

  it("the Thread pool page: a live demo, the picture, the reference linked, in the sidebar and in getting started", () => {
    expect(page).toContain("\n<PoolDemo />\n");
    expect(page).toContain("<svg");
    expect(page).toContain("](/action-states#heavy-work-—-the-machine-wide-thread-pool)");
    for (const word of [
      "Lease",
      "Budget",
      "Priority",
      "Locks",
      "Backfill",
      "Overrun",
      "wf-run",
      "config.yaml",
    ])
      expect(page).toContain(word);
    expect(theme).toContain('app.component("PoolDemo", PoolDemo)');
    expect(demo).toContain("poolStateAt(f, at.value)");
    expect(config).toContain('{ text: "Thread pool", link: "/pool" }');
    expect(read("docs/getting-started.md")).toContain("(/pool)");
  });
});
