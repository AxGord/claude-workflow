import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { Executor } from "./executor.js";
import { Pool } from "./pool.js";
import type { StateDefinition } from "./types.js";

// Runs the bundled templates' routing exec states as the engine would and
// resolves the route they pick (cases → default).

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");

function templateState(workflow: string, state: string): StateDefinition {
  const def = YAML.parse(fs.readFileSync(path.join(TEMPLATES, `${workflow}.yaml`), "utf8"));
  return def.states[state];
}

async function route(state: StateDefinition, vars: Record<string, unknown>): Promise<string> {
  const result = await new Executor().execute(state, vars);
  return state.cases![String(result.exit_code)] ?? state.default!;
}

describe("review routing (review-size.sh)", () => {
  let repo: string;

  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" }).trim();
  const write = (file: string, lines: number) =>
    fs.writeFileSync(path.join(repo, file), Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n") + "\n");
  const vars = (context: Record<string, unknown> = {}, root = "master") =>
    ({ context: { cwd: repo, ...context }, root_workflow: root });

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "wf-review-"));
    git("init", "-q");
    write("a.txt", 10);
    git("add", ".");
    git("commit", "-qm", "init");
  });

  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  for (const workflow of ["coding", "bug-fix"]) {
    describe(workflow, () => {
      const review = templateState(workflow, "review");

      it("trivial change → review_single", async () => {
        write("a.txt", 20);
        write("new.txt", 5);
        expect(await route(review, vars())).toBe("review_single");
      });

      it("over the line cap → review_delegate", async () => {
        write("a.txt", 80);
        expect(await route(review, vars())).toBe("review_delegate");
      });

      it("over the file cap (untracked counted) → review_delegate", async () => {
        write("a.txt", 11);
        write("b.txt", 1);
        write("c.txt", 1);
        expect(await route(review, vars())).toBe("review_delegate");
      });

      it("diffs against review_base, including committed work", async () => {
        const base = git("rev-parse", "HEAD");
        write("a.txt", 80);
        git("commit", "-qam", "big");
        expect(await route(review, vars())).toBe("review_route");
        expect(await route(review, vars({ review_base: base }))).toBe("review_delegate");
      });

      it("fix round: untracked files older than review_base don't count", async () => {
        write("a.txt", 12);
        for (const f of ["n1.txt", "n2.txt", "n3.txt"]) {
          write(f, 100);
          const past = new Date(Date.now() - 60_000);
          fs.utimesSync(path.join(repo, f), past, past);
        }
        const base = git("stash", "create");
        write("a.txt", 14);
        expect(await route(review, vars({ review_base: base }))).toBe("review_single");
        write("n1.txt", 101);
        expect(await route(review, vars({ review_base: base }))).toBe("review_delegate");
      });

      it("fix round after a new-files-only task: commit-tree base (clean tracked tree)", async () => {
        for (const f of ["n1.txt", "n2.txt", "n3.txt"]) {
          write(f, 100);
          const past = new Date(Date.now() - 60_000);
          fs.utimesSync(path.join(repo, f), past, past);
        }
        expect(git("stash", "create")).toBe("");
        const base = git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "review-base");
        write("a.txt", 11);
        expect(await route(review, vars({ review_base: base }))).toBe("review_single");
      });

      it("fix round: option-like and git-quoted untracked names still count", async () => {
        write("a.txt", 11);
        const base = git("stash", "create");
        write("-newer.txt", 1);
        write('q"1.txt', 1);
        // 1-second-mtime filesystems: keep -newer.txt strictly after the base
        const ahead = new Date(Date.now() + 2_000);
        fs.utimesSync(path.join(repo, "-newer.txt"), ahead, ahead);
        expect(await route(review, vars({ review_base: base }))).toBe("review_delegate");
      });

      it("nothing measured → review_route fallback", async () => {
        expect(await route(review, vars())).toBe("review_route");
      });

      it("binary file counts as over the line cap", async () => {
        fs.writeFileSync(path.join(repo, "a.txt"), Buffer.from([0, 1, 2, 0]));
        expect(await route(review, vars())).toBe("review_delegate");
      });

      it("cwd in a subdirectory still counts untracked files repo-wide", async () => {
        fs.mkdirSync(path.join(repo, "sub"));
        write("b.txt", 1);
        write("c.txt", 1);
        write("sub/d.txt", 1);
        expect(await route(review, { context: { cwd: path.join(repo, "sub") }, root_workflow: "master" })).toBe("review_delegate");
      });

      it("sub-agent root → review_single whatever the size", async () => {
        write("a.txt", 500);
        expect(await route(review, vars({}, "subagent"))).toBe("review_single");
      });

      it("bad baseline → review_route fallback", async () => {
        expect(await route(review, vars({ review_base: "deadbeef" }))).toBe("review_route");
      });

      it("not a git repo → review_route fallback", async () => {
        fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
        expect(await route(review, vars())).toBe("review_route");
      });
    });
  }
});

