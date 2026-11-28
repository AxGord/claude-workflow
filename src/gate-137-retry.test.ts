import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, trustStoreFor } from "./test-helpers.js";

// ENG-GATE-137-RETRY: a gate whose check was killed by SIGKILL (exit 137) reached the parent as a red test, and both kills
// of 2026-11-27 passed on a plain retry. The REAL engine runs the REAL engine-task.yaml and the REAL gate commands; only
// the leased check (`$CHECK`) is a stub that exits with a scripted sequence of codes.
const root = resolve(__dirname, "..");
const WORKFLOW = join(root, ".claude/workflows/engine-task.yaml");
let seq = 0;

const git = (cwd: string, ...a: string[]) =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t", ...a],
    { cwd, encoding: "utf8" },
  ).trim();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Def = {
  states: Record<
    string,
    {
      command?: string;
      env?: Record<string, string>;
      resource?: unknown;
      prompt?: string;
      max_visits?: number;
      on_exhausted?: string;
      on_success?: string;
      on_error?: string;
      station?: boolean;
      cases?: Record<string, string>;
    }
  >;
};
const load = () => parse(readFileSync(WORKFLOW, "utf8")) as Def;

/** A session of the real engine-task with a committed branch; the check stub exits with `codes` in turn (the last repeats). */
async function sandbox(codes: number[]) {
  const TASK = `T-G137-${process.pid}-${++seq}`;
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rv-g137-")));
  dirs.push(base);
  const main = join(base, "main");
  const WT = join(base, ".wt", "main", TASK);
  mkdirSync(main);
  git(main, "init", "-q", "-b", "master");
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  git(main, "config", "commit.gpgsign", "false");
  writeFileSync(join(main, "CHANGELOG.md"), "## Unreleased\n");
  mkdirSync(join(main, "src"));
  writeFileSync(join(main, "src/y.ts"), "const l1 = 1;\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "base");
  mkdirSync(join(base, "batch"));
  const queue = join(base, "batch", "queue.yaml");
  writeFileSync(queue, `  - id: ${TASK}\n    kind: feature\n`);

  const counter = join(base, "runs");
  const stub = join(base, "check-stub.sh");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"`,
      `codes="${codes.join(" ")}"`,
      `code=$(echo "$codes" | cut -d' ' -f$n)`,
      `[ -n "$code" ] || code=$(echo "$codes" | awk '{print $NF}')`,
      `echo "stub check run $n -> $code"`,
      `exit $code`,
    ].join("\n"),
  );
  chmodSync(stub, 0o755);

  const def = load();
  for (const s of ["project_gate", "project_gate_rebased", "regate_gate"]) {
    def.states[s].env = { CHECK: stub };
    delete def.states[s].resource;
  }
  def.states.project_land.command = `echo 'stub: would land'; exit 9`;
  delete def.states.project_land.resource;
  const project = join(base, "project-workflows");
  mkdirSync(project);
  writeFileSync(join(project, "engine-task.yaml"), stringify(def));
  const loader = new Loader(
    join(root, "templates"),
    join(base, "global"),
    project,
    trustStoreFor(join(project, "engine-task.yaml")),
  );
  const engine = new Engine(new InMemoryStorage(), loader, new Executor());
  const first = await engine.start("engine-task", undefined, undefined, main, undefined, {
    task: TASK,
    queue_file: queue,
  });
  const id = first.sessionId;
  const to = (t: string) => engine.transition(id, t);
  await to("prepare");
  writeFileSync(join(WT, "src/y.ts"), "const l1 = 11;\n");
  writeFileSync(join(WT, "CHANGELOG.md"), "## Unreleased\n- slice\n");
  git(WT, "add", ".");
  git(WT, "commit", "-q", "-m", "the change");
  await engine.setContext(id, "worker_agent", "w1");
  const runs = () => Number(readFileSync(counter, "utf8").trim());
  return { to, runs };
}

describe("engine-task: a gate whose check was killed (exit 137)", () => {
  it("re-runs the gate once with no parent round, and a green second run goes on to the review", async () => {
    const { to, runs } = await sandbox([137, 0]);
    const s = await to("check");
    const path = s.history.map(h => h.to);
    expect(path.slice(-5), JSON.stringify(path)).toEqual([
      "project_gate",
      "project_gate_retry",
      "project_gate",
      "review_route",
      "review",
    ]);
    expect(path).not.toContain("gate_failed");
    expect(runs()).toBe(2);
  }, 60000);

  it("a second kill in the session reaches gate_failed, which names the kill", async () => {
    const { to, runs } = await sandbox([137, 137, 0]);
    const s = await to("check");
    expect(s.currentStateName, JSON.stringify(s.history.map(h => h.to))).toBe("gate_failed");
    expect(runs()).toBe(2);
    const shown = JSON.stringify(s);
    expect(shown).toContain("npm run check killed (exit 137, SIGKILL): not a red test");
    expect(shown).toContain("exit 137");
  }, 60000);

  it("a red test (exit 1) is not retried: it goes straight to gate_failed", async () => {
    const { to, runs } = await sandbox([1, 0]);
    const s = await to("check");
    const path = s.history.map(h => h.to);
    expect(s.currentStateName, JSON.stringify(path)).toBe("gate_failed");
    expect(path).not.toContain("project_gate_retry");
    expect(runs()).toBe(1);
  }, 60000);

  it("a killed regate is not retried: regate_red shows the kill and the parent decides", async () => {
    const { to, runs } = await sandbox([137, 0]);
    await to("blocked");
    const s = await to("regate");
    const path = s.history.map(h => h.to);
    expect(s.currentStateName, JSON.stringify(path)).toBe("regate_red");
    expect(path.filter(n => n === "regate_gate")).toHaveLength(1);
    expect(runs()).toBe(1);
    const shown = JSON.stringify(s);
    expect(shown).toContain("npm run check killed (exit 137, SIGKILL): not a red test");
    expect(shown).toContain("is a kill of the check, not a red test");
  }, 60000);
});

describe("engine-task.yaml: the 137 routes", () => {
  const def = load();

  it.each([
    ["project_gate", "project_gate_retry"],
    ["project_gate_rebased", "project_gate_rebased_retry"],
  ])("%s routes 137 to %s, one visit, back to its own gate, then gate_failed", (gate, retry) => {
    expect(def.states[gate].cases?.["137"]).toBe(retry);
    const r = def.states[retry];
    expect(r.station).toBe(false);
    expect(r.max_visits).toBe(1);
    expect(r.on_exhausted).toBe("gate_failed");
    expect(r.on_success).toBe(gate);
    expect(def.states[gate].cases?.["0"]).not.toBe(retry);
  });

  it.each(["project_gate", "project_gate_rebased", "regate_gate"])(
    "%s exits 137 for a kill, ahead of the red-test exit",
    name => {
      const c = def.states[name].command ?? "";
      expect(c).toContain('if [ "$rc" -eq 137 ]');
      expect(c).toContain("exit 137; fi");
      expect(c.indexOf('"$rc" -eq 137')).toBeLessThan(c.indexOf('"$rc" -ne 0'));
    },
  );

  it("regate_gate has no 137 retry route", () => {
    expect(def.states.regate_gate.cases?.["137"]).toBeUndefined();
  });

  it("the gate_failed prompt names the 137 route", () => {
    const p = def.states.gate_failed.prompt ?? "";
    expect(p).toContain("- 137 (the check was killed by SIGKILL");
    expect(p).toContain("never `fix`");
  });
});
