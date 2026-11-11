import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Storage } from "./storage.js";
import { KEEP_TERMINAL_SESSIONS } from "./types.js";
import { measureSpend, subtreeOf } from "./spend.js";
import type { SessionState } from "./types.js";

const base = (id: string, over: Partial<SessionState>): SessionState => ({
  session_id: id,
  stack: [],
  active_frame: -1,
  started_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  history: [],
  overrides: {},
  context: {},
  outcome: "completed",
  ...over,
});

describe("ledger spend roll-up of a pipeline", () => {
  it("sums the agents of every child session even after the terminal-session cap pruned them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-rollup-"));
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "wf-rollup-proj-"));
    const subs = path.join(proj, "p", "conv", "subagents");
    fs.mkdirSync(subs, { recursive: true });
    const usage = { input_tokens: 1000, output_tokens: 1000 };
    const n = KEEP_TERMINAL_SESSIONS + 3;
    const storage = new Storage(dir);
    for (let i = 0; i < n; i++) {
      fs.writeFileSync(
        path.join(subs, `agent-a${i}.jsonl`),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-01-01T00:00:30.000Z",
          message: { id: `m${i}`, model: "claude-sonnet-4-5", usage },
        }),
      );
      const kid = base(`kid${i}`, {
        parent_session_id: "pipe",
        agent_id: `a${i}`,
        claude_session_id: "conv",
        updated_at: `2026-01-01T00:00:0${i}.000Z`,
      });
      await storage.write(kid.session_id, kid);
      // the engine prunes after each session ends
      storage.pruneTerminal(KEEP_TERMINAL_SESSIONS);
    }
    const pipe = base("pipe", {
      updated_at: "2026-01-01T00:01:00.000Z",
      claude_session_id: "conv",
    });
    await storage.write("pipe", pipe);
    const spend = measureSpend(
      subtreeOf(pipe, storage.readAll()),
      pipe.started_at,
      pipe.updated_at,
      proj,
    );
    expect(spend?.agents).toBe(n);
  });
});
