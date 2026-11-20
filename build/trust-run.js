// The wf-trust command's logic (src/trust-cli.ts wires it to a terminal): kept apart so a test runs it
// with a scripted terminal. A project directory is approved once (every file in it, edits included);
// a single file.yaml, or any target in strict mode, is approved by the hash of its exact bytes.
import fs from "node:fs";
import { actionFilesIn, resolveWorkflowsDir } from "./trust.js";
function realpathOrSelf(p) {
    try {
        return fs.realpathSync(p);
    }
    catch {
        return p;
    }
}
const USAGE = "usage: wf-trust <project | .claude/workflows | file.yaml> | --list | --revoke <project dir | hash prefix>";
export async function runTrust(argv, store, io) {
    if (argv[0] === "--list") {
        const projects = store.listProjects();
        const rows = store.list();
        io.out(projects.length + rows.length === 0 ? "nothing approved" : "");
        for (const p of projects)
            io.out(`project  ${p.approved_at}  ${p.dir}`);
        for (const r of rows)
            io.out(`${r.hash.slice(0, 12)}  ${r.approved_at}  ${r.file}`);
        return 0;
    }
    if (argv[0] === "--revoke") {
        const arg = argv[1] ?? "";
        if (arg !== "" && store.removeProject(arg)) {
            io.out(`revoked project ${arg}`);
            return 0;
        }
        const hit = arg.length >= 6 ? store.list().filter(r => r.hash.startsWith(arg)) : [];
        if (hit.length !== 1) {
            io.out(`--revoke needs an approved project directory, or a prefix (6+ characters) of exactly one approved hash; see --list`);
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
    const { dir, root, only } = resolveWorkflowsDir(argv[0]);
    const files = actionFilesIn(dir, store, root).filter(f => only === undefined || f.file === only);
    const pending = files.filter(f => !f.trusted);
    if (pending.length === 0) {
        const source = store.projectTrust(root);
        io.out(files.length === 0
            ? `${dir}: no workflow file with exec/fetch states; nothing to approve`
            : `${dir}: every file with exec/fetch states is already approved` +
                (source === "claude"
                    ? " (the project's folder is trusted in Claude Code)"
                    : source === "wf-trust"
                        ? " (the project is approved)"
                        : ""));
        return 0;
    }
    for (const f of pending) {
        io.out(`${f.file}  (${f.hash.slice(0, 12)})`);
        for (const l of f.lines)
            io.out(`    ${l}`);
    }
    if (!io.interactive) {
        io.out("not approved: approval needs a terminal (stdin and stdout) where you type the answer; run this yourself, not through an agent");
        return 3;
    }
    io.out("These commands and requests run on your machine, as you, whenever a session enters them.");
    const wholeProject = only === undefined && !store.strict;
    const key = store.projectKey(root);
    const named = key === root || key === realpathOrSelf(root)
        ? key
        : `${key} (the main checkout of ${root}; it covers its worktrees)`;
    const answer = await io.ask(wholeProject
        ? `Trust the project ${named} (these files and any edit of them)? Type "yes": `
        : `Approve ${pending.length} file(s)? Type "yes": `);
    if (answer.trim() !== "yes") {
        io.out("not approved");
        return 3;
    }
    if (wholeProject) {
        store.addProject(root);
        io.out(`trusted the project ${named}; a running server picks it up on its next read`);
        return 0;
    }
    for (const f of pending)
        store.add(f.hash, f.file);
    io.out(`approved ${pending.length} file(s); a running server picks it up on its next read`);
    return 0;
}
