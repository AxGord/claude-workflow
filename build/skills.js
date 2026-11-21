// The bundled skills on a user's machine: what the SessionStart hook copies into ~/.claude/skills, what it
// records about each copy (the manifest in the engine's state dir) and what it may do with a copy later.
//
// A copy is `unedited` when its files equal what an engine release shipped: the manifest's record of what
// was copied, the version this release ships, or any version the repo ever shipped (`templates/skills-history.txt`,
// built at release time, so an install from before the manifest is adopted without reading git). An unedited
// copy is replaced when the release ships something else; an edited one is never touched, only named once.
// A skill the user deleted stays deleted (recorded). The release ships two sets: the DEFAULT set
// (`templates/skills`, copied on every start) and the STACK pack (`templates/skills-stack`, language, domain and
// tool skills), which the start hook never copies: `wf-skills add <name>` installs one, and from then on it is
// recorded, updated and removed like a default skill. A skill named `learned-<name>` is the user's own: lessons
// kept beside the bundled skill `<name>`, never shipped, recorded, updated or removed (`splitSkill` moves the
// additions of an edited copy there). Only node built-ins here: the hook runs this on every session start.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/** Under its own subdirectory: a `*.json` directly in the state dir is a session to `Storage.list()`. */
export const MANIFEST_FILE = path.join("skills", "manifest.json");
const IGNORED_FILES = new Set([".DS_Store"]);
/** The personal sibling of a bundled skill: `learned-<name>`, written by reflection or by `splitSkill`, invisible to the manifest. */
export const LEARNED_PREFIX = "learned-";
export const isLearned = (name) => name.startsWith(LEARNED_PREFIX);
/** A staging directory in the skills dir: a dot name, swept at the start of every sync. */
const SCRATCH = ".wf-";
/** Where each set lives under `<root>/templates`. */
const DEFAULT_SET = "skills";
const STACK_SET = "skills-stack";
/** Beside the manifest: a link to the plugin's `scripts/wf-skills`, refreshed at every start, so an agent has a stable path to the command. */
export const CLI_LINK = path.join("skills", "wf-skills");
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
/** Every regular file under `dir` (a Finder `.DS_Store` aside), by relative path. */
export function hashTree(dir) {
    const out = {};
    const walk = (rel) => {
        const names = fs.readdirSync(path.join(dir, rel)).sort();
        for (const name of names) {
            if (IGNORED_FILES.has(name))
                continue;
            const r = rel ? `${rel}/${name}` : name;
            try {
                const st = fs.statSync(path.join(dir, r));
                if (st.isDirectory())
                    walk(r);
                else if (st.isFile())
                    out[r] = sha256(fs.readFileSync(path.join(dir, r)));
            }
            catch {
                // a broken link or a file gone while reading: not part of the skill
            }
        }
    };
    walk("");
    return out;
}
/** One digest for a whole skill: its file set and every file's content. */
export function treeDigest(files) {
    const lines = Object.keys(files)
        .sort()
        .map(rel => `${rel}\0${files[rel]}\n`);
    return sha256(lines.join(""));
}
function shippedSet(root, set) {
    const dir = path.join(root, "templates", set);
    const out = new Map();
    if (!fs.existsSync(dir))
        return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory() && !isLearned(ent.name))
            out.set(ent.name, hashTree(path.join(dir, ent.name)));
    }
    return out;
}
/** The skills this release ships, by name: the default set and the stack pack. */
export function shippedSkills(root) {
    return new Map([...shippedSet(root, DEFAULT_SET), ...shippedSet(root, STACK_SET)]);
}
/** The names of the stack pack: shipped, never copied by the start hook. */
export function stackSkillNames(root) {
    return new Set(shippedSet(root, STACK_SET).keys());
}
/** The directory a shipped skill is copied from. */
export function sourceDir(root, name) {
    const stack = path.join(root, "templates", STACK_SET, name);
    return fs.existsSync(stack) ? stack : path.join(root, "templates", DEFAULT_SET, name);
}
/** Every `<digest> <name>` line of the history file: the versions of each skill the repo ever shipped. */
export function loadHistory(root) {
    const out = new Map();
    let text;
    try {
        text = fs.readFileSync(path.join(root, "templates", "skills-history.txt"), "utf8");
    }
    catch {
        return out;
    }
    for (const line of text.split("\n")) {
        const m = /^([0-9a-f]{64}) (\S+)$/.exec(line);
        if (!m)
            continue;
        const set = out.get(m[2]) ?? new Set();
        set.add(m[1]);
        out.set(m[2], set);
    }
    return out;
}
export function engineVersion(root) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        return pkg.version ?? "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
/** `a` newer than `b` by numeric dotted parts. */
export function versionNewer(a, b) {
    const pa = a.split(".").map(n => Number.parseInt(n, 10) || 0);
    const pb = b.split(".").map(n => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0)
            return d > 0;
    }
    return false;
}
export function skillsDir(env = process.env) {
    if (env.CLAUDE_SKILLS_DIR)
        return path.resolve(env.CLAUDE_SKILLS_DIR);
    return path.join(env.HOME || os.homedir(), ".claude", "skills");
}
/** The manifest, or null when there is none (or it is unreadable: then every copy is adopted afresh). */
export function readManifest(stateDir) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(stateDir, MANIFEST_FILE), "utf8"));
        if (raw.version !== 1 || typeof raw.skills !== "object" || raw.skills === null)
            return null;
        return {
            version: 1,
            skills: raw.skills,
            deleted: Array.isArray(raw.deleted) ? raw.deleted : [],
            noticed: raw.noticed ?? {},
        };
    }
    catch {
        return null;
    }
}
export function writeManifest(stateDir, manifest) {
    const file = path.join(stateDir, MANIFEST_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(tmp, file);
}
/** What sits at `p`: nothing, a real directory, or anything else (a link, a stray file) — which is the user's. */
function kindOf(p) {
    try {
        return fs.lstatSync(p).isDirectory() ? "dir" : "other";
    }
    catch {
        return "none";
    }
}
/**
 * What is there for every skill the release ships or the manifest knows. `manifest` null = none yet: copies
 * are adopted by the history table. A stack skill that is not installed is only `available` (or `deleted`).
 */
export function planSkills(ctx, manifest) {
    const shipped = shippedSkills(ctx.root);
    const stack = stackSkillNames(ctx.root);
    const history = loadHistory(ctx.root);
    const entries = manifest?.skills ?? {};
    const deleted = new Set(manifest?.deleted ?? []);
    const names = [...new Set([...shipped.keys(), ...Object.keys(entries)])]
        .filter(n => !isLearned(n))
        .sort();
    const dir = (name) => path.join(ctx.skillsDir, name);
    const present = (name) => kindOf(dir(name)) !== "none";
    return names.map((name) => {
        const ship = shipped.get(name);
        const entry = entries[name];
        const row = (state, action, installed, differs = false) => ({
            name,
            shipped: ship !== undefined,
            pack: stack.has(name),
            installed,
            state,
            action,
            differs,
        });
        if (present(name)) {
            if (kindOf(dir(name)) === "other")
                return row("edited", "none", true);
            const have = treeDigest(hashTree(dir(name)));
            const shipDigest = ship ? treeDigest(ship) : undefined;
            const known = have === shipDigest ||
                (entry !== undefined && have === treeDigest(entry.files)) ||
                history.get(name)?.has(have) === true;
            if (!known)
                return row("edited", "none", true, shipDigest !== undefined);
            if (!ship)
                return row("retired", "none", true);
            if (have === shipDigest) {
                const recorded = entry !== undefined && treeDigest(entry.files) === have;
                return row("current", recorded && !deleted.has(name) ? "none" : "adopt", true);
            }
            // Only a copy this release knows it supersedes is replaced: one the history table lists, or one an
            // OLDER engine version recorded. A copy another plugin root with this or a newer version put there
            // (the cache and the marketplace directory both hold a copy of the plugin) is never taken back.
            const supersedes = history.get(name)?.has(have) === true ||
                (entry !== undefined &&
                    treeDigest(entry.files) === have &&
                    versionNewer(ctx.version, entry.engine));
            return row("outdated", supersedes ? "update" : "none", true);
        }
        if (!ship)
            return row("missing", "forget", false);
        if (deleted.has(name))
            return row("deleted", "none", false);
        if (entry)
            return row("deleted", "record-deleted", false);
        return stack.has(name) ? row("available", "none", false) : row("missing", "install", false);
    });
}
/** Copy `files` of `src` to `<skillsDir>/<name>` whole: staged beside it, then swapped in. */
function install(ctx, name, files) {
    const src = sourceDir(ctx.root, name);
    const dst = path.join(ctx.skillsDir, name);
    const stage = path.join(ctx.skillsDir, `${SCRATCH}new.${name}.${process.pid}`);
    const old = path.join(ctx.skillsDir, `${SCRATCH}old.${name}.${process.pid}`);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    for (const rel of Object.keys(files)) {
        fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
        fs.copyFileSync(path.join(src, rel), path.join(stage, rel));
    }
    if (fs.existsSync(dst))
        fs.renameSync(dst, old);
    fs.renameSync(stage, dst);
    fs.rmSync(old, { recursive: true, force: true });
}
/**
 * `install` swaps in two renames; a crash between them leaves `<name>` absent and the old copy under
 * `.wf-old.<name>.<pid>`. Put it back before anything is planned, or the next sync takes the gap for a deletion.
 */
function restoreInterrupted(skills) {
    if (!fs.existsSync(skills))
        return;
    for (const entry of fs.readdirSync(skills)) {
        const m = /^\.wf-old\.(.+)\.\d+$/.exec(entry);
        if (m && kindOf(path.join(skills, m[1])) === "none") {
            fs.renameSync(path.join(skills, entry), path.join(skills, m[1]));
        }
    }
}
/** The staging entries a sweep would remove: an `.wf-old.<name>.<pid>` whose `<name>` is gone is restored first, so it stays. */
function scratchEntries(skills) {
    if (!fs.existsSync(skills))
        return [];
    return fs.readdirSync(skills).filter(entry => {
        if (!entry.startsWith(SCRATCH))
            return false;
        const m = /^\.wf-old\.(.+)\.\d+$/.exec(entry);
        return !(m && kindOf(path.join(skills, m[1])) === "none");
    });
}
function sweepScratch(skills) {
    for (const name of scratchEntries(skills)) {
        fs.rmSync(path.join(skills, name), { recursive: true, force: true });
    }
}
/**
 * `<stateDir>/skills.lock`: one syncing process at a time; a lock older than a minute is a crash's. Held by
 * another process: waits up to ten seconds when `wait`, else gives up (null). A lock that cannot be created for
 * any other reason (an unwritable or full state dir) is null for the hook's sync and an error for `update`/`remove`.
 */
export function withSkillsLock(stateDir, wait, fn) {
    const lock = path.join(stateDir, "skills.lock");
    const sleep = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0;; attempt++) {
        try {
            fs.mkdirSync(stateDir, { recursive: true });
            fs.mkdirSync(lock);
            break;
        }
        catch (err) {
            if (err.code !== "EEXIST") {
                if (wait)
                    throw err;
                return null; // the hook's sync: nothing to do here, and it must never fail the start
            }
            if (attempt >= 100)
                return null;
            let age = 0;
            try {
                age = Date.now() - fs.statSync(lock).mtimeMs;
            }
            catch {
                continue; // released between the mkdir and the stat: try again at once
            }
            if (age > 60_000) {
                fs.rmSync(lock, { recursive: true, force: true });
                continue;
            }
            if (!wait)
                return null;
            Atomics.wait(sleep, 0, 0, 100);
        }
    }
    try {
        return fn();
    }
    finally {
        fs.rmSync(lock, { recursive: true, force: true });
    }
}
/** What the hook runs on every start: install the missing, update the unedited, adopt, record deletions, name edits once. */
export function syncSkills(ctx) {
    return withSkillsLock(ctx.stateDir, false, () => {
        fs.mkdirSync(ctx.skillsDir, { recursive: true });
        restoreInterrupted(ctx.skillsDir);
        sweepScratch(ctx.skillsDir);
        const had = readManifest(ctx.stateDir);
        const rows = planSkills(ctx, had);
        const shipped = shippedSkills(ctx.root);
        const skills = { ...(had?.skills ?? {}) };
        const deleted = new Set(had?.deleted ?? []);
        const noticed = { ...(had?.noticed ?? {}) };
        const out = {
            installed: [],
            updated: [],
            adopted: [],
            edited: [],
            deleted: [],
            named: [],
            errors: [],
        };
        for (const r of rows) {
            const files = shipped.get(r.name);
            try {
                if (r.action === "install" || r.action === "update") {
                    if (!files)
                        continue;
                    install(ctx, r.name, files);
                    skills[r.name] = { engine: ctx.version, files };
                    deleted.delete(r.name);
                    (r.action === "install" ? out.installed : out.updated).push(r.name);
                }
                else if (r.action === "adopt" && files) {
                    skills[r.name] = { engine: ctx.version, files };
                    deleted.delete(r.name);
                    if (had === null)
                        out.adopted.push(r.name);
                }
                else if (r.action === "record-deleted") {
                    delete skills[r.name];
                    deleted.add(r.name);
                    out.deleted.push(r.name);
                }
                else if (r.action === "forget") {
                    delete skills[r.name];
                }
            }
            catch (err) {
                out.errors.push(`${r.name}: ${err.message}`);
            }
            if (r.state === "edited" && r.differs && files) {
                out.edited.push(r.name);
                const digest = treeDigest(files);
                if (noticed[r.name] !== digest) {
                    noticed[r.name] = digest;
                    out.named.push(r.name);
                }
            }
            else {
                delete noticed[r.name];
            }
        }
        writeManifest(ctx.stateDir, { version: 1, skills, deleted: [...deleted].sort(), noticed });
        refreshCliLink(ctx);
        return out;
    });
}
/** `<stateDir>/skills/wf-skills` → this root's `scripts/wf-skills`; a failure is not the start's to report. */
function refreshCliLink(ctx) {
    const link = path.join(ctx.stateDir, CLI_LINK);
    const target = path.join(ctx.root, "scripts", "wf-skills");
    try {
        if (fs.readlinkSync(link) === target)
            return;
    }
    catch {
        // no link yet, or something else in its place: replaced below
    }
    try {
        fs.rmSync(link, { force: true });
        fs.symlinkSync(target, link);
    }
    catch {
        // the command is also reachable by its plugin path
    }
}
/** The one-line note the hook prints for edited copies named for the first time. */
export function editedNote(named, cmd) {
    if (named.length === 0)
        return "";
    const first = named[0];
    return (`Workflow plugin: ${named.length} bundled skill(s) carry your edits and differ from the version this release ships, ` +
        `so they were left as they are: ${named.join(", ")}. ` +
        `Show the difference: ${cmd} diff ${first}; if you only ADDED text, ${cmd} split ${first} moves it to learned-${first} and restores the shipped text; ` +
        `take the shipped version (your copy is saved first): ${cmd} update ${first}.`);
}
/** Force `name` to the shipped version; an edited copy is moved to `<stateDir>/skill-backups` first. Returns that backup, if any. */
export function updateSkill(ctx, name) {
    const shipped = shippedSkills(ctx.root).get(name);
    if (!shipped)
        throw new Error(`no bundled skill named ${name}`);
    const result = withSkillsLock(ctx.stateDir, true, () => {
        if (fs.existsSync(ctx.skillsDir))
            restoreInterrupted(ctx.skillsDir);
        return { backup: installShipped(ctx, name, shipped) };
    });
    if (result === null)
        throw new Error("another process is syncing the skills; try again");
    return result.backup;
}
/** The body of `updateSkill`, run under the skills lock: the shipped version replaces the copy, an edited one saved first. */
function installShipped(ctx, name, shipped) {
    const had = readManifest(ctx.stateDir);
    const row = planSkills(ctx, had).find(r => r.name === name);
    let backup = null;
    const dst = path.join(ctx.skillsDir, name);
    if (row?.installed && row.state === "edited") {
        backup = path.join(ctx.stateDir, "skill-backups", `${name}.${Date.now()}.${process.pid}`);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.cpSync(dst, backup, { recursive: true, dereference: true });
        fs.rmSync(dst, { recursive: true, force: true });
    }
    fs.mkdirSync(ctx.skillsDir, { recursive: true });
    install(ctx, name, shipped);
    const skills = { ...(had?.skills ?? {}), [name]: { engine: ctx.version, files: shipped } };
    const noticed = { ...(had?.noticed ?? {}) };
    delete noticed[name];
    writeManifest(ctx.stateDir, {
        version: 1,
        skills,
        deleted: (had?.deleted ?? []).filter(n => n !== name),
        noticed,
    });
    return backup;
}
/**
 * Install shipped skills by name (the way a stack skill gets in), or every stack skill with `allStack`. A
 * skill the user had deleted comes back: asking for it by name is the answer to the deletion.
 */
