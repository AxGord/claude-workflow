#!/usr/bin/env node
// PreToolUse(Bash) hook entry (`hooks/pool-gate.sh` → build/pool-gate-hook.js): reads the
// hook payload on stdin, prints a rewrite or a refusal on stdout, or nothing. Never fails the
// tool call: any error is one stderr line and the command passes as it is.
import fs from "node:fs";
import { poolGateOutput } from "./pool-gate-run.js";
import { findReadOnlyConfig, isReadOnlyAgent } from "./read-only-gate.js";
function main() {
    const payload = JSON.parse(fs.readFileSync(0, "utf8"));
    const input = payload.tool_input;
    if (payload.tool_name !== "Bash" || typeof input?.command !== "string")
        return;
    const cwd = payload.cwd ?? process.cwd();
    // A read-only agent type's call goes through read-only-gate-hook, which applies this gate itself
    // after exporting the env — two hooks must not each return a rewrite.
    if (payload.agent_type !== undefined) {
        let agents;
        try {
            agents = findReadOnlyConfig(cwd)?.agents;
        }
        catch {
            agents = undefined;
        }
        if (isReadOnlyAgent(payload.agent_type, agents))
            return;
    }
    const out = poolGateOutput(input.command, input, cwd, process.env, l => process.stderr.write(l + "\n"));
    if (!out)
        return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...out } }) + "\n");
}
try {
    main();
}
catch (err) {
    process.stderr.write(`pool-gate: ${err.message} — command passes as is\n`);
}
