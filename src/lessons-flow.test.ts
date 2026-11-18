import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import type { StateDefinition } from "./types.js";

// The lesson records' path through the shipped task flows: the keys the driver sets, the exec after the land, the line the
// driver reports. The queue side (what is filed, what goes to triage) is src/lessons-file.test.ts.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(ROOT, "templates");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-lessons-flow-")));
  dirs.push(d);
  return d;
};

/** batch-task as loaded; engine-task = its file's own states over batch-task's (`extends` replaces a state whole). */
const flows = (): Record<string, { states: Record<string, StateDefinition> }> => {
  const batch = new Loader(TEMPLATES, tmp(), null).get("batch-task")!;
  const own = parse(
    fs.readFileSync(path.join(ROOT, ".claude", "workflows", "engine-task.yaml"), "utf8"),
  ) as { states: Record<string, StateDefinition> };
  return { "batch-task": batch, "engine-task": { states: { ...batch.states, ...own.states } } };
};
const flat = (s: string | undefined): string => (s ?? "").replace(/\s+/g, " ");

describe.each(["batch-task", "engine-task"])("%s hands the lesson records over", name => {
  const states = () => flows()[name].states;

  it("mark_done goes to lessons_file, which goes to cleanup on success, error and timeout: a land is never failed by it", () => {
    const s = states();
    expect(s.mark_done.on_success).toBe("lessons_file");
    expect(s.lessons_file).toMatchObject({
      type: "exec",
      station: false,
      on_success: "cleanup",
      on_error: "cleanup",
      on_timeout: "cleanup",
    });
  });

  it("the exec reads both context keys and shows its line in the done prompt", () => {
    const s = states();
    expect(s.lessons_file.env).toMatchObject({
      LESSONS: "{{context.lessons}}",
      REVIEW_LESSONS: "{{context.review_lessons}}",
    });
    expect(s.lessons_file.context_set).toMatchObject({ lessons_out: "{{stdout}}" });
    expect(flat(s.done.prompt)).toContain("`lessons=` field is `{{context.lessons_out}}` verbatim");
    expect(flat(s.done.prompt)).toContain("`lessons=not run`");
  });

  it("the worker's and the reviewer's records ride on the transitions that follow their answers", () => {
    const s = states();
    expect(flat(s.work.prompt)).toMatch(/`check`.*lessons: <the JSON/);
    expect(flat(s.work.prompt)).toContain("leave the key out");
    expect(flat(s.review.prompt)).toContain("review_lessons: <the JSON");
  });

  it("both agents are told the record shape, the kinds and what each kind becomes", () => {
    const s = states();
    for (const prompt of [flat(s.work.prompt), flat(s.review.prompt)]) {
      expect(prompt).toContain('{"lessons":[{"id"');
      expect(prompt).toContain("lessons");
    }
    const worker = flat(s.work.prompt);
    for (const kind of [
      "unverified",
      "arm-rot-on-base",
      "reproduced-on-real-tree",
      "loss",
      "process",
    ])
      expect(worker).toContain(kind);
    expect(worker).toContain("1-8 files, never a directory or a glob");
    expect(worker).toContain("repeat the records you still stand by");
  });
});

