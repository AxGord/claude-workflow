// A task queue in a Markdown file, shared by every project: the header (up to `## Tasks`) holds
// `batch_size: N` (the window; `0` = paused, a `# comment` on the same line says why) and other
// `key: value` lines; each task is `- [m] ID | key: value | … | free text |`. The file is the only
// truth: a pick re-reads it under a lock beside it and changes nothing but `[m]` marks; the line
// and header writes (`addQueueLine`, `editQueueLine`, `setQueueWindow`) take the same lock.
//
// Admission (`planPick`, pure): free = batch_size minus the `[>]` lines; a `[ ]` line in file
// order is admitted when its model is not `—` (parent-run), no `⏸` stands in its metadata or its
// `after:`, every `after:` id is `[x]`, its `repo:` resolves, and it overlaps neither a `[>]` line
// nor a line admitted earlier in the same pick (`touches:` path prefixes on a `/` boundary, compared
// only between lines of one repo, where a line without `touches:` overlaps every line; `owner:`
// equal or a `.`-prefix, across repos; `exclusive:` overlaps every line of every repo). The header's
// `overlap: files` narrows `touches:` to its FILE entries (a regular file under the line's repo, or
// a path that does not exist whose last segment holds a `.`): a directory or glob entry is a hint
// that conflicts with nothing. A bad `overlap:` refuses the pick only; marks and edits still work. A `workflow:` field names the line's own task workflow (the
// dispatcher's default otherwise); a name that is not one word keeps the line out.
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { projectRoot } from "./pool.js";

export const QUEUE_EXIT = {
  ADMITTED: 0,
  WAIT: 10,
  DONE: 11,
  PAUSED: 12,
  ERROR: 2,
} as const;
export type PickCode = 0 | 10 | 11 | 12;

export const MARK_TARGETS = {
  running: { from: " ", to: ">" },
  done: { from: ">", to: "x" },
  failed: { from: ">", to: "!" },
  released: { from: ">", to: " " },
} as const;
export type MarkTarget = keyof typeof MARK_TARGETS;

const LINE_RE = /^- \[(.)\] (\S+)(?: \|(.*))?$/;
const META_KEYS = new Set([
  "model",
  "effort",
  "after",
  "touches",
  "owner",
  "repo",
  "workflow",
  "exclusive",
]);
/** The header's `overlap:` values; `paths` (the default) = every `touches:` entry is a path prefix. */
const OVERLAP_MODES = ["paths", "files"] as const;
export type OverlapMode = (typeof OVERLAP_MODES)[number];
// A field this long is the line's prose; `⏸` inside prose is a mention, not a pause.
const PROSE_MIN = 160;
const ID_RE = /^[A-Za-z0-9._-]+$/;
const HEADER_RE = /^([a-z_]+):\s*(.*?)\s*$/;
const BATCH_RE = /^(\d+)\s*(?:#\s*(.*))?$/;
// The lock outlives a dead holder by this long; proper-lockfile refreshes it while held.
const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = { retries: 300, minTimeout: 10, maxTimeout: 100, randomize: true };

export class QueueError extends Error {}

export interface QueueLine {
  /** Row index in the file. */
  readonly index: number;
  readonly mark: string;
  readonly id: string;
  readonly meta: Readonly<Record<string, string>>;
  readonly paused: boolean;
  /** The fields that are not metadata, joined by ` | `. */
  readonly text: string;
}

export interface Queue {
  readonly file: string;
  readonly rows: readonly string[];
  readonly lines: readonly QueueLine[];
  readonly batchSize: number;
  /** The `# …` comment of the `batch_size:` line. */
  readonly batchComment?: string;
  /** Every `key: value` line of the header, the first of each key (`batch_size` included). */
  readonly header: Readonly<Record<string, string>>;
  /** The `base:` lines' repo paths (`base: <abs-path>=<sha>`). */
  readonly baseRepos: readonly string[];
  /** The header's `overlap:` (`paths` when absent or not a mode): how `touches:` entries conflict. */
  readonly overlap: OverlapMode;
  /** Why the header's `overlap:` is not a mode: a pick refuses the queue, other operations go on. */
  readonly overlapError?: string;
}

export interface AdmittedTask {
  readonly id: string;
  readonly model: string;
  readonly effort: string;
  /** Absolute path of the repo the task works in. */
  readonly repo: string;
  /** The line's `workflow:` — its task workflow; absent = the dispatcher's own (`task_workflow`). */
  readonly workflow?: string;
  readonly text: string;
}

export interface PickResult {
  readonly file: string;
  readonly code: PickCode;
  readonly batchSize: number;
  readonly batchComment?: string;
  readonly running: readonly string[];
  readonly pending: number;
  readonly admitted: readonly AdmittedTask[];
  /** One entry per pending line not admitted, in file order. */
  readonly reasons: readonly { readonly id: string; readonly why: string }[];
  readonly dryRun: boolean;
}

function stripParens(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\([^()]*\)/g, " ");
  } while (s !== prev);
  return s;
}

