import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

// ENG-CI-NODE-MATRIX-PUBLISH-NEEDS-CI: the suite runs ONCE per commit, in ci.yml, on every node the engine
// supports; publish.yml builds and publishes only when ci.yml is green for the same commit
// (scripts/ci-green.sh). What only a real run on GitHub proves: the matrix cells themselves, `gh api` with the
// workflow's token, and the order of a push's two workflows.
const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const SCRIPT = path.join(ROOT, "scripts", "ci-green.sh");

interface Job {
  needs?: string | string[];
  strategy?: { matrix?: { node?: string[] } };
  permissions?: Record<string, string>;
  steps?: { name?: string; run?: string; uses?: string; with?: Record<string, string> }[];
}
interface Workflow {
  on: unknown;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}
const workflow = (name: string): Workflow => parse(read(`.github/workflows/${name}`)) as Workflow;
const major = (v: string): number => Number(v.replace(/^[^\d]*/, "").split(".")[0]);

describe("ci.yml: the node matrix", () => {
  it("tests node 22 and 24, and package.json engines names the lowest version it tests", () => {
    const matrix = workflow("ci.yml").jobs.test?.strategy?.matrix?.node ?? [];
    expect(matrix.map(String)).toEqual(expect.arrayContaining(["22", "24"]));
    const pkg = JSON.parse(read("package.json")) as { engines: { node: string } };
    expect(major(pkg.engines.node)).toBe(Math.min(...matrix.map(major)));
    expect(pkg.engines.node).toMatch(/^>=\d+\.0\.0$/);
    const lock = JSON.parse(read("package-lock.json")) as {
      packages: Record<string, { engines?: { node?: string } }>;
    };
    expect(lock.packages[""]?.engines?.node).toBe(pkg.engines.node);
  });

  it("gives each cell its own node version, and a failed cell does not hide the others", () => {
    const test = workflow("ci.yml").jobs.test;
    const setup = test?.steps?.find(s => s.uses?.startsWith("actions/setup-node"));
    expect(setup?.with?.["node-version"]).toBe("${{ matrix.node }}");
    expect(read(".github/workflows/ci.yml")).toContain("fail-fast: false");
  });

  it("the fresh-install smoke runs on the lowest version, and the smoke script refuses a lower one", () => {
    const pkg = JSON.parse(read("package.json")) as { engines: { node: string } };
    const smoke = workflow("ci.yml").jobs["smoke-fresh"];
    const setup = smoke?.steps?.find(s => s.uses?.startsWith("actions/setup-node"));
    expect(major(String(setup?.with?.["node-version"]))).toBe(major(pkg.engines.node));
    expect(read("scripts/smoke-fresh-install.sh")).toContain(
      `>= ${major(pkg.engines.node)} ? 0 : 1`,
    );
  });

  it("the docs that state a node requirement say the same version", () => {
    const pkg = JSON.parse(read("package.json")) as { engines: { node: string } };
    const v = `Node.js ${major(pkg.engines.node)}`;
    expect(read("README.md")).toContain(v);
    expect(read("docs/getting-started.md")).toContain(v);
  });
});

describe("publish.yml: no second run of the suite", () => {
  const wf = (): Workflow => workflow("publish.yml");

  it("publishes only after the ci-green job, which runs scripts/ci-green.sh on the commit being published", () => {
    const { jobs } = wf();
    expect([jobs.publish?.needs].flat()).toContain("ci-green");
    const gate = jobs["ci-green"];
    const run = gate?.steps?.map(s => s.run ?? "").join("\n") ?? "";
    expect(run).toContain("scripts/ci-green.sh");
    expect(run).toContain('"$GITHUB_SHA"');
    expect(gate?.permissions?.actions).toBe("read");
  });

  it("builds without running a test, and no step runs the suite", () => {
    const text = read(".github/workflows/publish.yml");
    const steps = wf().jobs.publish?.steps ?? [];
    for (const s of steps) expect(s.run ?? "", s.name).not.toMatch(/npm (run )?test|vitest/);
    const build = steps.find(s => s.run?.includes("npm run build"));
    expect(build?.name).toBe("Build");
    expect(text).toContain("npm ci");
  });

  it("keeps the dispatch trigger and the OIDC publish (id-token: write, --provenance, no registry-url)", () => {
    const text = read(".github/workflows/publish.yml");
    const w = wf();
    expect(Object.keys(w.on as object)).toEqual(
      expect.arrayContaining(["push", "workflow_dispatch"]),
    );
    expect(w.permissions?.["id-token"]).toBe("write");
    expect(text).toContain("npm publish --provenance --access public");
    const setup = w.jobs.publish?.steps?.find(s => s.uses?.startsWith("actions/setup-node"));
    expect(setup?.with).not.toHaveProperty("registry-url");
  });
});

