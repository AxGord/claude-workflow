import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { readQueue } from "./queue.js";
import type { StateDefinition } from "./types.js";

// ENG-CURATOR-SERVICE: the bundled `curator` workflow's exec steps run the four jobs (memory, calibration, hygiene,
// lessons) on a fixture project, end to end through the real `wf-curator` and `wf-queue` (compiled into a scratch
// plugin root): plan → counts → (the judge's plan, given here) → check → apply under `edits: direct` → record, which
// tunes each job's interval, writes present.md and marks the curator's queue line done.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(ROOT, "templates");
let root = "";
let plugin = "";
let def: ReturnType<Loader["get"]>;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-cur-wf-")));
  plugin = path.join(root, "plugin");
  fs.mkdirSync(path.join(root, "empty"));
  def = new Loader(TEMPLATES, path.join(root, "empty"), null).get("curator");
  fs.mkdirSync(path.join(plugin, "scripts"), { recursive: true });
  execFileSync(
    "node",
    [
      path.join(ROOT, "node_modules/typescript7/bin/tsc"),
      "-p",
      ROOT,
      "--outDir",
      path.join(plugin, "build"),
    ],
    {
      cwd: ROOT,
    },
  );
  for (const s of ["wf-curator", "wf-queue"])
    fs.copyFileSync(path.join(ROOT, "scripts", s), path.join(plugin, "scripts", s));
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(plugin, "package.json"));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(plugin, "node_modules"));
}, 120_000);
afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function state(name: string, env: Record<string, string>): StateDefinition {
  const s = def?.states[name];
  if (!s) throw new Error(`no state ${name}`);
  return { ...s, env: { ...s.env, ...env } };
}

