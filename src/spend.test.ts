import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentsOf, measureSpend, subtreeOf } from "./spend.js";
import type { SessionState } from "./types.js";

const sess = (id: string, over: Partial<SessionState> = {}): SessionState =>
  ({
    session_id: id,
    context: {},
    stack: [],
    history: [],
    ...over,
  }) as unknown as SessionState;

const turn = (mid: string, at: string, model: string, usage: object) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at,
    message: { id: mid, model, usage },
  });

function projects(files: Record<string, string[]>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "spend-"));
  const dir = path.join(root, "proj", "conv", "subagents");
  mkdirSync(dir, { recursive: true });
  for (const [id, lines] of Object.entries(files))
    writeFileSync(path.join(dir, `agent-${id}.jsonl`), lines.join("\n"));
  return root;
}

describe("agentsOf", () => {
  it("collects the link, role keys and stage keys of the whole subtree, once", () => {
    const root = sess("r", {
      agent_id: "a1",
      context: { recon_agent: "a2", agent_id_work: "agent-a3" },
    });
    const kid = sess("k", {
      parent_session_id: "r",
      context: { reviewer_agent: "a2", note: "x" },
    });
    const other = sess("o", { context: { worker_agent: "zz" } });
    expect(agentsOf(subtreeOf(root, [root, kid, other])).sort()).toEqual(["a1", "a2", "a3"]);
  });
});

describe("measureSpend", () => {
  const usage = {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
  };
  const W = ["2026-11-09T10:00:00Z", "2026-11-09T11:00:00Z"] as const;

  it("prices input, output, cache read and write by the turn's own model, a turn once, inside the window", () => {
    const root = projects({
      a1: [
        turn("m1", "2026-11-09T10:10:00Z", "claude-sonnet-5-5", usage),
        turn("m1", "2026-11-09T10:10:01Z", "claude-sonnet-5-5", usage), // same turn, second block
        turn("m0", "2026-11-09T09:00:00Z", "claude-sonnet-5-5", usage), // before the task
        turn("m2", "2026-11-09T10:20:00Z", "claude-opus-5-5", {
          output_tokens: 1_000_000,
        }),
      ],
    });
    const s = measureSpend([sess("r", { agent_id: "a1" })], W[0], W[1], root)!;
    // sonnet: 3 + 15 + 0.3 + 3.75 = 22.05; opus output 75
    expect(s.usd).toBeCloseTo(97.05, 6);
    expect(s.agents).toBe(1);
    expect(s.output).toBe(2_000_000);
  });

  it("a 1-hour cache write costs twice the input rate", () => {
    const root = projects({
      a1: [
        turn("m1", "2026-11-09T10:10:00Z", "sonnet", {
          cache_creation_input_tokens: 1_000_000,
          cache_creation: {
            ephemeral_1h_input_tokens: 1_000_000,
            ephemeral_5m_input_tokens: 0,
          },
        }),
      ],
    });
    expect(measureSpend([sess("r", { agent_id: "a1" })], W[0], W[1], root)!.usd).toBeCloseTo(6, 6);
  });

  it("a synthetic zero-usage turn costs $0 and does not unmeasure the agent", () => {
    const root = projects({
      a1: [
        turn("s1", "2026-11-09T10:10:00Z", "<synthetic>", { input_tokens: 0, output_tokens: 0 }),
        turn("m1", "2026-11-09T10:11:00Z", "sonnet", { output_tokens: 1_000_000 }),
      ],
    });
    expect(measureSpend([sess("r", { agent_id: "a1" })], W[0], W[1], root)!.usd).toBeCloseTo(15, 6);
  });

  it("an agent no key names is counted on the row as unnamed", () => {
    const root = projects({
      a1: [turn("m1", "2026-11-09T10:10:00Z", "sonnet", usage)],
      a2: [turn("m2", "2026-11-09T10:12:00Z", "sonnet", usage)],
    });
    const s = measureSpend(
      [sess("r", { agent_id: "a1", claude_session_id: "conv" })],
      "2000-01-01T00:00:00Z",
      "2100-01-01T00:00:00Z",
      root,
    )!;
    expect(s.unnamed).toBe(1);
  });

  it("an unreadable transcript leaves the task unmeasured, not $0", () => {
    const root = projects({
      a1: [turn("m1", "2026-11-09T10:10:00Z", "sonnet", usage)],
    });
    const s = measureSpend(
      [sess("r", { agent_id: "a1", context: { recon_agent: "gone" } })],
      W[0],
      W[1],
      root,
    )!;
    expect(s.usd).toBeUndefined();
    expect(s.unmeasured).toEqual(["gone"]);
  });

  it("an unpriced model leaves it unmeasured; a task with no agent has no spend", () => {
    const root = projects({
      a1: [turn("m1", "2026-11-09T10:10:00Z", "mystery-1", usage)],
    });
    expect(measureSpend([sess("r", { agent_id: "a1" })], W[0], W[1], root)!.usd).toBeUndefined();
    expect(measureSpend([sess("r")], W[0], W[1], root)).toBeUndefined();
  });
});
