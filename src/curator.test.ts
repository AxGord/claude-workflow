import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CuratorConfig,
  type CuratorState,
  CuratorError,
  curatorStandings,
  dueJobs,
  INTERVAL_CAP,
  INTERVAL_FLOOR,
  nextInterval,
  parseCuratorConfig,
  recordYield,
} from "./curator.js";
import type { LedgerEntry } from "./ledger.js";

// ENG-CURATOR-SERVICE: the ENGINE decides when each curator job runs — lands since the job's last run against its
// interval, a model row's new lands for calibration, the memory index's budget and new files as events — and each
// run's yield tunes the interval (nothing found doubles it, cap 40; a high yield halves it, floor 5).

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const PROJECT = "/p";
const config = (yaml: string): CuratorConfig =>
  parseCuratorConfig(yaml, "/p/.claude/curator.yaml", PROJECT);

let n = 0;
function land(task: string, endedAt: string, stages?: LedgerEntry["stages"]): LedgerEntry {
  n++;
  return {
    session_id: `s${n}`,
    parent_session_id: null,
    root_session_id: `s${n}`,
    workflow: "batch-task",
    outcome: "complete",
    started_at: endedAt,
    ended_at: endedAt,
    transitions: 1,
    exec_ms_total: 0,
    wait_ms_total: 0,
    execs: [],
    task,
    project: PROJECT,
    ...(stages ? { stages } : {}),
  };
}

const lands = (k: number, from = 0): LedgerEntry[] =>
  Array.from({ length: k }, (_, i) => land(`T${from + i}`, `2026-11-2${(i % 5) + 1}T10:00:00Z`));
const empty: CuratorState = { project: PROJECT, jobs: {} };
const noMemory = () => ({ indexBytes: 0, newFiles: 0 });

describe("curator config", () => {
  it("enables only the jobs it lists, with their default intervals; a project job needs a prompt", () => {
    const c = config(
      "jobs:\n  hygiene: {}\n  memory: {every: 12}\n  skills: {enabled: false}\n  docs-sweep: {prompt: 'list stale docs', command: 'ls docs'}\n",
    );
    expect(c.jobs.map(j => [j.name, j.every])).toEqual([
      ["hygiene", 10],
      ["memory", 12],
      ["docs-sweep", 20],
    ]);
    expect(c.edits).toBe("propose");
    expect(() => config("jobs:\n  mine: {}\n")).toThrow(CuratorError);
    expect(() => config("edits: always\n")).toThrow(/propose or direct/);
    expect(() => config("jobz: {}\n")).toThrow(/unknown key jobz/);
  });
});

