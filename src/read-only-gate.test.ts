import { describe, it, expect } from "vitest";
import { build } from "esbuild";
import { afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideReadOnly,
  isReadOnlyAgent,
  parseReadOnlyConfig,
  type ReadOnlyConfig,
  redirectsToFile,
} from "./read-only-gate.js";

const config = parseReadOnlyConfig(
  JSON.stringify({
    write: ["apq patch", "hxq replace-node", "/^hxq lint\\b.*--fix/"],
    env: { APQ_READ_ONLY: "1" },
  }),
);
const call = (
  agent_type: string | undefined,
  command: string,
  cfg: ReadOnlyConfig | null = config,
) => decideReadOnly({ tool_name: "Bash", agent_type, tool_input: { command } }, cfg ?? undefined);
const DENY = { kind: "deny" };

describe("read-only gate", () => {
  it("touches only the read-only agent types", () => {
    expect(isReadOnlyAgent("wf-recon")).toBe(true);
    expect(isReadOnlyAgent("workflow:wf-reviewer")).toBe(true);
    expect(isReadOnlyAgent("wf-driver")).toBe(false);
    expect(isReadOnlyAgent(undefined)).toBe(false);
    expect(call(undefined, "git commit -m x")).toEqual({ kind: "pass" });
    expect(call("general-purpose", "git commit -m x")).toEqual({ kind: "pass" });
    expect(call("wf-driver", "rm -rf x")).toEqual({ kind: "pass" });
  });

  it.each([
    "git commit -m x",
    "git -C /repo add .",
    "git -c core.x=1 stash",
    "FOO=1 git rm a",
    "cd d && git mv a b",
    "echo hi > out.txt",
    "cat a >> notes.md",
    "rm a",
    "sed -i s/a/b/ f",
    "apq patch F.hx --write",
    "/usr/local/bin/hxq replace-node F.hx",
    "hxq lint a.hx --fix",
    "sh -c 'git commit -m x'",
    'bash -lc "echo 1 > x"',
    "rtk git commit -m x",
    "rtk proxy git add .",
    "xargs rm",
    "find . -name a | xargs -n 1 rm",
    "env FOO=1 git stash",
    "command rm a",
    "nice -n 5 git reset --hard",
    "git branch newname",
    "git tag v1",
    "git config user.name x",
    "git worktree add ../w",
    "git update-ref refs/x HEAD",
    "git notes add -m x",
    "git gc",
    "git fetch",
    "cat <<EOF\nhi\nEOF",
  ])("denies %s", command => {
    expect(call("wf-reviewer", command)).toMatchObject(DENY);
  });

  it.each([
    "git status && git log --grep commit",
    "git -C /repo diff HEAD~1",
    "grep -n '>' file",
    "echo 'a > b'",
    "ls 2>&1 | head",
    "cmd > /dev/null 2>&1",
    "ls > /tmp/out.txt",
    "apq get a.json x.y",
    "git branch --list",
    "git branch -a -v",
    "git tag -l",
    "git config --get user.name",
    "git config --list",
    "rtk git log -3",
    "hxq lint a.hx",
  ])("lets %s through with the env exported", command => {
    expect(call("wf-recon", command)).toEqual({
      kind: "env",
      command: `export APQ_READ_ONLY='1'; ${command}`,
    });
  });

  it("without a config the built-in write list still holds and nothing is exported", () => {
    expect(call("wf-recon", "git commit -m x", null)).toMatchObject(DENY);
    expect(call("wf-recon", "git status", null)).toEqual({ kind: "env", command: "git status" });
  });

  it("the config can name its own read-only types", () => {
    const c = parseReadOnlyConfig(JSON.stringify({ agents: ["curator"] }));
    expect(call("curator", "rm a", c)).toMatchObject(DENY);
    expect(call("wf-recon", "rm a", c)).toEqual({ kind: "pass" });
  });

  it("redirectsToFile ignores quotes, fd duplication and scratch targets", () => {
    expect(redirectsToFile("echo '>' x")).toBeUndefined();
    expect(redirectsToFile("a 2>&1")).toBeUndefined();
    expect(redirectsToFile("a > /dev/null")).toBeUndefined();
    expect(redirectsToFile(`a > ${os.tmpdir()}/x`)).toBeUndefined();
    expect(redirectsToFile("a >| src/x")).toContain("src/x");
  });

  it("rejects a malformed config naming the key", () => {
    expect(() => parseReadOnlyConfig("[]")).toThrow(/object/);
    expect(() => parseReadOnlyConfig('{"write":[1]}')).toThrow(/write/);
    expect(() => parseReadOnlyConfig('{"env":{"1x":"a"}}')).toThrow(/env/);
    expect(() => parseReadOnlyConfig('{"write":["/(/"]}')).toThrow(/regex/);
  });
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("composition with the pool gate", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it("a wrapped heavy command of a read-only agent still carries the exported env, and pool-gate-hook stays out", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-ro-"));
    dirs.push(dir);
    const plugin = path.join(dir, "plugin");
    for (const name of ["pool-gate-hook", "read-only-gate-hook"])
      await build({
        entryPoints: [path.join(ROOT, "src", `${name}.ts`)],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node18",
        outfile: path.join(plugin, "build", `${name}.js`),
        logLevel: "silent",
      });
    const proj = path.join(dir, "proj");
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    fs.mkdirSync(path.join(proj, ".claude", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, ".claude", "workflows", "pool-gate.json"),
      JSON.stringify({ rules: [{ match: "make", threads: 2, pass: "-j $WF_THREADS" }] }),
    );
    fs.writeFileSync(
      path.join(proj, ".claude", "read-only-commands.json"),
      JSON.stringify({ env: { APQ_READ_ONLY: "1" } }),
    );
    const hook = (name: string, agent: string) =>
      spawnSync("node", [path.join(plugin, "build", `${name}.js`)], {
        input: JSON.stringify({
          tool_name: "Bash",
          agent_type: agent,
          cwd: proj,
          tool_input: { command: "make all" },
        }),
        encoding: "utf8",
        env: { PATH: path.dirname(process.execPath) },
      });
    const out = JSON.parse(hook("read-only-gate-hook", "wf-recon").stdout) as {
      hookSpecificOutput: { updatedInput: { command: string } };
    };
    expect(out.hookSpecificOutput.updatedInput.command).toContain("wf-run");
    expect(out.hookSpecificOutput.updatedInput.command).toContain("APQ_READ_ONLY");
    expect(hook("pool-gate-hook", "wf-recon").stdout).toBe("");
    expect(hook("pool-gate-hook", "wf-driver").stdout).toContain("wf-run");
  });
});

