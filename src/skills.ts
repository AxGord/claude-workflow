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
// recorded, updated and removed like a default skill. Only node built-ins here: the hook runs this on every session start.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** relative path (with `/`) → sha256 of the file's bytes. */
export type FileHashes = Readonly<Record<string, string>>;

export interface ManifestEntry {
  /** The engine version that shipped the copy. */
  readonly engine: string;
  /** The files as shipped. */
  readonly files: FileHashes;
}

export interface Manifest {
  readonly version: 1;
  readonly skills: Readonly<Record<string, ManifestEntry>>;
  /** Shipped skills the user removed: never copied again. */
  readonly deleted: readonly string[];
  /** Edited skill → digest of the shipped version it was last named against (named once per shipped version). */
  readonly noticed: Readonly<Record<string, string>>;
}

export interface SkillsContext {
  /** The plugin root: `templates/skills` and `templates/skills-history.txt` are read from it. */
  readonly root: string;
  readonly skillsDir: string;
  readonly stateDir: string;
  /** The engine version this root ships. */
  readonly version: string;
}

/** Under its own subdirectory: a `*.json` directly in the state dir is a session to `Storage.list()`. */
export const MANIFEST_FILE = path.join("skills", "manifest.json");
const IGNORED_FILES = new Set([".DS_Store"]);
/** A staging directory in the skills dir: a dot name, swept at the start of every sync. */
const SCRATCH = ".wf-";
/** Where each set lives under `<root>/templates`. */
const DEFAULT_SET = "skills";
const STACK_SET = "skills-stack";
/** Beside the manifest: a link to the plugin's `scripts/wf-skills`, refreshed at every start, so an agent has a stable path to the command. */
export const CLI_LINK = path.join("skills", "wf-skills");

const sha256 = (data: Buffer | string): string =>
  crypto.createHash("sha256").update(data).digest("hex");

/** Every regular file under `dir` (a Finder `.DS_Store` aside), by relative path. */
export function hashTree(dir: string): FileHashes {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    const names = fs.readdirSync(path.join(dir, rel)).sort();
    for (const name of names) {
      if (IGNORED_FILES.has(name)) continue;
      const r = rel ? `${rel}/${name}` : name;
      try {
        const st = fs.statSync(path.join(dir, r));
        if (st.isDirectory()) walk(r);
        else if (st.isFile()) out[r] = sha256(fs.readFileSync(path.join(dir, r)));
      } catch {
        // a broken link or a file gone while reading: not part of the skill
      }
    }
  };
  walk("");
  return out;
}

/** One digest for a whole skill: its file set and every file's content. */
export function treeDigest(files: FileHashes): string {
  const lines = Object.keys(files)
    .sort()
    .map(rel => `${rel}\0${files[rel]}\n`);
  return sha256(lines.join(""));
}

function shippedSet(root: string, set: string): Map<string, FileHashes> {
  const dir = path.join(root, "templates", set);
  const out = new Map<string, FileHashes>();
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) out.set(ent.name, hashTree(path.join(dir, ent.name)));
  }
  return out;
}

/** The skills this release ships, by name: the default set and the stack pack. */
export function shippedSkills(root: string): Map<string, FileHashes> {
  return new Map([...shippedSet(root, DEFAULT_SET), ...shippedSet(root, STACK_SET)]);
}

/** The names of the stack pack: shipped, never copied by the start hook. */
export function stackSkillNames(root: string): Set<string> {
  return new Set(shippedSet(root, STACK_SET).keys());
}

/** The directory a shipped skill is copied from. */
function sourceDir(root: string, name: string): string {
  const stack = path.join(root, "templates", STACK_SET, name);
  return fs.existsSync(stack) ? stack : path.join(root, "templates", DEFAULT_SET, name);
}

/** Every `<digest> <name>` line of the history file: the versions of each skill the repo ever shipped. */
export function loadHistory(root: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, "templates", "skills-history.txt"), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64}) (\S+)$/.exec(line);
    if (!m) continue;
    const set = out.get(m[2]) ?? new Set<string>();
    set.add(m[1]);
    out.set(m[2], set);
  }
  return out;
}

export function engineVersion(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** `a` newer than `b` by numeric dotted parts. */
export function versionNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(n => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

export function skillsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_SKILLS_DIR) return path.resolve(env.CLAUDE_SKILLS_DIR);
  return path.join(env.HOME || os.homedir(), ".claude", "skills");
}

