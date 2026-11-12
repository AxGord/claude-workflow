import { describe, it, expect } from "vitest";
import { prunePolicy } from "./storage.js";
import type { SessionState } from "./types.js";

function term(id: string, at: string, parent?: string): SessionState {
  return {
    session_id: id,
    stack: [],
    active_frame: -1,
    started_at: at,
    updated_at: at,
    history: [],
    overrides: {},
    context: {},
    outcome: "completed",
    ...(parent ? { parent_session_id: parent } : {}),
  };
}

describe("prunePolicy orphan child", () => {
  it("prunes a terminal child whose parent file is gone, at the usual age", () => {
    const sessions = [
      term("new1", "2026-01-03T00:00:00Z"),
      term("orphan", "2026-01-01T00:00:00Z", "missing-parent"),
    ];
    const deleted: string[] = [];
    prunePolicy(sessions, 1, id => deleted.push(id));
    expect(deleted).toEqual(["orphan"]);
  });
});
