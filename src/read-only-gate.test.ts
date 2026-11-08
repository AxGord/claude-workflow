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
    read: ["apq", "hxq", "make"],
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
    expect(isReadOnlyAgent("workflow:recon")).toBe(true);
    expect(isReadOnlyAgent("workflow:reviewer")).toBe(true);
    expect(isReadOnlyAgent("reviewer")).toBe(false);
    expect(isReadOnlyAgent("recon")).toBe(false);
    expect(isReadOnlyAgent("other:reviewer")).toBe(false);
    expect(isReadOnlyAgent("other:reviewer", ["other:reviewer"])).toBe(true);
    expect(isReadOnlyAgent("other:reviewer", ["reviewer"])).toBe(false);
    expect(isReadOnlyAgent("workflow:wf-recon")).toBe(false);
    expect(isReadOnlyAgent("workflow:wf-reviewer")).toBe(false);
    expect(isReadOnlyAgent("workflow:driver")).toBe(false);
    expect(isReadOnlyAgent(undefined)).toBe(false);
    expect(call(undefined, "git commit -m x")).toEqual({ kind: "pass" });
    expect(call("general-purpose", "git commit -m x")).toEqual({
      kind: "pass",
    });
    expect(call("workflow:driver", "rm -rf x")).toEqual({ kind: "pass" });
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
    "echo -delete | xargs find .",
    "GIT_EXTERNAL_DIFF=x git diff",
    "env GIT_EXTERNAL_DIFF=x git diff",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=x git log",
    "git grep -O",
    "git grep -nOless x",
    "git grep --open-files-in-pager=x y",
    "sort -ofile f",
    "sort --compress-program=x f",
    "uniq in out",
    "sed -n 'w out' f",
    "sed -e s/a/b/ f",
    "uniq - out",
    "uniq -- - out",
    "sed -n 1p -e 'w out' f",
    "sed -n 1p f --expression='w out'",
    "cat a > /tmp/../x",
    "file -C -m x",
    "perl -i -pe 's/a/b/' f",
    'python -c \'open("f","w")\'',
    "node -e 'fs.writeFileSync(1,1)'",
    "find . -name a -delete",
    "find . -exec rm {} ;",
    "tee out.txt",
    "ls | tee out.txt",
    "dd if=a of=b",
    "cp a b",
    "mv a b",
    "sort -o f f",
    "git -c core.pager=x log",
    "git diff --output=f",
    "echo $(rm a)",
    'echo "`rm a`"',
    "cat <(rm a)",
    "ls; curl x",
    "make clean > src/x",
  ])("denies %s", command => {
    expect(call("workflow:reviewer", command)).toMatchObject(DENY);
  });

  it.each([
    "git status && git log --grep commit",
    "git -C /repo diff HEAD~1",
    "grep -n '>' file",
    "echo 'a > b'",
    "ls 2>&1 | head",
    "ls > /dev/null 2>&1",
    "ls > /tmp/out.txt",
    "git branch --list",
    "git branch -a -v",
    "git tag -l",
    "git config --get user.name",
    "git config --list",
    "rtk git log -3",
    "sed -n 1,20p f",
    "sed -n '/x/p' f",
    "sort -u f | uniq -c",
  ])("lets %s through unchanged: no project reader reads the env", command => {
    expect(call("workflow:recon", command)).toEqual({ kind: "env", command });
  });

  it.each(["hxq lint a.hx", "cd d && hxq lint a.hx | head", "rtk proxy hxq lint a.hx", "make all"])(
    "%s starts with a project reader: the env is exported in front",
    command => {
      expect(call("workflow:recon", command)).toEqual({
        kind: "env",
        command: `export APQ_READ_ONLY='1'; ${command}`,
      });
    },
  );

  it("without a config the built-in write list still holds and nothing is exported", () => {
    expect(call("workflow:recon", "git commit -m x", null)).toMatchObject(DENY);
    expect(call("workflow:recon", "git status", null)).toEqual({
      kind: "env",
      command: "git status",
    });
  });

  it("the config can name its own read-only types", () => {
    const c = parseReadOnlyConfig(JSON.stringify({ agents: ["curator"] }));
    expect(call("curator", "rm a", c)).toMatchObject(DENY);
    expect(call("workflow:recon", "rm a", c)).toEqual({ kind: "pass" });
  });

  it("redirectsToFile ignores quotes, fd duplication and scratch targets", () => {
    expect(redirectsToFile("echo '>' x")).toBeUndefined();
    expect(redirectsToFile("a 2>&1")).toBeUndefined();
    expect(redirectsToFile("a > /dev/null")).toBeUndefined();
    expect(redirectsToFile(`a > ${os.tmpdir()}/x`)).toBeUndefined();
    expect(redirectsToFile("a >| src/x")).toContain("src/x");
  });

  it("the config `read` list declares a project reader; unlisted commands are refused with the rule", () => {
    expect(call("workflow:recon", "hxq lint a.hx", null)).toMatchObject({
      kind: "deny",
      reason: expect.stringContaining("not a declared reader") as string,
    });
    expect(call("workflow:recon", "hxq lint a.hx")).toMatchObject({ kind: "env" });
    expect(call("workflow:recon", "cat hxq")).toEqual({ kind: "env", command: "cat hxq" });
  });

  it("a redirect into a git work tree under scratch is refused", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-ro-wt-"));
    fs.mkdirSync(path.join(d, "src"));
    fs.writeFileSync(path.join(d, ".git"), "gitdir: x");
    try {
      expect(redirectsToFile(`a > ${d}/src/x`)).toContain("src/x");
      expect(redirectsToFile(`a > ${os.tmpdir()}/../x`)).toBeDefined();
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("rejects a malformed config naming the key", () => {
    expect(() => parseReadOnlyConfig('{"read":[1]}')).toThrow(/read/);
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
      path.join(proj, ".claude", "workflows", "pool-gate.yaml"),
      JSON.stringify({
        rules: [{ match: "make", threads: 2, pass: "-j $WF_THREADS" }],
      }),
    );
    fs.writeFileSync(
      path.join(proj, ".claude", "read-only-commands.yaml"),
      JSON.stringify({ env: { APQ_READ_ONLY: "1" }, read: ["make", "hxq"] }),
    );
    const hook = (name: string, agent: string, command = "make all") =>
      spawnSync("node", [path.join(plugin, "build", `${name}.js`)], {
        input: JSON.stringify({
          tool_name: "Bash",
          agent_type: agent,
          cwd: proj,
          tool_input: { command },
        }),
        encoding: "utf8",
        env: { PATH: path.dirname(process.execPath) },
      });
    const out = JSON.parse(hook("read-only-gate-hook", "workflow:recon").stdout) as {
      hookSpecificOutput: { permissionDecision: string; updatedInput: { command: string } };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput.command).toContain("wf-run");
    expect(out.hookSpecificOutput.updatedInput.command).toContain("APQ_READ_ONLY");
    // An allowed call that no project reader reads the env for passes UNCHANGED: no hook output.
    const plain = hook("read-only-gate-hook", "workflow:recon", "cat x");
    expect(plain.stdout).toBe("");
    expect(plain.status).toBe(0);
    // A project reader gets the env, and the rewrite is allowed (auto mode refuses an unallowed one).
    const reader = JSON.parse(
      hook("read-only-gate-hook", "workflow:recon", "hxq lint a.hx").stdout,
    ) as {
      hookSpecificOutput: { permissionDecision: string; updatedInput: { command: string } };
    };
    expect(reader.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(reader.hookSpecificOutput.updatedInput.command).toBe(
      "export APQ_READ_ONLY='1'; hxq lint a.hx",
    );
    expect(hook("pool-gate-hook", "workflow:recon").stdout).toBe("");
    expect(hook("pool-gate-hook", "workflow:driver").stdout).toContain("wf-run");
  });
});

