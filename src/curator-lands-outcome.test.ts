import { describe, expect, it } from "vitest";
import { curatorStandings, parseCuratorConfig, landsSince } from "./curator.js";
import { ledgerEntry } from "./ledger.js";
import type { SessionState } from "./types.js";

// ENG-CURATOR-LANDS-OUTCOME: the curator counts a land from the line the REAL ledger writer produces
// (outcome "completed"), so a finished task makes the land-driven jobs come due.

function endedSession(id: string, task: string): SessionState {
  return {
    session_id: id,
    stack: [],
    active_frame: 0,
    started_at: "2026-11-26T10:00:00.000Z",
    updated_at: "2026-11-26T11:00:00.000Z",
    history: [
      { frame: 0, at: "2026-11-26T10:00:00.000Z", event: "start", workflow: "slice-pipeline" },
    ] as never,
    overrides: {},
    context: { slice: task },
  };
}

describe("curator counts a land written by the real ledger writer", () => {
  it("a completed session's ledger line is a land and makes hygiene due", () => {
    const entries = ["A-1", "A-2", "A-3"].map((t, i) => ledgerEntry(endedSession(`s${i}`, t)));
    expect(entries.map(e => e.outcome)).toEqual(["completed", "completed", "completed"]);
    const scope = { ids: new Set(["A-1", "A-2", "A-3"]) };
    expect(landsSince(entries, scope, undefined).map(e => e.task)).toEqual(["A-1", "A-2", "A-3"]);
    const config = parseCuratorConfig(
      "jobs:\n  hygiene: {every: 2}\n",
      "/p/.claude/curator.yaml",
      "/p",
    );
    const standings = curatorStandings({
      config,
      state: { project: "/p", jobs: {} },
      ledger: entries,
      scope,
    });
    expect(standings.map(s => [s.job, s.count, s.due !== undefined])).toEqual([
      ["hygiene", 3, true],
    ]);
  });
});
