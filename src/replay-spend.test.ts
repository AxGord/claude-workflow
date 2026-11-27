// Pins of ENG-REPLAY-SPEND: the replay carries the ledger's real spend of its own tasks (and only those), under the same
// allowlist as its events, and the scene's plan pane shows it as the live pane does. The allowlist is two projects now:
// anyparse and the engine's own.
import { describe, expect, it, vi } from "vitest";
import { nodeText, paneTree, type PaneEl, type PaneNode } from "../hooks/pane-view.js";
import type { EventKind, WfEvent } from "./event-fold.js";
import {
  assertReplayClean,
  buildPool,
  buildReplay,
  ledgerSpend,
  renderReplay,
  snapshotAt,
  type ReplayFile,
} from "./replay.js";

vi.mock("claude-code", () => ({ atom: () => ({}), read: () => ({}), update: () => ({}) }));

interface Spend {
  usd?: number;
  endedAt: number;
  outcome: string;
}
interface PaneModule {
  daySpends: (lands: unknown[], spends: Map<string, Spend>, now?: number) => unknown;
  landedUsd: (lands: unknown[]) => number | undefined;
  ledgerSpendOf: (text: string) => Map<string, Spend>;
}
const pane = async (): Promise<PaneModule> =>
  (await import("../hooks/plan-pane.tsx")) as PaneModule;

const START = "2026-11-13T06:00:00.000Z";
const T0 = Date.parse(START);
const sec = (n: number): string => new Date(T0 + n * 1000).toISOString();

/** A ledger row of a task run: ended at `end` s, through `land` when `landed`, with `usd` (absent: no spend recorded). */
const row = (
  task: string,
  o: { usd?: number; end?: number; outcome?: string; landed?: boolean; workflow?: string } = {},
): string =>
  JSON.stringify({
    session_id: `s-${task}`,
    task,
    workflow: o.workflow ?? "slice-pipeline",
    outcome: o.outcome ?? "completed",
    started_at: sec(0),
    ended_at: sec(o.end ?? 50),
    ...(o.landed === true ? { visits: { claim: 1, land: 1 } } : { visits: { claim: 1 } }),
    ...(o.usd === undefined ? {} : { spend: { usd: o.usd } }),
  });

describe("ledgerSpend reads the ledger the way the plan pane does, for the replay's tasks only", () => {
  const tasks = new Set(["A", "B", "C"]);
  it("sums every run of a line, leaves a line any run of which recorded none, skips other workflows and torn lines", () => {
    const text = [
      row("A", { usd: 1.1 }),
      row("A", { usd: 0.2 }),
      row("B", { usd: 3 }),
      row("B"),
      row("C", { usd: 2, workflow: "slice-review" }),
      "{torn",
    ].join("\n");
    expect(ledgerSpend(text, tasks)).toEqual({ A: 1.3 });
  });

  it("never reads a task that is not the replay's: its id, its sum", () => {
    const out = ledgerSpend(
      [row("A", { usd: 1 }), row("PRIVATE-TASK", { usd: 77 })].join("\n"),
      tasks,
    );
    expect(out).toEqual({ A: 1 });
    expect(JSON.stringify(out)).not.toContain("PRIVATE");
  });

  it("agrees with the pane's own ledgerSpendOf on every measured task", async () => {
    const { ledgerSpendOf } = await pane();
    const text = [
      row("A", { usd: 1.1 }),
      row("A", { usd: 0.2, end: 70 }),
      row("B", { usd: 0.05 }),
      row("C"),
    ].join("\n");
    const own = ledgerSpend(text, tasks);
    for (const [task, sp] of ledgerSpendOf(text)) {
      if (sp.usd === undefined) expect(own[task]).toBeUndefined();
      else expect(own[task]).toBeCloseTo(sp.usd, 4);
    }
  });
});

const ev = (
  ts: string,
  kind: EventKind,
  session: string,
  data: Record<string, unknown>,
): WfEvent => ({ seq: 0, run: "r", ts, kind, session, data });

/** A task run of `project` for `task`, minutes `a` to `b`; with a recon child unless `alone` (an engine-task spawns none). */
function pipeline(
  id: string,
  project: string,
  task: string,
  a: number,
  b: number,
  alone = false,
): WfEvent[] {
  return [
    ev(sec(a * 60), "session_start", id, {
      workflow: alone ? "engine-task" : "slice-pipeline",
      parent: "dispatch0",
      task,
      project,
    }),
    ...(alone
      ? []
      : [
          ev(sec(a * 60 + 1), "session_start", `${id}-k`, {
            workflow: "slice-recon",
            parent: id,
            project: "wf-worktree",
          }),
          ev(sec(a * 60 + 2), "session_end", `${id}-k`, { outcome: "completed" }),
        ]),
    ev(sec(a * 60 + 3), "transition", id, { from: "x", to: "land", name: "go" }),
    ev(sec(b * 60), "session_end", id, { outcome: "completed" }),
  ];
}

