import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { decide, parseConfig, splitSegments, type GateConfig } from "./pool-gate.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const WF = "/plug/scripts/wf-run";
const opts = { wfRun: WF, shell: "sh", env: {} as NodeJS.ProcessEnv };

const config: GateConfig = parseConfig(
  JSON.stringify({
    rules: [
      { match: "npx vitest run", threads: "2-8", pass: "--maxWorkers=$WF_THREADS" },
      { match: "npx vitest", deny: "watch mode never ends — use `npx vitest run`" },
      { match: "haxe", threads: 4, pass: "env:HXCPP_COMPILE_THREADS" },
      { match: "/^turbo run (build|test)\\b/", threads: 6, pass: "--concurrency=$WF_THREADS" },
      { match: "make", threads: 3, pass: "-j $WF_THREADS" },
    ],
    wrappers: ["build-run.sh", "app-run.sh"],
  }),
);

const wrapped = (threads: string, body: string, label = body) =>
  `${WF} --fail-open --threads ${threads} --label ${q(label)} -- sh -c ${q(body)}`;
const q = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

describe("pool-gate decide", () => {
  const PASS = { kind: "pass" };
  const table: [string, string, object][] = [
    // wrap + pass
    [
      "flag goes after the matched words",
      "npx vitest run src/a.test.ts",
      {
        kind: "wrap",
        command: wrapped(
          "2-8",
          "npx vitest run --maxWorkers=$WF_THREADS src/a.test.ts",
          "npx vitest run src/a.test.ts",
        ),
      },
    ],
    [
      "env pass goes before the command, after its own assignments",
      "FOO=1 haxe build.hxml",
      {
        kind: "wrap",
        command: wrapped(
          "4",
          'FOO=1 env HXCPP_COMPILE_THREADS="$WF_THREADS" haxe build.hxml',
          "FOO=1 haxe build.hxml",
        ),
      },
    ],
    [
      "regex rule appends its flag at the segment end",
      "turbo run build --filter=web",
      {
        kind: "wrap",
        command: wrapped(
          "6",
          "turbo run build --filter=web --concurrency=$WF_THREADS",
          "turbo run build --filter=web",
        ),
      },
    ],
    [
      "regex rule puts its flag before `--`",
      "turbo run build -- --filter x",
      {
        kind: "wrap",
        command: wrapped(
          "6",
          "turbo run build --concurrency=$WF_THREADS -- --filter x",
          "turbo run build -- --filter x",
        ),
      },
    ],
    [
      "a glued short flag counts as given",
      "make -j8 all",
      { kind: "wrap", command: wrapped("3", "make -j8 all") },
    ],
    [
      "a --flag=value counts as given",
      "turbo run test --concurrency=2",
      { kind: "wrap", command: wrapped("6", "turbo run test --concurrency=2") },
    ],
    [
      "a flag already given is kept, not doubled",
      "make -j 2 all",
      { kind: "wrap", command: wrapped("3", "make -j 2 all") },
    ],
    [
      "the first word matches by basename",
      "/opt/bin/haxe x.hxml",
      {
        kind: "wrap",
        command: wrapped(
          "4",
          'env HXCPP_COMPILE_THREADS="$WF_THREADS" /opt/bin/haxe x.hxml',
          "/opt/bin/haxe x.hxml",
        ),
      },
    ],
    // segments and quotes
    [
      "&& — the whole command under one lease, the largest share",
      "cd web && haxe b.hxml && npx vitest run",
      {
        kind: "wrap",
        command: wrapped(
          "4-8",
          'cd web && env HXCPP_COMPILE_THREADS="$WF_THREADS" haxe b.hxml && npx vitest run --maxWorkers=$WF_THREADS',
          "cd web && haxe b.hxml && npx vitest run",
        ),
      },
    ],
    [
      "quotes and escapes survive the single-quoting",
      `echo "it's; && |" 'a"b' \\; && haxe "my file.hxml"`,
      {
        kind: "wrap",
        command: wrapped(
          "4",
          `echo "it's; && |" 'a"b' \\; && env HXCPP_COMPILE_THREADS="$WF_THREADS" haxe "my file.hxml"`,
          `echo "it's; && |" 'a"b' \\; && haxe "my file.hxml"`,
        ),
      },
    ],
    ["operators inside quotes are not segments", `echo "x && haxe b.hxml"`, PASS],
    ["a heavy command inside $( ) is not seen", "echo $(haxe b.hxml)", PASS],
    [
      "pipe and subshell segments are matched",
      "(cd a; make) | tee log",
      {
        kind: "wrap",
        command: wrapped("3", "(cd a; make -j $WF_THREADS) | tee log", "(cd a; make) | tee log"),
      },
    ],
    [
      "2>&1 is a redirection, not a background job",
      "haxe b.hxml 2>&1",
      {
        kind: "wrap",
        command: wrapped(
          "4",
          'env HXCPP_COMPILE_THREADS="$WF_THREADS" haxe b.hxml 2>&1',
          "haxe b.hxml 2>&1",
        ),
      },
    ],
    ["a background job passes — the lease would end before it", "haxe b.hxml &", PASS],
    ["a heredoc is opaque — passes", "cat <<EOF\nhaxe b.hxml\nEOF", PASS],
    ["an unterminated quote passes", "haxe 'b.hxml", PASS],
    // deny
    [
      "watch mode is refused",
      "npx vitest",
      { kind: "deny", reason: "pool-gate: watch mode never ends — use `npx vitest run`" },
    ],
    [
      "deny in a later segment",
      "npm ci && npx vitest --ui",
      { kind: "deny", reason: "pool-gate: watch mode never ends — use `npx vitest run`" },
    ],
    // skips
    ["no match", "git status && ls", PASS],
    ["already under wf-run", "/plug/scripts/wf-run --threads 2 -- haxe b.hxml", PASS],
    ["wf-run in a later segment", "cd a && wf-run --threads 2 -- make", PASS],
    ["a wrapper takes its own lease", "./tools/build-run.sh test", PASS],
    ["a wrapper through a shell", "bash app-run.sh && make", PASS],
    ["a word that only starts like a rule", "haxelib install x", PASS],
  ];
  for (const [name, command, want] of table)
    it(name, () => expect(decide(command, config, opts)).toEqual(want));

  describe("env conditions on leading assignments", () => {
    const envConfig = parseConfig(
      JSON.stringify({
        rules: [
          { match: "node bin/test.js", env: { APQ_TEST: "/^unit\\./" }, threads: 1 },
          { match: "node bin/test.js", env: { APQ_TEST: true }, threads: 2 },
          { match: "node bin/test.js", env: { APQ_TEST: false }, threads: 8 },
          { match: "/^node bin/dev.js shard/", env: { FAST: false, CI: true }, threads: 4 },
        ],
      }),
    );
    const cases: [string, string, string | null][] = [
      ["regex on the value", "APQ_TEST=unit.check. node bin/test.js", "1"],
      ["set, regex fails → next rule (any value)", "APQ_TEST=corpus node bin/test.js", "2"],
      ["an empty value is set", "APQ_TEST= node bin/test.js", "2"],
      ["not set → the `false` rule", "node bin/test.js", "8"],
      ["assignments after `env` count", "env APQ_TEST=x node bin/test.js", "2"],
      ["quotes are removed before the regex", "APQ_TEST='unit.a' node bin/test.js", "1"],
      ["another segment's assignment does not count", "APQ_TEST=x true && node bin/test.js", "8"],
      ["all conditions must hold", "CI=1 node bin/dev.js shard -n 4", "4"],
      ["a `false` condition fails", "CI=1 FAST=1 node bin/dev.js shard -n 4", null],
      ["a `true` condition fails", "node bin/dev.js shard -n 4", null],
    ];
    for (const [name, command, threads] of cases)
      it(name, () =>
        expect(decide(command, envConfig, opts)).toEqual(
          threads === null
            ? { kind: "pass" }
            : { kind: "wrap", command: wrapped(threads, command) },
        ),
      );
  });

  describe("deny vs. a command already under a lease", () => {
    const denyConfig = parseConfig(
      JSON.stringify({
        rules: [
          { match: "/vitest(?! run)/", deny: "watch mode" },
          { match: "make", threads: 2 },
        ],
        wrappers: ["build-run.sh"],
      }),
    );
    const deny = { kind: "deny", reason: "pool-gate: watch mode" };
    const cases: [string, string, object][] = [
      ["a bare hit is refused", "npx vitest", deny],
      ["inside wf-run: not matched, deny included", "wf-run --threads 2 -- npx vitest", PASS],
      [
        "the gate's own wrapped form is left alone",
        wrapped("2", "npx vitest --ui", "npx vitest --ui"),
        PASS,
      ],
      ["a wrapper's arguments are not matched", "sh build-run.sh npx vitest", PASS],
      ["another segment beside a wf-run is still refused", "wf-run -- make && npx vitest", deny],
    ];
    for (const [name, command, want] of cases)
      it(name, () => expect(decide(command, denyConfig, opts)).toEqual(want));
  });

  it("no config → passes silently", () => {
    expect(decide("haxe b.hxml", undefined, opts)).toEqual({ kind: "pass" });
  });

  it("WF_THREADS in the hook's environment (an exec under a lease) → passes", () => {
    const env = { WF_THREADS: "4" };
    expect(decide("haxe b.hxml", config, { ...opts, env })).toEqual({ kind: "pass" });
  });

  it("WF_POOL_BYPASS=1 up front → passes with a note naming the reason", () => {
    expect(
      decide("WF_POOL_BYPASS=1 WF_POOL_BYPASS_REASON='quick probe' haxe b.hxml", config, opts),
    ).toEqual({
      kind: "pass",
      note: "pool-gate: WF_POOL_BYPASS=1 — runs outside the pool (reason: quick probe)",
    });
    expect(decide("WF_POOL_BYPASS=1 npx vitest", config, opts)).toMatchObject({
      kind: "pass",
      note: expect.stringContaining("no WF_POOL_BYPASS_REASON") as unknown,
    });
  });

  it("the body goes through the rewriter; its allow is carried, its refusal leaves the command alone", () => {
    const seen: string[] = [];
    const rewrite = (allow: boolean) => (body: string) => {
      seen.push(body);
      return { body: body.replace("make", "rtk make"), allow };
    };
    expect(decide("make", config, { ...opts, rewrite: rewrite(true) })).toEqual({
      kind: "wrap",
      command: wrapped("3", "rtk make -j $WF_THREADS", "make"),
      allow: true,
    });
    expect(seen).toEqual(["make -j $WF_THREADS"]);
    expect(decide("make", config, { ...opts, rewrite: rewrite(false) })).toEqual({
      kind: "wrap",
      command: wrapped("3", "rtk make -j $WF_THREADS", "make"),
    });
    expect(decide("make", config, { ...opts, rewrite: () => undefined })).toEqual({
      kind: "pass",
    });
    seen.length = 0;
    decide("git status", config, { ...opts, rewrite: rewrite(true) });
    expect(seen).toEqual([]);
  });

  it("the shell is the one given (the Bash tool's)", () => {
    const d = decide("make", config, { ...opts, shell: "/bin/zsh" });
    expect(d).toEqual({
      kind: "wrap",
      command: `${WF} --fail-open --threads 3 --label make -- /bin/zsh -c 'make -j $WF_THREADS'`,
    });
  });

  it("the label is the command, whitespace folded, cut to 80", () => {
    const d = decide(`make   ${"x".repeat(100)}`, config, opts) as { command: string };
    expect(d.command).toContain(`--label 'make ${"x".repeat(75)}' --`);
  });
});