/** The manifest, or null when there is none (or it is unreadable: then every copy is adopted afresh). */
export function readManifest(stateDir: string): Manifest | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, MANIFEST_FILE), "utf8"),
    ) as Partial<Manifest>;
    if (raw.version !== 1 || typeof raw.skills !== "object" || raw.skills === null) return null;
    return {
      version: 1,
      skills: raw.skills,
      deleted: Array.isArray(raw.deleted) ? raw.deleted : [],
      noticed: raw.noticed ?? {},
    };
  } catch {
    return null;
  }
}

export function writeManifest(stateDir: string, manifest: Manifest): void {
  const file = path.join(stateDir, MANIFEST_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export type SkillState =
  /** installed, equal to what this release ships */
  | "current"
  /** installed, unedited, and the release ships something else */
  | "outdated"
  /** installed with the user's changes, or a link: never touched */
  | "edited"
  /** not installed (a default skill: the next start installs it) */
  | "missing"
  /** a stack skill, not installed and not deleted by the user: `wf-skills add <name>` installs it */
  | "available"
  /** the user removed it */
  | "deleted"
  /** installed, unedited, no longer shipped */
  | "retired";

export interface SkillRow {
  readonly name: string;
  readonly shipped: boolean;
  /** Shipped in the stack pack: installed only by `wf-skills add`. */
  readonly pack: boolean;
  readonly installed: boolean;
  readonly state: SkillState;
  /** What a sync does about it. */
  readonly action: "none" | "install" | "update" | "adopt" | "record-deleted" | "forget";
  /** `edited` only: the installed files differ from what this release ships (a link never does). */
  readonly differs: boolean;
}

/** What sits at `p`: nothing, a real directory, or anything else (a link, a stray file) — which is the user's. */
function kindOf(p: string): "none" | "dir" | "other" {
  try {
    return fs.lstatSync(p).isDirectory() ? "dir" : "other";
  } catch {
    return "none";
  }
}

/**
 * What is there for every skill the release ships or the manifest knows. `manifest` null = none yet: copies
 * are adopted by the history table. A stack skill that is not installed is only `available` (or `deleted`).
 */
export function planSkills(ctx: SkillsContext, manifest: Manifest | null): SkillRow[] {
  const shipped = shippedSkills(ctx.root);
  const stack = stackSkillNames(ctx.root);
  const history = loadHistory(ctx.root);
  const entries = manifest?.skills ?? {};
  const deleted = new Set(manifest?.deleted ?? []);
  const names = [...new Set([...shipped.keys(), ...Object.keys(entries)])].sort();
  const dir = (name: string): string => path.join(ctx.skillsDir, name);
  const present = (name: string): boolean => kindOf(dir(name)) !== "none";

  return names.map((name): SkillRow => {
    const ship = shipped.get(name);
    const entry = entries[name];
    const row = (
      state: SkillState,
      action: SkillRow["action"],
      installed: boolean,
      differs = false,
    ): SkillRow => ({
      name,
      shipped: ship !== undefined,
      pack: stack.has(name),
      installed,
      state,
      action,
      differs,
    });

    if (present(name)) {
      if (kindOf(dir(name)) === "other") return row("edited", "none", true);
      const have = treeDigest(hashTree(dir(name)));
      const shipDigest = ship ? treeDigest(ship) : undefined;
      const known =
        have === shipDigest ||
        (entry !== undefined && have === treeDigest(entry.files)) ||
        history.get(name)?.has(have) === true;
      if (!known) return row("edited", "none", true, shipDigest !== undefined);
      if (!ship) return row("retired", "none", true);
      if (have === shipDigest) {
        const recorded = entry !== undefined && treeDigest(entry.files) === have;
        return row("current", recorded && !deleted.has(name) ? "none" : "adopt", true);
      }
      // Only a copy this release knows it supersedes is replaced: one the history table lists, or one an
      // OLDER engine version recorded. A copy another plugin root with this or a newer version put there
      // (the cache and the marketplace directory both hold a copy of the plugin) is never taken back.
      const supersedes =
        history.get(name)?.has(have) === true ||
        (entry !== undefined &&
          treeDigest(entry.files) === have &&
          versionNewer(ctx.version, entry.engine));
      return row("outdated", supersedes ? "update" : "none", true);
    }

    if (!ship) return row("missing", "forget", false);
    if (deleted.has(name)) return row("deleted", "none", false);
    if (entry) return row("deleted", "record-deleted", false);
    return stack.has(name) ? row("available", "none", false) : row("missing", "install", false);
  });
}

/** Copy `files` of `src` to `<skillsDir>/<name>` whole: staged beside it, then swapped in. */
function install(ctx: SkillsContext, name: string, files: FileHashes): void {
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
  if (fs.existsSync(dst)) fs.renameSync(dst, old);
  fs.renameSync(stage, dst);
  fs.rmSync(old, { recursive: true, force: true });
}

/**
 * `install` swaps in two renames; a crash between them leaves `<name>` absent and the old copy under
 * `.wf-old.<name>.<pid>`. Put it back before anything is planned, or the next sync takes the gap for a deletion.
 */
function restoreInterrupted(skills: string): void {
  if (!fs.existsSync(skills)) return;
  for (const entry of fs.readdirSync(skills)) {
    const m = /^\.wf-old\.(.+)\.\d+$/.exec(entry);
    if (m && kindOf(path.join(skills, m[1])) === "none") {
      fs.renameSync(path.join(skills, entry), path.join(skills, m[1]));
    }
  }
}

function sweepScratch(skills: string): void {
  if (!fs.existsSync(skills)) return;
  for (const name of fs.readdirSync(skills)) {
    if (name.startsWith(SCRATCH))
      fs.rmSync(path.join(skills, name), { recursive: true, force: true });
  }
}

/**
 * `<stateDir>/skills.lock`: one syncing process at a time; a lock older than a minute is a crash's. Held by
 * another process: waits up to ten seconds when `wait`, else gives up (null). A lock that cannot be created for
 * any other reason (an unwritable or full state dir) is null for the hook's sync and an error for `update`/`remove`.
 */
export function withSkillsLock<T>(stateDir: string, wait: boolean, fn: () => T): T | null {
  const lock = path.join(stateDir, "skills.lock");
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        if (wait) throw err;
        return null; // the hook's sync: nothing to do here, and it must never fail the start
      }
      if (attempt >= 100) return null;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // released between the mkdir and the stat: try again at once
      }
      if (age > 60_000) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (!wait) return null;
      Atomics.wait(sleep, 0, 0, 100);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export interface SyncResult {
  readonly installed: readonly string[];
  readonly updated: readonly string[];
  readonly adopted: readonly string[];
  /** Edited copies the release ships a different version of. */
  readonly edited: readonly string[];
  readonly deleted: readonly string[];
  /** Edited skills named for the first time against this shipped version: the hook prints them. */
  readonly named: readonly string[];
  readonly errors: readonly string[];
}

/** What the hook runs on every start: install the missing, update the unedited, adopt, record deletions, name edits once. */
export function syncSkills(ctx: SkillsContext): SyncResult | null {
  return withSkillsLock(ctx.stateDir, false, () => {
    fs.mkdirSync(ctx.skillsDir, { recursive: true });
    restoreInterrupted(ctx.skillsDir);
    sweepScratch(ctx.skillsDir);
    const had = readManifest(ctx.stateDir);
    const rows = planSkills(ctx, had);
    const shipped = shippedSkills(ctx.root);

    const skills: Record<string, ManifestEntry> = { ...(had?.skills ?? {}) };
    const deleted = new Set(had?.deleted ?? []);
    const noticed: Record<string, string> = { ...(had?.noticed ?? {}) };
    const out = {
      installed: [] as string[],
      updated: [] as string[],
      adopted: [] as string[],
      edited: [] as string[],
      deleted: [] as string[],
      named: [] as string[],
      errors: [] as string[],
    };

    for (const r of rows) {
      const files = shipped.get(r.name);
      try {
        if (r.action === "install" || r.action === "update") {
          if (!files) continue;
          install(ctx, r.name, files);
          skills[r.name] = { engine: ctx.version, files };
          deleted.delete(r.name);
          (r.action === "install" ? out.installed : out.updated).push(r.name);
        } else if (r.action === "adopt" && files) {
          skills[r.name] = { engine: ctx.version, files };
          deleted.delete(r.name);
          if (had === null) out.adopted.push(r.name);
        } else if (r.action === "record-deleted") {
          delete skills[r.name];
          deleted.add(r.name);
          out.deleted.push(r.name);
        } else if (r.action === "forget") {
          delete skills[r.name];
        }
      } catch (err) {
        out.errors.push(`${r.name}: ${(err as Error).message}`);
      }
      if (r.state === "edited" && r.differs && files) {
        out.edited.push(r.name);
        const digest = treeDigest(files);
        if (noticed[r.name] !== digest) {
          noticed[r.name] = digest;
          out.named.push(r.name);
        }
      } else {
        delete noticed[r.name];
      }
    }

    writeManifest(ctx.stateDir, { version: 1, skills, deleted: [...deleted].sort(), noticed });
    refreshCliLink(ctx);
    return out;
  });
}

/** `<stateDir>/skills/wf-skills` → this root's `scripts/wf-skills`; a failure is not the start's to report. */
function refreshCliLink(ctx: SkillsContext): void {
  const link = path.join(ctx.stateDir, CLI_LINK);
  const target = path.join(ctx.root, "scripts", "wf-skills");
  try {
    if (fs.readlinkSync(link) === target) return;
  } catch {
    // no link yet, or something else in its place: replaced below
  }
  try {
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link);
  } catch {
    // the command is also reachable by its plugin path
  }
}

