#!/usr/bin/env node
// PreToolUse(Bash) hook entry (`hooks/read-only-gate.sh` → build/read-only-gate-hook.js): reads the
// payload on stdin; a call by a read-only agent type that would write is denied on stdout, else it
// runs unchanged — with the project's read-only env exported, and the rewrite explicitly allowed,
// only when a segment starts with a project reader and every other segment is a harmless default;
// a rewrite that would carry a file-reading default is denied ("run it in its own call"). Any error
// is one stderr line and the call passes.
import fs from "node:fs";
import { poolGateOutput } from "./pool-gate-run.js";
import {
  decideReadOnly,
  findReadOnlyConfig,
  unharmlessSegment,
  type ReadOnlyPayload,
} from "./read-only-gate.js";

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
    // Auto mode refuses a rewritten call that is not allowed, and the allow covers the whole call:
    // a rewrite beside a segment that is not a project reader or a harmless default is denied
    // instead (the env is neither dropped silently nor exported without an allow).
    const cwd = payload.cwd ?? process.cwd();
    const original = String(payload.tool_input?.command);
    const input = { ...payload.tool_input, command: decision.command };
    const pooled = poolGateOutput(decision.command, input, cwd, process.env, l =>
      process.stderr.write(l + "\n"),
    );
    if (!pooled && decision.command === original) return;
    const offender = unharmlessSegment(original, config);
    if (offender !== undefined && pooled?.permissionDecision !== "allow")
      out =
        pooled?.permissionDecision === "deny"
          ? pooled
          : {
              permissionDecision: "deny",
              permissionDecisionReason: `read-only: \`${offender}\` in the same call as a project reader or a heavy command cannot be allowed with the env export; run it in its own call`,
            };
    else
      out = {
        permissionDecision: "allow",
        permissionDecisionReason: "read-only agent: project read-only env exported",
        updatedInput: input,
        ...pooled,
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
