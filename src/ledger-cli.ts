// Ledger lines for sessions ended OUTSIDE the server — hooks/workflow-cleanup.sh
// abandons sessions by editing their JSON directly, then runs:
//   node build/ledger-cli.js <state-dir> <session-id>...
import { Storage } from "./storage.js";
import { ledgerEntry } from "./ledger.js";

export async function appendLedgerFor(stateDir: string, sessionIds: readonly string[]): Promise<number> {
  const storage = new Storage(stateDir);
  let written = 0;
  for (const id of sessionIds) {
    const session = storage.read(id);
    if (!session || session.stack?.length !== 0) continue;
    await storage.appendLedger(ledgerEntry(session));
    written++;
  }
  return written;
}

const [, script, stateDir, ...ids] = process.argv;
if (script?.endsWith("ledger-cli.js") && stateDir) {
  appendLedgerFor(stateDir, ids).catch(err => {
    console.error("ledger-cli:", err);
    process.exit(1);
  });
}
