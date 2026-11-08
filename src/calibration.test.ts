import { describe, expect, it } from "vitest";
import { calibrate, formatCalibration } from "./calibration.js";
import { runCalibration } from "./calibration-cli.js";
import { ledgerEntry, type LedgerEntry } from "./ledger.js";
import type { SessionState } from "./types.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const base = {
  parent_session_id: null,
  transitions: 1,
  exec_ms_total: 0,
  wait_ms_total: 0,
  execs: [],
  started_at: "2026-11-01T00:00:00Z",
};
const line = (id: string, over: Partial<LedgerEntry>): LedgerEntry => ({
  ...base,
  session_id: id,
  root_session_id: id,
  workflow: "w",
  outcome: "completed",
  ended_at: "2026-11-05T00:00:00Z",
  ...over,
});

const ledger: LedgerEntry[] = [
  line("a", {
    project: "/p1",
    difficulty: 2,
    stages: {
      execute: { model: "sonnet", effort: "low" },
      review: { model: "opus", effort: "high" },
    },
    visits: { review: 2, review_route: 3, work: 1 },
    tokens: { worker: 10, review: 5 },
    escalations: 1,
    verdict: "pass",
    counts: { findings: 4 },
  }),
  line("b", {
    project: "/p1",
    difficulty: 5,
    model: "haiku",
    effort: "low",
    outcome: "failed",
  }),
  line("c", {
    project: "/p2",
    difficulty: 9,
    tokens: { total: 7 },
    ended_at: "2026-10-01T00:00:00Z",
  }),
  line("d", { workflow: null }),
];

describe("calibrate", () => {
  it("bands by the claim difficulty, not the final one", () => {
    const rows = calibrate([line("x", { project: "/p", difficulty: 9, claim_difficulty: 5 })], {});
    expect(rows.map(r => r.band)).toEqual(["4-6"]);
  });

  it("folds two projects and three bands into the exact table", () => {
    const rows = calibrate(ledger, { findingsKey: "findings" });
    expect(
      rows.map(r => [
        r.project,
        r.workflow,
        r.band,
        r.stage,
        `${r.model}/${r.effort}`,
        r.tasks,
        r.review_rounds,
        r.escalations,
        r.tokens,
        r.findings,
        r.outcomes,
        r.verdicts,
      ]),
    ).toEqual([
      ["-", "-", "-", "-", "-/-", 1, 0, 0, 0, 0, { completed: 1 }, {}],
      ["/p1", "w", "1-3", "execute", "sonnet/low", 1, 2, 1, 15, 4, { completed: 1 }, { pass: 1 }],
      ["/p1", "w", "1-3", "review", "opus/high", 1, 0, 0, 0, 0, { completed: 1 }, { pass: 1 }],
      ["/p1", "w", "4-6", "-", "haiku/low", 1, 0, 0, 0, 0, { failed: 1 }, {}],
      ["/p2", "w", "7-10", "-", "-/-", 1, 0, 0, 7, 0, { completed: 1 }, {}],
    ]);
  });

  it("filters by --since and --project", () => {
    expect(calibrate(ledger, { since: "2026-11-01" }).map(r => r.project)).not.toContain("/p2");
    expect(calibrate(ledger, { project: "/p2" })).toHaveLength(1);
    expect(calibrate(ledger, { project: "/p2/" })).toHaveLength(1);
  });

  it("prints a table and json from a ledger file", () => {
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), "cal-")), "l.jsonl");
    writeFileSync(f, ledger.map(l => JSON.stringify(l)).join("\n") + "\n{broken\n");
    const out = runCalibration(["--ledger", f, "--project", "/p2"], f);
    expect(out.split("\n")).toHaveLength(2);
    expect(JSON.parse(runCalibration(["--ledger", f, "--json"], f))).toHaveLength(5);
    expect(formatCalibration(calibrate(ledger), false).split("\n")[0]).toMatch(
      /^project\s+workflow/,
    );
  });
});

describe("wf-calibration bin", () => {
  it("runs through a symlink", () => {
    execFileSync("npx", ["tsc", "-p", "."], { cwd: process.cwd() });
    const dir = mkdtempSync(path.join(os.tmpdir(), "cal-bin-"));
    const f = path.join(dir, "l.jsonl");
    writeFileSync(f, JSON.stringify(ledger[0]) + "\n");
    const link = path.join(dir, "wf-calibration");
    symlinkSync(path.resolve("build/calibration-cli.js"), link);
    const out = execFileSync("node", [link, "--ledger", f], {
      encoding: "utf8",
    });
    expect(out).toContain("/p1");
  });
});

describe("ledgerEntry fields", () => {
  it("records project, visits, verdict, agent_ids, plan_handoff and counts", () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cal-repo-")));
    execFileSync("git", ["init", "-q", repo]);
    const at = "2026-11-05T00:00:00Z";
    const session = {
      session_id: "s",
      stack: [],
      active_frame: -1,
      started_at: at,
      updated_at: at,
      overrides: {},
      context: {
        cwd: repo,
        slice: "LINE-1",
        review_verdict: "pass",
        agent_id_execute: "ag1",
        plan_handoff: "true",
        items: ["a", "b", "c"],
      },
      history: [
        { frame: 0, at, event: "start", workflow: "w", to: "work" },
        { frame: 0, at, from: "work", to: "review" },
        { frame: 0, at, from: "review", to: "work" },
        { frame: 0, at, from: "work", to: "review" },
      ],
    } as unknown as SessionState;
    const e = ledgerEntry(session);
    expect(e.project).toBe(repo);
    expect(e.task).toBe("LINE-1");
    expect(
      ledgerEntry({ ...session, context: { task: "free text with spaces" } }).task,
    ).toBeUndefined();
    expect(e.visits).toEqual({ work: 2, review: 2 });
    expect(e.verdict).toBe("pass");
    expect(e.agent_ids).toEqual({ execute: "ag1" });
    expect(e.plan_handoff).toBe(true);
    expect(e.counts).toEqual({ items: 3 });
  });
});
