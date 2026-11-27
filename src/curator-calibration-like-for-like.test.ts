import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCuratorConfig } from "./curator.js";
import { tuningChanges } from "./curator-counts.js";
import { changedRows, stageEvidence, stagePicks } from "./curator-tuning.js";
import type { LedgerEntry } from "./ledger.js";

// ENG-CURATOR-CALIBRATION-LIKE-FOR-LIKE: a tuning change is a commit that changes a model_table row, and its evidence
// is the changed STAGE's own spend in the same band, not the whole task's spend over every land of the workflow.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const WF = (review: string, comment: string): string =>
  `name: slice-pipeline\n${comment}initial: a\nmodel_table:\n  stages:\n    review:\n      - { upto: 10, model: opus, effort: ${review} }\nstates:\n  a: { type: terminal }\n`;

function repo(): { project: string; commits: Record<string, string> } {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-cal-lfl-")));
  dirs.push(project);
  const wfDir = path.join(project, ".claude", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  const file = path.join(wfDir, "slice-pipeline.yaml");
  const git = (date: string, ...a: string[]): string =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], {
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    }).trim();
  git("2026-11-01T10:00:00Z", "init", "-q");
  const commit = (date: string, text: string, msg: string): string => {
    fs.writeFileSync(file, text);
    git(date, "add", "-f", "-A");
    git(date, "commit", "-q", "-m", msg);
    return git(date, "rev-parse", "HEAD");
  };
  const commits = {
    seed: commit("2026-11-10T10:00:00Z", WF("high", ""), "seed"),
    comment: commit("2026-11-15T10:00:00Z", WF("high", "# a note\n"), "comment only"),
    row: commit("2026-11-20T10:00:00Z", WF("medium", "# a note\n"), "review high -> medium"),
  };
  return { project, commits };
}

let n = 0;
function land(project: string, endedAt: string, reviewUsd: number, otherUsd: number): LedgerEntry {
  n++;
  return {
    session_id: `s${n}`,
    parent_session_id: null,
    root_session_id: `s${n}`,
    workflow: "slice-pipeline",
    outcome: "completed",
    started_at: endedAt,
    ended_at: endedAt,
    transitions: 1,
    exec_ms_total: 0,
    wait_ms_total: 0,
    execs: [],
    task: `T${n}`,
    project,
    difficulty: 5,
    claim_difficulty: 5,
    visits: { review: 1 },
    spend: {
      agents: 2,
      usd: reviewUsd + otherUsd,
      by_agent: [
        {
          agent: "a1",
          state: "plan_spawn",
          stage: "plan",
          usd: otherUsd,
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
        },
        {
          agent: "a2",
          state: "review_spawn",
          stage: "review",
          usd: reviewUsd,
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
        },
      ],
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    },
  };
}

describe("curator calibration evidence is like-for-like", () => {
  it("a model-row change is judged on the changed stage's spend; a comment edit is no tuning change", () => {
    const { project, commits } = repo();
    // the review stage got cheaper (2.37 -> 1.11) while the whole task got dearer (10.01 -> 12.02)
    const before = [11, 12, 13, 14, 15, 16].map(d =>
      land(project, `2026-11-${d}T12:00:00Z`, 2.37, 7.64),
    );
    const after = [21, 22, 23, 24, 25, 26].map(d =>
      land(project, `2026-11-${d}T12:00:00Z`, 1.11, 10.91),
    );
    const config = parseCuratorConfig(
      "jobs:\n  calibration: {}\n",
      `${project}/.claude/curator.yaml`,
      project,
    );
    const job = config.jobs[0];
    const changes = tuningChanges(job, project, [...before, ...after]);
    // only the commit that changed a model_table row is a tuning change
    expect(changes.map(c => c.commit)).toEqual([commits.row]);
    // its evidence carries the review stage's own spend on both sides
    const text = JSON.stringify(changes);
    expect(text).toContain("2.37");
    expect(text).toContain("1.11");
  });

  it("the cell carries the stage's median and mean on both sides, and the whole-task spend is nowhere in it", () => {
    const { project } = repo();
    const before = [13, 14, 15, 16, 17, 18].map(d =>
      land(project, `2026-11-${d}T12:00:00Z`, 2.37, 7.64),
    );
    const after = [21, 22, 23, 24, 25, 26].map(d =>
      land(project, `2026-11-${d}T12:00:00Z`, 1.11, 10.91),
    );
    const config = parseCuratorConfig(
      "jobs:\n  calibration: {}\n",
      `${project}/.claude/curator.yaml`,
      project,
    );
    const [change] = tuningChanges(config.jobs[0], project, [...before, ...after]);
    // the fixture's one row covers every difficulty, so every band changed; only 4-6 has lands
    expect(change.stages.map(s => [s.stage, s.band, s.cells.length])).toEqual([
      ["review", "1-3", 0],
      ["review", "4-6", 1],
      ["review", "7-10", 0],
    ]);
    const cell = change.stages[1].cells[0];
    expect(cell.before.stage_usd_median).toBe(2.37);
    expect(cell.after.stage_usd_median).toBe(1.11);
    expect(cell.after.stage_usd_mean).toBe(1.11);
    expect([cell.before.n, cell.after.n, cell.thin]).toEqual([6, 6, false]);
    expect(change.enough).toBe(true);
    expect(JSON.stringify(change)).not.toMatch(/10\.01|12\.02/);
  });
});

