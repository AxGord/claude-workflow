#!/usr/bin/env node
// wf-trust: the USER's approval of the exec/fetch states a project's own workflow files declare.
//   wf-trust <project | .claude/workflows | file.yaml>   show every command, ask in the terminal, record the files' hashes
//   wf-trust --list                                      the approved files
//   wf-trust --revoke <hash prefix>                      withdraw one approval
// Approval needs a terminal on stdin and stdout and a typed "yes": an agent's Bash has none, and no
// MCP tool of the engine can approve. A file edited afterwards hashes differently and is asked again.
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
