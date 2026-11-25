import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { decideResume, resumeErrors } from "./resume.js";
import type { Resume, ResumeStep } from "./types.js";
import { InMemoryStorage, cleanupDir, createFixtureDir } from "./test-helpers.js";

const AGENT = "a8a8bb7cd343aa2ad";

const spec: Resume = {
  agent: "worker_agent",
  tokens: "tokens_worker",
  model: "{{context.model_fix}}",
  effort: "{{context.effort_fix}}",
  after_respawn: "link_agent it to {{context.worker_session}}.",
};
const step: ResumeStep = {
  message: "the cause: {{context.cause}}",
  brief: "fresh brief for {{context.task}}",
};
const MIN = 60_000;

describe("decideResume", () => {
  const at = (idleMin: number | undefined, context: number | undefined, s: ResumeStep = step) =>
    decideResume(spec, s, {
      agent: AGENT,
      idleMs: idleMin === undefined ? undefined : idleMin * MIN,
      context,
    }).choice;

  it("warm: idle under the limit resumes, however large the context", () => {
    expect(at(59, 900_000)).toBe("resume");
    expect(at(0, 10)).toBe("resume");
  });
  it("cold and small resumes; cold and large respawns; the bound itself resumes", () => {
    expect(at(61, 50_000)).toBe("resume");
    expect(at(61, 50_001)).toBe("respawn");
    expect(at(60, 120_000)).toBe("respawn");
  });
  it("a never_respawn step resumes cold and large", () => {
    expect(at(600, 900_000, { message: "m", never_respawn: true })).toBe("resume");
  });
  it("unknown idle or unknown context resumes; no agent respawns (a never step resumes)", () => {
    expect(at(undefined, 900_000)).toBe("resume");
    expect(at(600, undefined)).toBe("resume");
    expect(decideResume(spec, step, { agent: "" }).choice).toBe("respawn");
    expect(decideResume(spec, { message: "m", never_respawn: true }, { agent: "" }).choice).toBe(
      "resume",
    );
  });
  it("the thresholds are the spec's", () => {
    const own = { ...spec, idle_minutes: 10, context_tokens: 1000 };
    expect(decideResume(own, step, { agent: AGENT, idleMs: 11 * MIN, context: 1001 }).choice).toBe(
      "respawn",
    );
    expect(decideResume(own, step, { agent: AGENT, idleMs: 9 * MIN, context: 1001 }).choice).toBe(
      "resume",
    );
  });
});

describe("resumeErrors", () => {
  const fixed = { prompt: "{{resume}}", revisit_prompt: "{{resume}}" };
  it("names a step without the workflow's resume, a workflow without a step, a step without a brief", () => {
    expect(
      resumeErrors({ states: { a: { ...fixed, resume: { message: "m", brief: "b" } } } }),
    ).toEqual([
      expect.stringContaining('state "a" declares `resume:` but the workflow declares none'),
    ]);
    expect(resumeErrors({ resume: spec, states: { a: {} } })).toEqual([
      expect.stringContaining("no state does"),
    ]);
    expect(
      resumeErrors({ resume: spec, states: { a: { ...fixed, resume: { message: "m" } } } }),
    ).toEqual([expect.stringContaining('state "a" needs a `brief`')]);
    expect(
      resumeErrors({
        resume: spec,
        states: { a: { ...fixed, resume: { message: "m", brief: "b", never_respawn: true } } },
      }),
    ).toEqual([expect.stringContaining("needs no brief")]);
    expect(
      resumeErrors({
        resume: spec,
        states: { a: { ...fixed, resume: { message: "m", never_respawn: true } } },
      }),
    ).toEqual([]);
  });
  it("a step shows {{resume}} in its prompt and on a revisit (revisit_prompt, or full_on_revisit)", () => {
    const own = { message: "m", brief: "b" };
    expect(
      resumeErrors({
        resume: spec,
        states: { a: { prompt: "go", revisit_prompt: "{{resume}}", resume: own } },
      }),
    ).toEqual([expect.stringContaining("in its `prompt`")]);
    expect(
      resumeErrors({ resume: spec, states: { a: { prompt: "{{resume}}", resume: own } } }),
    ).toEqual([expect.stringContaining("in its `revisit_prompt`")]);
    expect(
      resumeErrors({
        resume: spec,
        states: { a: { prompt: "{{resume}}", revisit_prompt: "again", resume: own } },
      }),
    ).toEqual([expect.stringContaining("in its `revisit_prompt`")]);
    expect(
      resumeErrors({
        resume: spec,
        states: { a: { prompt: "{{resume}}", full_on_revisit: true, resume: own } },
      }),
    ).toEqual([]);
  });
});

