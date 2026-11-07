#!/usr/bin/env node
// PreToolUse(Bash) hook entry (`hooks/read-only-gate.sh` → build/read-only-gate-hook.js): reads the
// payload on stdin; a call by a read-only agent type that would write is denied on stdout, else it
// runs with the project's read-only env exported. Any error is one stderr line and the call passes.
import fs from "node:fs";
import { poolGateOutput } from "./pool-gate-run.js";
import { decideReadOnly, findReadOnlyConfig, type ReadOnlyPayload } from "./read-only-gate.js";

interface Payload extends ReadOnlyPayload {
  readonly cwd?: string;
  readonly tool_input?: { readonly command?: unknown } & Record<string, unknown>;
}

function main(): void {
  const payload = JSON.parse(fs.readFileSync(0, "utf8")) as Payload;
  let config;
  try {
    config = findReadOnlyConfig(payload.cwd ?? process.cwd());
  } catch (err) {
    process.stderr.write(`read-only-gate: config ignored — ${(err as Error).message}\n`);
  }
  const decision = decideReadOnly(payload, config);
  if (decision.kind === "pass") return;
  let out;
  if (decision.kind === "deny") {
    out = { permissionDecision: "deny", permissionDecisionReason: decision.reason };
  } else {
    // This hook owns the one rewrite of a read-only agent's call: the pool gate runs on the
    // env-prefixed command, so a wrapped heavy command still carries the exported variables.
    const cwd = payload.cwd ?? process.cwd();
    const input = { ...payload.tool_input, command: decision.command };
    const pooled = poolGateOutput(decision.command, input, cwd, process.env, l =>
      process.stderr.write(l + "\n"),
    );
    if (!pooled && decision.command === payload.tool_input?.command) return;
    out = pooled ?? {
      permissionDecisionReason: "read-only agent: project read-only env exported",
      updatedInput: input,
    };
  }
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...out } }) + "\n",
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`read-only-gate: ${(err as Error).message} — command passes as is\n`);
}
