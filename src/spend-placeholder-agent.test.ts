// Repro of ENG-SPEND-PLACEHOLDER-AGENT-DROPS-TOTAL: a driver linked the literal `PENDING` as an agent id; the ledger
// lost the whole task total (`usd` absent) although another agent was measured, and link_agent accepted the id.
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { measureSpend } from "./spend.js";
import { buildCost } from "./calibration.js";
import { taskCostRows } from "./ledger.js";
import { ledgerSpend } from "./replay.js";
import { InMemoryStorage, cleanupDir, createTestLoader } from "./test-helpers.js";
import type { SessionState } from "./types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const CHILD = {
  initial: "go",
  states: { go: { prompt: "go", transitions: { end: "fin" } }, fin: { terminal: true } },
};

describe("a placeholder agent id", () => {
  it("one unmeasured agent keeps the measured sum as usd, with a partial mark", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-placeholder-")));
    dirs.push(root);
    const sub = path.join(root, "proj", "conv", "subagents");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(sub, "agent-real1.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-09T10:10:00Z",
        message: { id: "m1", model: "claude-sonnet-5-5", usage: { output_tokens: 1_000_000 } },
      }),
    );
    const s = {
      session_id: "w",
      context: {},
      stack: [],
      history: [],
      agent_id: "PENDING",
      agent_links: [
        { agent_id: "real1", at: "2026-11-09T10:05:00Z", state: "work", stage: "execute" },
        { agent_id: "PENDING", at: "2026-11-09T10:06:00Z", state: "fix", stage: "fix" },
      ],
    } as unknown as SessionState;
    const spend = measureSpend([s], "2026-11-09T10:00:00Z", "2026-11-09T11:00:00Z", root)!;
    expect(spend.unmeasured).toEqual(["PENDING"]);
    // the measured $10 of the real agent is kept, not dropped to `—`
    expect(spend.usd).toBe(10);
    expect(Object.keys(spend).some(k => /partial/.test(k)) || spend.unmeasured !== undefined).toBe(
      true,
    );
    expect(spend.usd_partial).toBe(true);
  });

  it("link_agent refuses an id that is no agent id", async () => {
    const storage = new InMemoryStorage();
    const { loader, dir } = createTestLoader({ child: CHILD });
    try {
      const engine = new Engine(storage, loader, new Executor());
      const kid = (await engine.start("child")).sessionId;
      await expect(engine.linkAgent(kid, "PENDING")).rejects.toThrow(/PENDING/);
    } finally {
      cleanupDir(dir);
    }
  });

  it("link_agent takes an Agent tool id, with or without the transcript's `agent-` prefix, and names a refused one", async () => {
    const storage = new InMemoryStorage();
    const { loader, dir } = createTestLoader({ child: CHILD });
    try {
      const engine = new Engine(storage, loader, new Executor());
      const kid = (await engine.start("child")).sessionId;
      for (const bad of ["PENDING", "PENDING_FIX", "pending", "worker1", "agent-"])
        await expect(engine.linkAgent(kid, bad)).rejects.toThrow(`"${bad}" is not an agent id`);
      expect(storage.read(kid)!.agent_id).toBeUndefined();
      await engine.linkAgent(kid, "a15bb6b2a76ef441c");
      await engine.linkAgent(kid, "agent-aa6a163349f7dfe23");
      expect(storage.read(kid)!.linked_agents).toEqual([
        "a15bb6b2a76ef441c",
        "agent-aa6a163349f7dfe23",
      ]);
    } finally {
      cleanupDir(dir);
    }
  });

  it("a partial sum is read as a lower bound everywhere: kept on the pane's rows, never a whole cost", () => {
    const sp = { agents: 2, input: 1, output: 2, cache_read: 3, cache_write: 4 };
    const partial = { ...sp, usd: 17.4, usd_partial: true as const, unmeasured: ["PENDING"] };
    const rows = taskCostRows(
      JSON.stringify({ task: "T", session_id: "s", spend: partial }) +
        "\n" +
        JSON.stringify({ task: "U", session_id: "u", spend: { ...sp, usd: 2 } }),
    );
    const spendOf = (task: string): unknown =>
      (JSON.parse(rows.get(task)![0]) as { spend?: unknown }).spend;
    expect(spendOf("T")).toEqual({ usd: 17.4, usd_partial: true });
    expect(spendOf("U")).toEqual({ usd: 2 });
    const entry = {
      session_id: "p",
      root_session_id: "p",
      parent_session_id: null,
      workflow: "slice-pipeline",
      outcome: "completed",
      started_at: "2026-11-08T00:00:00Z",
      ended_at: "2026-11-08T12:00:00",
      transitions: 1,
      exec_ms_total: 0,
      wait_ms_total: 0,
      execs: [],
      task: "T",
      visits: { review: 1, project_land: 1 },
      tokens: { total: 1_000_000 },
      spend: partial,
    } as unknown as Parameters<typeof buildCost>[0][number];
    const cost = buildCost([entry], "2026-11-08", "2026-11-08");
    expect([cost.tasks[0].measured, cost.tasks[0].usd]).toEqual([false, 0]);
    const ledger = JSON.stringify({
      task: "T",
      workflow: "engine-task",
      ended_at: "2026-11-08T12:00:00Z",
      spend: partial,
    });
    expect(ledgerSpend(ledger, new Set(["T"]))).toEqual({});
  });
});
