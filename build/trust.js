// Consent for the exec/fetch states a PROJECT's own workflow files declare. A state of those
// types runs a shell command or an HTTP request the moment the session enters it, so a project
// file (a cloned repo's `.claude/workflows`) runs one only in a TRUSTED project: one whose folder
// the user already trusted in Claude Code (its own question, read from its config: see
// claude-trust.ts; after that answer Claude Code runs the project's hooks as shell commands too),
// or one approved with the `wf-trust` CLI, which records the project directory once in
// `<state dir>/trusted-workflows.json` (a terminal prompt; no MCP tool reads or writes it). Strict
// mode (`WF_TRUST_STRICT`) ignores both and needs the sha256 of each file's exact bytes, so an edited
// file asks again. Bundled and global files are not gated.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ClaudeFolderTrust, folderTrustKeys } from "./claude-trust.js";
import { WorkflowFileSchema } from "./types.js";
export const TRUST_FILE = "trusted-workflows.json";
/** The env switch of strict mode: `WF_TRUST_STRICT=1`. */
export const STRICT_ENV = "WF_TRUST_STRICT";
export function strictFromEnv(env = process.env) {
    const v = env[STRICT_ENV];
    return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}
export function hashContent(raw) {
    return createHash("sha256").update(raw).digest("hex");
}
/** Why a tool call may not bring an exec/fetch state: that is a command or request run with no one's approval. */
export function actionStateRefusal(what) {
    return (`${what}: exec/fetch states are not accepted from modify or create (the command would run with ` +
        `nothing the user approved). Write the state in a workflow YAML file under .claude/workflows/ of a project the user trusted (accepted in Claude Code, or \`${wfTrustCommand()} <project>\` run by the USER in a terminal).`);
}
/** The names of the exec/fetch states a workflow file declares itself (not inherited ones). */
export function actionStateNames(states) {
    return Object.entries(states ?? {})
        .filter(([, s]) => s.type === "exec" || s.type === "fetch")
        .map(([name]) => name);
}
/** The plugin (or package) directory this module runs from: `src/` under vitest, `build/` once compiled, one level below it either way. */
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shellWord = (s) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
/** The `wf-trust` command word a user can paste into a terminal: the script's full path, because a plugin install puts no `wf-*` on the user's PATH. */
export function wfTrustCommand() {
    return shellWord(path.join(PLUGIN_DIR, "scripts", "wf-trust"));
}
/** What the user runs to approve a project; one wording for every refusal. */
export function trustHint(projectDir) {
    return `run \`${wfTrustCommand()} ${shellWord(projectDir)}\` in a terminal (it shows the commands and asks; the agent cannot approve for you)`;
}
/** One plain sentence: why `projectDir`'s files are left out and the two ways to fix it. */
export function untrustedReason(projectDir, store) {
    return store.strict
        ? `strict trust mode (${STRICT_ENV}) needs the user's approval of each exact file, and this one is not approved (or changed since): ${trustHint(projectDir)}.`
        : `the project ${projectDir} is not trusted (no Claude Code folder trust is recorded for it): either open the folder in Claude Code and accept its trust question, or ask the USER to ${trustHint(projectDir)}.`;
}
/** The directory a project approval is recorded under: the main checkout for a linked worktree. */
const keyOf = (root) => folderTrustKeys(root)[0] ?? path.resolve(root);
/** The approvals of one state dir, and the rule that turns them (and Claude Code's folder trust) into "this project file may run its exec states". Reads afresh (the file is tiny) so a live server sees an approval at once. */
export class TrustStore {
    _file;
    _opts;
    _all = false;
    /** `file` null: nothing is ever trusted (the secure default of a Loader built without a store). */
    constructor(file, opts = {}) {
        this._file = file;
        this._opts = opts;
    }
    /** For a loader that only DESCRIBES workflows (the site's and the replay's graphs): nothing it loads runs. */
    static describeOnly() {
        const store = new TrustStore(null);
        store._all = true;
        return store;
    }
    /** The production store: the state dir's file, Claude Code's folder trust, strict mode from the env. */
    static inStateDir(stateDir, env = process.env) {
        return new TrustStore(path.join(stateDir, TRUST_FILE), {
            strict: strictFromEnv(env),
            claude: new ClaudeFolderTrust(env),
        });
    }
    get file() {
        return this._file;
    }
    get strict() {
        return this._opts.strict === true;
    }
    /** Changes whenever the approvals file does: the cache key of whoever depends on `has`. */
    stamp() {
        if (!this._file)
            return "none";
        try {
            const st = fs.statSync(this._file);
            return `${st.mtimeMs}:${st.size}`;
        }
        catch {
            return "none";
        }
    }
    /** Changes whenever Claude Code's config does (it rewrites it often, so a cache keyed on it re-checks `allows`, not reloads). */
    claudeStamp() {
        return this._opts.claude?.stamp() ?? "none";
    }
    /** The file with this exact content is approved (a per-file approval, any mode). */
    has(hash) {
        return this._all || hash in this._read().trusted;
    }
    /** The directory `addProject(root)` records: `root` itself, or the main checkout when `root` is a linked worktree. */
    projectKey(root) {
        return keyOf(root);
    }
    /** The project's trust, from `wf-trust` or Claude Code's folder trust; undefined when it has none (strict mode counts neither). */
    projectTrust(root) {
        if (this.strict)
            return undefined;
        const approved = this._read().projects;
        if ([...folderTrustKeys(root), keyOf(root)].some(k => Object.hasOwn(approved, k)))
            return "wf-trust";
        return this._opts.claude?.trusted(root) ? "claude" : undefined;
    }
    /** The project file with this content, in the project at `root`, may run its exec/fetch states. */
    allows(root, hash) {
        return this.has(hash) || this.projectTrust(root) !== undefined;
    }
    list() {
        return Object.entries(this._read().trusted).map(([hash, r]) => ({ hash, ...r }));
    }
    listProjects() {
        return Object.entries(this._read().projects).map(([dir, r]) => ({ dir, ...r }));
    }
    add(hash, file, at = new Date().toISOString()) {
        const doc = this._read();
        this._write({ ...doc, trusted: { ...doc.trusted, [hash]: { file, approved_at: at } } });
    }
    addProject(root, at = new Date().toISOString()) {
        const doc = this._read();
        this._write({ ...doc, projects: { ...doc.projects, [keyOf(root)]: { approved_at: at } } });
    }
    remove(hash) {
        const doc = this._read();
        if (!(hash in doc.trusted))
            return false;
        const rest = Object.fromEntries(Object.entries(doc.trusted).filter(([h]) => h !== hash));
        this._write({ ...doc, trusted: rest });
        return true;
    }
    /** Withdraw the approval recorded for the project directory `dir`; false when it has none. */
    removeProject(dir) {
        const doc = this._read();
        const key = [keyOf(dir), path.resolve(dir)].find(k => Object.hasOwn(doc.projects, k));
        if (key === undefined)
            return false;
        this._write({
            ...doc,
            projects: Object.fromEntries(Object.entries(doc.projects).filter(([k]) => k !== key)),
        });
        return true;
    }
    _read() {
        const empty = { version: 1, trusted: {}, projects: {} };
        if (!this._file)
            return empty;
        try {
            const doc = JSON.parse(fs.readFileSync(this._file, "utf8"));
            const record = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
            return {
                version: 1,
                trusted: record(doc.trusted),
                projects: record(doc.projects),
            };
        }
        catch {
            return empty;
        }
    }
    _write(doc) {
        if (!this._file)
            throw new Error("no trust store file");
        fs.mkdirSync(path.dirname(this._file), { recursive: true });
        const tmp = `${this._file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
        fs.renameSync(tmp, this._file);
    }
}
/** The workflow files under `dir` (a `.claude/workflows` directory) that declare exec/fetch states. */
export function actionFilesIn(dir, store, root) {
    if (!fs.existsSync(dir))
        return [];
    const out = [];
    for (const f of fs.readdirSync(dir).sort()) {
        if (!f.endsWith(".yaml") && !f.endsWith(".yml"))
            continue;
        const file = path.join(dir, f);
        const raw = fs.readFileSync(file);
        let parsed;
        try {
            parsed = WorkflowFileSchema.safeParse(YAML.parse(raw.toString("utf8")));
        }
        catch {
            continue;
        }
        if (!parsed.success)
            continue;
        const states = parsed.data.states ?? {};
        const names = actionStateNames(states);
        if (names.length === 0)
            continue;
        const hash = hashContent(raw);
        out.push({
            file,
            name: parsed.data.name,
            hash,
            trusted: store.allows(root, hash),
            lines: names.flatMap(n => {
                const s = states[n];
                const extra = (label, v) => v === undefined ? [] : [`    ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`];
                return s.type === "exec"
                    ? [
                        `${n} (exec): ${s.command}`,
                        ...extra("fanout items_command", s.fanout?.items_command),
                        ...extra("fanout", s.fanout),
                        ...extra("cwd", s.cwd),
                        ...extra("env", s.env),
                    ]
                    : [
                        `${n} (fetch): ${s.method ?? "GET"} ${s.url}`,
                        ...extra("headers", s.headers),
                        ...extra("body", s.body),
                    ];
            }),
        });
    }
    return out;
}
/** The project a `.claude/workflows` directory belongs to; any other directory is its own project. */
export function projectOfWorkflowsDir(dir) {
    return path.basename(dir) === "workflows" && path.basename(path.dirname(dir)) === ".claude"
        ? path.dirname(path.dirname(dir))
        : dir;
}
/** `<project>` as the user typed it: the project root, its `.claude/workflows`, or one workflow file. */
export function resolveWorkflowsDir(target) {
    const abs = path.resolve(target);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const dir = path.dirname(abs);
        return { dir, root: projectOfWorkflowsDir(dir), only: abs };
    }
    const nested = path.join(abs, ".claude", "workflows");
    const dir = fs.existsSync(nested) ? nested : abs;
    return { dir, root: projectOfWorkflowsDir(dir) };
}
