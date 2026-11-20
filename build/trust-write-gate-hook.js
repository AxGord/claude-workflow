#!/usr/bin/env node
// PreToolUse(Bash|Write|Edit|MultiEdit|NotebookEdit) hook entry (`hooks/trust-write-gate.sh` →
// build/trust-write-gate-hook.js): reads the payload on stdin, prints an `ask` for a write to the
// trust record or the global workflows directory, or nothing. It only decides, never rewrites the
// call. Any error is one stderr line and the call passes.
import fs from "node:fs";
import { decideTrustWrite } from "./trust-write-gate.js";
function main() {
    const payload = JSON.parse(fs.readFileSync(0, "utf8"));
    const out = decideTrustWrite(payload);
    if (!out)
        return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...out } }) + "\n");
}
try {
    main();
}
catch (err) {
    process.stderr.write(`trust-write-gate: ${err.message} — the call passes as is\n`);
}