function parseLine(row: string, index: number): QueueLine | null {
  const m = LINE_RE.exec(row);
  if (!m) return null;
  const fields = (m[3] ?? "").split(" | ").map(f => f.trim());
  const meta: Record<string, string> = {};
  const prose: string[] = [];
  let paused = false;
  let inProse = false;
  for (const f of fields) {
    const km = /^([a-z]+):\s*(.*)$/s.exec(f);
    if (km && META_KEYS.has(km[1])) {
      if (!(km[1] in meta)) meta[km[1]] = km[2].trim();
      if (km[1] === "after" && f.includes("⏸")) paused = true;
      continue;
    }
    if (f.length >= PROSE_MIN) inProse = true;
    if (!inProse && f.includes("⏸")) paused = true;
    prose.push(f);
  }
  // A line closed by ` |` leaves its last field ending in `|`.
  const text = prose
    .join(" | ")
    .replace(/\s*\|$/, "")
    .trim();
  return { index, mark: m[1], id: m[2], meta, paused, text };
}

export function parseQueue(text: string, file: string): Queue {
  const rows = text.split("\n");
  const tasksAt = rows.findIndex(r => r.trim() === "## Tasks");
  if (tasksAt < 0) throw new QueueError(`${file}: no "## Tasks" line`);
  const header: Record<string, string> = {};
  const baseRepos: string[] = [];
  for (const row of rows.slice(0, tasksAt)) {
    const m = HEADER_RE.exec(row);
    if (!m) continue;
    if (!(m[1] in header)) header[m[1]] = m[2];
    if (m[1] === "base") {
      const repo = /^(\/\S*?)=\S+$/.exec(m[2])?.[1];
      if (repo) baseRepos.push(repo);
    }
  }
  const bs = header.batch_size === undefined ? null : BATCH_RE.exec(header.batch_size);
  if (!bs) throw new QueueError(`${file}: no "batch_size: N" line in the header`);
  const lines: QueueLine[] = [];
  for (let i = tasksAt + 1; i < rows.length; i++) {
    const l = parseLine(rows[i], i);
    if (l) lines.push(l);
  }
  const ov = (header.overlap ?? "paths").replace(/\s*#.*$/, "").trim();
  const known = (OVERLAP_MODES as readonly string[]).includes(ov);
  const overlap: OverlapMode = known ? (ov as OverlapMode) : "paths";
  const overlapError = known
    ? undefined
    : `${file}: overlap: "${ov}" is not one of ${OVERLAP_MODES.join(", ")}`;
  const batchComment = bs[2]?.trim() || undefined;
  return {
    file,
    rows,
    lines,
    batchSize: Number(bs[1]),
    batchComment,
    header,
    baseRepos,
    overlap,
    ...(overlapError ? { overlapError } : {}),
  };
}

function touchesOf(line: QueueLine): string[] | null {
  const v = line.meta.touches;
  if (v === undefined) return null; // overlaps everything
  return stripParens(v)
    .split(",")
    .map(p => p.trim().split(/\s+/)[0] ?? "")
    .map(p => p.replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter(p => p !== "" && p !== "—" && p !== "-");
}

/** The line's `workflow:`: undefined when absent or `—`; null when it is not a workflow name. */
function workflowOf(line: QueueLine): string | undefined | null {
  const v = line.meta.workflow?.trim();
  if (!v || v === "-" || v === "—") return undefined;
  return ID_RE.test(v) ? v : null;
}

function ownerOf(line: QueueLine): string | null {
  const v = line.meta.owner;
  if (v === undefined) return null;
  const o = stripParens(v).trim().replace(/\s+/g, " ");
  return o === "" || o === "—" ? null : o;
}

/** `exclusive:` with any value but an empty one or `—`: the line overlaps every other line. */
function exclusiveOf(line: QueueLine): boolean {
  const v = line.meta.exclusive?.trim();
  return v !== undefined && v !== "" && v !== "-" && v !== "—";
}

const pathOverlap = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const ownerOverlap = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
/**
 * A `touches:` entry that names one file: no glob, and a regular file under `repo` — or, when it
 * does not exist there (yet), its last segment holds a `.` (`Makefile` counts only once it exists).
 */
function isFileEntry(p: string, repo: string | null): boolean {
  if (/[*?[\]{}]/.test(p)) return false;
  if (repo !== null) {
    try {
      return fs.statSync(path.resolve(repo, p)).isFile();
    } catch {
      /* not there: judged by its name */
    }
  }
  return (p.split("/").pop() ?? "").includes(".");
}

/** A line's repo as compared across lines: the resolved path, through symlinks when it exists. */
function repoKey(repo: string | null): string | null {
  if (repo === null) return null;
  try {
    return fs.realpathSync(repo);
  } catch {
    return repo;
  }
}

/**
 * Why `a` and `b` may not run together, or null. `repoA`/`repoB` are their repo keys: `touches:`
 * (and its absence) compares only within one repo (a null key, a repo that resolves nowhere, counts
 * as the same); `exclusive:` and `owner:` compare across repos.
 */
function conflict(
  a: QueueLine,
  b: QueueLine,
  mode: OverlapMode,
  repoA: string | null,
  repoB: string | null,
): string | null {
  if (exclusiveOf(a)) return `exclusive ${a.id}`;
  if (exclusiveOf(b)) return `exclusive ${b.id}`;
  if (repoA === null || repoB === null || repoA === repoB) {
    const ta = touchesOf(a);
    const tb = touchesOf(b);
    if (ta === null || tb === null) return "no touches:";
    const fa = mode === "files" ? ta.filter(p => isFileEntry(p, repoA)) : ta;
    const fb = mode === "files" ? tb.filter(p => isFileEntry(p, repoB)) : tb;
    for (const x of fa) for (const y of fb) if (pathOverlap(x, y)) return `touches ${x} ~ ${y}`;
  }
  const oa = ownerOf(a);
  const ob = ownerOf(b);
  if (oa !== null && ob !== null && ownerOverlap(oa, ob)) return `owner ${oa}`;
  return null;
}

/** null = every dependency is `[x]`; otherwise why the line must wait. */
function blockedBy(line: QueueLine, byId: ReadonlyMap<string, QueueLine>): string | null {
  const v = line.meta.after;
  if (v === undefined) return null;
  const waits: string[] = [];
  // Every id token is consumed; a plain word stays and makes the residue non-empty: prose beside
  // the ids is a condition only a human can judge.
  const rest = stripParens(v).replace(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g, tok => {
    const dep = byId.get(tok);
    if (dep) {
      if (dep.mark !== "x") waits.push(`${tok}[${dep.mark}]`);
    } else if (/^[A-Z]/.test(tok) && /\d/.test(tok)) {
      waits.push(`${tok}?`);
    } else {
      return tok;
    }
    return " ";
  });
  const residue = rest.replace(/[\s,+&;✅—–-]+/g, "");
  if (residue !== "") waits.push(`manual: "${stripParens(v).trim()}"`);
  return waits.length === 0 ? null : waits.join(", ");
}

/**
 * The repo a line works in, absolute: `repo:` as an absolute path; a name = the `base:` repo of
 * that basename, else the directory of that name beside the queue's project; no `repo:` = the
 * queue's project (the git root of the queue file's directory). null = the name resolves nowhere.
 */
export function resolveRepo(queue: Queue, line: QueueLine): string | null {
  const own = projectRoot(path.dirname(queue.file));
  const v = line.meta.repo?.trim();
  if (!v || v === "-" || v === "—") return own;
  if (path.isAbsolute(v)) return path.resolve(v);
  const base = queue.baseRepos.find(r => path.basename(r) === v);
  if (base) return base;
  const sibling = path.join(path.dirname(own), v);
  try {
    if (fs.statSync(sibling).isDirectory()) return sibling;
  } catch {
    /* no such directory */
  }
  return null;
}

/** The admission pass over a parsed queue; writes nothing. A bad `overlap:` header is refused. */
export function planPick(queue: Queue): Omit<PickResult, "dryRun"> {
  if (queue.overlapError !== undefined) throw new QueueError(queue.overlapError);
  const byId = new Map(queue.lines.map(l => [l.id, l]));
  const running = queue.lines.filter(l => l.mark === ">");
  const taken: QueueLine[] = [...running];
  const admitted: AdmittedTask[] = [];
  const reasons: { id: string; why: string }[] = [];
  const free = queue.batchSize - running.length;
  const repoKeys = new Map<QueueLine, string | null>(
    running.map(l => [l, repoKey(resolveRepo(queue, l))]),
  );
  for (const l of queue.lines) {
    if (l.mark !== " ") continue;
    let why: string | null = null;
    let repo: string | null = null;
    if (queue.batchSize === 0) why = "paused (batch_size 0)";
    else if (free <= admitted.length) why = "window full";
    else if ((l.meta.model ?? "").startsWith("—")) why = "parent-run (model —)";
    else if (l.paused) why = "⏸";
    else {
      const after = blockedBy(l, byId);
      if (after !== null) why = `after: ${after}`;
      else {
        repo = resolveRepo(queue, l);
        if (repo === null) why = `repo: "${l.meta.repo}" resolves to no directory`;
        else if (workflowOf(l) === null)
          why = `workflow: "${l.meta.workflow}" is not a workflow name`;
      }
      if (why === null) {
        const key = repoKey(repo);
        for (const t of taken) {
          const c = conflict(l, t, queue.overlap, key, repoKeys.get(t) ?? null);
          if (c !== null) {
            why = `overlaps ${t.id} (${c})`;
            break;
          }
        }
      }
    }
    if (why === null && repo !== null) {
      const workflow = workflowOf(l) ?? undefined;
      admitted.push({
        id: l.id,
        model: l.meta.model ?? "opus",
        effort: l.meta.effort ?? "-",
        repo,
        ...(workflow ? { workflow } : {}),
        text: l.text,
      });
      taken.push(l);
      repoKeys.set(l, repoKey(repo));
    } else reasons.push({ id: l.id, why: why ?? "?" });
  }
  const code: PickCode =
    admitted.length > 0
      ? QUEUE_EXIT.ADMITTED
      : running.length > 0
        ? QUEUE_EXIT.WAIT
        : queue.batchSize === 0
          ? QUEUE_EXIT.PAUSED
          : QUEUE_EXIT.DONE;
  return {
    file: queue.file,
    code,
    batchSize: queue.batchSize,
    batchComment: queue.batchComment,
    running: running.map(l => l.id),
    pending: queue.lines.filter(l => l.mark === " ").length,
    admitted,
    reasons,
  };
}

export function readQueue(file: string): Queue {
  const abs = path.resolve(file);
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (err) {
    throw new QueueError(`${abs}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
  }
  return parseQueue(text, abs);
}

const REPLAN_TRIES = 5;

/**
 * Writes `rows` over the queue only while the file still reads as `queue` did: a hand edit made
 * since the read (outside the lock) is never overwritten — false, and the caller plans again.
 */
function writeRows(queue: Queue, rows: readonly string[]): boolean {
  if (fs.readFileSync(queue.file, "utf8") !== queue.rows.join("\n")) return false;
  const tmp = `${queue.file}.wf-queue.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, rows.join("\n"));
  fs.renameSync(tmp, queue.file);
  return true;
}

/** `attempt` until it writes (true) or needs no write (a result); a queue that keeps changing is an error. */
function replanning<T>(file: string, attempt: () => T | false): T {
  for (let i = 0; i < REPLAN_TRIES; i++) {
    const r = attempt();
    if (r !== false) return r;
  }
  throw new QueueError(`${file} changed under every one of ${REPLAN_TRIES} writes`);
}

function setMark(rows: string[], line: QueueLine, mark: string, note?: string): void {
  const rest = rows[line.index].replace(/^- \[.\] \S+/, "");
  rows[line.index] = `- [${mark}] ${line.id}${note ? ` | ${note}` : ""}${rest}`;
}

/**
 * Exclusive lock beside the queue: the directory `<file>.lock` (mkdir is atomic across
 * processes), the same path the pre-engine picker script took, so both exclude each other.
 */
export async function withQueueLock<T>(file: string, fn: () => T): Promise<T> {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new QueueError(`${abs}: not found`);
  let release: (() => Promise<void>) | undefined;
  try {
    try {
      release = await lockfile.lock(abs, {
        stale: LOCK_STALE_MS,
        retries: LOCK_RETRIES,
        realpath: false,
      });
    } catch (err) {
      throw new QueueError(
        `${abs}.lock is held — another pick is writing the queue (${String(err)})`,
      );
    }
    return fn();
  } finally {
    if (release) await release();
  }
}

/** Pick under the lock and mark every admitted line `[>]`; `dryRun` reads without the lock or a write. */
export async function pickQueue(
  file: string,
  opts: { readonly dryRun?: boolean } = {},
): Promise<PickResult> {
  const dryRun = opts.dryRun === true;
  const run = (): PickResult | false => {
    const queue = readQueue(file);
    const plan = planPick(queue);
    if (!dryRun && plan.admitted.length > 0) {
      const rows = [...queue.rows];
      const ids = new Set(plan.admitted.map(a => a.id));
      for (const l of queue.lines) if (ids.has(l.id) && l.mark === " ") setMark(rows, l, ">");
      if (!writeRows(queue, rows)) return false;
    }
    return { ...plan, dryRun };
  };
  return dryRun ? replanning(file, run) : withQueueLock(file, () => replanning(file, run));
}

export interface MarkResult {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

// A note is one free-text field: a `|`, a leading `key:` or a `⏸` would rewrite the line's metadata.
function checkNote(note: string | undefined): void {
  if (note !== undefined && /[\n\r|⏸]|^\s*[a-z]+:/.test(note))
    throw new QueueError("a note is one line without `|`, `⏸` or a leading `key:`");
}

/**
 * One line's mark under the lock, only from the mark `to` expects; `note` lands right after the id.
 * `retry` (with `running` only) restarts a failed line: `[!]`→`[>]`.
 */
export async function markQueue(
  file: string,
  id: string,
  to: MarkTarget,
  note?: string,
  opts: { readonly retry?: boolean } = {},
): Promise<MarkResult> {
  if (!ID_RE.test(id)) throw new QueueError(`refused task id "${id}"`);
  checkNote(note);
  if (opts.retry === true && to !== "running")
    throw new QueueError("retry restarts a failed line: it goes with `running` only");
  const { from, to: mark } = opts.retry === true ? { from: "!", to: ">" } : MARK_TARGETS[to];
  return withQueueLock(file, () =>
    replanning(file, () => {
      const queue = readQueue(file);
      const line = lineOf(queue, id);
      if (line.mark !== from) {
        const hint =
          line.mark === "!" && to === "running" ? " (retry: true restarts a failed line)" : "";
        throw new QueueError(`${id} is [${line.mark}], expected [${from}]${hint}`);
      }
      const rows = [...queue.rows];
      setMark(rows, line, mark, note?.trim() || undefined);
      return writeRows(queue, rows) ? { id, from, to: mark } : false;
    }),
  );
}

function lineOf(queue: Queue, id: string): QueueLine {
  const line = queue.lines.find(l => l.id === id);
  if (!line) throw new QueueError(`no line ${id} in ${queue.file}`);
  return line;
}

/** A task row cut into its fields so that a rewrite keeps every untouched byte. */
interface RowFields {
  readonly mark: string;
  readonly id: string;
  /** The whitespace after the first ` |`. */
  readonly lead: string;
  readonly fields: string[];
  /** The line's closing ` |` (with what follows it), or "". */
  readonly closer: string;
}

function splitRow(row: string): RowFields {
  const m = LINE_RE.exec(row);
  if (!m) throw new QueueError(`not a task line: "${row}"`);
  const body = m[3];
  if (body === undefined || body.trim() === "")
    return { mark: m[1], id: m[2], lead: " ", fields: [], closer: body === undefined ? "" : " |" };
  const lead = /^\s*/.exec(body)?.[0] ?? "";
  const fields = body.slice(lead.length).split(" | ");
  const last = fields[fields.length - 1];
  const close = /\s*\|\s*$/.exec(last);
  let closer = "";
  if (close) {
    closer = close[0];
    fields[fields.length - 1] = last.slice(0, close.index);
    if (fields[fields.length - 1].trim() === "") fields.pop();
  }
  return { mark: m[1], id: m[2], lead, fields, closer };
}

function joinRow(r: RowFields): string {
  const head = `- [${r.mark}] ${r.id}`;
  return r.fields.length === 0 ? head : `${head} |${r.lead}${r.fields.join(" | ")}${r.closer}`;
}

/** The field's metadata key (`touches: a` → `touches`), the same test parseLine makes. */
function metaKey(field: string): string | null {
  const km = /^([a-z]+):/.exec(field.trim());
  return km && META_KEYS.has(km[1]) ? km[1] : null;
}

/** The `after:` ids that pick would wait on as unknown (`X?`). */
function unknownAfterIds(after: string, byId: ReadonlyMap<string, QueueLine>): string[] {
  const unknown: string[] = [];
  for (const tok of stripParens(after).match(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g) ?? [])
    if (!byId.has(tok) && /^[A-Z]/.test(tok) && /\d/.test(tok)) unknown.push(tok);
  return unknown;
}

/** A dependency path from `id` back to itself through `after:` ids, or null. */
function afterCycle(queue: Queue, id: string): string[] | null {
  const byId = new Map(queue.lines.map(l => [l.id, l]));
  const deps = (l: QueueLine): string[] =>
    (stripParens(l.meta.after ?? "").match(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g) ?? []).filter(
      t => byId.has(t),
    );
  const seen = new Set<string>();
  const walk = (cur: string, trail: string[]): string[] | null => {
    for (const d of deps(byId.get(cur) as QueueLine)) {
      if (d === id) return [...trail, d];
      if (seen.has(d)) continue;
      seen.add(d);
      const found = walk(d, [...trail, d]);
      if (found) return found;
    }
    return null;
  };
  return walk(id, [id]);
}

/**
 * Checks the fields `keys` of `line` (every metadata field when `keys` is undefined) as a pick
 * would read them in `queue` (which holds the line): `after:` names only lines of the queue and
 * closes no cycle, `workflow:` is one word, `repo:` resolves.
 */
function checkFields(queue: Queue, line: QueueLine, keys?: ReadonlySet<string>): void {
  const has = (k: string): boolean =>
    (keys === undefined || keys.has(k)) && line.meta[k] !== undefined;
  if (has("after")) {
    const byId = new Map(queue.lines.map(l => [l.id, l]));
    const unknown = unknownAfterIds(line.meta.after, byId);
    if (unknown.length > 0)
      throw new QueueError(`${line.id}: after: ${unknown.join(", ")} — no such line in the queue`);
    const cycle = afterCycle(queue, line.id);
    if (cycle) throw new QueueError(`${line.id}: after: closes a cycle ${cycle.join(" → ")}`);
  }
  if (has("workflow") && workflowOf(line) === null)
    throw new QueueError(`${line.id}: workflow: "${line.meta.workflow}" is not a workflow name`);
  if (has("repo") && resolveRepo(queue, line) === null)
    throw new QueueError(`${line.id}: repo: "${line.meta.repo}" resolves to no directory`);
}

/** The rows written, read back by the parser a pick uses; the line `id` as it now reads. */
function reparse(
  queue: Queue,
  rows: readonly string[],
  id: string,
): { queue: Queue; line: QueueLine } {
  const next = parseQueue(rows.join("\n"), queue.file);
  const lines = next.lines.filter(l => l.id === id);
  if (lines.length !== 1)
    throw new QueueError(`${id}: the written line does not read back as one line`);
  return { queue: next, line: lines[0] };
}

export interface AddResult {
  readonly id: string;
  /** 1-based line number of the new line in the file. */
  readonly lineNo: number;
}

/**
 * A new `[ ]` line under the lock: after the line `after`, before the line `before`, or after the
 * last task line. `line` is `- [ ] ID | key: value | … | text |` or the same without `- [ ] `. The
 * line must read as pick reads it: a unique id, one row, each `key:` field a known key at most
 * once, `after:` naming only lines of the queue (and no cycle), a one-word `workflow:`, a `repo:`
 * that resolves.
 */
export async function addQueueLine(
  file: string,
  line: string,
  pos: { readonly after?: string; readonly before?: string } = {},
): Promise<AddResult> {
  if (/[\n\r]/.test(line)) throw new QueueError("a queue line is one row");
  const row = line.trim().startsWith("- [") ? line.trim() : `- [ ] ${line.trim()}`;
  const r = splitRow(row);
  if (r.mark !== " ") throw new QueueError(`a new line is [ ], not [${r.mark}]`);
  if (!ID_RE.test(r.id)) throw new QueueError(`refused task id "${r.id}"`);
  const seenKeys = new Set<string>();
  for (const f of r.fields) {
    const k = metaKey(f);
    if (k !== null) {
      if (seenKeys.has(k))
        throw new QueueError(`${r.id}: ${k}: given twice (a pick reads the first)`);
      seenKeys.add(k);
      continue;
    }
    const km = /^([a-z_]+):(?!\/)/.exec(f.trim());
    if (km && f.length < PROSE_MIN)
      throw new QueueError(
        `${r.id}: unknown field "${km[1]}:" (keys: ${[...META_KEYS].join(", ")}) — a pick would read it as text`,
      );
  }
  if (pos.after !== undefined && pos.before !== undefined)
    throw new QueueError("after_id and before_id exclude each other");
  return withQueueLock(file, () =>
    replanning(file, () => {
      const queue = readQueue(file);
      if (queue.lines.some(l => l.id === r.id))
        throw new QueueError(`${r.id} is already in ${queue.file}`);
      let at: number;
      if (pos.after !== undefined) at = lineOf(queue, pos.after).index + 1;
      else if (pos.before !== undefined) at = lineOf(queue, pos.before).index;
      else {
        const last = queue.lines[queue.lines.length - 1];
        at = last ? last.index + 1 : queue.rows.findIndex(x => x.trim() === "## Tasks") + 1;
      }
      const rows = [...queue.rows];
      rows.splice(at, 0, joinRow(r));
      const next = reparse(queue, rows, r.id);
      checkFields(next.queue, next.line);
      return writeRows(queue, rows) ? { id: r.id, lineNo: at + 1 } : false;
    }),
  );
}

export interface EditResult {
  readonly id: string;
  /** The line as written. */
  readonly line: string;
}

/**
 * Sets metadata fields of one line under the lock (`""` removes the field) and/or appends a note
 * as its last field; the mark is `queue_mark`'s. A set field keeps its place (a duplicate of its
 * key goes); a new one goes after the line's last metadata field. The fields set must read as a
 * pick reads them (see addQueueLine).
 */
export async function editQueueLine(
  file: string,
  id: string,
  set: Readonly<Record<string, string>>,
  appendNote?: string,
): Promise<EditResult> {
  if (!ID_RE.test(id)) throw new QueueError(`refused task id "${id}"`);
  for (const [k, v] of Object.entries(set)) {
    if (!META_KEYS.has(k))
      throw new QueueError(`unknown field "${k}" (keys: ${[...META_KEYS].join(", ")})`);
    if (/[\n\r|]/.test(v)) throw new QueueError(`${k}: a value is one line without \`|\``);
  }
  checkNote(appendNote);
  const note = appendNote?.trim() || undefined;
  if (Object.keys(set).length === 0 && note === undefined)
    throw new QueueError("nothing to edit: give fields to set or a note");
  return withQueueLock(file, () =>
    replanning(file, () => {
      const queue = readQueue(file);
      const r = splitRow(queue.rows[lineOf(queue, id).index]);
      for (const [k, raw] of Object.entries(set)) {
        const v = raw.trim();
        const at = r.fields.findIndex(f => metaKey(f) === k);
        const kept = r.fields.filter((f, i) => i === at || metaKey(f) !== k);
        r.fields.splice(0, r.fields.length, ...kept);
        if (at >= 0) {
          const i = r.fields.findIndex(f => metaKey(f) === k);
          if (v === "") r.fields.splice(i, 1);
          else r.fields[i] = `${k}: ${v}`;
        } else if (v !== "") {
          let last = -1;
          r.fields.forEach((f, i) => {
            if (metaKey(f) !== null) last = i;
          });
          r.fields.splice(last + 1, 0, `${k}: ${v}`);
        }
      }
      if (note !== undefined) r.fields.push(note);
      const rows = [...queue.rows];
      const written = joinRow(r);
      rows[lineOf(queue, id).index] = written;
      const next = reparse(queue, rows, id);
      checkFields(next.queue, next.line, new Set(Object.keys(set)));
      return writeRows(queue, rows) ? { id, line: written } : false;
    }),
  );
}

export interface HeaderResult {
  readonly from: number;
  readonly to: number;
  readonly reason: string;
}

/** The header's `batch_size: N  # reason` under the lock: the window, `0` = the pause. */
export async function setQueueWindow(
  file: string,
  batchSize: number,
  reason: string,
): Promise<HeaderResult> {
  if (!Number.isInteger(batchSize) || batchSize < 0)
    throw new QueueError(`batch_size is a whole number ≥ 0, not ${batchSize}`);
  const why = reason.trim();
  if (why === "" || /[\n\r]/.test(why)) throw new QueueError("the reason is one non-empty line");
  return withQueueLock(file, () =>
    replanning(file, () => {
      const queue = readQueue(file);
      const at = queue.rows.findIndex(x => HEADER_RE.exec(x)?.[1] === "batch_size");
      const rows = [...queue.rows];
      rows[at] = `batch_size: ${batchSize}  # ${why}`;
      const next = parseQueue(rows.join("\n"), queue.file);
      if (next.batchSize !== batchSize)
        throw new QueueError("the batch_size line does not read back");
      return writeRows(queue, rows) ? { from: queue.batchSize, to: batchSize, reason: why } : false;
    }),
  );
}

// Reasons that say nothing about a line itself: with `explain` they fold into one summary line each.
const BLANK_WHY: ReadonlySet<string> = new Set(["window full", "paused (batch_size 0)"]);
const BLANK_NAMES = 5;

/**
 * The `--explain` lines: a line with a substantive reason (`after:`, `overlaps`, `⏸`, …) by name in
 * file order, then one line per blank reason (`N lines: window full — first: A, B …`). `all` = one
 * line per pending line.
 */
export function explainLines(reasons: PickResult["reasons"], mode: boolean | "all"): string[] {
  if (mode === false) return [];
  if (mode === "all") return reasons.map(x => `  ${x.id}: ${x.why}`);
  const out = reasons.filter(x => !BLANK_WHY.has(x.why)).map(x => `  ${x.id}: ${x.why}`);
  for (const why of BLANK_WHY) {
    const ids = reasons.filter(x => x.why === why).map(x => x.id);
    if (ids.length === 0) continue;
    if (ids.length === 1) out.push(`  ${ids[0]}: ${why}`);
    else {
      const more = ids.length > BLANK_NAMES ? " …" : "";
      out.push(
        `  ${ids.length} lines: ${why} — first: ${ids.slice(0, BLANK_NAMES).join(", ")}${more}`,
      );
    }
  }
  return out;
}

/** The pick's summary: counts, a pause, why nothing was admitted, and (with `explain`) why pending lines wait. */
export function formatPickSummary(r: PickResult, explain: boolean | "all"): string {
  const out: string[] = [];
  const running = r.running.length > 0 ? ` (${r.running.join(", ")})` : "";
  out.push(
    `queue ${r.file}: batch_size ${r.batchSize}, running ${r.running.length}${running}, ` +
      `pending ${r.pending}, admitted ${r.admitted.length}${r.dryRun ? " (dry run)" : ""}`,
  );
  if (r.batchSize === 0)
    out.push(`window 0 — paused${r.batchComment ? `: ${r.batchComment}` : ""}`);
  if (r.admitted.length === 0)
    out.push(
      r.code === QUEUE_EXIT.WAIT
        ? "nothing admitted: wait for a running line to end"
        : r.code === QUEUE_EXIT.PAUSED
          ? "nothing admitted and nothing runs: paused"
          : "nothing admitted and nothing runs: the queue is done (what stays pending is blocked)",
    );
  out.push(...explainLines(r.reasons, explain));
  return out.join("\n");
}

/** `ID\tmodel\teffort\trepo\tworkflow` — one admitted line as the exec form prints it (`-` = no `workflow:`). */
export function formatTask(a: AdmittedTask): string {
  return [a.id, a.model, a.effort, a.repo, a.workflow ?? "-"].join("\t");
}