function entry(
  over: Partial<LedgerEntry> & { spent: [string, number][]; rounds?: number },
): LedgerEntry {
  const base = land("/p", over.ended_at ?? "2026-11-12T12:00:00Z", 0, 0);
  return {
    ...base,
    ...over,
    visits: { review: over.rounds ?? 1 },
    spend: {
      agents: over.spent.length,
      by_agent: over.spent.map(([stage, usd], i) => ({
        agent: `x${i}`,
        stage,
        usd,
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
      })),
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    },
  };
}

const change = { stage: "review", band: "4-6", rows: [] };
const OLD = "opus/high";
const NEW = "opus/medium";
const row = (m: string): NonNullable<LedgerEntry["stages"]> => {
  const [model, effort] = m.split("/");
  return { review: { model, effort } };
};
const picksOf = (from: Record<number, string>, to: Record<number, string>) => ({
  before: new Map(Object.entries(from).map(([d, v]) => [Number(d), v])),
  after: new Map(Object.entries(to).map(([d, v]) => [Number(d), v])),
});
const wholeBand = picksOf({ 4: OLD, 5: OLD, 6: OLD }, { 4: NEW, 5: NEW, 6: NEW });

describe("stage evidence cells", () => {
  it("lands of different process shapes are never in one cell", () => {
    const plain = (usd: number): LedgerEntry =>
      entry({
        spent: [
          ["plan", 1],
          ["review", usd],
        ],
      });
    const handOn = (usd: number): LedgerEntry =>
      entry({
        spent: [
          ["plan", 1],
          ["execute", 3],
          ["review", usd],
        ],
      });
    const fixed = (usd: number): LedgerEntry =>
      entry({
        spent: [
          ["plan", 1],
          ["review", usd],
        ],
        rounds: 2,
      });
    const side = (usd: number): LedgerEntry[] => [
      ...Array.from({ length: 5 }, () => plain(usd)),
      ...Array.from({ length: 5 }, () => handOn(usd * 2)),
      ...Array.from({ length: 5 }, () => fixed(usd * 3)),
    ];
    const ev = stageEvidence(change, side(1), side(0.5), wholeBand);
    expect(ev.cells.map(c => c.shape)).toEqual([
      "execute+plan+review; one review round",
      "plan+review; fix rounds",
      "plan+review; one review round",
    ]);
    expect(ev.cells.map(c => [c.before.stage_usd_median, c.after.stage_usd_median])).toEqual([
      [2, 1],
      [3, 1.5],
      [1, 0.5],
    ]);
    expect(ev.enough).toBe(true);
  });

  it("a cell under 5 lands on either side is thin; all thin reads 'not enough lands yet'", () => {
    const l = (usd: number): LedgerEntry => entry({ spent: [["review", usd]] });
    const four = [l(1), l(1), l(1), l(1)];
    const ev = stageEvidence(change, [...four, l(1)], four, wholeBand);
    expect(ev.cells[0].thin).toBe(true);
    expect(ev.enough).toBe(false);
    expect(ev.note).toContain("not enough lands yet");
  });

  it("a land whose stage spend is a lower bound, and a land of another band, are left out", () => {
    const ok = entry({ spent: [["review", 1]] });
    const whole = entry({ spent: [["review", 1]] });
    const partial: LedgerEntry = {
      ...whole,
      spend: {
        ...whole.spend,
        agents: 2,
        by_agent: [
          ...(whole.spend?.by_agent ?? []),
          { agent: "u", stage: "review", input: 0, output: 0, cache_read: 0, cache_write: 0 },
        ],
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
      },
    };
    const other = entry({ spent: [["review", 9]], difficulty: 9 });
    const ev = stageEvidence(change, [ok, partial, other], [], wholeBand);
    expect(ev.cells.map(c => c.before.n)).toEqual([1]);
    expect(ev.unmeasured_lands).toBe(1);
  });

  it("the median is not the mean", () => {
    const mk = (xs: number[]): LedgerEntry[] => xs.map(u => entry({ spent: [["review", u]] }));
    const ev = stageEvidence(change, mk([1, 1, 1, 1, 11]), mk([1, 1, 1, 1, 1]), wholeBand);
    expect([ev.cells[0].before.stage_usd_median, ev.cells[0].before.stage_usd_mean]).toEqual([
      1, 3,
    ]);
  });
});