describe("pool-gate splitSegments", () => {
  const words = (c: string) => splitSegments(c)?.map(s => s.words.map(w => w.value));
  it("unquotes words and splits at operators", () => {
    expect(words(`a "b c" 'd'\\ e; f||g|h & i\nj`)).toEqual([
      ["a", "b c", "d e"],
      ["f"],
      ["g"],
      ["h"],
      ["i"],
      ["j"],
    ]);
  });
  it("keeps substitutions and redirections inside their words", () => {
    expect(words(`a $(b && c) "\`d;e\`" x>&2 &>/dev/null`)).toEqual([
      ["a", "$(b && c)", "`d;e`", "x>&2", "&>/dev/null"],
    ]);
  });
  it("drops comments and joins continued lines", () => {
    expect(words("a \\\n b # c && d")).toEqual([["a", "b"]]);
  });
});

describe("pool-gate parseConfig", () => {
  const bad: [string, unknown][] = [
    ["rules[0]: exactly one of `threads` and `deny`", { rules: [{ match: "x" }] }],
    [
      "rules[0]: exactly one of `threads` and `deny`",
      { rules: [{ match: "x", threads: 2, deny: "no" }] },
    ],
    ['rules[0]: `threads` is N or "MIN-MAX"', { rules: [{ match: "x", threads: "two" }] }],
    ["rules[0]: `threads` min exceeds max", { rules: [{ match: "x", threads: "8-2" }] }],
    ["rules[0]: `pass` is `env:NAME`", { rules: [{ match: "x", threads: 1, pass: "-j4" }] }],
    ["is not a valid /regex/", { rules: [{ match: "/(/", threads: 1 }] }],
    ["rules[0]: `env` must be an object", { rules: [{ match: "x", threads: 1, env: ["A"] }] }],
    ['rules[0]: `env` key "1A"', { rules: [{ match: "x", threads: 1, env: { "1A": true } }] }],
    [
      "rules[0]: `env.A` must be true, false or a valid",
      { rules: [{ match: "x", threads: 1, env: { A: "plain" } }] },
    ],
    ["`env.A` must be", { rules: [{ match: "x", threads: 1, env: { A: "/(/" } }] }],
    ["`wrappers` must be a list", { rules: [], wrappers: "build-run.sh" }],
  ];
  for (const [msg, cfg] of bad)
    it(`refuses: ${msg}`, () => expect(() => parseConfig(JSON.stringify(cfg))).toThrow(msg));
  it("refuses broken JSON", () => expect(() => parseConfig("{ rules: ")).toThrow());
});