/** The one-line note the hook prints for edited copies named for the first time. */
export function editedNote(named: readonly string[], cmd: string): string {
  if (named.length === 0) return "";
  const first = named[0];
  return (
    `Workflow plugin: ${named.length} bundled skill(s) carry your edits and differ from the version this release ships, ` +
    `so they were left as they are: ${named.join(", ")}. ` +
    `Show the difference: ${cmd} diff ${first}; take the shipped version (your copy is saved first): ${cmd} update ${first}.`
  );
}

/** Force `name` to the shipped version; an edited copy is moved to `<stateDir>/skill-backups` first. Returns that backup, if any. */
export function updateSkill(ctx: SkillsContext, name: string): string | null {
  const shipped = shippedSkills(ctx.root).get(name);
  if (!shipped) throw new Error(`no bundled skill named ${name}`);
  const result = withSkillsLock(ctx.stateDir, true, () => {
    if (fs.existsSync(ctx.skillsDir)) restoreInterrupted(ctx.skillsDir);
    const had = readManifest(ctx.stateDir);
    const row = planSkills(ctx, had).find(r => r.name === name);
    let backup: string | null = null;
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
    return { backup };
  });
  if (result === null) throw new Error("another process is syncing the skills; try again");
  return result.backup;
}

export interface AddResult {
  readonly installed: readonly string[];
  /** Already in the skills dir (an edited copy included): `update` is the way to change it. */
  readonly present: readonly string[];
}