describe("a land goes to the side whose row it ran on", () => {
  const ran = (m: string, over: Partial<LedgerEntry> = {}): LedgerEntry =>
    entry({ spent: [["review", 1]], stages: row(m), ...over });
  const n = (ev: ReturnType<typeof stageEvidence>): number[] => [
    ev.cells.reduce((a, c) => a + c.before.n, 0),
    ev.cells.reduce((a, c) => a + c.after.n, 0),
  ];

  it("a land in the after window that ran on the old row is not in after", () => {
    const after = [ran(NEW), ran(NEW), ran(NEW), ran(NEW), ran(NEW), ran(OLD)];
    const ev = stageEvidence(change, [ran(OLD)], after, wholeBand);
    expect(n(ev)).toEqual([2, 5]);
  });

  it("a land that ran on a row of neither side is off_row, in no cell", () => {
    const ev = stageEvidence(change, [ran(OLD)], [ran("sonnet/low")], wholeBand);
    expect(n(ev)).toEqual([1, 0]);
    expect(ev.off_row_lands).toBe(1);
  });

  it("a land at an unchanged difficulty of the band is in neither side", () => {
    const partial = picksOf({ 4: OLD, 5: OLD, 6: OLD }, { 4: OLD, 5: NEW, 6: OLD });
    const lands = (d: number): LedgerEntry[] => [
      ran(OLD, { difficulty: d }),
      ran(NEW, { difficulty: d }),
    ];
    const ev = stageEvidence(
      change,
      [...lands(4), ...lands(6)],
      [...lands(4), ...lands(6)],
      partial,
    );
    expect(ev.cells).toEqual([]);
    const at5 = stageEvidence(
      change,
      [ran(OLD, { difficulty: 5 })],
      [ran(NEW, { difficulty: 5 })],
      partial,
    );
    expect(n(at5)).toEqual([1, 1]);
  });
});

describe("model_table row changes", () => {
  const doc = (execute: string, review: string): unknown => ({
    model_table: {
      rows: [{ upto: 10, model: "sonnet", effort: execute }],
      stages: {
        review: [
          { upto: 3, model: "haiku", effort: "low" },
          { upto: 10, model: "opus", effort: review },
        ],
      },
    },
  });

  it("names the stage, band and rows a change touches, and nothing else", () => {
    const rows = changedRows(stagePicks(doc("high", "high")), stagePicks(doc("high", "medium")));
    expect(rows).toEqual([
      {
        stage: "review",
        band: "4-6",
        rows: [{ difficulties: "4-6", from: "opus/high", to: "opus/medium" }],
      },
      {
        stage: "review",
        band: "7-10",
        rows: [{ difficulties: "7-10", from: "opus/high", to: "opus/medium" }],
      },
    ]);
    expect(changedRows(stagePicks(doc("high", "high")), stagePicks(doc("high", "high")))).toEqual(
      [],
    );
  });

  it("`rows` is the execute stage unless stages.execute replaces it", () => {
    expect([...stagePicks(doc("high", "high")).keys()].sort()).toEqual(["execute", "review"]);
    const replaced = stagePicks({
      model_table: {
        rows: [{ upto: 10, model: "a", effort: "x" }],
        stages: { execute: [{ upto: 10, model: "b", effort: "y" }] },
      },
    });
    expect(replaced.get("execute")?.get(5)).toBe("b/y");
  });
});