export function addSkills(ctx, names, allStack = false) {
    const shipped = shippedSkills(ctx.root);
    const wanted = allStack
        ? [...new Set([...stackSkillNames(ctx.root), ...names])].sort()
        : [...new Set(names)];
    for (const name of wanted) {
        if (!shipped.has(name))
            throw new Error(`no bundled skill named ${name} (wf-skills list)`);
    }
    const result = withSkillsLock(ctx.stateDir, true, () => {
        if (fs.existsSync(ctx.skillsDir))
            restoreInterrupted(ctx.skillsDir);
        fs.mkdirSync(ctx.skillsDir, { recursive: true });
        const had = readManifest(ctx.stateDir);
        const rows = planSkills(ctx, had);
        const skills = { ...(had?.skills ?? {}) };
        const deleted = new Set(had?.deleted ?? []);
        const out = { installed: [], present: [] };
        for (const name of wanted) {
            const files = shipped.get(name);
            if (!files)
                continue;
            if (rows.find(r => r.name === name)?.installed) {
                out.present.push(name);
                continue;
            }
            install(ctx, name, files);
            skills[name] = { engine: ctx.version, files };
            deleted.delete(name);
            out.installed.push(name);
        }
        writeManifest(ctx.stateDir, {
            version: 1,
            skills,
            deleted: [...deleted].sort(),
            noticed: had?.noticed ?? {},
        });
        return out;
    });
    if (result === null)
        throw new Error("another process is syncing the skills; try again");
    return result;
}
export function planRemove(ctx) {
    const rows = planSkills(ctx, readManifest(ctx.stateDir));
    return {
        remove: rows
            .filter(r => r.installed && ["current", "outdated", "retired"].includes(r.state))
            .map(r => r.name),
        keep: rows.filter(r => r.installed && r.state === "edited").map(r => r.name),
        scratch: scratchEntries(ctx.skillsDir),
    };
}
/** Remove every unedited engine copy and the manifest; an edited copy and a skill the engine never shipped stay. */
export function removeSkills(ctx) {
    const stateExisted = fs.existsSync(ctx.stateDir);
    const result = withSkillsLock(ctx.stateDir, true, () => {
        if (fs.existsSync(ctx.skillsDir))
            restoreInterrupted(ctx.skillsDir);
        const plan = planRemove(ctx);
        for (const name of plan.remove) {
            fs.rmSync(path.join(ctx.skillsDir, name), { recursive: true, force: true });
        }
        for (const name of plan.scratch) {
            fs.rmSync(path.join(ctx.skillsDir, name), { recursive: true, force: true });
        }
        fs.rmSync(path.dirname(path.join(ctx.stateDir, MANIFEST_FILE)), {
            recursive: true,
            force: true,
        });
        return plan;
    });
    if (result === null)
        throw new Error("another process is syncing the skills; try again");
    if (!stateExisted)
        fs.rmSync(ctx.stateDir, { recursive: true, force: true });
    return result;
}
/** The `learned-*` skills in the skills dir: the user's, listed apart and never touched by a sync, an update or `remove`. */
export function learnedSkills(ctx) {
    if (!fs.existsSync(ctx.skillsDir))
        return [];
    return fs
        .readdirSync(ctx.skillsDir)
        .filter(n => isLearned(n) && kindOf(path.join(ctx.skillsDir, n)) !== "none")
        .sort();
}
/**
 * A new `learned-<name>/SKILL.md`: the description makes Claude Code load it by itself wherever `<name>` applies
 * (a scratch probe on 2.1.327 loaded it by description alone, with and without an explicit `Skill(<name>)`).
 */