describe("bug-fix verify_route", () => {
  const state = templateState("bug-fix", "verify_route");

  it("routes by context bug_type", async () => {
    expect(await route(state, { context: { bug_type: "logic" } })).toBe("done");
    expect(await route(state, { context: { bug_type: "visual" } })).toBe("load_skills_verify");
  });

  it("missing or unknown bug_type → manual fallback", async () => {
    expect(await route(state, { context: {} })).toBe("verify_route_manual");
    expect(await route(state, { context: { bug_type: "both" } })).toBe("verify_route_manual");
  });
});

describe("testing check_test_changes", () => {
  const state = templateState("testing", "check_test_changes");

  it("no fix_* visits → done", async () => {
    expect(await route(state, { context: {}, visits: { assess: 1, unit_tests: 1 } })).toBe("done");
  });

  it("any fix_* visit → review_test_changes", async () => {
    for (const fix of ["fix_unit", "fix_integration", "fix_user_issue"])
      expect(await route(state, { context: {}, visits: { [fix]: 1 } })).toBe("review_test_changes");
  });
});

describe("review lint pass: probe without a lease, the pass under one", () => {
  let dir: string;
  let outerPath: string | undefined;
  let outerParallel: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-lint-"));
    fs.mkdirSync(path.join(dir, "bin"));
    // a stand-in hxq that reports the oracle parallelism it was given
    fs.writeFileSync(path.join(dir, "bin", "hxq"), '#!/bin/sh\necho "hxq $1 APQ=${APQ_ORACLE_PARALLEL-unset}"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "A.hx"), "class A {}\n");
    fs.writeFileSync(path.join(dir, "a.ts"), "\n");
    outerPath = process.env.PATH;
    outerParallel = process.env.APQ_ORACLE_PARALLEL;
    delete process.env.APQ_ORACLE_PARALLEL;
  });
  afterEach(() => {
    process.env.PATH = outerPath;
    if (outerParallel !== undefined) process.env.APQ_ORACLE_PARALLEL = outerParallel;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const withHxq = () => { process.env.PATH = `${path.join(dir, "bin")}:${outerPath}`; };
  const withoutHxq = () => { process.env.PATH = "/usr/bin:/bin"; };
  const ctx = (files: string) => ({ context: { file_path: files } });

  for (const [workflow, probe, pass, skip] of [
    ["file-review", "mechanical_probe", "mechanical_pass", "determine_authorship"],
    ["lint-review", "probe", "run", "act"],
  ] as const) {
    describe(workflow, () => {
      it("nothing to lint (non-.hx, no hxq) skips the leased pass; a .hx with hxq runs it", async () => {
        const state = templateState(workflow, probe);
        withHxq();
        expect(await route(state, ctx(path.join(dir, "a.ts")))).toBe(skip);
        expect(await route(state, ctx(`${path.join(dir, "a.ts")} ${path.join(dir, "A.hx")}`))).toBe(pass);
        withoutHxq();
        expect(await route(state, ctx(path.join(dir, "A.hx")))).toBe(skip);
      });

      it("the pass leases threads and hands them to the oracle as APQ_ORACLE_PARALLEL", async () => {
        const state = templateState(workflow, pass);
        expect(state.resource?.threads).toBe(4);
        withHxq();
        const poolDir = path.join(dir, "pool");
        fs.mkdirSync(poolDir);
        fs.writeFileSync(path.join(poolDir, "config.json"), JSON.stringify({ budget: 10, load_threshold: 1000 }));
        const r = await new Executor(new Pool(poolDir)).execute(state, ctx(path.join(dir, "A.hx")));
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toMatch(/hxq lint APQ=4/);
        // a value the caller set wins
        process.env.APQ_ORACLE_PARALLEL = "2";
        expect((await new Executor(new Pool(poolDir)).execute(state, ctx(path.join(dir, "A.hx")))).stdout).toMatch(/hxq lint APQ=2/);
      });
    });
  }
});
