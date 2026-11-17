import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfigFromFile } from "vite";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT } from "./site-browser-helpers.js";

// ENG-GATE-LEASE-ESLINT-AND-ASK: project_gate held `threads: { min: 4, max: budget }` and handed the grant to the
// command as WF_THREADS, but `npm run check` ran vitest with no worker cap (about cpus-1 workers whatever it was
// granted) and, by a worker's hand, with no lease at all. The grant must reach vitest as its worker count, and the
// leases must follow what each half of the check uses: the static half (tsc, biome, eslint, ast-grep) about 2 cores,
// the test half 4 to 6 (one lease over both held 8 and used ~4.6), taken one after the other by
// scripts/check-leased.sh, which the gates and the worker's prompt run.

const saved = process.env.WF_THREADS;
afterEach(() => {
  if (saved === undefined) delete process.env.WF_THREADS;
  else process.env.WF_THREADS = saved;
});

async function resolvedMaxWorkers(grant: string): Promise<unknown> {
  process.env.WF_THREADS = grant;
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "test" },
    path.join(ROOT, "vitest.config.ts"),
    ROOT,
  );
  const test = (loaded?.config as { test?: { maxWorkers?: unknown } } | undefined)?.test;
  return test?.maxWorkers;
}

describe("the gate's vitest under a pool grant", () => {
  it("runs with as many workers as the grant says: WF_THREADS=3 caps it at 3", async () => {
    expect(Number(await resolvedMaxWorkers("3"))).toBe(3);
  });

  it("follows the grant, not a constant: WF_THREADS=5 caps it at 5", async () => {
    expect(Number(await resolvedMaxWorkers("5"))).toBe(5);
  });
});

type State = {
  prompt?: string;
  command?: string;
  resource?: unknown;
  env?: Record<string, string>;
};
const states = (
  parse(readFileSync(path.join(ROOT, ".claude/workflows/engine-task.yaml"), "utf8")) as {
    states: Record<string, State>;
  }
).states;

describe("the grant reaches every step of the check", () => {
  it("check:ci keeps WF_THREADS through its emptied environment", () => {
    const script = readFileSync(path.join(ROOT, "scripts/check-ci.sh"), "utf8");
    const envCall = script.slice(script.indexOf("env -i"));
    expect(envCall).toMatch(/\$\{WF_THREADS:\+WF_THREADS="\$WF_THREADS"\}/);
  });

  it("check is the two halves in order, and each half is its own script", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.check).toBe("npm run check:static && npm run check:tests");
    expect(pkg.scripts["check:static"]).toMatch(/tsc.*lint.*scan/);
    expect(pkg.scripts["check:tests"]).toBe("vitest run && npm run test:pane && npm run check:ci");
  });

  it.each(["project_gate", "project_gate_rebased"])(
    "%s runs the leased check and holds no lease of its own",
    name => {
      const state = states[name];
      // a lease on the state would be held while the script waits for its own: it would wait on itself
      expect(state?.resource).toBeUndefined();
      expect(state?.env?.CHECK).toMatch(/\/scripts\/check-leased\.sh$/);
      expect(state?.command).toContain('"$CHECK" >"$log"');
      expect(state?.command).not.toContain("npm run check >");
    },
  );

  it.each(["work", "rebase_fix"])("the %s prompt has the worker run the leased check", name => {
    expect(states[name]?.prompt ?? "").toContain(
      "/scripts/check-leased.sh` from the worktree, never bare",
    );
  });
});

describe("scripts/check-leased.sh", () => {
  const script = path.join(ROOT, "scripts/check-leased.sh");
  const tmp: string[] = [];
  afterEach(() => {
    for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // A tree whose npm scripts only print their name, and a wf-run that logs its arguments and runs the command.
  function setup(scripts: Record<string, string>): { dir: string; log: string; run: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wf-check-leased-"));
    tmp.push(dir);
    const log = path.join(dir, "leases.log");
    const run = path.join(dir, "fake-wf-run");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", scripts }));
    writeFileSync(
      run,
      `#!/bin/sh\necho "$*" >> "${log}"\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
      { mode: 0o755 },
    );
    return { dir, log, run };
  }

  function leases(env: Record<string, string>, scripts: Record<string, string>) {
    const { dir, log, run } = setup(scripts);
    const base: NodeJS.ProcessEnv = { ...process.env, WF_RUN: run, ...env };
    if (!("WF_THREADS" in env)) delete base.WF_THREADS;
    const r = spawnSync("sh", [script], { cwd: dir, env: base, encoding: "utf8" });
    const taken = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    return { status: r.status, out: r.stdout, taken };
  }

  const halves = {
    "check:static": "echo static",
    "check:tests": "echo tests",
    check: "echo whole",
  };

  it("takes a 2-thread lease for the static half, then a 4-6 one for the tests", () => {
    const r = leases({}, halves);
    expect(r.status).toBe(0);
    expect(r.taken).toEqual([
      "--threads 2 --label check-static -- npm run check:static",
      "--threads 4-6 --label check-tests -- npm run check:tests",
    ]);
  });

  it("takes no second lease when the static half is red", () => {
    const r = leases({}, { ...halves, "check:static": "exit 7" });
    expect(r.status).toBe(7);
    expect(r.taken).toHaveLength(1);
  });

  it("a tree without the halves takes one 4-6 lease over the whole check", () => {
    const r = leases({}, { check: "echo whole" });
    expect(r.status).toBe(0);
    expect(r.taken).toEqual(["--threads 4-6 --label check -- npm run check"]);
  });

  it("under a lease already (WF_THREADS set) it takes none and runs the plain check", () => {
    const r = leases({ WF_THREADS: "5" }, halves);
    expect(r.status).toBe(0);
    expect(r.taken).toEqual([]);
    expect(r.out).toContain("whole");
  });
});
