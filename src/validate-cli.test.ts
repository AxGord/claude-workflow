import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { Loader } from "./loader.js";
import { TrustStore } from "./trust.js";
import { runValidate } from "./validate-cli.js";
import { cleanupDir } from "./test-helpers.js";

// ENG-WF-VALIDATE-CLI: `wf-validate` answers, outside a session, whether a project's workflow files
// still load, with the loader the server uses.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-validate-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const GOOD = {
  name: "good",
  initial: "build",
  states: {
    build: { type: "exec", command: "true", on_success: "fin", on_error: "fin" },
    fin: { terminal: true },
  },
};
/** The state the engine refused after the landed change: an exec with on_success and no on_error. */
const NO_ON_ERROR = {
  name: "sweepy",
  initial: "sweep_wait",
  states: {
    sweep_wait: { type: "exec", command: "true", on_success: "fin" },
    fin: { terminal: true },
  },
};
const NO_ON_ERROR_REASON =
  'state "sweep_wait" action requires on_success + on_error or cases + default';

/** A project holding `.claude/workflows/<file>` per entry; the global and state dirs do not exist. */
function project(files: Record<string, object>): {
  cwd: string;
  dir: string;
  env: NodeJS.ProcessEnv;
} {
  const cwd = tmp();
  const dir = path.join(cwd, ".claude", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, def] of Object.entries(files))
    fs.writeFileSync(path.join(dir, file), YAML.stringify(def));
  const env = {
    WORKFLOW_DIR: path.join(tmp(), "global-not-created"),
    STATE_DIR: path.join(tmp(), "state-not-created"),
  };
  return { cwd, dir, env };
}

describe("wf-validate", () => {
  it("a good file prints `ok <name>` and exits 0; an exec file loads with no trust question", () => {
    const p = project({ "good.yaml": GOOD });
    expect(runValidate([], p.env, p.cwd)).toEqual({ lines: ["ok good"], code: 0 });
  });

  it("an exec with on_success and no on_error prints the loader's own reason and exits 1", () => {
    const p = project({ "sweepy.yaml": NO_ON_ERROR });
    const r = runValidate([], p.env, p.cwd);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual([`fail ${path.join(p.dir, "sweepy.yaml")}: ${NO_ON_ERROR_REASON}`]);
  });

  it("a directory with one of each prints both lines and exits 1", () => {
    const p = project({ "good.yaml": GOOD, "sweepy.yaml": NO_ON_ERROR });
    const r = runValidate([p.dir], p.env, p.cwd);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual([
      "ok good",
      `fail ${path.join(p.dir, "sweepy.yaml")}: ${NO_ON_ERROR_REASON}`,
    ]);
  });

  it("a file argument reports that file alone, whatever its neighbours do", () => {
    const p = project({ "good.yaml": GOOD, "sweepy.yaml": NO_ON_ERROR });
    expect(runValidate([path.join(p.dir, "good.yaml")], p.env, p.cwd)).toEqual({
      lines: ["ok good"],
      code: 0,
    });
    expect(runValidate(["sweepy.yaml"], p.env, p.dir).code).toBe(1);
  });

  it("a schema error (an unknown key) prints the loader's did-you-mean text", () => {
    const p = project({ "typo.yaml": { ...GOOD, name: "typo", initail: "build" } });
    const r = runValidate([], p.env, p.cwd);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain('unknown key "initail" — did you mean "initial"?');
  });

  it("a file that is not YAML at all fails with the parser's message", () => {
    const p = project({});
    fs.writeFileSync(path.join(p.dir, "broken.yaml"), "name: [unclosed\n");
    const r = runValidate([], p.env, p.cwd);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^fail .*broken\.yaml: /);
  });

  it("an extends of a bundled workflow resolves, and a missing parent fails", () => {
    const p = project({
      "heir.yaml": { name: "heir", extends: "bug-fix" },
      "orphan.yaml": { name: "orphan", extends: "no-such-parent" },
    });
    const r = runValidate([], p.env, p.cwd);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toBe("ok heir");
    expect(r.lines[1]).toContain('extends "no-such-parent": no such workflow');
  });

  it("a missing directory is exit 0 with a note; a missing yaml file is a failure", () => {
    const cwd = tmp();
    const env = { WORKFLOW_DIR: path.join(tmp(), "g"), STATE_DIR: path.join(tmp(), "s") };
    const none = runValidate([], env, cwd);
    expect(none.code).toBe(0);
    expect(none.lines).toEqual([
      `note: ${path.join(cwd, ".claude", "workflows")} does not exist, nothing to validate`,
    ]);
    expect(runValidate(["gone.yaml"], env, cwd).code).toBe(1);
  });

  it("an empty directory is a note, exit 0", () => {
    const p = project({});
    const r = runValidate([], p.env, p.cwd);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/^note: no workflow files in /);
  });

  it("reads only: neither the global directory nor the state directory is created", () => {
    const p = project({ "good.yaml": GOOD });
    runValidate([], p.env, p.cwd);
    expect(fs.existsSync(p.env.WORKFLOW_DIR as string)).toBe(false);
    expect(fs.existsSync(p.env.STATE_DIR as string)).toBe(false);
    expect(fs.readdirSync(p.dir)).toEqual(["good.yaml"]);
  });

  it("two files declaring one name: the one the loader dropped is reported, not `ok`", () => {
    const p = project({ "a.yaml": GOOD, "b.yaml": GOOD });
    const r = runValidate([], p.env, p.cwd);
    expect(r.code).toBe(1);
    expect(r.lines.filter(l => l.startsWith("ok "))).toHaveLength(1);
    expect(r.lines.join("\n")).toContain("declares the same name");
  });

  it("the pool gate's pool-gate.yaml beside the workflows is not a workflow: no fail line, and the server's loader does not list it as broken", () => {
    const p = project({ "good.yaml": GOOD });
    fs.writeFileSync(
      path.join(p.dir, "pool-gate.yaml"),
      "rules:\n  - match: npx vitest run\n    threads: 4\n",
    );
    expect(runValidate([], p.env, p.cwd)).toEqual({ lines: ["ok good"], code: 0 });
    expect(runValidate([p.dir], p.env, p.cwd).code).toBe(0);
    const loader = new Loader(null, tmp(), p.dir, TrustStore.describeOnly());
    expect(loader.broken()).toEqual([]);
    expect(loader.names()).toEqual(["good"]);
  });

  it("an unreadable directory is a fail line, not a stack", () => {
    const p = project({ "good.yaml": GOOD });
    fs.chmodSync(p.dir, 0o000);
    try {
      const r = runValidate([], p.env, p.cwd);
      if (process.getuid?.() !== 0) {
        expect(r.code).toBe(1);
        expect(r.lines[0]).toMatch(/^fail .*workflows: /);
      }
    } finally {
      fs.chmodSync(p.dir, 0o755);
    }
  });

  it("unknown flags are a usage error, exit 2", () => {
    expect(runValidate(["--bogus"]).code).toBe(2);
  });

  it("a sub_workflow that is not there is a warning, not a failure", () => {
    const p = project({
      "parent.yaml": {
        name: "parent",
        initial: "go",
        states: {
          go: { sub_workflow: "not-there", on_complete: "fin" },
          fin: { terminal: true },
        },
      },
    });
    const r = runValidate([], p.env, p.cwd);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe("ok parent");
    expect(r.lines.join("\n")).toContain('sub_workflow "not-there" not found');
  });
});

