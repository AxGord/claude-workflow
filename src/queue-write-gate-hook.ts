#!/usr/bin/env node
// PreToolUse(Bash|Write|Edit|MultiEdit) hook entry (`hooks/queue-write-gate.sh` →
// build/queue-write-gate-hook.js): reads the payload on stdin, prints a `deny` for a write to a
// queue file, or nothing. It only decides, never rewrites the
// call. Any error is one stderr line and the call passes.
import fs from "node:fs";
import { decideQueueWrite, type QueueWritePayload } from "./queue-write-gate.js";

function main(): void {
  const payload = JSON.parse(fs.readFileSync(0, "utf8")) as QueueWritePayload;
  const out = decideQueueWrite(payload);
  if (!out) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...out } }) + "\n",
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`queue-write-gate: ${(err as Error).message} — the call passes as is\n`);
}
