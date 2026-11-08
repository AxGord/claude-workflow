// A task queue in a YAML file, shared by every project: the top-level keys are the header —
// `batch_size: N` (the window; `0` = paused) with `reason:` (why it is that), `overlap:`, `base:`
// and any other `key: value` a workflow reads (`--header`) — and `tasks:`, a list of
// `{id, status, difficulty, model, effort, repo, workflow, after, touches, owner, exclusive, parked,
// text, notes}`. The file is the only truth: every write (pick, mark, add, edit, header) re-reads it
// under a lock beside it, edits the parsed document in place (key order and comments kept) and
// writes it only while the file still reads as it did.
//
// Admission (`planPick`, pure): free = batch_size minus the running tasks; a pending task in file
// order is admitted when its model is not `—` (parent-run), it is not `parked`, every `after:` id is
// done, its `repo:` resolves, and it overlaps neither a running task nor one admitted earlier in the
// same pick (`touches:` path prefixes on a `/` boundary, compared only between tasks of one repo,
// where a task without `touches:` overlaps every task; `owner:` equal or a `.`-prefix, across repos;
// `exclusive: true` overlaps every task of every repo). The header's `overlap: files` narrows
// `touches:` to its FILE entries (a regular file under the task's repo, or a path that does not
// exist whose last segment holds a `.`): a directory or glob entry is a hint that conflicts with
// nothing. A bad `overlap:` refuses the pick only; marks and edits still work. `workflow:` names the
// task's own task workflow (the dispatcher's default otherwise); `difficulty:` (1..10) is what a
// task workflow's `model_table` maps to model/effort. `backlog` tasks are never picked.
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import YAML, { type Document, isMap, isScalar, isSeq, Scalar, type YAMLMap, YAMLSeq } from "yaml";
import { projectRoot } from "./pool.js";
import { difficultyError, parseDifficulty } from "./model-table.js";
import { DIFFICULTY_MAX } from "./types.js";

export const QUEUE_EXIT = {
  ADMITTED: 0,
  WAIT: 10,
  DONE: 11,
  PAUSED: 12,
  ERROR: 2,
} as const;
export type PickCode = 0 | 10 | 11 | 12;

export const STATUSES = ["pending", "running", "done", "failed", "backlog"] as const;
export type Status = (typeof STATUSES)[number];

export const MARK_TARGETS = {
  running: { from: "pending", to: "running" },
  done: { from: "running", to: "done" },
  failed: { from: "running", to: "failed" },
  released: { from: "running", to: "pending" },
  promoted: { from: "backlog", to: "pending" },
  shelved: { from: "pending", to: "backlog" },
} as const satisfies Record<string, { from: Status; to: Status }>;
export type MarkTarget = keyof typeof MARK_TARGETS;

/** The task keys, in the order a new task is written. */
export const TASK_KEYS = [
  "id",
  "status",
  "difficulty",
  "priority",
  "model",
  "effort",
  "repo",
  "workflow",
  "after",
  "touches",
  "owner",
  "exclusive",
  "parked",
  "text",
  "notes",
] as const;
/** The keys `queue_edit` sets (status is the mark's, notes are appended, id is fixed). */
export const EDIT_KEYS: ReadonlySet<string> = new Set(
  TASK_KEYS.filter(k => k !== "id" && k !== "status" && k !== "notes"),
);
const LIST_KEYS: ReadonlySet<string> = new Set(["after", "touches"]);
const BOOL_KEYS: ReadonlySet<string> = new Set(["exclusive", "parked"]);
const NOTE_KEYS: ReadonlySet<string> = new Set(["from", "date", "text"]);
/** The header's `overlap:` values; `paths` (the default) = every `touches:` entry is a path prefix. */
const OVERLAP_MODES = ["paths", "files"] as const;
export type OverlapMode = (typeof OVERLAP_MODES)[number];
const ID_RE = /^[A-Za-z0-9._-]+$/;
// The lock outlives a dead holder by this long; proper-lockfile refreshes it while held.
const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = { retries: 300, minTimeout: 10, maxTimeout: 100, randomize: true };
/** How every write prints the document: no folding of long scalars. */
const YAML_OUT = { lineWidth: 0 } as const;

export class QueueError extends Error {}

export interface QueueNote {
  readonly from?: string;
  readonly date?: string;
  readonly text: string;
}

