import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ENG-TEST-ABORT-EXEC-GROUP-FLAKE: engine tests that run real subprocesses against a FIXED
// per-test timeout (vitest.config.ts testTimeout 15s) time out when the host is loaded the way a
// busy pool loads it (load average 90-126 on this 16-cpu host). The body below is the shell work
// of batch-template.test.ts "review-class.sh: ..." unchanged; the hogs reproduce the host load.
// The hogs slow every test file running beside this one (a whole suite run failed on them), so
// the reproduction runs only on request: WF_LOAD_REPRO=1 npx vitest run src/test-timeout-under-load.test.ts
// (red with testTimeout 15_000, green with the config's); the always-on pin is the config's value.
const REPRO = process.env.WF_LOAD_REPRO === "1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hogs: ChildProcess[] = [];

beforeAll(() => {
  if (!REPRO) return;
  for (let i = 0; i < os.cpus().length * 8; i++)
    hogs.push(spawn(process.execPath, ["-e", "for(;;);"], { stdio: "ignore" }));
}, 30_000);
afterAll(() => {
  for (const h of hogs.splice(0)) h.kill("SIGKILL");
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
    },
  ).trim();

describe("engine tests with real subprocesses under host load", () => {
  it("the suite's test timeout is a hang guard: at least 4x the 15 s that a loaded host outran", () => {
    const text = fs.readFileSync(path.join(ROOT, "vitest.config.ts"), "utf8");
    const ms = Number(/testTimeout:\s*([\d_]+)/.exec(text)?.[1]?.replaceAll("_", ""));
    expect(ms).toBeGreaterThanOrEqual(60_000);
  });

  it.skipIf(!REPRO)(
    "the review-class.sh case loop finishes inside the suite's fixed test timeout",
    () => {
      const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-load-")));
      try {
        git(repo, "init", "-q", "-b", "main");
        fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
        git(repo, "add", ".");
        git(repo, "commit", "-qm", "init");
        const script = path.join(ROOT, "scripts", "review-class.sh");
        const cases: [string, string][] = [
          ["docs/guide.md", "light"],
          ["docs/api.html", "light"],
          ["src/tests/a.ts", "light"],
          ["src/__tests__/b.ts", "light"],
          ["src/x.test.ts", "light"],
          ["src/FooTest.hx", "light"],
          ["CHANGELOG", "light"],
          ["CMakeLists.txt", "code"],
          ["requirements.txt", "code"],
          ["src/doc/Printer.x", "code"],
          ["src/spec/Typer.x", "code"],
          ["src/check/common/docs/Rule.hx", "code"],
        ];
        for (const [i, [file, want]] of cases.entries()) {
          git(repo, "checkout", "-q", "-b", `c${i}`, "main");
          fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
          fs.writeFileSync(path.join(repo, file), "x\n");
          git(repo, "add", ".");
          git(repo, "commit", "-qm", file);
          git(repo, "checkout", "-q", "main");
          const got = execFileSync("sh", [script, "main", `c${i}`], {
            cwd: repo,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
          expect([file, got]).toEqual([file, want]);
        }
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );
});
