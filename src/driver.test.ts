import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { driverPrompt, driverRefError, resolveDriverRef } from "./driver.js";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { render } from "./template.js";
import { InMemoryStorage, cleanupDir, createFixtureDir, createTestEngine } from "./test-helpers.js";

const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-driver-")));
  dirs.push(d);
  return d;
}

const TASK = {
  initial: "claim",
  driver: { model: "haiku", effort: "low", prompt_ref: "task-driver" },
  states: {
    claim: { prompt: "claim {{context.task}}", transitions: { go: "done" } },
    done: { terminal: true, outcome: "complete" },
  },
};
const PARENT = {
  initial: "run",
  states: { run: { prompt: "run", transitions: { end: "fin" } }, fin: { terminal: true } },
};

describe("driver (pure)", () => {
  it("a bare name is a shipped driver, ~/ is home, anything else a path from the session's cwd", () => {
    expect(resolveDriverRef("task-driver", "/p", "/ship")).toBe("/ship/task-driver.md");
    expect(resolveDriverRef("~/d.md", "/p")).toBe(path.join(os.homedir(), "d.md"));
    expect(resolveDriverRef(".claude/d.md", "/p")).toBe("/p/.claude/d.md");
    expect(resolveDriverRef("d.md", "/p")).toBe("/p/d.md");
    expect(resolveDriverRef("/abs/d.md", "/p")).toBe("/abs/d.md");
    expect(fs.existsSync(resolveDriverRef("task-driver", "/p"))).toBe(true);
  });

  it("the loader refuses a bare name that is no shipped driver, never a path", () => {
    const d = { model: "m", effort: "low" as const };
    expect(driverRefError({ ...d, prompt_ref: "task-driver" })).toBeNull();
    expect(driverRefError({ ...d, prompt_ref: "nope" })).toContain(
      "no shipped driver of that name",
    );
    expect(driverRefError({ ...d, prompt_ref: "lib/nope.md" })).toBeNull();
    // the message names exactly what resolveDriverRef takes as a path
    expect(driverRefError({ ...d, prompt_ref: "nope" })).toContain(
      '(a path needs "/", "~" or ".md")',
    );
    for (const ref of ["a/b", "~/b.md", "~", "nope.md"]) {
      expect(driverRefError({ ...d, prompt_ref: ref })).toBeNull();
      expect(resolveDriverRef(ref, "/p", "/ship").startsWith("/ship/")).toBe(false);
    }
  });

  it("the driver prompt names the session, the task, the queue and the one-status rule", () => {
    const p = driverPrompt({
      driver: { model: "m", effort: "low", prompt_ref: "x" },
      sessionId: "abcd",
      task: "T1",
      queueFile: "/q.md",
      instructions: "/i.md",
      instructionsExist: true,
    });
    expect(p).toContain("task T1 of the queue /q.md");
    expect(p).toContain("P = abcd");
    expect(p).toContain("/i.md");
    expect(p).toContain("never call `status` after it");
    const flat = p.replace(/\n/g, " ");
    expect(flat).toContain(
      "A current agent → start no new session or agent — SendMessage it first",
    );
    expect(flat).toContain("a fresh agent on the session it is linked to");
    expect(p).not.toMatch(/now at|started at|claim/);
  });

  it("a re-spawned driver takes only an agent the engine marks current as this visit's", () => {
    const flat = driverPrompt({
      driver: { model: "m", effort: "low", prompt_ref: "x" },
      sessionId: "abcd",
      task: "T1",
      queueFile: undefined,
      instructions: "/i.md",
      instructionsExist: true,
    }).replace(/\n/g, " ");
    expect(flat).toContain(
      "that status lists P's LINKED AGENTS of its current state — the engine marks each `current` (linked at this visit) or not; only a `current` one is this visit's agent",
    );
    // the probe is barred, the prompt's own steps and re-link are not; nothing names a batch-task state
    expect(flat).toContain(
      "its own steps still apply (any SendMessage to an earlier agent and its link_agent included) — but never ask an earlier visit's agent where it stands, nor take it as this visit's",
    );
    expect(flat).toContain(
      "gone → check the tree for the work its step leaves behind and, when the step's own instructions say how to verify it, follow them; else a fresh agent on the session it is linked to, then link_agent it",
    );
    expect(flat).not.toMatch(/worker_agent|review\.md|VERDICT|task's branch/);
    // no context key carries the visit
    expect(flat).not.toMatch(/visit marker|worker_visit|review_visit/);
  });
});

describe("batch-task links (template text)", () => {
  const def = () => new Loader(TEMPLATES, tmp(), null).get("batch-task")!;
  const flat = (state: "work" | "review") =>
    render(def().states[state].prompt!, { visits: { [state]: 1 }, context: {} }).replace(
      /\s+/g,
      " ",
    );

  it("work links its worker, and a fix round that keeps it links it again; no visit key", () => {
    const work = flat("work");
    expect(work).toContain(
      "`link_agent({session_id: W, agent_id: <its id>})` (the engine records it as this visit's agent); context_set `worker_agent` = its id.",
    );
    expect(work).toContain(
      "the values this prompt rendered are the first visit's: read each one it uses from P's context now (`status` with `key`) — `model_fix` / `effort_fix` (a fix round's worker; empty — no difficulty, or a table without a `fix` stage — = `model` / `effort`) against `worker_model`, and `worker_agent`, `worker_session`:",
    );
    expect(work).toContain(
      "SendMessage `worker_agent` with the cause: its one line plus \"read <its file> whole\" (never the file's text pasted); then `link_agent({session_id: <worker_session>, agent_id: <worker_agent>})` again — it marks the worker as this visit's;",
    );
    expect(def().states.work.prompt).not.toMatch(/worker_visit|review_visit/);
  });

  it("review links its reviewer and records no visit key", () => {
    expect(flat("review")).toContain(
      "`link_agent({session_id: R, agent_id: <its id>})` (the engine records it as this visit's agent). END your turn on this task.",
    );
    expect(def().states.review.prompt).not.toMatch(/review_agent|review_visit/);
  });

  it("the driver's last line carries lessons copied from the agents' report and review sections", () => {
    const md = fs.readFileSync(resolveDriverRef("task-driver", "/"), "utf8").replace(/\s+/g, " ");
    expect(md).toContain("lessons=<phrase (file)>; <phrase (file)>|none");
    expect(md).toContain("COPIED (not judged)");
    const d = def();
    expect(d.states.work.prompt).toContain("## Follow-up not done");
    expect(d.states.work.prompt).toContain("## Tool defect found");
    expect(d.states.review.prompt).toContain("## Notes (non-blocking)");
    expect(d.states.work.prompt).toContain("carry the previous report.md's three sections");
    expect(d.states.work.prompt).toContain(
      "handoff.md when you stop unfinished (the same three sections)",
    );
    expect(d.states.review.prompt).toContain("carry its `## Notes (non-blocking)` items");
    expect(d.states.review.prompt).toContain("when review.md already exists (an earlier round)");
    expect(md).toContain("CLOSED task=<ID> reason=<short> lessons=");
    const collect = new Loader(TEMPLATES, tmp(), null)
      .get("batch")!
      .states.collect.prompt.replace(/\s+/g, " ");
    expect(collect).toContain("`lessons=<phrase (file)>; …|none`");
    expect(collect).toContain("`queue_add` line, a memory note, or nothing");
  });

  it("a driver messaged after its last line resumes from status, and collect relays an orphaned line", () => {
    const md = fs.readFileSync(resolveDriverRef("task-driver", "/"), "utf8").replace(/\s+/g, " ");
    expect(md).toContain("## Resumed after your last line");
    expect(md).toContain('never answer "my run already ended"');
    expect(md).toContain("A relayed worker or reviewer line IS that agent's answer");
    const collect = new Loader(TEMPLATES, tmp(), null)
      .get("batch")!
      .states.collect.prompt.replace(/\s+/g, " ");
    expect(collect).toContain("relay it by SendMessage to the driver linked to P");
    expect(collect).toContain("Never both, never drop it.");
  });

  it("the driver asks a decider for design choices and reports decided=", () => {
    const md = fs.readFileSync(resolveDriverRef("task-driver", "/"), "utf8").replace(/\s+/g, " ");
    expect(md).toContain("Design choices — ask the DECIDER, not the parent");
    expect(md).toContain("model opus, effort high");
    expect(md).toContain("`DECIDED file=<wt>.log/decisions.md`");
    expect(md).toContain("`ESCALATE reason=<short>`");
    expect(md).toContain("P's context key `memory_index`");
    expect(md).toContain("the decider answered ESCALATE");
    expect(md).toContain("a THIRD FIXES verdict (the Nth when P's context key `max_fixes` is N)");
    expect(md).toContain("` decided=<file>`");
    expect(md).not.toContain("/.claude/projects/");
    const collect = new Loader(TEMPLATES, tmp(), null)
      .get("batch")!
      .states.collect.prompt.replace(/\s+/g, " ");
    expect(collect).toContain("`decided=<file>` means a decider answered");
    const bt =
      JSON.stringify(def().states) +
      JSON.stringify(new Loader(TEMPLATES, tmp(), null).get("batch")!.states);
    expect(bt).toContain("memory_index");
    expect(JSON.stringify(def().states.claim)).toContain("memory_index");
    expect(md).toContain("the decider's decisions");
    expect(def().states.review.prompt.replace(/\s+/g, " ")).toContain("decisions.md whole");
  });

  it("the shipped task-driver instructions take only a current linked agent as this visit's", () => {
    const md = fs.readFileSync(resolveDriverRef("task-driver", "/"), "utf8").replace(/\s+/g, " ");
    expect(md).toContain(
      "The `status` you start with lists P's LINKED AGENTS of its current state: `link_agent` records the state's visit beside the agent",
    );
    expect(md).toContain(
      "Only a `current` agent is this visit's. None current → follow the prompt from its first step",
    );
    expect(md).toContain(
      "Its own steps still apply — a fix round's SendMessage of the cause to `worker_agent`, then its `link_agent`, included",
    );
    expect(md).toContain(
      "never ask an earlier visit's agent where it stands, never take it as this visit's",
    );
    expect(md).toContain(
      "Gone → at `work`, check the tree: its commit on `batch/<ID>` and a clean worktree",
    );
    expect(md).toContain(
      "At `review`: `<wt>.log/review.md` newer than the branch's last commit (so not an earlier round's) holding a `VERDICT` line → route by that verdict",
    );
    expect(md).toContain(
      "3. Otherwise spawn a fresh agent with the prompt's text on the SAME session the current agent is linked to",
    );
    expect(md).toContain(
      "A reply \"Revisit #N\" means: follow that state's prompt as you got it at the first visit — but the values it rendered are that visit's",
    );
    expect(md).not.toMatch(/visit marker|worker_visit|review_visit/);
  });
});

describe("driver (loader + engine)", () => {
  function load(workflows: Record<string, object>): Loader {
    const dir = createFixtureDir(workflows);
    dirs.push(dir);
    return new Loader(null, dir, null);
  }

  it("a bad prompt_ref or key fails the load; a heir inherits the driver unless it sets its own", () => {
    const orig = console.error;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    try {
      const loader = load({
        ok: TASK,
        bad: { ...TASK, driver: { ...TASK.driver, prompt_ref: "missing" } },
        typo: { ...TASK, driver: { ...TASK.driver, modle: "x" } },
        execfirst: {
          ...TASK,
          initial: "run",
          states: { ...TASK.states, run: { type: "exec", command: "true", on_success: "claim" } },
        },
        heir: { extends: "ok" },
        heir2: {
          extends: "ok",
          driver: { model: "sonnet", effort: "medium", prompt_ref: "a/b.md" },
        },
      });
      expect(loader.names().sort()).toEqual(["heir", "heir2", "ok"]);
      expect(loader.get("heir")?.driver).toEqual(TASK.driver);
      expect(loader.get("heir2")?.driver?.model).toBe("sonnet");
    } finally {
      console.error = orig;
    }
    expect(errors.join("\n")).toContain('driver.prompt_ref "missing"');
    expect(errors.join("\n")).toContain('driver: the initial state "run" must be a prompt state');
  });

  it("start renders the driver call with the session, the start context and the parent's queue_file", async () => {
    const { engine, storage } = createTestEngine({ task: TASK, parent: PARENT });
    const p = await engine.start("parent");
    await engine.setContext(p.sessionId, "queue_file", "/q/queue.md");
    const s = await engine.start("task", undefined, p.sessionId, undefined, undefined, {
      task: "T7",
    });
    expect(s.prompt).toBe("claim T7");
    const call = s.driverCall!;
    expect(call).toContain("model: haiku, effort: low, run_in_background: true");
    expect(call).toContain(`link_agent({session_id: "${s.sessionId}"`);
    expect(call).toContain("task T7 of the queue /q/queue.md");
    expect(call).toContain(resolveDriverRef("task-driver", "/"));
    expect(call).not.toContain("WARNING");
    expect(storage.read(s.sessionId)!.context.task).toBe("T7");
    expect(storage.read(s.sessionId)!.context.driver_call).toBe(call);
    expect((await engine.start("parent", undefined, p.sessionId)).driverCall).toBeUndefined();
    await expect(
      engine.start("task", undefined, p.sessionId, undefined, undefined, { cwd: "/x" }),
    ).rejects.toThrow('"cwd" is the engine\'s');
  });

  it("a missing project driver file is named in the call; a start difficulty goes through the model_table", async () => {
    const templates = TEMPLATES;
    const empty = tmp();
    const engine = new Engine(
      new InMemoryStorage(),
      new Loader(templates, empty, null),
      new Executor(),
    );
    const s = await engine.start("batch-task", undefined, undefined, empty, undefined, {
      task: "T1",
      difficulty: "9",
    });
    expect(s.context).toMatchObject({ model: "opus", effort: "xhigh" });
    expect(s.driverCall).toContain("model: haiku, effort: low");
    await expect(
      engine.start("batch-task", undefined, s.sessionId, empty, undefined, { difficulty: "11" }),
    ).rejects.toThrow("not a whole number 1..10");

    const { engine: e2 } = createTestEngine({
      task: { ...TASK, driver: { ...TASK.driver, prompt_ref: "lib/none.md" } },
    });
    const m = await e2.start("task", undefined, undefined, empty);
    expect(m.driverCall).toContain(
      `WARNING: the driver's instructions ${empty}/lib/none.md do not exist`,
    );
  });
});

describe("batch-task mark_done (exec)", () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      encoding: "utf8",
    }).trim();

  it("marks the line done and appends the record line from the task's context when the header names a record_file", async () => {
    const root = tmp();
    const repo = path.join(root, "proj");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const plugin = path.join(root, "plugin");
    fs.mkdirSync(path.join(plugin, "scripts"), { recursive: true });
    // stub: --header prints $REC, anything else logs its args
    fs.writeFileSync(
      path.join(plugin, "scripts", "wf-queue"),
      '#!/bin/sh\nif [ "$2" = --header ]; then printf %s "$REC"; else echo "$@" >>"$CALLS"; fi\n',
      { mode: 0o755 },
    );
    const def = new Loader(TEMPLATES, tmp(), null).get("batch-task")!.states.mark_done;
    const vars = {
      context: {
        task: "T1",
        queue_file: path.join(root, "q.md"),
        wt: "/w/T1",
        difficulty: 5,
        model: "sonnet",
        effort: "high",
        tokens_worker: 1200,
        tokens_review: 300,
      },
      visits: { work: 2 },
    };
    const run = (rec: string) =>
      new Executor().execute(
        {
          ...def,
          env: { ...def.env, WF_PLUGIN_ROOT: plugin, REC: rec, CALLS: path.join(root, "calls") },
        },
        vars,
        { cwd: repo },
      );
    const none = await run("");
    expect(none.exit_code).toBe(0);
    const sha = git(repo, "rev-parse", "--short", "HEAD");
    expect(fs.readFileSync(path.join(root, "calls"), "utf8")).toContain(
      `--done T1 --note landed ${sha}`,
    );
    const done = await run("records.md");
    expect(done.exit_code).toBe(0);
    const line = fs.readFileSync(path.join(root, "records.md"), "utf8");
    expect(line).toMatch(
      new RegExp(
        `^- \\d{4}-\\d{2}-\\d{2} T1 landed ${sha} \\| difficulty: 5 \\| model: sonnet/high \\| review: sonnet/high \\| rounds: 2 \\| tokens: worker=1200 review=300 \\| report: /w/T1\\.log/report\\.md\\n$`,
      ),
    );
  });
});
