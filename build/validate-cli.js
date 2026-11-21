#!/usr/bin/env node
// wf-validate: does a project's workflow files still load? A check for a pre-commit or gate step of a
// project that tracks `.claude/workflows`, outside any session: it builds the SAME Loader the server
// builds (bundled templates, the global directory, the directory under test as the project tier) and
// reports what that loader says; there is no second validator. It only reads: no state directory, no
// session, no server, and no trust question (nothing it loads runs, so exec/fetch files are checked too).
//   wf-validate [<file.yaml | dir>...]   default: .claude/workflows of the cwd
// One line per file: `ok <name>`, or `fail <file>: <the loader's reason>`; `warn <name>: ...` lines for
// what the server only warns about at start (a sub_workflow or skill that is not there, a station
// without a prompt) never change the exit status. A directory that does not exist is a note, not a failure.
// Exit: 0 every file loads (or nothing to check) · 1 a file does not load · 2 usage.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Loader } from "./loader.js";
import { POOL_GATE_FILE } from "./pool-gate.js";
import { stationWarnings } from "./stations.js";
import { TrustStore } from "./trust.js";
import { workflowDirs } from "./workflow-dirs.js";
export const VALIDATE_USAGE = "usage: wf-validate [<file.yaml | dir>...]  (default: .claude/workflows)";
const YAML_FILE = /\.ya?ml$/;
function real(p) {
    try {
        return fs.realpathSync(p);
    }
    catch {
        return p;
    }
}
/** `build()` with the loader's own stderr chatter held back: its reasons are reported as lines, once. */
function quiet(build) {
    const original = console.error;
    console.error = () => undefined;
    try {
        return build();
    }
    finally {
        console.error = original;
    }
}
/** The loader's verdict on the yaml files of `dir` (only `only`, when given), one line each. */
function validateDir(dir, only, env, cwd) {
    const dirs = workflowDirs(env, cwd);
    const scratch = [];
    try {
        let global = dirs.global;
        // A missing global directory is not created for a read (the loader would); the directory under
        // test is its own tier, not also the global one.
        if (!fs.existsSync(global) || real(global) === real(dir)) {
            global = fs.mkdtempSync(path.join(os.tmpdir(), "wf-validate-"));
            scratch.push(global);
        }
        const loader = quiet(() => new Loader(dirs.bundled, global, dir, TrustStore.describeOnly()));
        const broken = new Map(loader.broken().map(b => [b.file, b.reason]));
        const loaded = new Map(loader.projectFiles().map(f => [f.file, f.name]));
        const lines = [];
        const names = [];
        let ok = true;
        const files = fs
            .readdirSync(dir)
            .filter(f => YAML_FILE.test(f) && f !== POOL_GATE_FILE)
            .map(f => path.join(dir, f))
            .filter(f => only === undefined || f === only)
            .sort();
        for (const file of files) {
            const reason = broken.get(file);
            const name = loaded.get(file);
            if (reason !== undefined) {
                ok = false;
                lines.push(`fail ${file}: ${reason}`);
            }
            else if (name === undefined) {
                ok = false;
                lines.push(`fail ${file}: not loaded (another file of this directory declares the same name and replaced it)`);
            }
            else {
                names.push(name);
                lines.push(`ok ${name}`);
            }
        }
        if (files.length === 0)
            lines.push(`note: no workflow files in ${dir}`);
        for (const name of names) {
            const def = loader.get(name);
            for (const w of def ? stationWarnings(def) : [])
                lines.push(`warn ${name}: ${w}`);
        }
        for (const w of [...loader.validateReferences(), ...loader.validateSkillReferences()])
            if (names.some(n => w.startsWith(`${n}/`)))
                lines.push(`warn ${w}`);
        return { lines, ok };
    }
    finally {
        for (const d of scratch)
            fs.rmSync(d, { recursive: true, force: true });
    }
}
/** What `wf-validate <args>` prints and exits with, run from `cwd`. */
export function runValidate(args, env = process.env, cwd = process.cwd()) {
    if (args.includes("-h") || args.includes("--help"))
        return { lines: [VALIDATE_USAGE], code: 0 };
    const flag = args.find(a => a.startsWith("-"));
    if (flag !== undefined)
        return { lines: [`unknown argument ${flag}`, VALIDATE_USAGE], code: 2 };
    const targets = args.length > 0 ? args : [path.join(".claude", "workflows")];
    const lines = [];
    let ok = true;
    for (const arg of targets) {
        const target = path.resolve(cwd, arg);
        const stat = fs.statSync(target, { throwIfNoEntry: false });
        if (stat === undefined) {
            if (YAML_FILE.test(target)) {
                ok = false;
                lines.push(`fail ${target}: no such file`);
            }
            else
                lines.push(`note: ${target} does not exist, nothing to validate`);
            continue;
        }
        if (!stat.isDirectory() && !YAML_FILE.test(target)) {
            ok = false;
            lines.push(`fail ${target}: not a workflow file (.yaml or .yml) or a directory`);
            continue;
        }
        try {
            const r = stat.isDirectory()
                ? validateDir(target, undefined, env, cwd)
                : validateDir(path.dirname(target), target, env, cwd);
            lines.push(...r.lines);
            ok &&= r.ok;
        }
        catch (err) {
            ok = false;
            lines.push(`fail ${target}: ${err.message}`);
        }
    }
    return { lines, code: ok ? 0 : 1 };
}
if (process.argv[1] !== undefined &&
    fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const r = runValidate(process.argv.slice(2));
    (r.code === 2 ? process.stderr : process.stdout).write(`${r.lines.join("\n")}\n`);
    process.exitCode = r.code;
}