// The hook as Claude Code runs it: hooks/pool-gate.sh in a plugin root with a build.
describe("pool-gate hook (real processes)", () => {
  const dirs: string[] = [];
  const tmp = (prefix: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
  };
  let plugin = "";
  beforeAll(async () => {
    plugin = fs.realpathSync(tmp("wf-gate-plugin-"));
    bin = tmp("wf-gate-bin-");
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
    for (const d of ["hooks", "scripts", "build"]) fs.mkdirSync(path.join(plugin, d));
    fs.copyFileSync(
      path.join(SRC, "..", "hooks", "pool-gate.sh"),
      path.join(plugin, "hooks", "pool-gate.sh"),
    );
    fs.copyFileSync(
      path.join(SRC, "..", "scripts", "wf-run"),
      path.join(plugin, "scripts", "wf-run"),
    );
    for (const f of ["hooks/pool-gate.sh", "scripts/wf-run"])
      fs.chmodSync(path.join(plugin, f), 0o755);
    for (const name of ["pool-gate-hook", "wf-run"])
      await build({
        entryPoints: [path.join(SRC, `${name}.ts`)],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node18",
        outfile: path.join(plugin, "build", `${name}.js`),
        logLevel: "silent",
      });
  });
  afterAll(() => {
    for (const d of dirs) {
      fs.chmodSync(d, 0o755); // the read-only pool dirs
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  /** A git project (a `.git` dir is all the search needs) with this pool-gate.json, if any. */
  function project(cfg?: string): string {
    const dir = tmp("wf-gate-proj-");
    fs.mkdirSync(path.join(dir, ".git"));
    fs.mkdirSync(path.join(dir, "sub"));
    if (cfg !== undefined) {
      fs.mkdirSync(path.join(dir, ".claude", "workflows"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".claude", "workflows", "pool-gate.json"), cfg);
    }
    return dir;
  }
  /** Only what the test sets: the caller's WF_THREADS / WF_POOL_DIR / SHELL never leak in. */
  /** A bin dir holding only `node` (and what a test adds): no real rtk, no caller's tools. */
  let bin = "";
  const cleanEnv = (extra: Record<string, string> = {}) => ({
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: tmp("wf-gate-home-"),
    ...extra,
  });
  function hook(cwd: string, command: string, env = cleanEnv(), root = plugin) {
    const r = spawnSync(path.join(root, "hooks", "pool-gate.sh"), [], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command, description: "d" }, cwd }),
      env,
      encoding: "utf8",
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  const nodeCmd = `node -e 'process.stdout.write("n=" + (process.env.N || "-") + "\\n"); process.exit(3)'`;
  const realCfg = (pass?: string) =>
    JSON.stringify({ rules: [{ match: "node -e", threads: "1-2", ...(pass ? { pass } : {}) }] });

  it("no config → no output, exit 0", () => {
    expect(hook(project(), "haxe b.hxml")).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("a broken config → the command passes, one stderr line", () => {
    const r = hook(path.join(project("{ rules: "), "sub"), "haxe b.hxml");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toMatch(/^pool-gate: config ignored — .*pool-gate\.json: /);
  });

  it("no build → the command passes, one stderr line", () => {
    const bare = tmp("wf-gate-bare-");
    fs.mkdirSync(path.join(bare, "hooks"));
    fs.copyFileSync(
      path.join(plugin, "hooks", "pool-gate.sh"),
      path.join(bare, "hooks", "pool-gate.sh"),
    );
    fs.chmodSync(path.join(bare, "hooks", "pool-gate.sh"), 0o755);
    const r = hook(project(realCfg()), "node -e 1", cleanEnv(), bare);
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(r.stderr).toMatch(/^pool-gate: .*missing \(npm run build\) — command passes as is\n$/);
  });

  it("deny → a PreToolUse refusal with the reason", () => {
    const cfg = JSON.stringify({ rules: [{ match: "npx vitest", deny: "watch mode" }] });
    const r = hook(project(cfg), "npx vitest");
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "pool-gate: watch mode",
      },
    });
  });

  it("the config is found from a subdirectory; the rewrite keeps the other input fields", () => {
    const r = hook(path.join(project(realCfg()), "sub"), "node -e 1");
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { updatedInput: object } };
    expect(out.hookSpecificOutput.updatedInput).toEqual({
      command: `${path.join(plugin, "scripts", "wf-run")} --fail-open --threads 1-2 --label 'node -e 1' -- sh -c 'node -e 1'`,
      description: "d",
    });
  });

  /** Run a command as the Bash tool would (here: sh), with a private pool. */
  function runAs(command: string, cwd: string, pool: string) {
    const r = spawnSync("sh", ["-c", command], {
      cwd,
      env: cleanEnv({ WF_POOL_DIR: pool }),
      encoding: "utf8",
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  const pool = () => {
    const dir = tmp("wf-gate-pool-");
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ budget: 4, load_threshold: 1000 }),
    );
    return dir;
  };

  it("under wf-run: stdout and the exit code are the direct run's", () => {
    const dir = project(realCfg());
    const command = `printf '%s\\n' "it's \\"q\\"" && ${nodeCmd}`;
    const r = hook(dir, command);
    const rewritten = (
      JSON.parse(r.stdout) as { hookSpecificOutput: { updatedInput: { command: string } } }
    ).hookSpecificOutput.updatedInput.command;
    expect(
      rewritten.startsWith(path.join(plugin, "scripts", "wf-run") + " --fail-open --threads 1-2 "),
    ).toBe(true);
    const direct = runAs(command, dir, pool());
    const gated = runAs(rewritten, dir, pool());
    expect(direct).toMatchObject({ code: 3, stdout: `it's "q"\nn=-\n` });
    expect(gated.code).toBe(direct.code);
    expect(gated.stdout).toBe(direct.stdout);
  }, 20_000);

  it("under wf-run: the command gets its share through `pass`", () => {
    const dir = project(realCfg("env:N"));
    const r = hook(dir, nodeCmd);
    const rewritten = (
      JSON.parse(r.stdout) as { hookSpecificOutput: { updatedInput: { command: string } } }
    ).hookSpecificOutput.updatedInput.command;
    expect(runAs(rewritten, dir, pool())).toMatchObject({ code: 3, stdout: "n=2\n" });
  }, 20_000);
  /** A bin dir with `node` and a stub `name` running `script`. */
  function stubBin(name: string, script: string): string {
    const dir = tmp("wf-gate-stub-");
    if (name !== "node") fs.symlinkSync(process.execPath, path.join(dir, "node"));
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return dir;
  }
  const output = (r: { stdout: string }) =>
    JSON.parse(r.stdout) as {
      hookSpecificOutput: { permissionDecision?: string; updatedInput: { command: string } };
    };

  it("no pool-gate.json → node is never started", () => {
    const mark = path.join(tmp("wf-gate-mark-"), "node-ran");
    const dir = stubBin("node", `touch '${mark}'\nexec '${process.execPath}' "$@"`);
    const env = { ...cleanEnv(), PATH: `${dir}:/usr/bin:/bin` };
    expect(hook(path.join(project(), "sub"), "haxe b.hxml", env)).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    expect(fs.existsSync(mark)).toBe(false);
    expect(hook(project(realCfg()), "node -e 1", env).stdout).toContain("wf-run");
    expect(fs.existsSync(mark)).toBe(true);
  });

  it("rtk on PATH: exit 0 → its rewrite, allowed; 3 → its rewrite, no decision; 1 → as is; 2 → untouched", () => {
    const dir = project(realCfg());
    const rtk = (code: number) =>
      stubBin(
        "rtk",
        `[ "$1" = rewrite ] || exit 9\n${code === 0 || code === 3 ? `printf 'rtk %s\\n' "$2"\n` : ""}exit ${code}`,
      );
    const run = (code: number) =>
      hook(dir, "node -e 1", { ...cleanEnv(), PATH: `${rtk(code)}:/usr/bin:/bin` });
    const wf = path.join(plugin, "scripts", "wf-run");
    const cmd = (body: string) =>
      `${wf} --fail-open --threads 1-2 --label 'node -e 1' -- sh -c '${body}'`;
    expect(output(run(0)).hookSpecificOutput).toMatchObject({
      permissionDecision: "allow",
      updatedInput: { command: cmd("rtk node -e 1") },
    });
    const three = output(run(3)).hookSpecificOutput;
    expect(three.updatedInput.command).toBe(cmd("rtk node -e 1"));
    expect(three.permissionDecision).toBeUndefined();
    const one = output(run(1)).hookSpecificOutput;
    expect(one.updatedInput.command).toBe(cmd("node -e 1"));
    expect(one.permissionDecision).toBeUndefined();
    expect(run(2)).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  describe("wf-run --fail-open (the gate passes it)", () => {
    const asRoot = process.getuid?.() === 0;
    const wfRun = (pool: string, ...flags: string[]) =>
      spawnSync(
        path.join(plugin, "scripts", "wf-run"),
        [...flags, "--threads", "2-3", "--", "sh", "-c", 'echo "t=$WF_THREADS"; exit 4'],
        { env: cleanEnv({ WF_POOL_DIR: pool }), encoding: "utf8" },
      );
    const readOnly = () => {
      const dir = tmp("wf-gate-ro-");
      fs.chmodSync(dir, 0o555);
      return dir;
    };

    for (const [name, pool] of [
      ["a read-only pool dir", () => readOnly()],
      ["a pool dir that cannot be created", () => path.join(readOnly(), "pool")],
    ] as const)
      it(`${name}: the command runs unleased with its min share, its exit code kept`, () => {
        const dir = pool();
        const r = wfRun(dir, "--fail-open");
        expect(r.status).toBe(4);
        if (asRoot) return; // root writes anyway: the lease is real
        expect(r.stdout).toBe("t=2\n");
        expect(r.stderr).toMatch(/^wf-run: pool unavailable \(.+\) — running without a lease\n$/);
        // Without the flag the pool's failure is the run's: the command never starts.
        const strict = wfRun(dir);
        expect(strict.status).toBe(1);
        expect(strict.stdout).toBe("");
      });
  });
});
