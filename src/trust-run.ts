// The wf-trust command's logic (src/trust-cli.ts wires it to a terminal): kept apart so a test runs it
// with a scripted terminal.
import { TrustStore, actionFilesIn, resolveWorkflowsDir } from "./trust.js";

const USAGE =
  "usage: wf-trust <project | .claude/workflows | file.yaml> | --list | --revoke <hash prefix>";

export interface TrustIO {
  readonly interactive: boolean;
  out(line: string): void;
  ask(question: string): Promise<string>;
}

export async function runTrust(
  argv: readonly string[],
  store: TrustStore,
  io: TrustIO,
): Promise<number> {
  if (argv[0] === "--list") {
    const rows = store.list();
    io.out(rows.length === 0 ? "nothing approved" : "");
    for (const r of rows) io.out(`${r.hash.slice(0, 12)}  ${r.approved_at}  ${r.file}`);
    return 0;
  }
  if (argv[0] === "--revoke") {
    const prefix = argv[1] ?? "";
    const hit = prefix.length >= 6 ? store.list().filter(r => r.hash.startsWith(prefix)) : [];
    if (hit.length !== 1) {
      io.out(`--revoke needs a prefix (6+ characters) of exactly one approved hash; see --list`);
      return 2;
    }
    store.remove(hit[0].hash);
    io.out(`revoked ${hit[0].file}`);
    return 0;
  }
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    io.out(USAGE);
    return 2;
  }
  const { dir, only } = resolveWorkflowsDir(argv[0]);
  const files = actionFilesIn(dir, store).filter(f => only === undefined || f.file === only);
  const pending = files.filter(f => !f.trusted);
  if (pending.length === 0) {
    io.out(
      files.length === 0
        ? `${dir}: no workflow file with exec/fetch states; nothing to approve`
        : `${dir}: every file with exec/fetch states is already approved`,
    );
    return 0;
  }
  for (const f of pending) {
    io.out(`${f.file}  (${f.hash.slice(0, 12)})`);
    for (const l of f.lines) io.out(`    ${l}`);
  }
  if (!io.interactive) {
    io.out(
      "not approved: approval needs a terminal (stdin and stdout) where you type the answer; run this yourself, not through an agent",
    );
    return 3;
  }
  io.out(
    "These commands and requests run on your machine, as you, whenever a session enters them.",
  );
  const answer = await io.ask(`Approve ${pending.length} file(s)? Type "yes": `);
  if (answer.trim() !== "yes") {
    io.out("not approved");
    return 3;
  }
  for (const f of pending) store.add(f.hash, f.file);
  io.out(`approved ${pending.length} file(s); a running server picks it up on its next read`);
  return 0;
}
