import { afterAll, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { poolGateOutput } from "./pool-gate-run.js";
import { spawnChild } from "./test-helpers.js";

// The engine repo's own worktrees (/tmp/wf-*) are git checkouts of this tree: the gate must
// find a tracked .claude/workflows/pool-gate.yaml from there and lease the test runs, sized by
// what each really uses (held = used).
const worktree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// no rtk on PATH: its rewrite of the body is not what this file pins
const env = { PATH: "/usr/bin:/bin" };

function gate(command: string, e: NodeJS.ProcessEnv = env): string | undefined {
  const out = poolGateOutput(command, { command }, worktree, e, () => {});
  const wrapped = out?.updatedInput?.command;
  return typeof wrapped === "string" ? wrapped : undefined;
}

const threadsOf = (wrapped: string | undefined): string | undefined =>
  wrapped === undefined ? undefined : /--threads (\S+)/.exec(wrapped)?.[1];

describe("pool gate in an engine worktree", () => {
  const sized: [string, string][] = [
    ["npx vitest run src/a.test.ts", "1"],
    ["npx vitest run src/a.test.ts src/b.test.ts", "2"],
    ["npx vitest run src/a.test.ts src/b.test.ts src/c.test.ts", "4-14"],
    ["npx vitest run", "4-14"],
    ["npx vitest run -t name", "4-14"],
    ["npx --no-install vitest run src/", "4-14"],
    ["npm exec vitest -- run", "4-14"],
    ["node_modules/.bin/vitest run", "4-14"],
    ["./node_modules/.bin/vitest run src/a.test.ts", "1"],
    ["npx vitest run --maxWorkers=1", "1"],
    ["npx vitest run --maxWorkers=2", "2"],
    ["npx vitest run --max-workers 4 src/a.test.ts src/b.test.ts", "4"],
    ["npx vitest run --maxWorkers=8", "8"],
    ["npm test", "4-14"],
    ["npm test -- src/a.test.ts", "1"],
    ["npm run test", "4-14"],
    ["npm run check", "4-14"],
    ["npm run check:ci", "4-14"],
    ["sh scripts/check-ci.sh", "4-14"],
    ["cd /tmp/x && npx vitest run src/a.test.ts 2>&1 | tail -5", "1"],
  ];
  for (const [command, threads] of sized) {
    it(`leases \`${command}\` through wf-run with ${threads} threads`, () => {
      const wrapped = gate(command);
      expect(wrapped).toMatch(/scripts\/wf-run --fail-open --threads/);
      expect(threadsOf(wrapped)).toBe(threads);
    });
  }

  it("hands the lease's share to vitest (held = used)", () => {
    expect(gate("npx vitest run src/a.test.ts")).toContain(
      'env VITEST_MAX_WORKERS="$WF_THREADS" npx vitest run',
    );
    expect(gate("npm run check")).toContain('env VITEST_MAX_WORKERS="$WF_THREADS" npm run check');
  });

  for (const command of [
    "npm run build",
    "npm run test:pane",
    "node node_modules/typescript7/bin/tsc --noEmit",
    "npm run lint",
    "git status",
  ]) {
    it(`leaves \`${command}\` alone`, () => {
      expect(gate(command)).toBeUndefined();
    });
  }

  it("never leases a run twice", () => {
    const wf = "/x/scripts/wf-run --threads 4 -- ";
    expect(gate(`${wf}npm run check`)).toBeUndefined();
    expect(gate("node scripts/wf-run.js --threads 2 -- npx vitest run")).toBeUndefined();
    expect(gate("npx vitest run src/a.test.ts", { ...env, WF_THREADS: "3" })).toBeUndefined();
    expect(gate("npx vitest run src/a.test.ts &")).toBeUndefined();
  });

  it("the config file is tracked: .gitignore does not ignore it", () => {
    const r = spawnSync("git", ["check-ignore", "-q", ".claude/workflows/pool-gate.yaml"], {
      cwd: worktree,
    });
    expect(r.status).toBe(1);
  });

  it("check-ci.sh carries the lease's share into its emptied environment", () => {
    const script = spawnSync("grep", ["-c", "VITEST_MAX_WORKERS", "scripts/check-ci.sh"], {
      cwd: worktree,
      encoding: "utf8",
    });
    expect(Number(script.stdout.trim())).toBeGreaterThan(0);
  });

  // A worker's call is `cd /tmp/wf-X && npx vitest …` while the payload cwd is the caller's project.
  describe("the call's cwd is another project", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "wf-gate-other-"));
    fs.mkdirSync(path.join(other, ".git"));
    fs.mkdirSync(path.join(other, ".claude", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(other, ".claude", "workflows", "pool-gate.yaml"),
      "rules:\n  - match: haxe\n    threads: 1-2\n",
    );
    afterAll(() => fs.rmSync(other, { recursive: true, force: true }));
    const from = (command: string): string | undefined => {
      const out = poolGateOutput(command, { command }, other, env, () => {});
      const wrapped = out?.updatedInput?.command;
      return typeof wrapped === "string" ? wrapped : undefined;
    };

    it("`cd <engine worktree> && npx vitest run src/a.test.ts` is leased with 1 thread", () => {
      expect(threadsOf(from(`cd ${worktree} && npx vitest run src/a.test.ts`))).toBe("1");
      expect(threadsOf(from(`cd ${worktree}; npm run check`))).toBe("4-14");
      expect(threadsOf(from(`cd ${worktree} && cd src && npx vitest run a.test.ts`))).toBe("1");
    });

    it("without the cd the other project's config decides: vitest passes, haxe is leased", () => {
      expect(from("npx vitest run src/a.test.ts")).toBeUndefined();
      expect(threadsOf(from("haxe b.hxml"))).toBe("1-2");
    });

    it("a cd into a directory with no config keeps the call cwd's config", () => {
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), "wf-gate-bare-"));
      afterAll(() => fs.rmSync(bare, { recursive: true, force: true }));
      expect(threadsOf(from(`cd ${bare} && haxe b.hxml`))).toBe("1-2");
      expect(threadsOf(from(`cd /tmp && haxe b.hxml`))).toBe("1-2");
    });

    it("a cd it cannot resolve keeps the call's cwd", () => {
      for (const target of ["/nonexistent-wf-dir", "$HOME", "-P /tmp", "~"])
        expect(from(`cd ${target} && npx vitest run src/a.test.ts`)).toBeUndefined();
    });
  });

  // The lease's share rides in VITEST_MAX_WORKERS, which beats a child vitest's own --maxWorkers.
  it("spawnChild keeps a child's own --maxWorkers: the suite's VITEST_MAX_WORKERS does not reach it", () => {
    const show = "process.stdout.write(process.env.VITEST_MAX_WORKERS ?? 'unset')";
    const env = { ...process.env, VITEST_MAX_WORKERS: "9" };
    expect(
      spawnChild("node", ["-e", show, "--", "--maxWorkers=1"], { env, timeout: 20_000 }).stdout,
    ).toBe("unset");
    expect(spawnChild("node", ["-e", show], { env, timeout: 20_000 }).stdout).toBe("9");
  });
});