describe("curator cadence", () => {
  it("hygiene is due after 10 lands since its last run, not after 9", () => {
    const c = config("jobs:\n  hygiene: {}\n");
    const at = { config: c, scope: { project: PROJECT }, memory: noMemory };
    expect(dueJobs({ ...at, state: empty, ledger: lands(9) })).toEqual([]);
    expect(dueJobs({ ...at, state: empty, ledger: lands(10) })).toEqual([
      { job: "hygiene", reason: "10 lands since the start (interval 10)" },
    ]);
    // lands before the last run do not count again; another project's lands never do
    const ran: CuratorState = {
      project: PROJECT,
      jobs: { hygiene: { interval: 10, last_run_at: "2026-11-23T00:00:00Z", runs: [] } },
    };
    const other = { ...land("X", "2026-11-25T00:00:00Z"), project: "/q" };
    const s = curatorStandings({ ...at, state: ran, ledger: [...lands(10), other] });
    expect(s[0]).toMatchObject({ job: "hygiene", count: 6, interval: 10 });
    expect(s[0]?.due).toBeUndefined();
  });

  it("counts a queue's lands by its line ids, one per task, curator runs aside", () => {
    const c = config("jobs:\n  hygiene: {every: 2}\n");
    const ledger = [
      land("A", "2026-11-21T00:00:00Z"),
      land("A", "2026-11-22T00:00:00Z"),
      { ...land("CURATOR-2026-11-22-1", "2026-11-22T00:00:00Z"), workflow: "curator" },
      land("B", "2026-11-22T00:00:00Z"),
    ];
    const st = (ids: string[]) =>
      curatorStandings({ config: c, state: empty, ledger, scope: { ids: new Set(ids) } })[0];
    expect(st(["A", "CURATOR-2026-11-22-1"])).toMatchObject({ count: 1 });
    expect(st(["A", "B", "CURATOR-2026-11-22-1"])).toMatchObject({ count: 2 });
    expect(st(["A", "B", "CURATOR-2026-11-22-1"])?.due).toBe(
      "2 lands since the start (interval 2)",
    );
  });

  it("calibration is due when ONE model row has 5 new lands, not 5 lands spread over rows", () => {
    const c = config("jobs:\n  calibration: {}\n");
    const row = (m: string) => ({ execute: { model: m, effort: "high" } });
    const spread = ["opus", "sonnet", "haiku", "opus", "sonnet"].map((m, i) =>
      land(`S${i}`, "2026-11-22T00:00:00Z", row(m)),
    );
    expect(
      dueJobs({ config: c, state: empty, ledger: spread, scope: { project: PROJECT } }),
    ).toEqual([]);
    const five = Array.from({ length: 5 }, (_, i) =>
      land(`O${i}`, "2026-11-22T00:00:00Z", row("opus")),
    );
    expect(dueJobs({ config: c, state: empty, ledger: five, scope: { project: PROJECT } })).toEqual(
      [
        {
          job: "calibration",
          reason: "model row batch-task execute opus/high has 5 new lands (interval 5)",
        },
      ],
    );
  });

  it("the memory job's events fire before its interval: an index over budget (once it grew), 5 new files", () => {
    const c = config("jobs:\n  memory: {}\n");
    const base = { config: c, ledger: lands(1), scope: { project: PROJECT } };
    expect(
      dueJobs({ ...base, state: empty, memory: () => ({ indexBytes: 4000, newFiles: 4 }) }),
    ).toEqual([]);
    expect(
      dueJobs({ ...base, state: empty, memory: () => ({ indexBytes: 5000, newFiles: 0 }) }),
    ).toEqual([{ job: "memory", reason: "MEMORY.md is 5000 bytes, over its budget of 4096" }]);
    expect(
      dueJobs({ ...base, state: empty, memory: () => ({ indexBytes: 0, newFiles: 5 }) })[0]?.reason,
    ).toBe("5 new memory files since the start");
    // a run that saw the index at 5000 is not re-fired by the same index; it fires again once the index grew
    const seen: CuratorState = {
      project: PROJECT,
      jobs: {
        memory: {
          interval: 20,
          last_run_at: "2026-11-20T00:00:00Z",
          last_index_bytes: 5000,
          runs: [],
        },
      },
    };
    expect(
      dueJobs({ ...base, state: seen, memory: () => ({ indexBytes: 5000, newFiles: 0 }) }),
    ).toEqual([]);
    expect(
      dueJobs({ ...base, state: seen, memory: () => ({ indexBytes: 5100, newFiles: 0 }) }),
    ).toHaveLength(1);
  });

  it("reads the memory dir itself when no facts are passed: the index's bytes and the files new since the run", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-cur-mem-"));
    dirs.push(d);
    fs.writeFileSync(path.join(d, "MEMORY.md"), "x".repeat(5000));
    const c = config(`jobs:\n  memory: {dirs: [${d}]}\n`);
    expect(
      dueJobs({ config: c, state: empty, ledger: [], scope: { project: PROJECT } })[0]?.reason,
    ).toMatch(/over its budget/);
  });
});

describe("curator yield", () => {
  it("nothing found doubles the interval up to 40; a high yield halves it down to 5; else it stays", () => {
    expect(nextInterval(10, 0, 5)).toBe(20);
    expect(nextInterval(30, 0, 5)).toBe(INTERVAL_CAP);
    expect(nextInterval(10, 5, 5)).toBe(5);
    expect(nextInterval(6, 9, 5)).toBe(INTERVAL_FLOOR);
    expect(nextInterval(10, 2, 5)).toBe(10);
  });

  it("a recorded run sets each job's interval, last run and run record; the next cadence reads them", () => {
    const c = config("jobs:\n  hygiene: {}\n  lessons: {}\n");
    const now = new Date("2026-11-26T00:00:00Z");
    const s = recordYield(
      empty,
      c,
      [
        { job: "hygiene", found: 0, changed: 0 },
        { job: "lessons", found: 7, changed: 2 },
      ],
      "R1",
      now,
    );
    expect(s.jobs.hygiene).toMatchObject({ interval: 20, last_run_at: now.toISOString() });
    expect(s.jobs.lessons?.interval).toBe(5);
    expect(s.jobs.lessons?.runs).toEqual([
      { at: now.toISOString(), run: "R1", found: 7, changed: 2, interval: 5 },
    ]);
    const later = Array.from({ length: 19 }, (_, i) => land(`L${i}`, "2026-11-27T00:00:00Z"));
    const due = dueJobs({ config: c, state: s, ledger: later, scope: { project: PROJECT } }).map(
      d => d.job,
    );
    expect(due).toEqual(["lessons"]);
  });
});