export function learnedSkillStub(name) {
    return (`---\nname: ${LEARNED_PREFIX}${name}\n` +
        `description: Your own lessons for the ${name} skill - load them whenever ${name} is loaded or its topic comes up\n---\n\n` +
        `# Learned: ${name}\n\nLessons that belong with the bundled \`${name}\` skill. The engine never ships, updates or removes this file.\n`);
}
/** Largest middle part (after the common head and tail are cut) the line matching below will compare. */
const MAX_LCS_CELLS = 25_000_000;
/** Which lines of `b` are matched to a line of `a` in a longest common subsequence; null when `a` is not a subsequence of `b`. */
function matchedLines(a, b) {
    const kept = new Array(b.length).fill(false);
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head])
        kept[head++] = true;
    let tail = 0;
    while (tail < a.length - head &&
        tail < b.length - head &&
        a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
        kept[b.length - 1 - tail++] = true;
    }
    const am = a.slice(head, a.length - tail);
    const bm = b.slice(head, b.length - tail);
    if (am.length === 0)
        return kept;
    if (am.length > bm.length || am.length * bm.length > MAX_LCS_CELLS)
        return null;
    const w = bm.length + 1;
    const dp = new Int32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--) {
        for (let j = bm.length - 1; j >= 0; j--) {
            dp[i * w + j] =
                am[i] === bm[j]
                    ? dp[(i + 1) * w + j + 1] + 1
                    : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
    }
    if (dp[0] !== am.length)
        return null;
    for (let i = 0, j = 0; i < am.length;) {
        if (am[i] === bm[j]) {
            kept[head + j] = true;
            i++;
            j++;
        }
        else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1])
            i++;
        else
            j++;
    }
    return kept;
}
/** The line index of the `---` closing a leading frontmatter block, or -1 when the text has none. */
function frontmatterEnd(lines) {
    if (lines[0] !== "---")
        return -1;
    return lines.indexOf("---", 1);
}
const trimBlank = (lines) => lines.join("\n").replace(/^\n+|\s+$/g, "");
/** Whether `text` stands in `base` as a whole section (its "moved from" line and block), not as a part of a longer one. */
function holdsSection(base, text) {
    for (let at = base.indexOf(text); at >= 0; at = base.indexOf(text, at + 1)) {
        const before = base.slice(0, at);
        const after = base.slice(at + text.length);
        if ((before === "" || before.endsWith("\n\n")) && /^\s*($|_Moved from )/.test(after)) {
            return true;
        }
    }
    return false;
}
/** What `split` would move, or the reason it refuses: only a copy that is the shipped text plus added lines and files splits. */
function planSplit(ctx, name) {
    const shipped = shippedSkills(ctx.root).get(name);
    if (!shipped)
        throw new Error(`no bundled skill named ${name}`);
    const mine = path.join(ctx.skillsDir, name);
    const kind = kindOf(mine);
    if (kind === "none")
        throw new Error(`${name} is not installed in ${ctx.skillsDir}`);
    if (kind === "other")
        throw new Error(`${mine} is a link: yours, never touched`);
    const row = planSkills(ctx, readManifest(ctx.stateDir)).find(r => r.name === name);
    if (row?.state !== "edited")
        throw new Error(`${name} is not edited (${row?.state}): nothing to split`);
    const src = sourceDir(ctx.root, name);
    const have = hashTree(mine);
    const sections = [];
    const added = {};
    for (const rel of Object.keys(shipped)) {
        if (have[rel] === undefined)
            throw new Error(`refusing: ${rel} was deleted from your copy of ${name}`);
    }
    for (const rel of Object.keys(have).sort()) {
        if (shipped[rel] === undefined) {
            added[rel] = fs.readFileSync(path.join(mine, rel));
            continue;
        }
        if (have[rel] === shipped[rel])
            continue;
        const text = fs.readFileSync(path.join(mine, rel), "utf8");
        const was = fs.readFileSync(path.join(src, rel), "utf8").split("\n");
        const now = text.split("\n");
        const kept = matchedLines(was, now);
        if (kept === null) {
            throw new Error(`refusing: ${rel} of ${name} has lines changed or removed, not only added; ` +
                `\`wf-skills diff ${name}\` shows them, \`wf-skills update ${name}\` takes the shipped text (your copy is saved first)`);
        }
        const close = frontmatterEnd(now);
        let anchor = "";
        for (let i = 0; i < now.length;) {
            if (kept[i]) {
                if (now[i].trim() !== "")
                    anchor = now[i].trim().slice(0, 60);
                i++;
                continue;
            }
            let end = i;
            while (end < now.length && !kept[end])
                end++;
            const block = trimBlank(now.slice(i, end));
            if (rel === "SKILL.md" && close >= 0 && i < close && block !== "") {
                throw new Error(`refusing: SKILL.md of ${name} has lines added to its frontmatter (name, description): they cannot move into a learned skill`);
            }
            if (block !== "") {
                const where = anchor ? `${rel}, after "${anchor}"` : rel;
                sections.push({ block, text: `_Moved from your copy of ${name} (${where}):_\n\n${block}` });
            }
            i = end;
        }
    }
    return { sections, added };
}
/**
 * Move what the user added to an edited bundled copy into `learned-<name>` and put the shipped text back, so the
 * copy is updated again, all under one hold of the skills lock. Refuses (nothing written) unless the copy is the
 * shipped text plus added lines and files; a run that died after the learned write is finished by the next one.
 */