describe("buildReplay keeps the engine's own project beside anyparse, and spend only for their tasks", () => {
  const events = [
    ...pipeline("aaaa1111", "anyparse", "TASK-A", 0, 20),
    ...pipeline("eeee2222", "mcp-workflow-engine", "ENG-B", 5, 30, true),
    ...pipeline("gggg3333", "golf", "GOLF-PRIVATE", 10, 25),
  ];
  const ledger = [
    row("TASK-A", { usd: 2.5, landed: true }),
    row("ENG-B", { usd: 0.75, workflow: "engine-task", landed: true }),
    row("GOLF-PRIVATE", { usd: 123 }),
  ].join("\n");
  const base = { project: "anyparse", workflows: {}, from: sec(-60), hours: 2 };

  it("with `also`: both projects' sessions, the third one's not", () => {
    const file = buildReplay(events, { ...base, also: ["mcp-workflow-engine"], ledger });
    expect(file.projects).toEqual(["anyparse", "mcp-workflow-engine"]);
    expect(file.sessions.filter(s => !s.endsWith("-k"))).toEqual(["aaaa1111", "eeee2222"]);
    const text = renderReplay(file);
    for (const secret of ["gggg3333", "GOLF", "golf", "123"]) expect(text).not.toContain(secret);
  });

  it("a finished engine-task with no child session is a pipeline of the replay; a child-less conversation with no task is not", () => {
    const file = buildReplay(
      [
        ...pipeline("eeee2222", "mcp-workflow-engine", "ENG-B", 5, 30, true),
        ev(sec(0), "session_start", "chat0000", { workflow: "x", project: "anyparse" }),
        ev(sec(40 * 60), "session_end", "chat0000", { outcome: "completed" }),
      ],
      { ...base, also: ["mcp-workflow-engine"], ledger },
    );
    expect(file.sessions).toEqual(["eeee2222"]);
    expect(file.spend).toEqual({ "ENG-B": 0.75 });
  });

  it("without `also`: anyparse alone, as before, and no engine task in the spend", () => {
    const file = buildReplay(events, { ...base, ledger });
    expect(file.projects).toBeUndefined();
    expect(file.sessions.filter(s => !s.endsWith("-k"))).toEqual(["aaaa1111"]);
    expect(file.spend).toEqual({ "TASK-A": 2.5 });
  });

  it("the spend is the ledger's, per task of the replay: never another project's task, never a $0 for a missing row", () => {
    const file = buildReplay(events, {
      ...base,
      also: ["mcp-workflow-engine"],
      ledger: [ledger, row("ELSEWHERE", { usd: 9 })].join("\n"),
    });
    expect(file.spend).toEqual({ "ENG-B": 0.75, "TASK-A": 2.5 });
    expect(buildReplay(events, { ...base, also: ["mcp-workflow-engine"] }).spend).toBeUndefined();
    expect(
      buildReplay(events, { ...base, ledger: row("OTHER", { usd: 1 }) }).spend,
    ).toBeUndefined();
  });

  it("the self-check refuses a spend that is not a task of the replay, a non-number, a negative", () => {
    const file = buildReplay(events, { ...base, also: ["mcp-workflow-engine"], ledger });
    expect(() => assertReplayClean(file)).not.toThrow();
    for (const spend of [{ "GOLF-PRIVATE": 1 }, { "TASK-A": Number.NaN }, { "TASK-A": -1 }])
      expect(() => assertReplayClean({ ...file, spend })).toThrow(/a spend is not a task/);
  });

  it("the engine's own land lock keeps its name in the pool, a foreign lock does not", () => {
    const lines = [
      `${sec(30)} sample: load 1.0 external 0.0 held 4/14 runs 1.0 leases 1 waiting 2 [4-8 + lock mcp-workflow-engine-land, 2 + lock golf-land]`,
    ];
    const opts = {
      project: "anyparse",
      from: T0,
      to: T0 + 600_000,
      tasks: new Set(["ENG-B"]),
      sessions: new Set<string>(),
      threshold: 2,
    };
    expect(buildPool(lines, { ...opts, also: ["mcp-workflow-engine"] }).frames[0][7]).toEqual([
      "4-8 + lock mcp-workflow-engine-land",
      "2 + lock",
    ]);
    expect(buildPool(lines, opts).frames[0][7]).toEqual(["4-8 + lock", "2 + lock"]);
    const quiet = (n: number): string =>
      `${sec(n)} sample: load 1.0 external 0.0 held 0/14 runs 1.0 leases 0 waiting 0`;
    const file = buildReplay(events, {
      ...base,
      also: ["mcp-workflow-engine"],
      pool: { lines: [quiet(-10), ...lines, quiet(1900)], threshold: 2 },
    });
    expect(file.pool?.frames.some(f => f[7].includes("4-8 + lock mcp-workflow-engine-land"))).toBe(
      true,
    );
    expect(() => assertReplayClean(file)).not.toThrow();
    expect(() =>
      assertReplayClean({
        ...file,
        pool: { threshold: 2, frames: [[0, 0, 14, 0, 0, 0, 1, ["2 + lock golf-land"], []]] },
      }),
    ).toThrow(/not a thread count/);
  });
});

