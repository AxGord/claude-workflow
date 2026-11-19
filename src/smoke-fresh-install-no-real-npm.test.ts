import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// ENG-SMOKE-TEST-BUILD-ABORT-UNDER-LOAD: the unit cases of scripts/smoke-fresh-install.sh drove its real `npm ci` +
// `npm run build` of a fixture clone, so a gate's verdict depended on npm finishing under the suite's load (a gate saw
// `npm run build` exit 134 there). The script's own contract (a step running gets interrupted: exit 130, temp dir
// removed) must hold whatever npm does: here `npm` on PATH ends with the status the gate saw (134, an abort's). The steps are
// the test's through SMOKE_INSTALL_CMD / SMOKE_BUILD_CMD; without them they are npm's.
const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "smoke-fresh-install.sh");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-smoke-nonpm-")));
  dirs.push(d);
  return d;
};

/** A committed one-file repository, a fake real HOME, an empty TMPDIR, and a PATH `npm` that traces its call and exits 134. */
function setup(): {
  repo: string;
  home: string;
  tmpdir: string;
  shim: string;
  calls: string;
  path: string;
} {
  const base = tmp();
  const repo = path.join(base, "repo");
  const home = path.join(base, "realhome");
  const tmpdir = path.join(base, "tmpdir");
  const shim = path.join(base, "shim");
  for (const d of [repo, path.join(home, ".claude"), tmpdir, shim])
    fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "fx", version: "1.0.0" }),
  );
  const git = (...args: string[]): void => {
    const r = spawnSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: repo, encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
  };
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  const calls = path.join(base, "npm-calls");
  // the npm of a loaded host that aborts, as a shell reports it: exit 134 (a real SIGABRT would make the OS write a crash report into the user's home)
  fs.writeFileSync(path.join(shim, "npm"), `#!/bin/sh\necho "$@" >> ${calls}\nexit 134\n`, {
    mode: 0o755,
  });
  return { repo, home, tmpdir, shim, calls, path: `${shim}:${process.env["PATH"] ?? ""}` };
}

describe("smoke:fresh unit cases without a working npm", () => {
  it("Ctrl-C mid-step exits 130 and removes the temp dir; the stubbed steps never call npm", async () => {
    const s = setup();
    const marker = `33.${Date.now() % 100000}`;
    const started = path.join(path.dirname(s.repo), "started");
    const child = spawn("bash", [SCRIPT, "--source", s.repo], {
      env: {
        PATH: s.path,
        HOME: s.home,
        TMPDIR: s.tmpdir,
        SMOKE_INSTALL_CMD: "true",
        SMOKE_BUILD_CMD: `: > ${started}; sleep ${marker}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += String(d)));
    child.stderr.on("data", (d: Buffer) => (out += String(d)));
    let exited = false;
    const done = new Promise<number | null>(resolve =>
      child.on("exit", code => {
        exited = true;
        resolve(code);
      }),
    );
    const t0 = Date.now();
    while (!fs.existsSync(started) && !exited && Date.now() - t0 < 40_000)
      await new Promise(r => setTimeout(r, 50));
    expect(
      fs.existsSync(started),
      `no step was running to interrupt; the script's output:\n${out}`,
    ).toBe(true);
    child.kill("SIGINT");
    const code = await done;
    expect(code, out).toBe(130);
    expect(out).toContain("interrupted");
    expect(out).toMatch(/^PASS {2}install: SMOKE_INSTALL_CMD/m);
    expect(fs.existsSync(s.calls), "the script called npm although both steps are stubbed").toBe(
      false,
    );
    expect(fs.readdirSync(s.tmpdir)).toEqual([]);
  }, 60_000);

  it("without the hook the install step is npm's: an aborting npm is FAIL install (134), exit 1, an empty temp dir", () => {
    const s = setup();
    const r = spawnSync("bash", [SCRIPT, "--source", s.repo], {
      env: { PATH: s.path, HOME: s.home, TMPDIR: s.tmpdir },
      encoding: "utf8",
      timeout: 50_000,
    });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).toBe(1);
    expect(out).toMatch(/^FAIL {2}install: npm ci exited 134/m);
    expect(fs.readFileSync(s.calls, "utf8")).toBe("ci\n");
    expect(fs.readdirSync(s.tmpdir)).toEqual([]);
  }, 60_000);
});
