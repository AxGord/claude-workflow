import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// ENG-RELEASE-FRESH-INSTALL-SMOKE: scripts/smoke-fresh-install.sh is the one run of what a new user gets. Its
// own contract (exits, cleanup, the real-home comparison) is pinned here on a tiny fixture repository whose
// `build` script is the test's, so nothing needs the registry; the real run is `npm run smoke:fresh`.
const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "smoke-fresh-install.sh");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-smoke-test-")));
  dirs.push(d);
  return d;
};

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly tmpdir: string;
}

/** A committed repository with no dependency and a `build` command (given the fake real HOME), a fake real HOME holding a `.claude`. */
function fixture(build: string | ((home: string) => string)): Fixture {
  const base = tmp();
  const repo = path.join(base, "repo");
  const home = path.join(base, "realhome");
  const tmpdir = path.join(base, "tmpdir");
  for (const d of [repo, path.join(home, ".claude"), tmpdir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({
      name: "fx",
      version: "1.0.0",
      scripts: { build: typeof build === "string" ? build : build(home) },
    }),
  );
  fs.writeFileSync(
    path.join(repo, "package-lock.json"),
    JSON.stringify({
      name: "fx",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "fx", version: "1.0.0" } },
    }),
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
  return { repo, home, tmpdir };
}

const env = (f: Fixture): NodeJS.ProcessEnv => ({
  PATH: process.env["PATH"] ?? "",
  HOME: f.home,
  TMPDIR: f.tmpdir,
});

function run(f: Fixture, ...args: string[]): { status: number | null; out: string } {
  const r = spawnSync("bash", [SCRIPT, "--source", f.repo, ...args], {
    env: env(f),
    encoding: "utf8",
    timeout: 50_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** The shells the script may be started by: bash, and dash (no job control without a tty) where it exists: the script must re-exec itself under bash. */
const SHELLS = ["bash", ...(fs.existsSync("/bin/dash") ? ["/bin/dash"] : [])];

describe("smoke:fresh", () => {
  it("is wired: an executable script, an npm script, a CI job, the page that names it", () => {
    expect(fs.statSync(SCRIPT).mode & 0o111).not.toBe(0);
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["smoke:fresh"]).toBe("bash scripts/smoke-fresh-install.sh");
    expect(read("docs/development.md")).toContain("npm run smoke:fresh");
    expect(read(".github/workflows/ci.yml")).toContain("npm run smoke:fresh");
  });

  it("refuses a bad argument or a source that is no repository with exit 2 before it makes anything", () => {
    const f = fixture("true");
    for (const args of [["--nope"], ["--source"], ["--source", path.join(f.home, "missing")]]) {
      const r = spawnSync("bash", [SCRIPT, ...args], { env: env(f), encoding: "utf8" });
      expect([args, r.status], r.stderr).toEqual([args, 2]);
    }
    expect(fs.readdirSync(f.tmpdir)).toEqual([]);
  });

  it("a failed build ends the run with exit 1, one FAIL line, the isolation check and an empty temp dir", () => {
    const f = fixture("exit 3");
    const r = run(f);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/^FAIL {2}build: npm run build exited 3/m);
    expect(r.out).toMatch(/^PASS {2}isolation: /m);
    expect(r.out).toMatch(/1 failed/);
    expect(fs.readdirSync(f.tmpdir)).toEqual([]);
  }, 60_000);

  it("--keep leaves the temp dir and says where", () => {
    const f = fixture("exit 3");
    const r = run(f, "--keep");
    expect(r.out).toMatch(/smoke:fresh: kept (\S+)/);
    expect(fs.readdirSync(f.tmpdir)).toHaveLength(1);
  }, 60_000);

  it("FAILs isolation when the run writes an engine-owned path of the real ~/.claude, and only then", () => {
    const leaked = (home: string): string => path.join(home, ".claude", "skills", "leaked");
    const dirty = fixture(
      home => `mkdir -p ${leaked(home)} && echo x > ${leaked(home)}/SKILL.md && exit 3`,
    );
    const bad = run(dirty);
    expect(bad.status, bad.out).toBe(1);
    expect(bad.out).toMatch(/^FAIL {2}isolation: the run wrote into the real .*\.claude/m);
    expect(bad.out).toContain(leaked(dirty.home));
    const clean = run(fixture("exit 3"));
    expect(clean.out).toMatch(/^PASS {2}isolation: /m);
  }, 120_000);

  it("counts a write to a nested skills/ path (plugins/x/skills) as changed elsewhere, not as a leak", () => {
    const nested = fixture(
      home =>
        `mkdir -p ${home}/.claude/plugins/x/skills && echo x > ${home}/.claude/plugins/x/skills/y && exit 3`,
    );
    const r = run(nested);
    expect(r.out).toMatch(/^PASS {2}isolation: .* [1-9]\d* changed elsewhere/m);
  }, 120_000);

  it.each(SHELLS)(
    "Ctrl-C (SIGINT) mid-step kills the step's whole process group, removes the temp dir and exits 130 (started by %s)",
    async shell => {
      const marker = `31.${Date.now() % 100000}${shell.length}`;
      const f = fixture(`sleep ${marker}`);
      const child = spawn(shell, [SCRIPT, "--source", f.repo], {
        env: env(f),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += String(d)));
      child.stderr.on("data", (d: Buffer) => (out += String(d)));
      const done = new Promise<number | null>(resolve => child.on("exit", code => resolve(code)));
      const started = Date.now();
      const sleeping = (): boolean =>
        spawnSync("ps", ["-eo", "command"], { encoding: "utf8" }).stdout.includes(
          `sleep ${marker}`,
        );
      while (!sleeping() && Date.now() - started < 40_000)
        await new Promise(r => setTimeout(r, 200));
      expect(sleeping(), out).toBe(true);
      child.kill("SIGINT");
      const code = await done;
      await new Promise(r => setTimeout(r, 300));
      expect(code, out).toBe(130);
      expect(out).toContain("interrupted");
      expect(sleeping(), "the build's sleep outlived the run").toBe(false);
      expect(fs.readdirSync(f.tmpdir)).toEqual([]);
    },
    60_000,
  );

  it("names every step it runs in its header", () => {
    const text = read("scripts/smoke-fresh-install.sh");
    for (const name of [
      "clone",
      "install",
      "manifest",
      "npm-pack",
      "git-channel",
      "hook",
      "wf-skills",
      "path-link",
      "mcp-",
      "dashboard",
      "wf-run",
      "wf-queue",
      "uninstall",
      "claude-plugin-cli",
      "isolation",
    ])
      expect(text.split("\n\n")[0], name).toContain(`#   ${name}`);
  });
});

describe("docs: what the walk of a fresh install changed", () => {
  it("getting-started says the wf-* commands are not on PATH after an install and how to link them", () => {
    const text = read("docs/getting-started.md");
    expect(text).toContain("ln -s");
    expect(text).toContain("not on your `PATH`");
  });

  it("getting-started and README say that a git-sourced install has no compiled server", () => {
    for (const rel of ["README.md", "docs/getting-started.md"])
      expect(read(rel), rel).toMatch(/without `build\/`/);
  });
});