export interface QueueLine {
  /** Position in `tasks:`. */
  readonly index: number;
  readonly status: Status;
  readonly id: string;
  /** The task's fields as the picker reads them: lists joined by `, `, `exclusive: true` = "yes". */
  readonly meta: Readonly<Record<string, string>>;
  /** `parked: true`: never admitted until unparked. */
  readonly paused: boolean;
  readonly text: string;
  readonly notes: readonly QueueNote[];
}

export interface Queue {
  readonly file: string;
  /** The file's text as read: a write goes through only while the file still reads so. */
  readonly source: string;
  readonly lines: readonly QueueLine[];
  readonly batchSize: number;
  /** The header's `reason:` — why the window is what it is. */
  readonly batchComment?: string;
  /** Every top-level key but `tasks`, as a string (a list joined by `, `). */
  readonly header: Readonly<Record<string, string>>;
  /** The `base:` entries' repo paths (`<abs-path>=<sha>`). */
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
  /** The task's `workflow:` — its task workflow; absent = the dispatcher's own (`task_workflow`). */
  readonly workflow?: string;
  /** The task's `difficulty:` (1..10): the task workflow's `model_table` maps it to model/effort. */
  readonly difficulty?: number;
  /** The task's `priority:` when set (`normal` = absent): the picker admits higher first. */
  readonly priority?: Priority;
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
  /** One entry per pending task not admitted, in file order. */
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

/** A YAML value as text: a scalar as written, anything else as JSON. */
const str = (v: unknown): string =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null
    ? String(v)
    : (JSON.stringify(v) ?? "");
const scalarText = (v: unknown): string => (Array.isArray(v) ? v.map(str).join(", ") : str(v));

function parseNotes(v: unknown, at: string): QueueNote[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new QueueError(`${at}: notes: is a list`);
  return v.map((n, i) => {
    if (typeof n === "string") return { text: n };
    if (typeof n !== "object" || n === null || Array.isArray(n))
      throw new QueueError(`${at}: notes[${i}] is {from, date, text}`);
    const o = n as Record<string, unknown>;
    const bad = Object.keys(o).find(k => !NOTE_KEYS.has(k));
    if (bad !== undefined) throw new QueueError(`${at}: notes[${i}]: unknown key "${bad}"`);
    return {
      ...(o.from !== undefined ? { from: str(o.from) } : {}),
      ...(o.date !== undefined ? { date: str(o.date) } : {}),
      text: str(o.text ?? ""),
    };
  });
}

function parseTask(raw: unknown, index: number, file: string): QueueLine {
  const at = `${file}: tasks[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new QueueError(`${at} is not a mapping`);
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" || typeof o.id === "number" ? String(o.id) : "";
  if (!ID_RE.test(id)) throw new QueueError(`${at}: id "${id}" is not a task id`);
  const unknown = Object.keys(o).find(k => !(TASK_KEYS as readonly string[]).includes(k));
  if (unknown !== undefined)
    throw new QueueError(`${at} (${id}): unknown key "${unknown}" (keys: ${TASK_KEYS.join(", ")})`);
  const status = (o.status ?? "pending") as Status;
  if (!STATUSES.includes(status))
    throw new QueueError(
      `${at} (${id}): status "${String(o.status)}" is not one of ${STATUSES.join(", ")}`,
    );
  const meta: Record<string, string> = {};
  for (const k of [
    "difficulty",
    "priority",
    "model",
    "effort",
    "repo",
    "workflow",
    "owner",
    "after",
    "touches",
  ]) {
    const v = o[k];
    if (v === undefined || v === null) continue;
    if (LIST_KEYS.has(k) && !Array.isArray(v) && typeof v !== "string")
      throw new QueueError(`${at} (${id}): ${k}: is a list`);
    meta[k] = scalarText(v);
  }
  for (const k of BOOL_KEYS)
    if (o[k] !== undefined && o[k] !== null && typeof o[k] !== "boolean")
      throw new QueueError(`${at} (${id}): ${k}: is true or false`);
  if (o.exclusive === true) meta.exclusive = "yes";
  return {
    index,
    status,
    id,
    meta,
    paused: o.parked === true,
    text: o.text === undefined || o.text === null ? "" : str(o.text).trim(),
    notes: parseNotes(o.notes, `${at} (${id})`),
  };
}

export function parseQueue(text: string, file: string): Queue {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    throw new QueueError(`${file}: not YAML: ${(err as Error).message}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    throw new QueueError(`${file}: not a queue (a mapping with batch_size: and tasks:)`);
  const top = doc as Record<string, unknown>;
  const header: Record<string, string> = {};
  for (const [k, v] of Object.entries(top))
    if (k !== "tasks" && v !== null && v !== undefined) header[k] = scalarText(v);
  const bs = top.batch_size;
  if (typeof bs !== "number" || !Number.isInteger(bs) || bs < 0)
    throw new QueueError(`${file}: no "batch_size: N" (a whole number ≥ 0) in the header`);
  const tasks = top.tasks ?? [];
  if (!Array.isArray(tasks)) throw new QueueError(`${file}: tasks: is a list`);
  const lines = tasks.map((t, i) => parseTask(t, i, file));
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.id)) throw new QueueError(`${file}: ${l.id} is in tasks: twice`);
    seen.add(l.id);
  }
  const bases = top.base === undefined || top.base === null ? [] : [top.base].flat();
  const baseRepos = bases
    .map(b => /^(\/\S*?)=\S+$/.exec(str(b))?.[1])
    .filter((r): r is string => r !== undefined);
  const ov = (header.overlap ?? "paths").trim();
  const known = (OVERLAP_MODES as readonly string[]).includes(ov);
  const overlap: OverlapMode = known ? (ov as OverlapMode) : "paths";
  const overlapError = known
    ? undefined
    : `${file}: overlap: "${ov}" is not one of ${OVERLAP_MODES.join(", ")}`;
  const reason = header.reason?.trim();
  return {
    file,
    source: text,
    lines,
    batchSize: bs,
    ...(reason ? { batchComment: reason } : {}),
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

/** The line's `difficulty:`: undefined when absent or `-`/`—`; null when it is not 1..10. */
function difficultyOf(line: QueueLine): number | undefined | null {
  const v = line.meta.difficulty?.trim();
  if (!v || v === "-" || v === "—") return undefined;
  return parseDifficulty(v);
}

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** The line's `priority:`: `normal` when absent or `-`/`—`; null when it is not a priority. */
function priorityOf(line: QueueLine): Priority | null {
  const v = line.meta.priority?.trim().toLowerCase();
  if (!v || v === "-" || v === "—") return "normal";
  return (PRIORITIES as readonly string[]).includes(v) ? (v as Priority) : null;
}

/** Rank for sorting: urgent first; an unreadable priority ranks as normal (the pick refuses it). */
const priorityRank = (l: QueueLine): number => PRIORITIES.indexOf(priorityOf(l) ?? "normal");

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

/** null = every dependency is done; otherwise why the line must wait. */
function blockedBy(line: QueueLine, byId: ReadonlyMap<string, QueueLine>): string | null {
  const v = line.meta.after;
  if (v === undefined) return null;
  const waits: string[] = [];
  // Every id token is consumed; a plain word stays and makes the residue non-empty: prose beside
  // the ids is a condition only a human can judge.
  const rest = stripParens(v).replace(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g, tok => {
    const dep = byId.get(tok);
    if (dep) {
      if (dep.status !== "done") waits.push(`${tok} (${dep.status})`);
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
export function planPick(
  queue: Queue,
  opts: { readonly ignoreWindow?: boolean } = {},
): Omit<PickResult, "dryRun"> {
  if (queue.overlapError !== undefined) throw new QueueError(queue.overlapError);
  const byId = new Map(queue.lines.map(l => [l.id, l]));
  const running = queue.lines.filter(l => l.status === "running");
  const taken: QueueLine[] = [...running];
  const admitted: AdmittedTask[] = [];
  const reasons: { id: string; why: string; index: number }[] = [];
  const free = queue.batchSize - running.length;
  const repoKeys = new Map<QueueLine, string | null>(
    running.map(l => [l, repoKey(resolveRepo(queue, l))]),
  );
  const order = [...queue.lines].sort(
    (a, b) => priorityRank(a) - priorityRank(b) || a.index - b.index,
  );
  for (const l of order) {
    if (l.status !== "pending") continue;
    let why: string | null = null;
    let repo: string | null = null;
    if (queue.batchSize === 0) why = "paused (batch_size 0)";
    else if (opts.ignoreWindow !== true && free <= admitted.length) why = "window full";
    else if ((l.meta.model ?? "").startsWith("—")) why = "parent-run (model —)";
    else if (l.paused) why = "parked";
    else {
      const after = blockedBy(l, byId);
      if (after !== null) why = `after: ${after}`;
      else {
        repo = resolveRepo(queue, l);
        if (repo === null) why = `repo: "${l.meta.repo}" resolves to no directory`;
        else if (workflowOf(l) === null)
          why = `workflow: "${l.meta.workflow}" is not a workflow name`;
        else if (difficultyOf(l) === null) why = difficultyError(l.meta.difficulty);
        else if (priorityOf(l) === null)
          why = `priority: "${l.meta.priority}" is not one of ${PRIORITIES.join(", ")}`;
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
      const difficulty = difficultyOf(l) ?? undefined;
      const priority = priorityOf(l);
      admitted.push({
        id: l.id,
        model: l.meta.model ?? "opus",
        effort: l.meta.effort ?? "-",
        repo,
        ...(workflow ? { workflow } : {}),
        ...(difficulty !== undefined ? { difficulty } : {}),
        ...(priority !== null && priority !== "normal" ? { priority } : {}),
        text: l.text,
      });
      taken.push(l);
      repoKeys.set(l, repoKey(repo));
    } else reasons.push({ id: l.id, why: why ?? "?", index: l.index });
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
    pending: queue.lines.filter(l => l.status === "pending").length,
    admitted,
    reasons: reasons.sort((a, b) => a.index - b.index).map(({ id, why }) => ({ id, why })),
  };
}

export interface QueueLineView {
  readonly id: string;
  readonly status: Status;
  readonly difficulty?: string;
  readonly model?: string;
  readonly after?: string;
  readonly exclusive: boolean;
  readonly paused: boolean;
  readonly owner?: string;
  readonly touches?: string;
  readonly notes: number;
  /** The date of the task's last note (a land writes one), when it has one. */
  readonly lastNoteDate?: string;
  readonly text: string;
  /** Pending lines only: `ready`, or the picker's own reason (window ignored). */
  readonly reason?: string;
}

/** Every line of a queue with, for each pending one, the picker's reason evaluated without the window. */
export function describeQueue(queue: Queue): {
  readonly file: string;
  readonly batchSize: number;
  readonly lines: readonly QueueLineView[];
} {
  const plan = planPick(queue, { ignoreWindow: true });
  const why = new Map(plan.reasons.map(r => [r.id, r.why]));
  const ready = new Set(plan.admitted.map(a => a.id));
  return {
    file: queue.file,
    batchSize: queue.batchSize,
    lines: queue.lines.map(l => ({
      id: l.id,
      status: l.status,
      ...(l.meta.difficulty !== undefined ? { difficulty: l.meta.difficulty } : {}),
      ...(l.meta.model !== undefined ? { model: l.meta.model } : {}),
      ...(l.meta.after !== undefined ? { after: l.meta.after } : {}),
      ...(l.meta.owner !== undefined ? { owner: l.meta.owner } : {}),
      ...(l.meta.touches !== undefined ? { touches: l.meta.touches } : {}),
      exclusive: exclusiveOf(l),
      paused: l.paused,
      notes: l.notes.length,
      ...(l.notes.at(-1)?.date !== undefined ? { lastNoteDate: l.notes.at(-1)?.date } : {}),
      text: l.text,
      ...(l.status === "pending"
        ? { reason: ready.has(l.id) ? "ready" : (why.get(l.id) ?? "?") }
        : {}),
    })),
  };
}

/** The queue name a `queue:` argument may carry: one file-name stem, no path. */
const QUEUE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The queue file a tool or `wf-queue` call means. `file` (a full path) wins; else `queue` names
 * `.claude/batch/<queue>.yaml`, and neither names the project's default `.claude/batch/queue.yaml` —
 * the project being the git root of `cwd` (a linked worktree resolves to its main checkout).
 */
export function resolveQueueFile(
  sel: { readonly file?: string; readonly queue?: string },
  cwd: string = process.cwd(),
): string {
  if (sel.file !== undefined) {
    if (sel.queue !== undefined) throw new QueueError("give `file` or `queue`, not both");
    return path.resolve(cwd, sel.file);
  }
  const name = sel.queue ?? "queue";
  if (!QUEUE_NAME_RE.test(name))
    throw new QueueError(`refused queue name "${name}" (a file-name stem, no path)`);
  // A name is the stem: "q.yaml" would resolve to q.yaml.yaml and queue_add would create it.
  const ext = /\.(ya?ml|md)$/i.exec(name);
  if (ext)
    throw new QueueError(
      `refused queue name "${name}" (the stem without .${ext[1]}: "${name.slice(0, ext.index)}")`,
    );
  return path.join(projectRoot(cwd), ".claude", "batch", `${name}.yaml`);
}

function readText(file: string): { abs: string; text: string } {
  const abs = path.resolve(file);
  try {
    return { abs, text: fs.readFileSync(abs, "utf8") };
  } catch (err) {
    throw new QueueError(`${abs}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
  }
}

export function readQueue(file: string): Queue {
  const { abs, text } = readText(file);
  return parseQueue(text, abs);
}

const REPLAN_TRIES = 5;

/**
 * Writes `text` over the queue only while the file still reads as `queue` did: a hand edit made
 * since the read (outside the lock) is never overwritten — false, and the caller plans again.
 */
function writeText(queue: Queue, text: string): boolean {
  if (fs.readFileSync(queue.file, "utf8") !== queue.source) return false;
  const tmp = `${queue.file}.wf-queue.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text);
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

/**
 * Exclusive lock beside the queue: the directory `<file>.lock` (mkdir is atomic across
 * processes), so every writer of one queue excludes the others.
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

/** The editable form of a read queue: its document, and the `tasks:` list (made block-style). */
interface Editable {
  readonly queue: Queue;
  readonly doc: Document;
  readonly tasks: YAMLSeq;
}

function editable(file: string): Editable {
  const queue = readQueue(file);
  const doc = YAML.parseDocument(queue.source);
  const found: unknown = doc.get("tasks", true);
  const seq = isSeq(found) ? found : new YAMLSeq();
  if (seq !== found) doc.set("tasks", seq);
  seq.flow = false;
  return { queue, doc, tasks: seq };
}

function taskNode(e: Editable, line: QueueLine): YAMLMap {
  const node = e.tasks.items[line.index];
  if (!isMap(node)) throw new QueueError(`${line.id}: not a mapping in ${e.queue.file}`);
  return node;
}

/**
 * One write under the lock: `change` edits the document and returns the answer; the text it prints
 * must read back as a queue (and pass `check`) before it is written.
 */
function writing<T>(
  file: string,
  change: (e: Editable) => T,
  check?: (next: Queue, answer: T) => void,
): Promise<T> {
  return withQueueLock(file, () =>
    replanning(file, () => {
      const e = editable(file);
      const answer = change(e);
      const text = e.doc.toString(YAML_OUT);
      const next = parseQueue(text, e.queue.file);
      check?.(next, answer);
      return writeText(e.queue, text) ? answer : false;
    }),
  );
}

/**
 * The queue's whole text rewritten by `change` under the lock, written only while the file still
 * reads as it did (else re-read and run again); the result must read as a queue. Returns `change`'s
 * answer of the last run.
 */
export async function rewriteQueue<T>(
  file: string,
  change: (text: string) => { readonly text: string; readonly answer: T },
): Promise<T> {
  return withQueueLock(file, () =>
    replanning(file, () => {
      const queue = readQueue(file);
      const r = change(queue.source);
      parseQueue(r.text, queue.file);
      return writeText(queue, r.text) ? r.answer : false;
    }),
  );
}

/** Pick under the lock and mark every admitted task running; `dryRun` reads without the lock or a write. */
export async function pickQueue(
  file: string,
  opts: { readonly dryRun?: boolean } = {},
): Promise<PickResult> {
  if (opts.dryRun === true) return { ...planPick(readQueue(file)), dryRun: true };
  return withQueueLock(file, () =>
    replanning(file, () => {
      const e = editable(file);
      const plan = planPick(e.queue);
      if (plan.admitted.length > 0) {
        const ids = new Set(plan.admitted.map(a => a.id));
        for (const l of e.queue.lines)
          if (ids.has(l.id) && l.status === "pending") taskNode(e, l).set("status", "running");
        if (!writeText(e.queue, e.doc.toString(YAML_OUT))) return false;
      }
      return { ...plan, dryRun: false };
    }),
  );
}

export interface MarkResult {
  readonly id: string;
  readonly from: Status;
  readonly to: Status;
  /** A retry of a task with `difficulty:`: the value it had and the one written (+1, at most 10). */
  readonly difficulty?: { readonly from: number; readonly to: number };
}

/** The answer of a mark: `ID: failed → running`, plus the difficulty a retry raised. */
export function formatMark(r: MarkResult): string {
  const d = r.difficulty;
  const bump = !d
    ? ""
    : d.to > d.from
      ? ` (difficulty ${d.from} → ${d.to})`
      : ` (difficulty ${d.to}: already the cap)`;
  return `${r.id}: ${r.from} → ${r.to}${bump}`;
}

/** Today as `YYYY-MM-DD` (local time): a note's date. */
export function today(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function checkNote(note: string | undefined): void {
  if (note !== undefined && note.trim() === "" && note !== "")
    throw new QueueError("a note is not blank");
}

/** Appends `{from, date, text}` to the task's `notes:` (created when absent); `date` defaults to today. */
function addNote(e: Editable, node: YAMLMap, text: string, from: string, date = today()): void {
  const found: unknown = node.get("notes", true);
  const seq = isSeq(found) ? found : new YAMLSeq();
  if (seq !== found) node.set("notes", seq);
  seq.flow = false;
  seq.add(e.doc.createNode({ from, date, text }));
}

/**
 * One task's status under the lock, only from the status `to` expects; `note` goes to its `notes:`.
 * `retry` (with `running` only) restarts a failed task: failed → running, and raises its
 * `difficulty:` by one (at most 10) — the retried task's session starts a row up.
 */
export async function markQueue(
  file: string,
  id: string,
  to: MarkTarget,
  note?: string,
  opts: { readonly retry?: boolean; readonly from?: string } = {},
): Promise<MarkResult> {
  if (!ID_RE.test(id)) throw new QueueError(`refused task id "${id}"`);
  checkNote(note);
  if (opts.retry === true && to !== "running")
    throw new QueueError("retry restarts a failed task: it goes with `running` only");
  const { from, to: status }: { from: Status; to: Status } =
    opts.retry === true ? { from: "failed", to: "running" } : MARK_TARGETS[to];
  return writing(file, e => {
    const line = lineOf(e.queue, id);
    if (line.status !== from) {
      const hint =
        line.status === "failed" && to === "running" ? " (retry: true restarts a failed task)" : "";
      throw new QueueError(`${id} is ${line.status}, expected ${from}${hint}`);
    }
    const node = taskNode(e, line);
    node.set("status", status);
    const text = note?.trim();
    if (text) addNote(e, node, text, opts.from ?? "mark");
    const was = opts.retry === true ? difficultyOf(line) : undefined;
    let difficulty: MarkResult["difficulty"];
    if (typeof was === "number") {
      difficulty = { from: was, to: Math.min(was + 1, DIFFICULTY_MAX) };
      node.set("difficulty", difficulty.to);
    }
    return { id, from, to: status, ...(difficulty ? { difficulty } : {}) };
  });
}

function lineOf(queue: Queue, id: string): QueueLine {
  const line = queue.lines.find(l => l.id === id);
  if (!line) throw new QueueError(`no task ${id} in ${queue.file}`);
  return line;
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
 * Checks the fields `keys` of `line` (every field when `keys` is undefined) as a pick would read
 * them in `queue` (which holds the task): `after:` names only tasks of the queue and closes no
 * cycle, `workflow:` is one word, `repo:` resolves, `difficulty:` is 1..10.
 */
function checkFields(queue: Queue, line: QueueLine, keys?: ReadonlySet<string>): void {
  const has = (k: string): boolean =>
    (keys === undefined || keys.has(k)) && line.meta[k] !== undefined;
  if (has("after")) {
    const byId = new Map(queue.lines.map(l => [l.id, l]));
    const unknown = unknownAfterIds(line.meta.after, byId);
    if (unknown.length > 0)
      throw new QueueError(`${line.id}: after: ${unknown.join(", ")} — no such task in the queue`);
    const cycle = afterCycle(queue, line.id);
    if (cycle) throw new QueueError(`${line.id}: after: closes a cycle ${cycle.join(" → ")}`);
  }
  if (has("workflow") && workflowOf(line) === null)
    throw new QueueError(`${line.id}: workflow: "${line.meta.workflow}" is not a workflow name`);
  if (has("repo") && resolveRepo(queue, line) === null)
    throw new QueueError(`${line.id}: repo: "${line.meta.repo}" resolves to no directory`);
  if (has("difficulty") && difficultyOf(line) === null)
    throw new QueueError(`${line.id}: ${difficultyError(line.meta.difficulty)}`);
  if (has("priority") && priorityOf(line) === null)
    throw new QueueError(
      `${line.id}: priority: "${line.meta.priority}" is not one of ${PRIORITIES.join(", ")}`,
    );
}

/** Splits a list given as one string on its top-level commas (a `(…)` keeps its commas). */
export function splitList(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(s => s !== "" && s !== "—" && s !== "-");
}

/**
 * A task field's value as written: `after`/`touches` a list (a string is split on its commas),
 * `exclusive`/`parked` a boolean (`no`/`false`/`""` false), `difficulty` a number when it is one,
 * `text` a block scalar; null removes the field (`""`, null, or a false flag).
 */
function fieldValue(e: Editable, key: string, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === "") return null;
  if (LIST_KEYS.has(key)) {
    const list = Array.isArray(raw) ? raw.map(x => str(x).trim()) : splitList(str(raw));
    const seq = e.doc.createNode(list) as YAMLSeq;
    seq.flow = true;
    return seq;
  }
  if (BOOL_KEYS.has(key)) {
    const on = typeof raw === "boolean" ? raw : !/^(no|false|0|—|-)$/i.test(str(raw).trim());
    return on ? true : null;
  }
  if (key === "difficulty") return /^\d+$/.test(str(raw).trim()) ? Number(raw) : str(raw);
  if (typeof raw !== "string") throw new QueueError(`${key}: a value is a string`);
  if (key === "text") {
    const s = new Scalar(raw.trim());
    s.type = Scalar.BLOCK_LITERAL;
    return s;
  }
  if (/[\n\r]/.test(raw)) throw new QueueError(`${key}: a value is one line`);
  return raw.trim();
}

export interface AddResult {
  readonly id: string;
  /** 1-based line number of the new task in the file. */
  readonly lineNo: number;
  /** True when the queue file did not exist and this call created it. */
  readonly created?: true;
}

/** A new queue file's content: the minimal header a pick reads. */
const NEW_QUEUE = "batch_size: 1\ntasks: []\n";

/** A task given to `addQueueLine`: its id, fields by key, and its first notes. */
export type NewTask = Readonly<Record<string, unknown>>;

/** The 1-based line of task `id` in `text`. */
function lineNoOf(text: string, id: string): number {
  const doc = YAML.parseDocument(text);
  const tasks = doc.get("tasks", true);
  if (!isSeq(tasks)) return 0;
  const node = tasks.items.find(
    n => isMap(n) && isScalar(n.get("id", true)) && String(n.get("id")) === id,
  );
  const at = (node as { range?: [number, number, number] } | undefined)?.range?.[0] ?? 0;
  return text.slice(0, at).split("\n").length;
}

/**
 * A new pending (or backlog) task under the lock: after the task `after`, before the task `before`,
 * or last. The task must read as a pick reads it: a unique id, known keys, `after:` naming only
 * tasks of the queue (and no cycle), a one-word `workflow:`, a `repo:` that resolves, a
 * `difficulty:` of 1..10.
 */
export async function addQueueLine(
  file: string,
  task: NewTask,
  pos: { readonly after?: string; readonly before?: string } = {},
  opts: { readonly create?: boolean } = {},
): Promise<AddResult> {
  const id = typeof task.id === "string" ? task.id.trim() : "";
  if (!ID_RE.test(id)) throw new QueueError(`refused task id "${String(task.id)}"`);
  const unknown = Object.keys(task).find(k => !(TASK_KEYS as readonly string[]).includes(k));
  if (unknown !== undefined)
    throw new QueueError(`${id}: unknown key "${unknown}" (keys: ${TASK_KEYS.join(", ")})`);
  const status = task.status ?? "pending";
  if (status !== "pending" && status !== "backlog")
    throw new QueueError(`${id}: a new task is pending or backlog, not ${str(status)}`);
  if (pos.after !== undefined && pos.before !== undefined)
    throw new QueueError("after_id and before_id exclude each other");
  const place = (e: Editable): number => {
    if (e.queue.lines.some(l => l.id === id))
      throw new QueueError(`${id} is already in ${e.queue.file}`);
    const at =
      pos.after !== undefined
        ? lineOf(e.queue, pos.after).index + 1
        : pos.before !== undefined
          ? lineOf(e.queue, pos.before).index
          : e.tasks.items.length;
    const node = e.doc.createNode({ id }) as YAMLMap;
    for (const k of TASK_KEYS) {
      if (k === "id" || task[k] === undefined) continue;
      if (k === "status") node.set("status", status);
      else if (k === "notes") {
        for (const n of parseNotes(task.notes, id))
          addNote(e, node, n.text, n.from ?? "parent", n.date);
      } else {
        const v = fieldValue(e, k, task[k]);
        if (v !== null) node.set(k, v);
      }
    }
    if (task.status === undefined) node.items.splice(1, 0, e.doc.createPair("status", status));
    e.tasks.items.splice(at, 0, node);
    return at;
  };
  const check = (next: Queue): void => {
    checkFields(next, lineOf(next, id));
  };
  const abs = path.resolve(file);
  let created = false;
  if (opts.create === true && !fs.existsSync(abs)) {
    // the task is judged against the bare header BEFORE the file exists, so a refused first task
    // creates nothing and no rollback can delete a task another call wrote
    const doc = YAML.parseDocument(NEW_QUEUE);
    const tasks = doc.get("tasks", true) as YAMLSeq;
    tasks.flow = false;
    const e = { queue: parseQueue(NEW_QUEUE, abs), doc, tasks };
    place(e);
    check(parseQueue(doc.toString(YAML_OUT), abs));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    try {
      fs.writeFileSync(abs, NEW_QUEUE, { flag: "wx" });
      created = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  await writing(file, place, check);
  const lineNo = lineNoOf(fs.readFileSync(abs, "utf8"), id);
  return created ? { id, lineNo, created: true } : { id, lineNo };
}

export interface EditResult {
  readonly id: string;
  /** The task as written (YAML). */
  readonly task: string;
}

/**
 * Sets fields of one task under the lock (`""`/null removes the field) and/or appends a note to
 * its `notes:`; the status is `queue_mark`'s. A set field keeps its place; a new one goes where
 * TASK_KEYS orders it among the present ones. The fields set must read as a pick reads them
 * (see addQueueLine).
 */
export async function editQueueLine(
  file: string,
  id: string,
  set: Readonly<Record<string, unknown>>,
  appendNote?: string,
  noteFrom = "parent",
): Promise<EditResult> {
  if (!ID_RE.test(id)) throw new QueueError(`refused task id "${id}"`);
  for (const k of Object.keys(set))
    if (!EDIT_KEYS.has(k))
      throw new QueueError(`unknown field "${k}" (keys: ${[...EDIT_KEYS].join(", ")})`);
  const note = appendNote?.trim() || undefined;
  if (Object.keys(set).length === 0 && note === undefined)
    throw new QueueError("nothing to edit: give fields to set or a note");
  return writing(
    file,
    e => {
      const node = taskNode(e, lineOf(e.queue, id));
      for (const [k, raw] of Object.entries(set)) {
        const v = fieldValue(e, k, raw);
        if (v === null) node.delete(k);
        else if (node.has(k)) node.set(k, v);
        else {
          const order = TASK_KEYS.indexOf(k as (typeof TASK_KEYS)[number]);
          const at = node.items.findIndex(
            p =>
              TASK_KEYS.indexOf(String((p.key as Scalar).value) as (typeof TASK_KEYS)[number]) >
              order,
          );
          const pair = e.doc.createPair(k, v);
          if (at < 0) node.items.push(pair);
          else node.items.splice(at, 0, pair);
        }
      }
      if (note !== undefined) addNote(e, node, note, noteFrom);
      return { id, task: new YAML.Document(node).toString(YAML_OUT).trimEnd() };
    },
    next => checkFields(next, lineOf(next, id), new Set(Object.keys(set))),
  );
}

export interface HeaderResult {
  readonly from: number;
  readonly to: number;
  readonly reason: string;
}

/** The header's `batch_size: N` and `reason:` under the lock: the window, `0` = the pause. */
export async function setQueueWindow(
  file: string,
  batchSize: number,
  reason: string,
): Promise<HeaderResult> {
  if (!Number.isInteger(batchSize) || batchSize < 0)
    throw new QueueError(`batch_size is a whole number ≥ 0, not ${batchSize}`);
  const why = reason.trim();
  if (why === "" || /[\n\r]/.test(why)) throw new QueueError("the reason is one non-empty line");
  return writing(file, e => {
    e.doc.set("batch_size", batchSize);
    if (e.doc.has("reason")) e.doc.set("reason", why);
    else {
      const top = e.doc.contents as YAMLMap;
      const at = top.items.findIndex(p => String((p.key as Scalar).value) === "batch_size");
      top.items.splice(at + 1, 0, e.doc.createPair("reason", why));
    }
    return { from: e.queue.batchSize, to: batchSize, reason: why };
  });
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

/**
 * `ID\tmodel\teffort\trepo\tworkflow\tdifficulty` — one admitted line as the exec form prints it
 * (`-` = no `workflow:` / `difficulty:`).
 */
export function formatTask(a: AdmittedTask): string {
  return [a.id, a.model, a.effort, a.repo, a.workflow ?? "-", a.difficulty ?? "-"].join("\t");
}