describe("hooks/read-only-gate.sh", () => {
  const run = (payload: object) =>
    spawnSync("sh", [path.join(ROOT, "hooks", "read-only-gate.sh")], {
      input: JSON.stringify(payload),
      encoding: "utf8",
    });

  it("a payload without agent_type exits silently before any node is started", () => {
    const r = run({ tool_name: "Bash", tool_input: { command: "git commit -m x" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("a read-only agent's write is denied through the built hook", () => {
    if (!fs.existsSync(path.join(ROOT, "build", "read-only-gate-hook.js"))) return;
    const r = run({
      tool_name: "Bash",
      agent_type: "wf-reviewer",
      cwd: os.tmpdir(),
      tool_input: { command: "git commit -m x" },
    });
    expect(JSON.parse(r.stdout) as unknown).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });
});

describe("shipped agent types", () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
  const front = (n: string) =>
    Object.fromEntries(
      /^---\n([\s\S]*?)\n---/
        .exec(fs.readFileSync(path.join(dir, `${n}.md`), "utf8"))![1]
        .split("\n")
        .map(l => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]),
    );

  it.each([
    ["wf-driver", "haiku", "low"],
    ["wf-recon", "sonnet", "medium"],
    ["wf-reviewer", "opus", "high"],
  ])("%s is %s/%s", (name, model, effort) => {
    expect(front(name)).toMatchObject({ name, model, effort });
  });

  it("wf-driver lists every workflow tool the server registers, by name", () => {
    const src = fs.readFileSync(path.join(dir, "..", "src", "tools.ts"), "utf8");
    const names = [...src.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map(m => m[1]);
    const tools = front("wf-driver").tools.split(", ");
    expect(names.length).toBeGreaterThan(15);
    for (const n of names) expect(tools).toContain(`mcp__plugin_workflow_wf__${n}`);
  });

  it("read-only types carry no edit tool; the driver no Edit/Write/Bash", () => {
    for (const n of ["wf-recon", "wf-reviewer"])
      expect(front(n).tools).not.toMatch(/Edit|Write|NotebookEdit/);
    expect(front("wf-driver").tools).not.toMatch(/Edit|Write|Bash|NotebookEdit/);
  });
});