export function splitSkill(ctx, name) {
    const result = withSkillsLock(ctx.stateDir, true, () => {
        if (fs.existsSync(ctx.skillsDir))
            restoreInterrupted(ctx.skillsDir);
        const plan = planSplit(ctx, name);
        const learned = path.join(ctx.skillsDir, `${LEARNED_PREFIX}${name}`);
        if (kindOf(learned) === "other")
            throw new Error(`${learned} is not a directory: left as it is`);
        for (const [rel, bytes] of Object.entries(plan.added)) {
            const to = path.join(learned, rel);
            if (rel === "SKILL.md" || (fs.existsSync(to) && !fs.readFileSync(to).equals(bytes))) {
                throw new Error(`refusing: ${to} exists with other content`);
            }
        }
        fs.mkdirSync(learned, { recursive: true });
        const skillFile = path.join(learned, "SKILL.md");
        const base = fs.existsSync(skillFile)
            ? fs.readFileSync(skillFile, "utf8")
            : learnedSkillStub(name);
        // A section the learned skill already holds was written by a run that died before the restore: not twice.
        const fresh = plan.sections.filter(sec => !holdsSection(base, sec.text));
        if (fresh.length > 0) {
            const tmp = `${skillFile}.tmp.${process.pid}`;
            fs.writeFileSync(tmp, `${base.trimEnd()}\n\n${fresh.map(sec => sec.text).join("\n\n")}\n`);
            fs.renameSync(tmp, skillFile);
        }
        else if (!fs.existsSync(skillFile)) {
            fs.writeFileSync(skillFile, base);
        }
        for (const [rel, bytes] of Object.entries(plan.added)) {
            fs.mkdirSync(path.dirname(path.join(learned, rel)), { recursive: true });
            fs.writeFileSync(path.join(learned, rel), bytes);
        }
        const shipped = shippedSkills(ctx.root).get(name);
        if (!shipped)
            throw new Error(`no bundled skill named ${name}`);
        const backup = installShipped(ctx, name, shipped);
        return { learned, sections: fresh.length, files: Object.keys(plan.added), backup };
    });
    if (result === null)
        throw new Error("another process is syncing the skills; try again");
    return result;
}
