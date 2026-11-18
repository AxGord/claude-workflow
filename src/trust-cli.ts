#!/usr/bin/env node
// wf-trust: the USER's fallback approval of a project whose folder Claude Code has no trust record for
// (a folder never opened interactively, as under headless `claude -p`): without one, its own workflow
// files' exec/fetch states do not load. A folder trusted in Claude Code needs none of this.
//   wf-trust <project | .claude/workflows>   show every command, ask in the terminal, trust the project directory
//   wf-trust <file.yaml>                     the same for one file's exact content (its sha256)
//   wf-trust --list                          the approved projects and files
//   wf-trust --revoke <project dir | hash prefix>   withdraw one approval
// Approval needs a terminal on stdin and stdout and a typed "yes": an agent's Bash has none, and no
// MCP tool of the engine can approve. With WF_TRUST_STRICT set, a project target approves per-file
// hashes too, and a file edited afterwards is asked again.
// Exit: 0 done / nothing to approve · 2 usage or error · 3 no terminal, nothing approved.
import readline from "node:readline/promises";
import { TrustStore } from "./trust.js";
import { runTrust, type TrustIO } from "./trust-run.js";
import { stateDir } from "./workflow-dirs.js";

async function main(): Promise<void> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  const io: TrustIO = {
    interactive,
    out: line => console.log(line),
    ask: q => (rl ? rl.question(q) : Promise.resolve("")),
  };
  try {
    process.exitCode = await runTrust(process.argv.slice(2), TrustStore.inStateDir(stateDir()), io);
  } catch (err) {
    console.error(`wf-trust: ${(err as Error).message}`);
    process.exitCode = 2;
  } finally {
    rl?.close();
  }
}

await main();
