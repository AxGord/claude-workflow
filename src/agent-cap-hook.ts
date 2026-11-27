#!/usr/bin/env node
// PreToolUse(Agent|Task), SubagentStart and SubagentStop hook entry (`hooks/agent-cap-gate.sh` →
// build/agent-cap-hook.js): reads the payload on stdin and prints a `deny` when a spawn would pass the
// project's `agents.max_live`, or nothing. It only decides, never rewrites the call. Any error is one
// stderr line and the call passes.
import fs from "node:fs";
import { handleAgentCap, type AgentCapPayload } from "./agent-cap.js";

function main(): void {
  const payload = JSON.parse(fs.readFileSync(0, "utf8")) as AgentCapPayload;
  const out = handleAgentCap(payload);
  if (!out) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...out } }) + "\n",
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`agent-cap-gate: ${(err as Error).message} — the call passes as is\n`);
}
