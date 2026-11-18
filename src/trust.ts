// Consent for the exec/fetch states a PROJECT's own workflow files declare. A state of those
// types runs a shell command or an HTTP request the moment the session enters it, so a project
// file (a cloned repo's `.claude/workflows`) may run one only when the USER approved that exact
// content. Approval is a sha256 of the file's bytes in `<state dir>/trusted-workflows.json`,
// written by the `wf-trust` CLI (a terminal prompt); no MCP tool reads or writes it, and a changed
// file hashes differently, so it needs approval again. Bundled and global files are not gated.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { WorkflowFileSchema } from "./types.js";

export const TRUST_FILE = "trusted-workflows.json";

interface TrustRecord {
  readonly file: string;
  readonly approved_at: string;
}

interface TrustDocument {
  readonly version: 1;
  readonly trusted: Record<string, TrustRecord>;
}

export function hashContent(raw: string | Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Why a tool call may not bring an exec/fetch state: that is a command or request run with no one's approval. */
export function actionStateRefusal(what: string): string {
  return (
    `${what}: exec/fetch states are not accepted from modify or create (the command would run with ` +
    "nothing the user approved). Write the state in a workflow YAML file under .claude/workflows/ and ask the USER to run `wf-trust <project>` in a terminal."
  );
}

/** The names of the exec/fetch states a workflow file declares itself (not inherited ones). */
export function actionStateNames(states: Record<string, { type?: string }> | undefined): string[] {
  return Object.entries(states ?? {})
    .filter(([, s]) => s.type === "exec" || s.type === "fetch")
    .map(([name]) => name);
}

/** Why a file is refused and what the user runs; one wording for every refusal. */
export function trustHint(projectDir: string): string {
  return `run \`wf-trust ${projectDir}\` in a terminal (it shows the commands and asks; the agent cannot approve for you)`;
}

/** The approved hashes of one state dir; reads the file afresh (it is tiny) so a live server sees an approval at once. */
export class TrustStore {
  private readonly _file: string | null;
  private _all = false;

  /** `file` null: nothing is ever trusted (the secure default of a Loader built without a store). */
  constructor(file: string | null) {
    this._file = file;
  }

  /** For a loader that only DESCRIBES workflows (the site's and the replay's graphs): nothing it loads runs. */
  public static describeOnly(): TrustStore {
    const store = new TrustStore(null);
    store._all = true;
    return store;
  }

  public static inStateDir(stateDir: string): TrustStore {
    return new TrustStore(path.join(stateDir, TRUST_FILE));
  }

  public get file(): string | null {
    return this._file;
  }

  /** Changes whenever the file's content does: the cache key of whoever depends on `has`. */
  public stamp(): string {
    if (!this._file) return "none";
    try {
      const st = fs.statSync(this._file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "none";
    }
  }

  public has(hash: string): boolean {
    return this._all || hash in this._read().trusted;
  }

  public list(): Array<{ hash: string; file: string; approved_at: string }> {
    return Object.entries(this._read().trusted).map(([hash, r]) => ({ hash, ...r }));
  }

  public add(hash: string, file: string, at: string = new Date().toISOString()): void {
    const doc = this._read();
    this._write({ version: 1, trusted: { ...doc.trusted, [hash]: { file, approved_at: at } } });
  }

  public remove(hash: string): boolean {
    const doc = this._read();
    if (!(hash in doc.trusted)) return false;
    const rest = Object.fromEntries(Object.entries(doc.trusted).filter(([h]) => h !== hash));
    this._write({ version: 1, trusted: rest });
    return true;
  }

  private _read(): TrustDocument {
    if (!this._file) return { version: 1, trusted: {} };
    try {
      const doc = JSON.parse(fs.readFileSync(this._file, "utf8")) as Partial<TrustDocument>;
      return {
        version: 1,
        trusted: doc.trusted && typeof doc.trusted === "object" ? doc.trusted : {},
      };
    } catch {
      return { version: 1, trusted: {} };
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
export function actionFilesIn(dir: string, store: TrustStore): ActionFile[] {
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
      trusted: store.has(hash),
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

/** `<project>` as the user typed it: the project root, its `.claude/workflows`, or one workflow file. */
export function resolveWorkflowsDir(target: string): { dir: string; only?: string } {
  const abs = path.resolve(target);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return { dir: path.dirname(abs), only: abs };
  const nested = path.join(abs, ".claude", "workflows");
  return { dir: fs.existsSync(nested) ? nested : abs };
}
