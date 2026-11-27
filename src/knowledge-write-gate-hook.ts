#!/usr/bin/env node
// PreToolUse(Bash|Write|Edit|MultiEdit) hook entry (`hooks/knowledge-write-gate.sh` →
// build/knowledge-write-gate-hook.js): reads the payload on stdin, prints a `deny` / `ask` for the
// creation of a memory file with no `why-memory:` line in a project that set `memory_write_gate`, or
// nothing. It only decides, never rewrites the call. Any error is one stderr line and the call passes.
import fs from "node:fs";
import { decideKnowledgeWrite, type KnowledgeWritePayload } from "./knowledge-write-gate.js";

function main(): void {
  const payload = JSON.parse(fs.readFileSync(0, "utf8")) as KnowledgeWritePayload;
  const out = decideKnowledgeWrite(payload);
  if (!out) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...out } }) + "\n",
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`knowledge-write-gate: ${(err as Error).message} — the call passes as is\n`);
}