/** The pane's plan tab at `at` ms, 80 columns. */
const draw = (file: ReplayFile, at: number): PaneNode =>
  paneTree({
    snapshot: snapshotAt(file, at),
    tab: "plan",
    expanded: "",
    folded: [],
    now: Date.parse(file.start) + at,
    columns: 80,
    rows: 40,
    poolCounts: null,
    pool: null,
  });

function texts(n: PaneNode, re: RegExp): string[] {
  if (n === null || typeof n === "string") return [];
  if (Array.isArray(n)) return (n as readonly PaneNode[]).flatMap(c => texts(c, re));
  const el = n as PaneEl;
  if (el.el === "link") return [];
  const own = el.el === "text" && re.test(nodeText(el)) ? [nodeText(el)] : [];
  return [...own, ...el.children.flatMap(c => texts(c, re))];
}

describe("snapshotAt gives a Landed row its spend, and the day its sum", () => {
  // A lands (1.5), E lands with no spend, B closes (0.25), D fails (0.75), F fails with none
  const file: ReplayFile = {
    version: 1,
    project: "p",
    start: START,
    durationMs: 1000,
    sessions: ["aaaa", "bbbb", "dddd", "eeee", "ffff"],
    workflows: {
      "slice-pipeline": { stations: [{ name: "claim", script: false, terminal: false }] },
    },
    taskKinds: {},
    spend: { A: 1.5, B: 0.25, D: 0.75 },
    events: [
      [0, "session_start", 0, { workflow: "slice-pipeline", task: "A", difficulty: "7" }],
      [10, "transition", 0, { from: "claim", to: "land", name: "a", workflow: "slice-pipeline" }],
      [50, "session_end", 0, { outcome: "completed" }],
      [60, "session_start", 3, { workflow: "slice-pipeline", task: "E", difficulty: "3" }],
      [70, "transition", 3, { from: "claim", to: "land", name: "a", workflow: "slice-pipeline" }],
      [80, "session_end", 3, { outcome: "completed" }],
      [100, "session_start", 1, { workflow: "slice-pipeline", task: "B", difficulty: "3" }],
      [130, "session_end", 1, { outcome: "completed" }],
      [140, "session_start", 2, { workflow: "slice-pipeline", task: "D", difficulty: "5" }],
      [150, "session_end", 2, { outcome: "aborted" }],
      [160, "session_start", 4, { workflow: "slice-pipeline", task: "F", difficulty: "5" }],
      [170, "session_end", 4, { outcome: "aborted" }],
    ],
  };

  it("a measured landed line carries its usd, an unmeasured one none", () => {
    const s = snapshotAt(file, 500);
    expect(s.lands.find(l => l.slice === "A")?.usd).toBe(1.5);
    expect(s.lands.find(l => l.slice === "E")?.usd).toBeUndefined();
    expect(s.landedUsd).toBe(1.5);
    expect(snapshotAt({ ...file, spend: undefined }, 500).landedUsd).toBeUndefined();
  });

  it("a failed line carries its usd too", () => {
    const failed = snapshotAt(file, 500).queue?.failedLines ?? [];
    expect(failed.find(l => l.id === "D")?.usd).toBe(0.75);
    expect(failed.find(l => l.id === "F")?.usd).toBeUndefined();
  });

  it("the day sums the landed lines and the measured failed and closed ones that ended on it", () => {
    const day = snapshotAt(file, 500).days[dayKey(file, 50)];
    expect(day).toEqual({ usd: 2.5, lines: 4, measured: 3, failed: 1, closed: 1 });
  });

  it("a row of the replay shows `$1.50` and a row with none `—`, as the live pane does", () => {
    const tree = draw(file, 500);
    expect(texts(tree, /\$1\.50.*A/)).toHaveLength(1);
    expect(texts(tree, /—.*E/)).toHaveLength(1);
    expect(texts(tree, /✓ Done · 14d \(2\) · \$1\.50/)).toHaveLength(1);
  });

  it("agrees with the pane's own daySpends and landedUsd over the same ledger", async () => {
    const { daySpends, landedUsd, ledgerSpendOf } = await pane();
    const ledger = [
      row("A", { usd: 1.5, end: 0.05, landed: true }),
      row("E", { end: 0.08, landed: true }),
      row("B", { usd: 0.25, end: 0.13 }),
      row("D", { usd: 0.75, end: 0.15, outcome: "aborted" }),
    ].join("\n");
    const at = 500;
    const s = snapshotAt(file, at);
    expect(s.days).toEqual(daySpends(s.lands, ledgerSpendOf(ledger), Date.parse(START) + at));
    expect(s.landedUsd).toBe(landedUsd(s.lands));
  });
});

/** The pane's `DD.MM` key of the day a replay offset falls on. */
function dayKey(file: ReplayFile, at: number): string {
  const d = new Date(Date.parse(file.start) + at);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}
