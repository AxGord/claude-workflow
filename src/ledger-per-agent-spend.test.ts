// Pins of ENG-LEDGER-PER-AGENT-SPEND: a task's ledger `spend` also lists each agent's spend per state and stage it
// was linked at (`by_agent`), and `wf-calibration` sums it per stage row.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { calibrate, formatCalibration } from "./calibration.js";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import type { LedgerEntry } from "./ledger.js";
import { measureSpend } from "./spend.js";
import { InMemoryStorage, cleanupDir, createTestLoader } from "./test-helpers.js";
import type { AgentLink, SessionState } from "./types.js";

const turn = (mid: string, at: string, model: string, usage: object) =>
  JSON.stringify({ type: "assistant", timestamp: at, message: { id: mid, model, usage } });

/** One million output tokens: $10 of sonnet 5.5, $20 of opus 5.5. */
const MTOK = { output_tokens: 1_000_000 };
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";

const dirs: string[] = [];
let config: string | undefined;
beforeEach(() => {
  config = process.env.CLAUDE_CONFIG_DIR;
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  if (config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = config;
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const tmp = (prefix: string): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

/** `<projects>/proj/conv/subagents/agent-<id>.jsonl` per agent; returns the projects directory. */
function transcripts(files: Record<string, string[]>): string {
  const root = tmp("wf-per-agent-");
  const sub = path.join(root, "proj", "conv", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  for (const [id, lines] of Object.entries(files))
    fs.writeFileSync(path.join(sub, `agent-${id}.jsonl`), lines.join("\n"));
  return root;
}

const sess = (id: string, over: Partial<SessionState> = {}): SessionState =>
  ({ session_id: id, context: {}, stack: [], history: [], ...over }) as unknown as SessionState;

const link = (agent_id: string, at: string, state?: string, stage?: string): AgentLink => ({
  agent_id,
  at,
  ...(state !== undefined ? { state } : {}),
  ...(stage !== undefined ? { stage } : {}),
});

describe("measureSpend per agent", () => {
  const W = ["2026-11-09T10:00:00Z", "2026-11-09T11:00:00Z"] as const;

  it("splits an agent linked again at the call's time, and the rows sum to the task's spend", () => {
    const root = transcripts({
      w1: [
        turn("m1", "2026-11-09T10:10:00Z", SONNET, MTOK),
        turn("m2", "2026-11-09T10:40:00Z", SONNET, MTOK),
        turn("m3", "2026-11-09T10:50:00Z", SONNET, MTOK),
      ],
      r1: [turn("m4", "2026-11-09T10:30:00Z", OPUS, MTOK)],
    });
    const worker = sess("w", {
      agent_id: "w1",
      agent_links: [
        link("w1", "2026-11-09T10:05:00Z", "work_spawn", "execute"),
        link("w1", "2026-11-09T10:35:00Z", "fixes", "fix"),
      ],
    });
    const reviewer = sess("r", {
      agent_id: "r1",
      agent_links: [link("r1", "2026-11-09T10:20:00Z", "review_spawn", "review")],
    });
    const s = measureSpend([worker, reviewer], W[0], W[1], root)!;
    expect(s.by_agent!.map(a => [a.agent, a.state, a.stage, a.model, a.usd])).toEqual([
      ["w1", "work_spawn", "execute", SONNET, 10],
      ["w1", "fixes", "fix", SONNET, 20],
      ["r1", "review_spawn", "review", OPUS, 20],
    ]);
    expect(s.by_agent!.reduce((n, a) => n + a.usd!, 0)).toBeCloseTo(s.usd!, 6);
    expect(s.usd).toBeCloseTo(50, 6);
  });

  it("a link at a state that spawns no stage keeps the agent's stage; an unlinked agent has none", () => {
    const root = transcripts({
      r1: [
        turn("m1", "2026-11-09T10:10:00Z", OPUS, MTOK),
        turn("m2", "2026-11-09T10:40:00Z", OPUS, MTOK),
      ],
      d1: [turn("m3", "2026-11-09T10:15:00Z", SONNET, MTOK)],
    });
    const reviewer = sess("r", {
      agent_links: [
        link("r1", "2026-11-09T10:05:00Z", "review_spawn", "review"),
        link("r1", "2026-11-09T10:30:00Z", "review_warm"),
      ],
      context: { decider_agent: "d1" },
    });
    const rows = measureSpend([reviewer], W[0], W[1], root)!.by_agent!;
    expect(rows.map(a => [a.agent, a.state, a.stage, a.usd])).toEqual([
      ["r1", "review_spawn", "review", 20],
      ["r1", "review_warm", "review", 20],
      ["d1", undefined, undefined, 10],
    ]);
  });

  it("an unreadable agent is a row without usd, never $0, and the task has no usd", () => {
    const root = transcripts({ a1: [turn("m1", "2026-11-09T10:10:00Z", SONNET, MTOK)] });
    const s = measureSpend(
      [
        sess("r", {
          agent_links: [link("a1", "2026-11-09T10:05:00Z", "work", "execute")],
          context: { recon_agent: "gone" },
        }),
      ],
      W[0],
      W[1],
      root,
    )!;
    expect(s.usd).toBeUndefined();
    expect(s.by_agent!.find(a => a.agent === "gone")).not.toHaveProperty("usd");
    expect(s.by_agent!.find(a => a.agent === "a1")!.usd).toBeCloseTo(10, 6);
  });
});

describe("wf-calibration $ per stage", () => {
  const line = (over: Partial<LedgerEntry>): LedgerEntry => ({
    session_id: "s",
    parent_session_id: null,
    root_session_id: "s",
    workflow: "pipe",
    outcome: "completed",
    started_at: "2026-11-09T10:00:00Z",
    ended_at: "2026-11-09T11:00:00Z",
    transitions: 1,
    exec_ms_total: 0,
    wait_ms_total: 0,
    execs: [],
    project: "/p",
    difficulty: 5,
    stages: {
      recon: { model: "sonnet", effort: "medium" },
      execute: { model: "opus", effort: "high" },
      review: { model: "opus", effort: "high" },
    },
    ...over,
  });
  const row = (agent: string, stage: string | undefined, usd?: number) => ({
    agent,
    ...(stage !== undefined ? { stage } : {}),
    ...(usd !== undefined ? { usd } : {}),
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
  });
  const spend = (by_agent: ReturnType<typeof row>[]): LedgerEntry["spend"] => ({
    agents: by_agent.length,
    by_agent,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
  });

  it("a worker and a reviewer linked at different stages give two stage rows with their own $", () => {
    const rows = calibrate(
      [
        line({
          spend: spend([row("w", "execute", 9), row("r", "review", 3.5), row("r", "review", 1)]),
        }),
      ],
      {},
    );
    const by = (s: string) => rows.find(r => r.stage === s)!;
    expect([by("execute").usd, by("execute").spent_tasks]).toEqual([9, 1]);
    expect([by("review").usd, by("review").spent_tasks]).toEqual([4.5, 1]);
    expect([by("recon").usd, by("recon").spent_tasks]).toEqual([0, 0]);
    const text = formatCalibration(rows, false);
    expect(text).toMatch(/execute\s+opus\/high\s+1\s+0\s+0\s+0\s+0\s+9\.00\s+9\.00/);
    expect(text).toMatch(/review\s+opus\/high\s+1\s+0\s+0\s+0\s+0\s+4\.50\s+4\.50/);
    expect(text).toMatch(/recon\s+sonnet\/medium\s+1\s+0\s+0\s+0\s+0\s+-\s+-/);
  });

  it("a row with no stage, or a stage the task did not run, goes to a - row, never to the first stage row; $/task divides by tasks with spend", () => {
    const rows = calibrate(
      [
        line({ spend: spend([row("d", undefined, 2), row("x", "plan", 1)]) }),
        line({ session_id: "t", spend: spend([row("w", "execute", 6), row("d", undefined, 4)]) }),
        line({ session_id: "u" }),
      ],
      {},
    );
    const by = (s: string) => rows.find(r => r.stage === s)!;
    expect([by("recon").usd, by("recon").spent_tasks]).toEqual([0, 0]);
    expect([by("-").usd, by("-").spent_tasks, by("-").model]).toEqual([7, 2, "-"]);
    expect([by("execute").usd, by("execute").spent_tasks, by("execute").tasks]).toEqual([6, 1, 3]);
    const text = formatCalibration(rows, false);
    expect(text).toMatch(/execute\s+opus\/high\s+3\s.*\s6\.00\s+6\.00\s/);
    expect(text).toMatch(/-\s+-\/-\s+2\s.*\s7\.00\s+3\.50\s/);
  });

  it("an unmeasured agent linked at no stage makes the - row a lower bound", () => {
    const rows = calibrate([line({ spend: spend([row("d", undefined)]) })], {});
    const loose = rows.find(r => r.stage === "-")!;
    expect([loose.usd, loose.unmeasured, loose.spent_tasks]).toEqual([0, 1, 0]);
    expect(rows.find(r => r.stage === "recon")!.unmeasured).toBe(0);
  });

  it("an unmeasured agent on a row makes its $ a lower bound; a line with no by_agent adds none", () => {
    const rows = calibrate(
      [
        line({ spend: spend([row("w", "execute", 5), row("v", "execute")]) }),
        line({ session_id: "t", spend: { ...spend([]), by_agent: undefined } }),
      ],
      {},
    );
    const execute = rows.find(r => r.stage === "execute")!;
    expect([execute.usd, execute.unmeasured, execute.spent_tasks]).toEqual([5, 1, 1]);
    expect(formatCalibration(rows, false)).toMatch(
      /execute\s+opus\/high\s+2\s.*\s>=5\.00\s+>=5\.00\s/,
    );
    expect(rows.find(r => r.stage === "recon")!.spent_tasks).toBe(0);
  });
});

// A pipeline without `driver:`, as the slice pipeline is: one child session per agent, linked while the pipeline
// stands at the state that spawned it.
const PIPE = {
  initial: "claim",
  model_table: {
    stages: {
      execute: [{ upto: 10, model: "sonnet", effort: "high" }],
      review: [{ upto: 10, model: "opus", effort: "high" }],
      fix: [{ upto: 10, model: "sonnet", effort: "high" }],
    },
  },
  states: {
    claim: { prompt: "claim", transitions: { go: "work_spawn" } },
    work_spawn: { prompt: "worker {{context.model}}", transitions: { next: "review_spawn" } },
    review_spawn: {
      prompt: "review {{context.model_review}}",
      transitions: { fixes: "fixes" },
    },
    fixes: { prompt: "fix {{context.model_fix}}", transitions: { next: "review_warm" } },
    review_warm: { prompt: "warm round", transitions: { land: "done" } },
    done: { terminal: true, outcome: "complete" },
  },
};
const CHILD = {
  initial: "go",
  states: { go: { prompt: "go", transitions: { end: "fin" } }, fin: { terminal: true } },
};

describe("an ended pipeline's ledger line", () => {
  it("lists each agent's spend at the state and stage it was linked at, and wf-calibration puts it on the stage rows", async () => {
    const cfg = tmp("wf-cfg-");
    process.env.CLAUDE_CONFIG_DIR = cfg;
    const sub = path.join(cfg, "projects", "p", "conv", "subagents");
    fs.mkdirSync(sub, { recursive: true });
    const agent = (id: string, lines: string[]) =>
      fs.writeFileSync(path.join(sub, `agent-${id}.jsonl`), lines.join("\n"));
    agent("w1", [
      turn("w-a", "2026-11-09T10:03:00Z", SONNET, MTOK),
      turn("w-b", "2026-11-09T10:45:00Z", SONNET, MTOK),
    ]);
    agent("r1", [
      turn("r-a", "2026-11-09T10:25:00Z", OPUS, MTOK),
      turn("r-b", "2026-11-09T10:55:00Z", OPUS, MTOK),
    ]);
    const storage = new InMemoryStorage();
    const { loader, dir } = createTestLoader({ pipe: PIPE, child: CHILD });
    dirs.push(dir);
    const engine = new Engine(storage, loader, new Executor(undefined, tmp("wf-runs-")), {
      stateDir: tmp("wf-state-"),
    });
    const at = (hhmm: string) => vi.setSystemTime(new Date(`2026-11-09T${hhmm}:00Z`));
    const kids: string[] = [];
    const spawn = async (parent: string, agentId: string, when: string) => {
      const kid = (await engine.start("child", undefined, parent)).sessionId;
      kids.push(kid);
      at(when);
      await engine.linkAgent(kid, agentId);
    };

    at("10:00");
    const p = (
      await engine.start("pipe", undefined, undefined, undefined, undefined, {
        slice: "T-A",
        difficulty: "5",
      })
    ).sessionId;
    await engine.transition(p, "go");
    at("10:01");
    await spawn(p, "w1", "10:02");
    at("10:20");
    await engine.transition(p, "next");
    await spawn(p, "r1", "10:21");
    at("10:40");
    await engine.transition(p, "fixes");
    await spawn(p, "w1", "10:41");
    at("10:50");
    await engine.transition(p, "next");
    await spawn(p, "r1", "10:51");
    at("11:00");
    for (const kid of kids) await engine.transition(kid, "end");
    await engine.transition(p, "land");

    const entry = (storage.ledger as LedgerEntry[]).find(l => l.task === "T-A")!;
    expect(entry.spend!.by_agent!.map(a => [a.agent, a.state, a.stage, a.usd])).toEqual([
      ["w1", "work_spawn", "execute", 10],
      ["w1", "fixes", "fix", 10],
      ["r1", "review_spawn", "review", 20],
      ["r1", "review_warm", "review", 20],
    ]);
    expect(entry.spend!.usd).toBeCloseTo(60, 6);
    const rows = calibrate([entry], {}).filter(r => r.workflow === "pipe");
    expect(rows.map(r => [r.stage, r.usd])).toEqual([
      ["execute", 10],
      ["fix", 10],
      ["review", 40],
    ]);
    expect(formatCalibration(rows, false)).toMatch(/review\s+opus\/high\s+1\s.*\s40\.00\s+40\.00/);
  });
});

const DISPATCH = {
  initial: "dispatch",
  states: {
    dispatch: { prompt: "dispatch", transitions: { dispatched: "fin" } },
    fin: { terminal: true },
  },
};
const ONE = {
  initial: "claim",
  model_table: { stages: { execute: [{ upto: 10, model: "sonnet", effort: "high" }] } },
  states: {
    claim: { prompt: "claim", transitions: { go: "work_spawn" } },
    work_spawn: { prompt: "worker {{context.model}}", transitions: { next: "done" } },
    done: { terminal: true, outcome: "complete" },
  },
};

describe("a driver linked at the dispatcher's dispatch", () => {
  it("is spend of no stage: the first stage row keeps its own $, the driver is on a - row", async () => {
    const cfg = tmp("wf-cfg-");
    process.env.CLAUDE_CONFIG_DIR = cfg;
    const sub = path.join(cfg, "projects", "p", "conv", "subagents");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(sub, "agent-d1.jsonl"),
      turn("d-a", "2026-11-09T10:30:00Z", OPUS, MTOK),
    );
    fs.writeFileSync(
      path.join(sub, "agent-w1.jsonl"),
      turn("w-a", "2026-11-09T10:25:00Z", SONNET, MTOK),
    );
    const storage = new InMemoryStorage();
    const { loader, dir } = createTestLoader({ disp: DISPATCH, one: ONE, child: CHILD });
    dirs.push(dir);
    const engine = new Engine(storage, loader, new Executor(undefined, tmp("wf-runs-")), {
      stateDir: tmp("wf-state-"),
    });
    const at = (hhmm: string) => vi.setSystemTime(new Date(`2026-11-09T${hhmm}:00Z`));
    at("10:00");
    const d = (await engine.start("disp")).sessionId;
    const p = (
      await engine.start("one", undefined, d, undefined, undefined, {
        slice: "T-D",
        difficulty: "5",
      })
    ).sessionId;
    at("10:01");
    await engine.linkAgent(p, "d1");
    await engine.transition(p, "go");
    const w = (await engine.start("child", undefined, p)).sessionId;
    at("10:20");
    await engine.linkAgent(w, "w1");
    at("10:40");
    await engine.transition(w, "end");
    await engine.transition(p, "next");

    const entry = (storage.ledger as LedgerEntry[]).find(l => l.task === "T-D")!;
    expect(entry.spend!.by_agent!.find(a => a.agent === "d1")).toMatchObject({
      state: "dispatch",
      usd: 20,
    });
    expect(entry.spend!.by_agent!.find(a => a.agent === "d1")).not.toHaveProperty("stage");
    const rows = calibrate([entry], {}).filter(r => r.workflow === "one");
    expect(rows.map(r => [r.stage, r.usd])).toEqual([
      ["-", 20],
      ["execute", 10],
    ]);
  });
});