describe("hooks/read-only-gate.sh", () => {
  const run = (payload: object) =>
    spawnSync("sh", [path.join(ROOT, "hooks", "read-only-gate.sh")], {
      input: JSON.stringify(payload),
      encoding: "utf8",
    });

  it("a payload without agent_type exits silently before any node is started", () => {
    const r = run({
      tool_name: "Bash",
      tool_input: { command: "git commit -m x" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("a read-only agent's write is denied through the built hook", () => {
    if (!fs.existsSync(path.join(ROOT, "build", "read-only-gate-hook.js"))) return;
    const r = run({
      tool_name: "Bash",
      agent_type: "workflow:reviewer",
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
    ["driver", "haiku", "low"],
    ["recon", "sonnet", "medium"],
    ["reviewer", "opus", "high"],
  ])("%s is %s/%s", (name, model, effort) => {
    expect(front(name)).toMatchObject({ name, model, effort });
  });

  it("driver lists every workflow tool the server registers, by name", () => {
    const src = fs.readFileSync(path.join(dir, "..", "src", "tools.ts"), "utf8");
    const names = [...src.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map(m => m[1]);
    const tools = front("driver").tools.split(", ");
    expect(names.length).toBeGreaterThan(15);
    for (const n of names) expect(tools).toContain(`mcp__plugin_workflow_wf__${n}`);
  });

  it("read-only types carry no edit tool; the driver no Edit/Write/Bash", () => {
    for (const n of ["recon", "reviewer"])
      expect(front(n).tools).not.toMatch(/Edit|Write|NotebookEdit/);
    expect(front("driver").tools).not.toMatch(/Edit|Write|Bash|NotebookEdit/);
  });
});