describe("wf-validate: what the loader refuses at load, not at a transition", () => {
  it("a transition to a state that does not exist, and an on_exhausted that names none, already fail the load", () => {
    const p = project({
      "bad.yaml": {
        name: "bad",
        initial: "a",
        states: {
          a: {
            prompt: "go",
            transitions: { next: "nowhere" },
            max_visits: 2,
            on_exhausted: "gone",
          },
          fin: { terminal: true },
        },
      },
    });
    const r = runValidate([], p.env, p.cwd);
    expect(r.code).toBe(1);
    const text = r.lines.join("\n");
    expect(text).toContain('state "a" transition "next" → unknown state "nowhere"');
    expect(text).toContain('state "a" on_exhausted → unknown state "gone"');
  });
});

describe("wf-validate: shipped like the other wf-* commands", () => {
  it("package.json has the bin, the shim execs build/validate-cli.js and is executable", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };
    expect(pkg.bin["wf-validate"]).toBe("build/validate-cli.js");
    const shim = path.join(ROOT, "scripts", "wf-validate");
    expect(fs.readFileSync(shim, "utf8")).toContain('/build/validate-cli.js" "$@"');
    expect(fs.statSync(shim).mode & 0o111).not.toBe(0);
  });

  it("getting-started, the README and the bundled skill name it, and the smoke links it", () => {
    for (const f of [
      "docs/getting-started.md",
      "README.md",
      "templates/skills/wf-yaml-authoring/SKILL.md",
      "scripts/smoke-fresh-install.sh",
    ])
      expect(fs.readFileSync(path.join(ROOT, f), "utf8"), f).toContain("wf-validate");
  });
});
