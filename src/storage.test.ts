import { describe, it, expect } from "vitest";
import { prunePolicy } from "./storage.js";
import type { SessionState } from "./types.js";

/** Build a minimal terminal (empty-stack) session. */
function terminal(id: string, updatedAt: string): SessionState {
  return {
    session_id: id,
    stack: [],
    active_frame: -1,
    started_at: updatedAt,
    updated_at: updatedAt,
    history: [],
    overrides: {},
    context: {},
    outcome: "completed",
  };
}

/** Build an active (non-empty-stack) session. */
function active(id: string, updatedAt: string): SessionState {
  return {
    session_id: id,
    stack: [
      { workflow: "w", current_state: "s", state_visits: { s: 1 }, total_transitions: 0 },
    ],
    active_frame: 0,
    started_at: updatedAt,
    updated_at: updatedAt,
    history: [],
    overrides: {},
    context: {},
  };
}

describe("prunePolicy", () => {
  it("throws when keep < 0", () => {
    expect(() => prunePolicy([], -1, () => {})).toThrow("keep must be >= 0");
  });

  it("skips a session object with no stack field (the {} placeholder) without throwing or deleting it", () => {
    // write() creates a transient `{}` file before the lock+rename; parsed it
    // has no `stack` property, so `s.stack?.length === 0` must be false.
    const placeholder = {} as unknown as SessionState;
    const deleted: string[] = [];
    expect(() =>
      prunePolicy([placeholder], 0, id => deleted.push(id))
    ).not.toThrow();
    expect(deleted).toEqual([]);
  });

  it("skips placeholder but still prunes real terminal sessions around it", () => {
    const placeholder = {} as unknown as SessionState;
    const sessions: SessionState[] = [
      placeholder,
      terminal("a", "2026-01-01T00:00:01.000Z"),
      terminal("b", "2026-01-01T00:00:02.000Z"),
      terminal("c", "2026-01-01T00:00:03.000Z"),
    ];
    const deleted: string[] = [];
    prunePolicy(sessions, 1, id => deleted.push(id));
    // Newest ("c") retained; older two deleted; placeholder untouched.
    expect(deleted.sort()).toEqual(["a", "b"]);
  });

  it("does not delete active (non-empty-stack) sessions", () => {
    const sessions: SessionState[] = [
      active("act", "2026-01-01T00:00:00.000Z"),
      terminal("t1", "2026-01-01T00:00:01.000Z"),
      terminal("t2", "2026-01-01T00:00:02.000Z"),
    ];
    const deleted: string[] = [];
    prunePolicy(sessions, 1, id => deleted.push(id));
    expect(deleted).toEqual(["t1"]);
  });

  it("retains exactly the `keep` newest by updated_at", () => {
    const sessions: SessionState[] = [
      terminal("oldest", "2026-01-01T00:00:01.000Z"),
      terminal("mid", "2026-01-01T00:00:02.000Z"),
      terminal("newest", "2026-01-01T00:00:03.000Z"),
    ];
    const deleted: string[] = [];
    prunePolicy(sessions, 2, id => deleted.push(id));
    expect(deleted).toEqual(["oldest"]);
  });

  it("keep=0 deletes every terminal session", () => {
    const sessions: SessionState[] = [
      terminal("a", "2026-01-01T00:00:01.000Z"),
      terminal("b", "2026-01-01T00:00:02.000Z"),
    ];
    const deleted: string[] = [];
    prunePolicy(sessions, 0, id => deleted.push(id));
    expect(deleted.sort()).toEqual(["a", "b"]);
  });

  it("tiebreak by session_id desc is deterministic on identical updated_at (cascade case)", () => {
    // _cascadeAbandonChildren stamps every child with one identical updated_at.
    const ts = "2026-01-01T00:00:00.000Z";
    const sessions: SessionState[] = [
      terminal("aaa", ts),
      terminal("ccc", ts),
      terminal("bbb", ts),
    ];
    const deleted: string[] = [];
    prunePolicy(sessions, 1, id => deleted.push(id));
    // Sort is updated_at desc, then session_id desc → order: ccc, bbb, aaa.
    // keep=1 retains "ccc"; deletes the two lowest ids.
    expect(deleted.sort()).toEqual(["aaa", "bbb"]);

    // Determinism: identical input always yields the identical retained set.
    const deleted2: string[] = [];
    prunePolicy(
      [terminal("bbb", ts), terminal("aaa", ts), terminal("ccc", ts)],
      1,
      id => deleted2.push(id)
    );
    expect(deleted2.sort()).toEqual(["aaa", "bbb"]);
  });

  it("does nothing when terminal count <= keep", () => {
    const sessions: SessionState[] = [terminal("a", "2026-01-01T00:00:01.000Z")];
    const deleted: string[] = [];
    prunePolicy(sessions, 3, id => deleted.push(id));
    expect(deleted).toEqual([]);
  });
});