describe("bundled curator workflow", () => {
  it("is a driver workflow whose execs run the four jobs on a fixture project", async () => {
    expect(def?.initial).toBe("claim");
    expect(def?.driver).toBeDefined();
    const project = path.join(root, "proj");
    const mem = path.join(root, "memory");
    const stateDir = path.join(root, "state");
    fs.mkdirSync(path.join(project, ".claude", "batch"), { recursive: true });
    fs.mkdirSync(mem);
    fs.mkdirSync(stateDir);
    execFileSync("git", ["init", "-q", project]);
    fs.writeFileSync(
      path.join(project, ".claude", "curator.yaml"),
      `edits: direct\njobs:\n  memory: {dirs: [${mem}], every: 10}\n  calibration: {}\n  hygiene: {}\n  lessons: {}\n`,
    );
    fs.writeFileSync(path.join(mem, "MEMORY.md"), "- [Hot](hot.md)\n- [Cold](cold.md)\n");
    fs.writeFileSync(path.join(mem, "ARCHIVE.md"), "# Archive\n");
    fs.writeFileSync(path.join(mem, "hot.md"), "---\ndescription: hot\n---\nHot rule.\n");
    fs.writeFileSync(path.join(mem, "cold.md"), "---\ndescription: cold\n---\nCold rule.\n");
    const queue = path.join(project, ".claude", "batch", "queue.yaml");
    const ids = Array.from({ length: 10 }, (_, i) => `T${i}`);
    fs.writeFileSync(
      queue,
      [
        "batch_size: 2",
        "tasks:",
        ...ids.map(
          id =>
            `  - {id: ${id}, status: done, difficulty: 3, workflow: w, touches: [a], text: task ${id}}`,
        ),
        "  - {id: NOTOUCH, status: pending, difficulty: 3, workflow: w, text: no touches here}",
        "  - {id: CURATOR-2026-11-26-1, status: running, difficulty: 5, priority: urgent, workflow: curator, touches: [], text: run}",
        "",
      ].join("\n"),
    );
    fs.mkdirSync(path.join(project, ".claude", "backups", "slice-logs"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".claude", "backups", "slice-logs", "lessons-triage.txt"),
      "T3 process: a row\n",
    );
    fs.writeFileSync(
      path.join(stateDir, "ledger.jsonl"),
      ids
        .map(task =>
          JSON.stringify({
            session_id: `s-${task}`,
            workflow: "batch-task",
            outcome: "completed",
            started_at: "2026-11-25T00:00:00Z",
            ended_at: "2026-11-25T01:00:00Z",
            task,
            project,
            stages: { execute: { model: "sonnet", effort: "high" } },
          }),
        )
        .map(l => `${l}\n`)
        .join(""),
    );
    const env = {
      WF_PLUGIN_ROOT: plugin,
      STATE_DIR: stateDir,
      CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    };
    const vars: Record<string, unknown> = {
      project_root: project,
      context: { task: "CURATOR-2026-11-26-1", queue_file: queue },
    };
    const ex = new Executor();
    const run = async (name: string, extra: Record<string, unknown> = {}) => {
      const r = await ex.execute(
        state(name, env),
        { ...vars, context: { ...(vars.context as object), ...extra } },
        { cwd: project },
      );
      return r;
    };

    const plan = await run("plan");
    expect(plan.exit_code).toBe(0);
    const dir = plan.stdout?.trim() as string;
    expect(dir).toBe(
      path.join(
        stateDir,
        "curator",
        project.replace(/[^A-Za-z0-9-]/g, "-"),
        "runs",
        "CURATOR-2026-11-26-1",
      ),
    );
    expect(plan.stderr).toMatch(/jobs: memory, calibration, hygiene, lessons \(due:/);
    const ctx = { run_dir: dir };

    const counts = await run("counts", ctx);
    expect(counts.exit_code).toBe(0);
    expect(fs.readdirSync(path.join(dir, "counts")).sort()).toEqual([
      "calibration.json",
      "hygiene.json",
      "lessons.json",
      "memory.json",
    ]);
    const hygiene = JSON.parse(
      fs.readFileSync(path.join(dir, "counts", "hygiene.json"), "utf8"),
    ) as {
      findings: { id: string; check: string }[];
    };
    expect(hygiene.findings.map(f => `${f.id} ${f.check}`)).toEqual(["NOTOUCH require"]);
    const lessons = JSON.parse(
      fs.readFileSync(path.join(dir, "counts", "lessons.json"), "utf8"),
    ) as {
      triage: string[];
    };
    expect(lessons.triage).toEqual(["T3 process: a row"]);
    const calibration = JSON.parse(
      fs.readFileSync(path.join(dir, "counts", "calibration.json"), "utf8"),
    ) as { lands: number };
    expect(calibration.lands).toBe(10);

    // the judge's plan, as it would deliver it through the context
    const judged = JSON.stringify({
      jobs: {
        memory: { found: 1 },
        calibration: { found: 0 },
        hygiene: { found: 1 },
        lessons: { found: 1 },
      },
      ops: [
        {
          id: "m1",
          job: "memory",
          op: "move-index",
          file: path.join(mem, "cold.md"),
          from: "MEMORY.md",
          to: "ARCHIVE.md",
          reason: "cold",
        },
      ],
      proposals: ["queue_edit NOTOUCH touches: [b]", "triage T3: nothing"],
      decisions: [],
    });
    const check = await run("judge_check", { ...ctx, curator_plan: judged });
    expect(check.exit_code).toBe(20); // no text edit: apply, no verifier
    expect(def?.states.judge_check?.cases?.["20"]).toBe("apply");

    const apply = await run("apply", ctx);
    expect(apply.stdout).toContain("applied 1, proposed 0 (edits: direct)");
    expect(fs.readFileSync(path.join(mem, "ARCHIVE.md"), "utf8")).toContain("- [Cold](cold.md)");
    expect(fs.existsSync(path.join(mem, ".git"))).toBe(false);

    const record = await run("record", ctx);
    expect(record.exit_code).toBe(0);
    const present = fs.readFileSync(record.stdout?.trim() as string, "utf8");
    expect(present).toContain("| calibration | 0 | 0 | 5 → 10 |");
    expect(present).toContain("| memory | 1 | 1 | 10 → 10 |");
    expect(present).toContain("queue_edit NOTOUCH touches: [b]");
    expect(readQueue(queue).lines.find(l => l.id === "CURATOR-2026-11-26-1")?.status).toBe("done");
    const st = JSON.parse(
      fs.readFileSync(path.join(path.dirname(path.dirname(dir)), "state.json"), "utf8"),
    ) as { jobs: Record<string, unknown> };
    expect(Object.keys(st.jobs).sort()).toEqual(["calibration", "hygiene", "lessons", "memory"]);
    // the record step run again (a retry, a restart) leaves the state of one run: nothing tuned twice
    const again = await run("record", ctx);
    expect(again.exit_code).toBe(0);
    const st2 = JSON.parse(
      fs.readFileSync(path.join(path.dirname(path.dirname(dir)), "state.json"), "utf8"),
    ) as { jobs: Record<string, { interval: number; runs: unknown[] }> };
    expect(st2.jobs.calibration?.interval).toBe(10);
    expect(Object.values(st2.jobs).map(j => j.runs.length)).toEqual([1, 1, 1, 1]);
    // the dry run now: everything just ran, nothing is due
    const due = await ex.execute(
      {
        type: "exec",
        command: '"$WF_PLUGIN_ROOT/scripts/wf-curator" due --queue "$Q"',
        env: { ...env, Q: queue },
      },
      {},
      { cwd: project },
    );
    expect(due.exit_code).toBe(10);
    expect(due.stdout).toContain("nothing due");
  }, 120_000);
});