// scripts/ci-green.sh against a fake `gh` that answers from a script of replies, one per call.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function run(
  replies: string[],
  env: Record<string, string> = {},
  args: string[] = ["abc123", "o/r"],
) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-ci-green-")));
  dirs.push(d);
  fs.mkdirSync(path.join(d, "bin"));
  replies.forEach((r, i) => fs.writeFileSync(path.join(d, `reply.${i}`), r));
  // reply N is served on call N (the last one repeats); "FAIL" makes gh exit 1
  fs.writeFileSync(
    path.join(d, "bin", "gh"),
    `#!/bin/sh
echo "$*" >> "${d}/calls"
n=$(cat "${d}/n" 2>/dev/null || echo 0)
f="${d}/reply.$n"
[ -f "$f" ] || f="${d}/reply.${replies.length - 1}"
echo $((n + 1)) > "${d}/n"
[ "$(cat "$f")" = FAIL ] && exit 1
cat "$f"
`,
    { mode: 0o755 },
  );
  const r = spawnSync("sh", [SCRIPT, ...args], {
    env: {
      PATH: `${path.join(d, "bin")}:/usr/bin:/bin`,
      CI_GREEN_POLL: "0",
      CI_GREEN_TIMEOUT: "5",
      CI_GREEN_START_GRACE: "0",
      ...env,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  const calls = fs.existsSync(path.join(d, "calls"))
    ? fs.readFileSync(path.join(d, "calls"), "utf8")
    : "";
  return { status: r.status, out: r.stdout + r.stderr, calls };
}

describe("scripts/ci-green.sh", () => {
  it("is executable and asks for the push runs of ci.yml for exactly that commit", () => {
    expect(fs.statSync(SCRIPT).mode & 0o111).not.toBe(0);
    const r = run(["1 completed success\n"]);
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toContain("repos/o/r/actions/workflows/ci.yml/runs?head_sha=abc123&event=push");
  });

  it("fails when the commit's CI finished and none of its runs succeeded", () => {
    const r = run(["1 completed failure\n2 completed cancelled\n"]);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("not green");
  });

  it("a success wins over an earlier failed run of the same commit (a re-run)", () => {
    expect(run(["1 completed failure\n2 completed success\n"]).status).toBe(0);
  });

  it("waits for a run that is still going, then follows its verdict", () => {
    const ok = run(["5 in_progress null\n", "5 queued null\n", "5 completed success\n"]);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.calls.trim().split("\n")).toHaveLength(3);
    const bad = run(["5 in_progress null\n", "5 completed failure\n"]);
    expect(bad.status, bad.out).toBe(1);
  });

  it("does not take a running re-run as green, and gives up when CI never finishes", () => {
    const r = run(["1 completed failure\n2 in_progress null\n"], { CI_GREEN_TIMEOUT: "0" });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("did not finish");
  });

  it("fails when no CI run exists for the commit after the start grace", () => {
    const r = run([""]);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("no CI run");
  });

  it("waits for a first run to appear within the grace", () => {
    const r = run(["", "9 completed success\n"], { CI_GREEN_START_GRACE: "5" });
    expect(r.status, r.out).toBe(0);
  });

  it("exits 2 when gh fails, and on a missing argument", () => {
    expect(run(["FAIL"]).status).toBe(2);
    const r = run(["1 completed success\n"], {}, []);
    expect(r.status).toBe(2);
    expect(r.calls).toBe("");
  });
});
