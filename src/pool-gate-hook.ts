#!/usr/bin/env node
// PreToolUse(Bash) hook entry (`hooks/pool-gate.sh` → build/pool-gate-hook.js): reads the
// hook payload on stdin, prints a rewrite or a refusal on stdout, or nothing. Never fails the
// tool call: any error is one stderr line and the command passes as it is.
import fs from "node:fs";
import path from "node:path";
import { decide, findConfig, rtkRewriter, toolShell } from "./pool-gate.js";

interface Payload {
  readonly tool_name?: string;
  readonly tool_input?: { readonly command?: unknown } & Record<string, unknown>;
  readonly cwd?: string;
}

function main(): void {
  const payload = JSON.parse(fs.readFileSync(0, "utf8")) as Payload;
  const input = payload.tool_input;
  if (payload.tool_name !== "Bash" || typeof input?.command !== "string") return;
  const cwd = payload.cwd ?? process.cwd();
  let found;
  try {
    found = findConfig(cwd);
  } catch (err) {
    process.stderr.write(`pool-gate: config ignored — ${(err as Error).message}\n`);
    return;
  }
  // build/pool-gate-hook.js → the plugin root.
  const root = path.resolve(path.dirname(fs.realpathSync(process.argv[1])), "..");
  const decision = decide(input.command, found?.config, {
    wfRun: path.join(root, "scripts", "wf-run"),
    shell: toolShell(process.env),
    env: process.env,
    // Claude Code keeps one PreToolUse rewrite of a command — this one — so RTK's goes inside.
    rewrite: rtkRewriter(cwd, process.env),
  });
  if (decision.kind === "pass") {
    if (decision.note) process.stderr.write(decision.note + "\n");
    return;
  }
  const out =
    decision.kind === "deny"
      ? { permissionDecision: "deny", permissionDecisionReason: decision.reason }
      : {
          ...(decision.allow ? { permissionDecision: "allow" } : {}),
          permissionDecisionReason: decision.allow
            ? "pool-gate: heavy command runs under wf-run; rtk: allow rules cover every command"
            : "pool-gate: heavy command runs under wf-run",
          updatedInput: { ...input, command: decision.command },
        };
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...out } }) + "\n",
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`pool-gate: ${(err as Error).message} — command passes as is\n`);
}