describe("the lessons_file exec", () => {
  const base = (): StateDefinition => flows()["batch-task"].states.lessons_file;

  function setup(stub: string): {
    plugin: string;
    queue: string;
    vars: Record<string, unknown>;
    argv: string;
  } {
    const root = tmp();
    const plugin = path.join(root, "plugin");
    fs.mkdirSync(path.join(plugin, "scripts"), { recursive: true });
    const argv = path.join(root, "argv.txt");
    fs.writeFileSync(
      path.join(plugin, "scripts", "wf-queue"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\n${stub}\n`,
      {
        mode: 0o755,
      },
    );
    const queue = path.join(root, "proj", ".claude", "batch", "q.yaml");
    fs.mkdirSync(path.dirname(queue), { recursive: true });
    return { plugin, queue, argv, vars: { context: { task: "T1", queue_file: queue } } };
  }

  const exec = (
    e: { plugin: string; vars: Record<string, unknown> },
    lessons: string,
    review: string,
  ) => {
    const def = base();
    return new Executor().execute(
      {
        ...def,
        env: { ...def.env, WF_PLUGIN_ROOT: e.plugin, LESSONS: lessons, REVIEW_LESSONS: review },
      },
      e.vars,
      { cwd: path.dirname(e.plugin) },
    );
  };

  it("writes the keys to the task's slice-logs files and calls wf-queue --lessons on both, printing its line", async () => {
    const e = setup('echo "lessons=filed 1, triage 2"');
    const r = await exec(e, '{"lessons":[{"id":"A"}]}', '{"lessons":[{"id":"B"}]}');
    expect([r.exit_code, r.stdout.trim()]).toEqual([0, "lessons=filed 1, triage 2"]);
    const d = path.join(path.dirname(e.queue), "..", "backups", "slice-logs", "T1");
    expect(fs.readFileSync(path.join(d, "lessons.json"), "utf8")).toBe(
      '{"lessons":[{"id":"A"}]}\n',
    );
    expect(fs.readFileSync(path.join(d, "review-lessons.json"), "utf8")).toBe(
      '{"lessons":[{"id":"B"}]}\n',
    );
    expect(fs.readFileSync(e.argv, "utf8").split("\n")).toEqual([
      e.queue,
      "--lessons",
      "T1",
      "--records",
      `${path.dirname(e.queue)}/../backups/slice-logs/T1/lessons.json`,
      "--records",
      `${path.dirname(e.queue)}/../backups/slice-logs/T1/review-lessons.json`,
      "",
    ]);
  });

  it("a key that is empty leaves no file (an earlier run's file is removed): the CLI still runs and reports", async () => {
    const e = setup('echo "lessons=filed 0, triage 0"');
    const d = path.join(path.dirname(e.queue), "..", "backups", "slice-logs", "T1");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "lessons.json"), "stale");
    const r = await exec(e, "", "");
    expect(r.stdout.trim()).toBe("lessons=filed 0, triage 0");
    expect(fs.existsSync(path.join(d, "lessons.json"))).toBe(false);
    expect(fs.existsSync(path.join(d, "review-lessons.json"))).toBe(false);
  });

  it("a failing wf-queue, or output that is not its line, is `lessons=not run` with exit 0", async () => {
    const failing = setup('echo "wf-queue: boom" >&2; exit 2');
    const f = await exec(failing, '{"lessons":[]}', "");
    expect([f.exit_code, f.stdout.trim()]).toEqual([0, "lessons=not run"]);
    expect(f.stderr).toContain("wf-queue: boom");
    const garbage = setup('echo "something else"');
    const g = await exec(garbage, "", "");
    expect([g.exit_code, g.stdout.trim()]).toEqual([0, "lessons=not run"]);
  });

  it("a queue directory that cannot be written is `lessons=not run`, never a failed step", async () => {
    const e = setup('echo "lessons=filed 0, triage 0"');
    fs.writeFileSync(
      path.join(path.dirname(e.queue), "..", "backups"),
      "a file where the directory should be",
    );
    const r = await exec(e, '{"lessons":[]}', "");
    expect([r.exit_code, r.stdout.trim()]).toEqual([0, "lessons=not run"]);
  });
});

describe("the dispatcher agent and the docs reach the triage file", () => {
  const read = (p: string): string => flat(fs.readFileSync(path.join(ROOT, p), "utf8"));

  it("dispatch-driver copies a LANDED line with triage_file whole and tells main to take it with --lessons-take", () => {
    const md = read("templates/drivers/dispatch-driver.md");
    expect(md).toContain("`lessons=filed N, triage M triage_file=<path>` is copied whole");
    expect(md).toContain(
      "`wf-queue <queue> --lessons-take --triage <path>` (never per land, never by hand)",
    );
  });

  it("the docs and the bundled skill name --lessons-take and the LANDED / CLOSED split", () => {
    const q = read("docs/queue.md");
    expect(q).toContain("with `wf-queue <queue> --lessons-take [--triage FILE]`");
    expect(q).toContain("Never empty it by hand.");
    expect(q).toContain("prose lesson of a `CLOSED` line");
    expect(q).toContain("names the file (`triage_file=<path>`) when M > 0");
    const skill = read("templates/skills/wf-yaml-authoring/SKILL.md");
    expect(skill).toContain("a `LANDED` line ends with `lessons=filed N, triage M`");
    expect(skill).toContain("a `CLOSED` line ends with `lessons=<phrase (file)>; …|none`");
    expect(skill).toContain("`--lessons-take [--triage FILE]`");
    expect(skill).not.toContain("a `LANDED` / `CLOSED` line ends with `lessons=<phrase (file)>");
  });
});

describe("the driver's and the dispatcher's words", () => {
  const read = (p: string): string => flat(fs.readFileSync(path.join(ROOT, p), "utf8"));

  it("both copies of the task driver copy records verbatim into `set` and report the script's line", () => {
    for (const p of ["templates/drivers/task-driver.md", "agents/driver.md"]) {
      const md = read(p);
      expect(md).toContain(
        "copy the JSON verbatim into the `set` of the transition the prompt names",
      );
      expect(md).toContain(
        "`lessons` on the worker's `check`, `review_lessons` on the review's verdict transition",
      );
      expect(md).toContain("lessons=filed <N>, triage <M>`");
      expect(md).toContain("`lessons=not run`");
    }
  });

  it("the dispatcher's collect reads no filed lesson per land and reads the triage file in a batch", () => {
    const collect = flat(
      flows()["batch-task"] &&
        new Loader(TEMPLATES, tmp(), null).get("batch")!.states.collect.prompt,
    );
    expect(collect).toContain("`lessons=filed N, triage M`");
    expect(collect).toContain("read nothing for them");
    expect(collect).toContain(
      "`wf-queue <queue> --lessons-take [--triage <path>]` prints the file and empties it under the lock",
    );
    expect(collect).toContain("never empty it by hand");
    expect(collect).toContain("a `triage_file=<path>` on the line names it");
    expect(collect).toContain(
      "read in a batch, every `lessons_every` lands and before a curator run, never per land",
    );
  });
});