/**
 * Install shipped skills by name (the way a stack skill gets in), or every stack skill with `allStack`. A
 * skill the user had deleted comes back: asking for it by name is the answer to the deletion.
 */
export function addSkills(
  ctx: SkillsContext,
  names: readonly string[],
  allStack = false,
): AddResult {
  const shipped = shippedSkills(ctx.root);
  const wanted = allStack ? [...new Set([...stackSkillNames(ctx.root), ...names])].sort() : names;
  for (const name of wanted) {
    if (!shipped.has(name)) throw new Error(`no bundled skill named ${name} (wf-skills list)`);
  }
  const result = withSkillsLock(ctx.stateDir, true, () => {
    if (fs.existsSync(ctx.skillsDir)) restoreInterrupted(ctx.skillsDir);
    fs.mkdirSync(ctx.skillsDir, { recursive: true });
    const had = readManifest(ctx.stateDir);
    const rows = planSkills(ctx, had);
    const skills: Record<string, ManifestEntry> = { ...(had?.skills ?? {}) };
    const deleted = new Set(had?.deleted ?? []);
    const out = { installed: [] as string[], present: [] as string[] };
    for (const name of wanted) {
      const files = shipped.get(name);
      if (!files) continue;
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
  if (result === null) throw new Error("another process is syncing the skills; try again");
  return result;
}

export interface RemovePlan {
  /** Unedited engine copies: removed. */
  readonly remove: readonly string[];
  /** Edited copies: kept. */
  readonly keep: readonly string[];
}

export function planRemove(ctx: SkillsContext): RemovePlan {
  const rows = planSkills(ctx, readManifest(ctx.stateDir));
  return {
    remove: rows
      .filter(r => r.installed && ["current", "outdated", "retired"].includes(r.state))
      .map(r => r.name),
    keep: rows.filter(r => r.installed && r.state === "edited").map(r => r.name),
  };
}

/** Remove every unedited engine copy and the manifest; an edited copy and a skill the engine never shipped stay. */
export function removeSkills(ctx: SkillsContext): RemovePlan {
  const stateExisted = fs.existsSync(ctx.stateDir);
  const result = withSkillsLock(ctx.stateDir, true, () => {
    if (fs.existsSync(ctx.skillsDir)) restoreInterrupted(ctx.skillsDir);
    const plan = planRemove(ctx);
    for (const name of plan.remove) {
      fs.rmSync(path.join(ctx.skillsDir, name), { recursive: true, force: true });
    }
    fs.rmSync(path.dirname(path.join(ctx.stateDir, MANIFEST_FILE)), {
      recursive: true,
      force: true,
    });
    return plan;
  });
  if (result === null) throw new Error("another process is syncing the skills; try again");
  if (!stateExisted) fs.rmSync(ctx.stateDir, { recursive: true, force: true });
  return result;
}
