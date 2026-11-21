// Claude Code's own answer to its folder-trust question, read (never written) so the engine does not
// ask the user the same thing again. Claude Code keeps it in its user config, `<CLAUDE_CONFIG_DIR or
// home>/.claude.json`, as `projects[<absolute dir>].hasTrustDialogAccepted === true`. That file is an
// internal record of Claude Code, not a documented interface: every read or parse failure, a missing
// entry and a missing or renamed flag all mean "not trusted", and the caller's fallback (`wf-trust`)
// takes over. How Claude Code keys it (read from its 2.1 code): a trusted directory covers its
// children, bounded by the git root of the repository holding them; a linked worktree is the main
// checkout's entry only; the home directory's answer holds for one session and is never recorded;
// CLAUDE_CODE_IGNORE_PERSISTED_TRUST makes no record count.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const TRUST_FLAG = "hasTrustDialogAccepted";
const IGNORE_ENV = "CLAUDE_CODE_IGNORE_PERSISTED_TRUST";
function canonical(p) {
    try {
        return fs.realpathSync(p);
    }
    catch {
        return path.resolve(p);
    }
}
function isWithin(dir, root) {
    return dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
/** A file's first line, trimmed; throws when it cannot be read. */
function firstLine(file) {
    return fs.readFileSync(file, "utf8").split("\n")[0].trim();
}
/**
 * The main checkout a linked worktree's `.git` file points to, only when the pointer is mutual:
 * `<gitdir>/commondir` resolves to the main `.git`, the gitdir is a direct child of
 * `<common>/worktrees`, and `<gitdir>/gitdir` points back at this worktree's `.git`. A forged
 * pointer (a cloned repo naming a trusted project's `.git`), or any read error, gives undefined.
 */
function linkedMainOf(worktree, dotGit) {
    try {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
        if (!m)
            return undefined;
        const gitdir = canonical(path.resolve(worktree, m[1].trim()));
        const common = canonical(path.resolve(gitdir, firstLine(path.join(gitdir, "commondir"))));
        if (path.dirname(gitdir) !== path.join(common, "worktrees"))
            return undefined;
        // the back-pointer's last component is not resolved: a symlinked `.git` must not pass for the worktree's own
        const back = path.resolve(gitdir, firstLine(path.join(gitdir, "gitdir")));
        if (path.join(canonical(path.dirname(back)), path.basename(back)) !==
            path.join(canonical(worktree), ".git"))
            return undefined;
        return path.basename(common) === ".git" ? path.dirname(common) : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * The git root `dir` is trusted through: the nearest directory holding `.git`; a linked worktree
 * with a valid pointer maps to its main checkout, one whose pointer fails is its own root.
 * Undefined when no repository holds `dir`.
 */
function trustRootOf(dir) {
    for (let d = dir;; d = path.dirname(d)) {
        const dotGit = path.join(d, ".git");
        let stat;
        try {
            stat = fs.statSync(dotGit);
        }
        catch {
            /* not here */
        }
        if (stat?.isDirectory())
            return d;
        if (stat?.isFile())
            return linkedMainOf(d, dotGit) ?? d;
        if (path.dirname(d) === d)
            return undefined;
    }
}
/**
 * The `projects` keys of Claude Code's config that decide a session in `dir`, nearest first: the
 * directory and its ancestors up to the git root (no repository: up to the filesystem root), never
 * the home directory or above; a linked worktree whose pointer is mutual (see `linkedMainOf`) has the main checkout's key alone.
 */
export function folderTrustKeys(dir, home = os.homedir()) {
    const homes = new Set([path.resolve(home), canonical(home)]);
    const keys = new Set();
    for (const start of new Set([canonical(dir), path.resolve(dir)])) {
        const git = trustRootOf(start);
        if (git !== undefined && !isWithin(start, git)) {
            keys.add(git);
            continue;
        }
        for (let d = start; !homes.has(d) && path.dirname(d) !== d; d = path.dirname(d)) {
            keys.add(d);
            if (d === git)
                break;
        }
    }
    return [...keys];
}
export class ClaudeFolderTrust {
    _env;
    _home;
    constructor(env = process.env, home = os.homedir()) {
        this._env = env;
        this._home = home;
    }
    /** Claude Code's user config file. */
    get file() {
        return path.join(this._env.CLAUDE_CONFIG_DIR || this._home, ".claude.json");
    }
    /** Changes whenever the config file does: the cache key of whoever depends on `trusted`. */
    stamp() {
        try {
            const st = fs.statSync(this.file);
            return `${st.mtimeMs}:${st.size}`;
        }
        catch {
            return "none";
        }
    }
    /** True only when Claude Code's config records the folder-trust answer "yes" for `dir` or an ancestor that covers it. */
    trusted(dir) {
        const ignore = this._env[IGNORE_ENV];
        if (ignore && ignore !== "0" && ignore.toLowerCase() !== "false")
            return false;
        let projects;
        try {
            projects = JSON.parse(fs.readFileSync(this.file, "utf8"))
                .projects;
        }
        catch {
            return false;
        }
        if (typeof projects !== "object" || projects === null)
            return false;
        return folderTrustKeys(dir, this._home).some(key => {
            const entry = Object.hasOwn(projects, key)
                ? projects[key]
                : null;
            return (typeof entry === "object" &&
                entry !== null &&
                entry[TRUST_FLAG] === true);
        });
    }
}
