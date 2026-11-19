import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// An agent's write to the trust record or to the global workflows directory must be a question to
// the user. This runs the PreToolUse hooks exactly as hooks/hooks.json declares them, on the
// payloads Claude Code sends, in a scratch HOME / state dir / workflows dir.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wf-trust-bypass-"));
const STATE = path.join(scratch, "state");
const GLOBAL = path.join(scratch, "home", ".claude", "workflows");
const PROJECT = path.join(scratch, "proj");
for (const d of [STATE, GLOBAL, PROJECT]) fs.mkdirSync(d, { recursive: true });
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const preToolUse = (
  JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8")) as {
    hooks: { PreToolUse: HookEntry[] };
  }
).hooks.PreToolUse;

// A plugin root of its own: the shipped hooks, and the gate's entry bundled where the hook looks for
// it (`build/` is not there in a clean checkout).
const PLUGIN = path.join(scratch, "plugin");
beforeAll(async () => {
  fs.cpSync(path.join(ROOT, "hooks"), path.join(PLUGIN, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(PLUGIN, "package.json"), '{"type":"module"}');
  await build({
    entryPoints: [path.join(ROOT, "src", "trust-write-gate-hook.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    outfile: path.join(PLUGIN, "build", "trust-write-gate-hook.js"),
    logLevel: "silent",
  });
});

/** Every decision the declared PreToolUse hooks of `tool` print for this call, as Claude Code would read them. */
function decisions(tool: string, input: Record<string, unknown>): string[] {
  const payload = {
    hook_event_name: "PreToolUse",
    session_id: "s1",
    cwd: PROJECT,
    tool_name: tool,
    tool_input: input,
  };
  const out: string[] = [];
  for (const entry of preToolUse) {
    if (!new RegExp(`^(?:${entry.matcher ?? ".*"})$`).test(tool)) continue;
    for (const h of entry.hooks) {
      const r = spawnSync("sh", ["-c", h.command], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: PLUGIN,
          HOME: path.join(scratch, "home"),
          STATE_DIR: STATE,
          WORKFLOW_DIR: GLOBAL,
          CLAUDE_CONFIG_DIR: path.join(scratch, "config"),
        },
      });
      const text = r.stdout.trim();
      if (!text) continue;
      const j = JSON.parse(text) as {
        permissionDecision?: string;
        hookSpecificOutput?: { permissionDecision?: string };
      };
      out.push(j.hookSpecificOutput?.permissionDecision ?? j.permissionDecision ?? "none");
    }
  }
  return out;
}

const trustFile = path.join(STATE, "trusted-workflows.json");
const globalFile = path.join(GLOBAL, "evil.yaml");

describe("agent writes to the trust record and the global workflows dir are asked", () => {
  const guarded: Array<[string, string, Record<string, unknown>]> = [
    ["Write to the trust record", "Write", { file_path: trustFile, content: "{}" }],
    [
      "Edit of the trust record",
      "Edit",
      { file_path: trustFile, old_string: "a", new_string: "b" },
    ],
    [
      "NotebookEdit of the trust record",
      "NotebookEdit",
      { notebook_path: trustFile, new_source: "x" },
    ],
    ["Bash redirect onto the trust record", "Bash", { command: `echo '{}' > ${trustFile}` }],
    ["Bash cp onto the trust record", "Bash", { command: `cp /tmp/x ${trustFile}` }],
    ["Bash tee onto the trust record", "Bash", { command: `echo '{}' | tee ${trustFile}` }],
    ["Bash sed -i on the trust record", "Bash", { command: `sed -i '' 's/a/b/' ${trustFile}` }],
    ["Write into the global workflows dir", "Write", { file_path: globalFile, content: "x" }],
    [
      "Edit in the global workflows dir",
      "Edit",
      { file_path: globalFile, old_string: "a", new_string: "b" },
    ],
    ["Bash redirect into the global workflows dir", "Bash", { command: `echo x > ${globalFile}` }],
    ["Bash cp into the global workflows dir", "Bash", { command: `cp /tmp/x ${GLOBAL}/` }],
  ];
  for (const [name, tool, input] of guarded)
    it(`${name} is answered ask`, () => {
      expect(decisions(tool, input)).toContain("ask");
    });

  it("the hook only decides: its answer carries no rewrite of the call", () => {
    const r = spawnSync("sh", [path.join(PLUGIN, "hooks", "trust-write-gate.sh")], {
      input: JSON.stringify({
        tool_name: "Write",
        cwd: PROJECT,
        tool_input: { file_path: trustFile },
      }),
      encoding: "utf8",
      env: { ...process.env, STATE_DIR: STATE, WORKFLOW_DIR: GLOBAL },
    });
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: Record<string, unknown> };
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(String(out.hookSpecificOutput.permissionDecisionReason)).toContain("wf-trust");
    expect(out.hookSpecificOutput).not.toHaveProperty("updatedInput");
  });

  it("a default install (STATE_DIR and WORKFLOW_DIR unset) asks through the shell fast path too", () => {
    const home = path.join(scratch, "default-home");
    fs.mkdirSync(path.join(home, ".claude", "workflow-state"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude", "workflows"), { recursive: true });
    const env = { ...process.env, HOME: home };
    delete env.STATE_DIR;
    delete env.WORKFLOW_DIR;
    const run = (tool: string, input: Record<string, unknown>): string =>
      spawnSync("sh", [path.join(PLUGIN, "hooks", "trust-write-gate.sh")], {
        input: JSON.stringify({ tool_name: tool, cwd: PROJECT, tool_input: input }),
        encoding: "utf8",
        env,
      }).stdout;
    expect(
      run("Write", { file_path: path.join(home, ".claude", "workflows", "x.yaml") }),
    ).toContain('"ask"');
    expect(
      run("Bash", { command: "echo x > ~/.claude/workflow-state/trusted-workflows.json" }),
    ).toContain('"ask"');
    expect(run("Write", { file_path: path.join(PROJECT, "a.txt") })).toBe("");
    expect(run("Bash", { command: "echo x > /tmp/a.txt" })).toBe("");
  });

  it("an unrelated write is not touched", () => {
    expect(
      decisions("Write", { file_path: path.join(PROJECT, "a.txt"), content: "x" }),
    ).not.toContain("ask");
    expect(decisions("Bash", { command: `echo x > ${path.join(PROJECT, "a.txt")}` })).not.toContain(
      "ask",
    );
  });

  it("a read is not touched", () => {
    expect(decisions("Bash", { command: `cat ${trustFile}` })).not.toContain("ask");
    expect(decisions("Bash", { command: `ls ${GLOBAL}` })).not.toContain("ask");
  });
});
