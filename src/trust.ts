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
import YAML from "yaml";
import { ClaudeFolderTrust, folderTrustKeys } from "./claude-trust.js";
import { WorkflowFileSchema } from "./types.js";

export const TRUST_FILE = "trusted-workflows.json";

interface TrustRecord {
  readonly file: string;
  readonly approved_at: string;
}

interface ProjectRecord {
  readonly approved_at: string;
}

interface TrustDocument {
  readonly version: 1;
  /** Per-file approvals: sha256 of a file's bytes. */
  readonly trusted: Record<string, TrustRecord>;
  /** Per-project approvals of `wf-trust <project>`: the project directory. */
  readonly projects: Record<string, ProjectRecord>;
}

export interface TrustOptions {
  /** Only a file's own sha256 approval counts; the project approvals and Claude Code's folder trust do not. */
  readonly strict?: boolean;
  /** Claude Code's folder-trust answer; absent: it is not consulted. */
  readonly claude?: ClaudeFolderTrust;
}

/** The env switch of strict mode: `WF_TRUST_STRICT=1`. */
export const STRICT_ENV = "WF_TRUST_STRICT";

export function strictFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[STRICT_ENV];
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

export function hashContent(raw: string | Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Why a tool call may not bring an exec/fetch state: that is a command or request run with no one's approval. */
export function actionStateRefusal(what: string): string {
  return (
    `${what}: exec/fetch states are not accepted from modify or create (the command would run with ` +
    "nothing the user approved). Write the state in a workflow YAML file under .claude/workflows/ of a project the user trusted (accepted in Claude Code, or `wf-trust <project>` run by the USER in a terminal)."
  );
}

/** The names of the exec/fetch states a workflow file declares itself (not inherited ones). */
export function actionStateNames(states: Record<string, { type?: string }> | undefined): string[] {
  return Object.entries(states ?? {})
    .filter(([, s]) => s.type === "exec" || s.type === "fetch")
    .map(([name]) => name);
}

/** What the user runs to approve a project; one wording for every refusal. */
export function trustHint(projectDir: string): string {
  return `run \`wf-trust ${projectDir}\` in a terminal (it shows the commands and asks; the agent cannot approve for you)`;
}

/** One plain sentence: why `projectDir`'s files are left out and the two ways to fix it. */
export function untrustedReason(projectDir: string, store: TrustStore): string {
  return store.strict
    ? `strict trust mode (${STRICT_ENV}) needs the user's approval of each exact file, and this one is not approved (or changed since): ${trustHint(projectDir)}.`
    : `the project ${projectDir} is not trusted (no Claude Code folder trust is recorded for it): either open the folder in Claude Code and accept its trust question, or ask the USER to ${trustHint(projectDir)}.`;
}

/** Where the trust of a project comes from. */
export type TrustSource = "claude" | "wf-trust";

/** The directory a project approval is recorded under: the main checkout for a linked worktree. */
const keyOf = (root: string): string => folderTrustKeys(root)[0] ?? path.resolve(root);

/** The approvals of one state dir, and the rule that turns them (and Claude Code's folder trust) into "this project file may run its exec states". Reads afresh (the file is tiny) so a live server sees an approval at once. */
export class TrustStore {
  private readonly _file: string | null;
  private readonly _opts: TrustOptions;
  private _all = false;

  /** `file` null: nothing is ever trusted (the secure default of a Loader built without a store). */
  constructor(file: string | null, opts: TrustOptions = {}) {
    this._file = file;
    this._opts = opts;
  }

  /** For a loader that only DESCRIBES workflows (the site's and the replay's graphs): nothing it loads runs. */
  public static describeOnly(): TrustStore {
    const store = new TrustStore(null);
    store._all = true;
    return store;
  }

  /** The production store: the state dir's file, Claude Code's folder trust, strict mode from the env. */
  public static inStateDir(stateDir: string, env: NodeJS.ProcessEnv = process.env): TrustStore {
    return new TrustStore(path.join(stateDir, TRUST_FILE), {
      strict: strictFromEnv(env),
      claude: new ClaudeFolderTrust(env),
    });
  }

  public get file(): string | null {
    return this._file;
  }

  public get strict(): boolean {
    return this._opts.strict === true;
  }

  /** Changes whenever the approvals file does: the cache key of whoever depends on `has`. */
  public stamp(): string {
    if (!this._file) return "none";
    try {
      const st = fs.statSync(this._file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "none";
    }
  }

  /** Changes whenever Claude Code's config does (it rewrites it often, so a cache keyed on it re-checks `allows`, not reloads). */
  public claudeStamp(): string {
    return this._opts.claude?.stamp() ?? "none";
  }

  /** The file with this exact content is approved (a per-file approval, any mode). */
  public has(hash: string): boolean {
    return this._all || hash in this._read().trusted;
  }

  /** The directory `addProject(root)` records: `root` itself, or the main checkout when `root` is a linked worktree. */
  public projectKey(root: string): string {
    return keyOf(root);
  }

  /** The project's trust, from `wf-trust` or Claude Code's folder trust; undefined when it has none (strict mode counts neither). */
  public projectTrust(root: string): TrustSource | undefined {
    if (this.strict) return undefined;
    const approved = this._read().projects;
    if ([...folderTrustKeys(root), keyOf(root)].some(k => Object.hasOwn(approved, k)))
      return "wf-trust";
    return this._opts.claude?.trusted(root) ? "claude" : undefined;
  }

  /** The project file with this content, in the project at `root`, may run its exec/fetch states. */
  public allows(root: string, hash: string): boolean {
    return this.has(hash) || this.projectTrust(root) !== undefined;
  }

  public list(): Array<{ hash: string; file: string; approved_at: string }> {
    return Object.entries(this._read().trusted).map(([hash, r]) => ({ hash, ...r }));
  }

  public listProjects(): Array<{ dir: string; approved_at: string }> {
    return Object.entries(this._read().projects).map(([dir, r]) => ({ dir, ...r }));
  }

  public add(hash: string, file: string, at: string = new Date().toISOString()): void {
    const doc = this._read();
    this._write({ ...doc, trusted: { ...doc.trusted, [hash]: { file, approved_at: at } } });
  }

  public addProject(root: string, at: string = new Date().toISOString()): void {
    const doc = this._read();
    this._write({ ...doc, projects: { ...doc.projects, [keyOf(root)]: { approved_at: at } } });
  }

  public remove(hash: string): boolean {
    const doc = this._read();
    if (!(hash in doc.trusted)) return false;
    const rest = Object.fromEntries(Object.entries(doc.trusted).filter(([h]) => h !== hash));
    this._write({ ...doc, trusted: rest });
    return true;
  }

  /** Withdraw the approval recorded for the project directory `dir`; false when it has none. */
  public removeProject(dir: string): boolean {
    const doc = this._read();
    const key = [keyOf(dir), path.resolve(dir)].find(k => Object.hasOwn(doc.projects, k));
    if (key === undefined) return false;
    this._write({
      ...doc,
      projects: Object.fromEntries(Object.entries(doc.projects).filter(([k]) => k !== key)),
    });
    return true;
  }

  private _read(): TrustDocument {
    const empty: TrustDocument = { version: 1, trusted: {}, projects: {} };
    if (!this._file) return empty;
    try {
      const doc = JSON.parse(fs.readFileSync(this._file, "utf8")) as Partial<TrustDocument>;
      const record = <T>(v: unknown): Record<string, T> =>
        v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, T>) : {};
      return {
        version: 1,
        trusted: record(doc.trusted),
        projects: record(doc.projects),
      };
    } catch {
      return empty;
    }
  }

  private _write(doc: TrustDocument): void {
    if (!this._file) throw new Error("no trust store file");
    fs.mkdirSync(path.dirname(this._file), { recursive: true });
    const tmp = `${this._file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this._file);
  }
}

/** A project workflow file that declares exec/fetch states. */
export interface ActionFile {
  readonly file: string;
  readonly name: string;
  readonly hash: string;
  /** `state (exec): command` lines plus indented detail lines (fanout, cwd, env; fetch headers, body): everything the file runs, what the user is asked to approve. */
  readonly lines: readonly string[];
  readonly trusted: boolean;
}

/** The workflow files under `dir` (a `.claude/workflows` directory) that declare exec/fetch states. */
export function actionFilesIn(dir: string, store: TrustStore, root: string): ActionFile[] {
  if (!fs.existsSync(dir)) return [];
  const out: ActionFile[] = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
    const file = path.join(dir, f);
    const raw = fs.readFileSync(file);
    let parsed;
    try {
      parsed = WorkflowFileSchema.safeParse(YAML.parse(raw.toString("utf8")));
    } catch {
      continue;
    }
    if (!parsed.success) continue;
    const states = parsed.data.states ?? {};
    const names = actionStateNames(states);
    if (names.length === 0) continue;
    const hash = hashContent(raw);
    out.push({
      file,
      name: parsed.data.name,
      hash,
      trusted: store.allows(root, hash),
      lines: names.flatMap(n => {
        const s = states[n];
        const extra = (label: string, v: unknown): string[] =>
          v === undefined ? [] : [`    ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`];
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
export function projectOfWorkflowsDir(dir: string): string {
  return path.basename(dir) === "workflows" && path.basename(path.dirname(dir)) === ".claude"
    ? path.dirname(path.dirname(dir))
    : dir;
}

/** `<project>` as the user typed it: the project root, its `.claude/workflows`, or one workflow file. */
export function resolveWorkflowsDir(target: string): { dir: string; root: string; only?: string } {
  const abs = path.resolve(target);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    const dir = path.dirname(abs);
    return { dir, root: projectOfWorkflowsDir(dir), only: abs };
  }
  const nested = path.join(abs, ".claude", "workflows");
  const dir = fs.existsSync(nested) ? nested : abs;
  return { dir, root: projectOfWorkflowsDir(dir) };
}