describe("the engine renders ONE instruction at a `resume:` step", () => {
  let cfg: string;
  let dirs: string[];
  let savedCfg: string | undefined;

  beforeEach(() => {
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), "wf-resume-cfg-"));
    dirs = [];
    savedCfg = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
  });
  afterEach(() => {
    if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedCfg;
    cleanupDir(cfg);
    for (const d of dirs) cleanupDir(d);
  });

  /** The agent's transcript: one turn of `context` tokens, last changed `idleMin` minutes ago. */
  const transcript = (context: number, idleMin: number): void => {
    const subs = path.join(cfg, "projects", "p", "conv", "subagents");
    fs.mkdirSync(subs, { recursive: true });
    const file = path.join(subs, `agent-${AGENT}.jsonl`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "m1",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: context - 1 },
        },
      }) + "\n",
    );
    const t = new Date(Date.now() - idleMin * MIN);
    fs.utimesSync(file, t, t);
  };

  const workflow = (neverFix = false) => ({
    initial: "work",
    resume: spec,
    states: {
      work: { prompt: "first visit", transitions: { check: "fix" } },
      fix: {
        prompt: "{{resume}}",
        revisit_prompt: "{{resume}}",
        resume: neverFix ? { message: step.message, never_respawn: true } : step,
        transitions: { again: "fix", done: "end" },
      },
      end: { terminal: true, outcome: "complete" },
    },
  });

  const run = async (
    wf: object,
    context: Record<string, string>,
    set: Record<string, unknown> = {},
  ) => {
    const dir = createFixtureDir({ w: wf });
    dirs.push(dir);
    const engine = new Engine(new InMemoryStorage(), new Loader(null, dir, null), new Executor());
    const { sessionId } = await engine.start("w", undefined, undefined, undefined, undefined, {
      worker_agent: AGENT,
      cause: "tests red",
      task: "T1",
      worker_session: "W2",
      model_fix: "sonnet",
      effort_fix: "high",
      ...context,
    });
    const status = await engine.transition(sessionId, "check", undefined, set);
    return { engine, sessionId, status };
  };

  it("warm: resumes with the message, never the brief", async () => {
    transcript(300_000, 5);
    const { status, engine, sessionId } = await run(workflow(), {});
    expect(status.prompt).toContain(`RESUME (warm: idle 5 min < 60`);
    expect(status.prompt).toContain(`SendMessage \`${AGENT}\` with:\nthe cause: tests red`);
    expect(status.prompt).not.toContain("RESPAWN");
    expect(status.prompt).not.toContain("fresh brief");
    expect(engine.resumeChoiceLine(sessionId)).toContain("RESUME CHOICE at fix (visit 1): resume");
  });

  it("cold and small: resumes", async () => {
    transcript(40_000, 120);
    const { status } = await run(workflow(), {});
    expect(status.prompt).toContain(
      "RESUME (cold but small: idle 120 min >= 60, context 40000 <= 50000",
    );
    expect(status.prompt).not.toContain("fresh brief");
  });

  it("cold and large: respawns with the brief, model and effort, never SendMessage", async () => {
    transcript(120_000, 120);
    const { status, engine, sessionId } = await run(workflow(), {});
    expect(status.prompt).toContain(
      "RESPAWN (cold and large: idle 120 min >= 60, context 120000 > 50000",
    );
    expect(status.prompt).toContain(`do NOT SendMessage \`${AGENT}\``);
    expect(status.prompt).toContain("model sonnet, effort high");
    expect(status.prompt).toContain("fresh brief for T1");
    expect(status.prompt).toContain(
      "`context_set` `worker_agent` to the new agent's id. link_agent it to W2.",
    );
    expect(status.prompt).not.toContain("the cause: tests red");
    expect(engine.resumeChoiceLine(sessionId)).toContain("respawn");
  });

  it("a never_respawn step resumes a cold large agent", async () => {
    transcript(900_000, 600);
    const { status } = await run(workflow(true), {});
    expect(status.prompt).toContain("RESUME (this step never respawns");
    expect(status.prompt).toContain(`SendMessage \`${AGENT}\``);
  });

  it("without a readable transcript the context is the declared tokens key, idle unknown resumes", async () => {
    const { status } = await run(workflow(), {}, { tokens_worker: 777 });
    expect(status.prompt).toContain("RESUME (idle unknown: resume (idle unknown, context 777)");
  });

  it("a later visit records its own choice, and a revisit shows it", async () => {
    transcript(120_000, 120);
    const { engine, sessionId, status } = await run(workflow(), {});
    expect(status.prompt).toContain("RESPAWN");
    transcript(120_000, 1);
    const again = await engine.transition(sessionId, "again");
    expect(again.revisitPrompt).toContain("RESUME (warm: idle 1 min < 60");
    expect(again.revisitPrompt).not.toContain("RESPAWN");
    expect(engine.resumeChoiceLine(sessionId)).toContain("(visit 2): resume");
  });

  it("the choice is recorded once at entry: a second status shows the same text", async () => {
    transcript(120_000, 120);
    const { engine, sessionId, status } = await run(workflow(), {});
    transcript(120_000, 1);
    expect(engine.getStatus(sessionId).prompt).toBe(status.prompt);
  });

  it("the initial state of a workflow records its choice at start", async () => {
    transcript(120_000, 120);
    const dir = createFixtureDir({
      w: {
        initial: "fix",
        resume: spec,
        states: {
          fix: {
            prompt: "{{resume}}",
            revisit_prompt: "{{resume}}",
            resume: step,
            transitions: { done: "end" },
          },
          end: { terminal: true, outcome: "complete" },
        },
      },
    });
    dirs.push(dir);
    const engine = new Engine(new InMemoryStorage(), new Loader(null, dir, null), new Executor());
    const first = await engine.start("w", undefined, undefined, undefined, undefined, {
      worker_agent: AGENT,
      task: "T1",
    });
    expect(first.prompt).toContain("RESPAWN");
    transcript(120_000, 1);
    expect(engine.getStatus(first.sessionId).prompt).toBe(first.prompt);
    expect(engine.resumeChoiceLine(first.sessionId)).toContain(
      "RESUME CHOICE at fix (visit 1): respawn",
    );
  });

  it("a sub-workflow's initial step records its own choice, never the parent's same-named step", async () => {
    transcript(120_000, 120);
    const child = {
      initial: "fix",
      resume: spec,
      states: {
        fix: {
          prompt: "{{resume}}",
          revisit_prompt: "{{resume}}",
          resume: { message: "child message", brief: "child brief" },
          transitions: { done: "cend" },
        },
        cend: { terminal: true, outcome: "complete" },
      },
    };
    const parent = {
      ...workflow(),
      states: {
        ...workflow().states,
        fix: { ...workflow().states.fix, transitions: { sub: "run", done: "end" } },
        run: { sub_workflow: "child", on_complete: "end", on_fail: "end" },
      },
    };
    const dir = createFixtureDir({ w: parent, child });
    dirs.push(dir);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, new Loader(null, dir, null), new Executor());
    const { sessionId } = await engine.start("w", undefined, undefined, undefined, undefined, {
      worker_agent: AGENT,
      cause: "tests red",
      task: "T1",
    });
    const atFix = await engine.transition(sessionId, "check");
    expect(atFix.prompt).toContain("fresh brief for T1");
    const pushed = await engine.transition(sessionId, "sub");
    expect(pushed.currentWorkflow).toBe("child");
    expect(pushed.prompt).toContain("RESPAWN");
    expect(pushed.prompt).toContain("child brief");
    expect(pushed.prompt).not.toContain("fresh brief for T1");
    const rec = storage.read(sessionId)?.resume_choice;
    expect(rec).toMatchObject({ frame: 1, workflow: "child", state: "fix", visit: 1 });
    // the choice is fixed at entry: a warm transcript later does not flip it, and status lists it
    transcript(120_000, 1);
    expect(engine.getStatus(sessionId).prompt).toBe(pushed.prompt);
    expect(engine.resumeChoiceLine(sessionId)).toContain("RESUME CHOICE at fix (visit 1): respawn");
  });

  it("the loader refuses a step without a brief and a step without the workflow's resume", () => {
    const orig = console.error;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    try {
      const wf = workflow();
      const dir = createFixtureDir({
        ok: wf,
        nobrief: {
          ...wf,
          states: { ...wf.states, fix: { ...wf.states.fix, resume: { message: "m" } } },
        },
        nospec: { ...wf, resume: undefined },
        norevisit: {
          ...wf,
          states: { ...wf.states, fix: { ...wf.states.fix, revisit_prompt: "again" } },
        },
      });
      dirs.push(dir);
      const loader = new Loader(null, dir, null);
      expect(loader.names()).toEqual(["ok"]);
    } finally {
      console.error = orig;
    }
    const all = errors.join("\n");
    expect(all).toContain('state "fix" needs a `brief`');
    expect(all).toContain("declares `resume:` but the workflow declares none");
    expect(all).toContain("in its `revisit_prompt`");
  });
});
