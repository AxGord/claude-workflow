import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { agentContextOf, lastTurnContext } from "./spend.js";
import { InMemoryStorage, cleanupDir, createTestLoader } from "./test-helpers.js";

interface Turn {
  readonly id: string;
  readonly input?: number;
  readonly read?: number;
  readonly write?: number;
  readonly output?: number;
}

const line = (t: Turn): string =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-01-01T00:00:30.000Z",
    message: {
      id: t.id,
      model: "claude-sonnet-4-5",
      usage: {
        input_tokens: t.input ?? 0,
        output_tokens: t.output ?? 1,
        cache_read_input_tokens: t.read ?? 0,
        cache_creation_input_tokens: t.write ?? 0,
      },
    },
  });

describe("lastTurnContext", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-ctx-"));
  });
  afterEach(() => cleanupDir(dir));

  const file = (...lines: string[]): string => {
    const f = path.join(dir, "agent-a.jsonl");
    fs.writeFileSync(f, lines.join("\n") + "\n");
    return f;
  };

  it("is input + cache read + cache write of the last assistant turn, not an earlier one", () => {
    const f = file(
      line({ id: "m1", input: 10, read: 900_000, write: 5 }),
      line({ id: "m2", input: 3, read: 100, write: 20 }),
    );
    expect(lastTurnContext(f)).toBe(123);
  });

  it("takes the largest reading of a turn repeated per content block, and skips lines that are not a turn", () => {
    const f = file(
      line({ id: "m1", input: 1, read: 5 }),
      line({ id: "m2", input: 2, read: 40 }),
      line({ id: "m2", input: 2, read: 50, write: 8 }),
      JSON.stringify({ type: "user", message: { role: "user", content: "x" } }),
      line({ id: "synthetic" }).replace('"output_tokens":1', '"output_tokens":0'),
    );
    expect(lastTurnContext(f)).toBe(60);
  });

  it("finds the last turn behind a tail longer than the first read", () => {
    const big = JSON.stringify({
      type: "user",
      message: { content: "y".repeat(600_000) },
    });
    const f = file(line({ id: "m1", read: 7 }), big, line({ id: "m2", read: 9 }), big);
    expect(lastTurnContext(f)).toBe(9);
  });

  it("reads on until a turn before the last one proves the last turn's lines are whole", () => {
    const big = JSON.stringify({ type: "user", message: { content: "y".repeat(300_000) } });
    const f = file(
      line({ id: "m1", read: 5 }),
      line({ id: "m2", read: 50 }),
      big,
      line({ id: "m2", read: 40 }),
    );
    expect(lastTurnContext(f)).toBe(50);
  });

  it("is undefined for a transcript with no turn or no file", () => {
    expect(lastTurnContext(file("{}", "not json"))).toBeUndefined();
    expect(lastTurnContext(path.join(dir, "gone.jsonl"))).toBeUndefined();
  });
});

describe("AGENT_CONTEXT of an exec", () => {
  let cfg: string;
  let wfDirs: string[];
  let saved: { config?: string; inherited?: string };

  beforeEach(() => {
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), "wf-ctx-cfg-"));
    wfDirs = [];
    saved = {
      config: process.env.CLAUDE_CONFIG_DIR,
      inherited: process.env.AGENT_CONTEXT,
    };
    process.env.CLAUDE_CONFIG_DIR = cfg;
    // a value inherited from outside describes no session of this run
    process.env.AGENT_CONTEXT = "999";
  });
  afterEach(() => {
    for (const [k, v] of [
      ["CLAUDE_CONFIG_DIR", saved.config],
      ["AGENT_CONTEXT", saved.inherited],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanupDir(cfg);
    for (const d of wfDirs) cleanupDir(d);
  });

  const transcript = (agent: string, ...lines: string[]): void => {
    const subs = path.join(cfg, "projects", "p", "conv", "subagents");
    fs.mkdirSync(subs, { recursive: true });
    fs.writeFileSync(path.join(subs, `agent-${agent}.jsonl`), lines.join("\n") + "\n");
  };

  const setup = (): { engine: Engine; storage: InMemoryStorage } => {
    const { loader, dir } = createTestLoader({
      w: {
        initial: "show",
        states: {
          show: { prompt: "go", transitions: { next: "ctx" } },
          ctx: {
            type: "exec",
            command: 'printf "[%s]" "$AGENT_CONTEXT"',
            on_success: "out",
            on_error: "out",
          },
          out: { prompt: "{{stdout}}", transitions: { done: "end" } },
          end: { terminal: true, outcome: "complete" },
        },
      },
    });
    wfDirs.push(dir);
    const storage = new InMemoryStorage();
    return { engine: new Engine(storage, loader, new Executor()), storage };
  };

  const echoed = async (engine: Engine, sessionId: string): Promise<string> =>
    (await engine.transition(sessionId, "next")).prompt;

  it("equals the last turn of the linked agent's transcript", async () => {
    transcript(
      "a1",
      line({ id: "m1", read: 900_000 }),
      line({ id: "m2", input: 4, read: 300, write: 12 }),
    );
    const { engine } = setup();
    const { sessionId } = await engine.start("w");
    await engine.linkAgent(sessionId, "agent-a1");
    expect(await echoed(engine, sessionId)).toBe("[316]");
  });

  it("is empty when no agent is linked, whatever the environment held", async () => {
    const { engine } = setup();
    const { sessionId } = await engine.start("w");
    expect(await echoed(engine, sessionId)).toBe("[]");
  });

  it("is empty when the linked agent's transcript cannot be found", async () => {
    const { engine } = setup();
    const { sessionId } = await engine.start("w");
    await engine.linkAgent(sessionId, "nobody");
    expect(await echoed(engine, sessionId)).toBe("[]");
  });

  it("follows a re-linked agent: the new agent's value", async () => {
    transcript("a1", line({ id: "m1", read: 250_000 }));
    transcript("a2", line({ id: "n1", read: 11 }));
    const { engine } = setup();
    const { sessionId } = await engine.start("w");
    await engine.linkAgent(sessionId, "a1");
    await engine.linkAgent(sessionId, "a2");
    expect(await echoed(engine, sessionId)).toBe("[11]");
  });

  it("an exec run without a session context drops an inherited AGENT_CONTEXT", async () => {
    const r = await new Executor().execute(
      { type: "exec", command: 'printf "[%s]" "${AGENT_CONTEXT-unset}"' },
      {},
    );
    expect(r.stdout).toBe("[unset]");
  });

  it("agentContextOf reads the agent of the session it is given", () => {
    transcript("a1", line({ id: "m1", input: 1, read: 2, write: 3 }));
    expect(agentContextOf({ agent_id: "agent-a1" }, path.join(cfg, "projects"))).toBe(6);
    expect(agentContextOf({}, path.join(cfg, "projects"))).toBeUndefined();
  });
});
