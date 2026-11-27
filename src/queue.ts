// A task queue in a YAML file, shared by every project: the top-level keys are the header —
// `batch_size: N` (the window; `0` = paused) with `reason:` (why it is that), `overlap:`, `base:`,
// `archive_after_days: N` (a pick first archives the done / failed lines that ended over N days ago)
// and any other `key: value` a workflow reads (`--header`) — and `tasks:`, a list of
// `{id, status, difficulty, kind, priority, model, effort, repo, workflow, after, touches, owner, sweep, on_end_tell_parent, exclusive,
// breaking, parked, split_from, split_into, ended, restored, added, base, text_hash, text, notes}`. The file is the only truth: every write (pick, mark, add, edit, header) re-reads it
// under a lock beside it, edits the parsed document in place (key order and comments kept) and
// writes it only while the file still reads as it did.
//
// Admission (`planPick`, pure): free = batch_size minus the running tasks; a pending task in file
// order is admitted when its model is not `—` (parent-run), it is not `parked`, every `after:` id is
// done, its `repo:` resolves, and it overlaps neither a running task nor one admitted earlier in the
// same pick (`touches:` path prefixes on a `/` boundary, compared only between tasks of one repo,
// where a task without `touches:` overlaps every task; `owner:` equal or a `.`-prefix, across repos;
// `exclusive: true` overlaps every task of its own repo; `breaking: true` is admitted only into an empty window and nothing is admitted while it runs).
// A pending exclusive line that waits only for running lines (or lines admitted earlier in the same pass) of its repo HOLDS the repo: no later line (priority, then file order) of that repo is admitted
// meanwhile, so the running ones drain and it starts; other repos are not held, and the header's `exclusive_hold: no` turns the hold off. The header's `overlap: files` narrows
// `touches:` to its FILE entries (a regular file under the task's repo, or a path that does not
// exist whose last segment holds a `.`): a directory or glob entry is a hint that conflicts with
// nothing. A bad `overlap:` refuses the pick only; marks and edits still work. `workflow:` names the
// task's own task workflow (the dispatcher's default otherwise; a `kind: research` line without one runs the repo's `research-task` when it has one); `difficulty:` (1..10) is what a
// task workflow's `model_table` maps to model/effort; `kind:` (`bug|feature|research`, absent = feature) is the
// task's type, reported by the pick. `backlog` tasks are never picked. A write that leaves a pending
// line (not parked, not `model: —`) with no `difficulty:` is refused; lines already without one stay.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import YAML, { type Document, isMap, isScalar, isSeq, Scalar, type YAMLMap, YAMLSeq } from "yaml";
import { CURATOR_WORKFLOW, curatorAdmission } from "./curator.js";
import { PRIORITIES, type Priority } from "./priority.js";
import { projectRoot } from "./pool.js";
import { kindMark } from "./map-layout.js";
import { difficultyError, parseDifficulty } from "./model-table.js";
import { waitTail } from "./queue-wait.js";
import { DIFFICULTY_MAX } from "./types.js";

export const QUEUE_EXIT = {
  ADMITTED: 0,
  WAIT: 10,
  DONE: 11,
  PAUSED: 12,
  ERROR: 2,
} as const;
export type PickCode = 0 | 10 | 11 | 12;

/** `awaiting`: the task's session stands at a human wait state (`human:`): the line holds no window slot, and only the pick's resume admits it again, once answered. */
export const STATUSES = ["pending", "running", "awaiting", "done", "failed", "backlog"] as const;
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
  "kind",
  "priority",
  "model",
  "effort",
  "repo",
  "workflow",
  "after",
  "touches",
  "split_from",
  "split_into",
  "owner",
  "sweep",
  "on_end_tell_parent",
  "owed_handed",
  "human_gate",
  "human_passed",
  "human_wait",
  "exclusive",
  "breaking",
  "parked",
  "ended",
  "restored",
  "added",
  "base",
  "text_hash",
  "text",
  "notes",
] as const;
/** Known state the engine writes (`ended` by the mark, `restored` by a restore, `owed_handed` by the engine once the owed step is handed to the parent, `added` by add, `base` / `text_hash` by add and edit, `human_wait` / `human_passed` by a human wait state, `split_into` by the batch add's split mark): never set by a caller. */
const STATE_KEYS: ReadonlySet<string> = new Set([
  "split_into",
  "owed_handed",
  "human_passed",
  "human_wait",
  "ended",
  "restored",
  "added",
  "base",
  "text_hash",
]);
/** The keys `queue_edit` sets (status is the mark's, state keys are the engine's, notes are appended, id is fixed). */
export const EDIT_KEYS: ReadonlySet<string> = new Set(
  TASK_KEYS.filter(k => k !== "id" && k !== "status" && k !== "notes" && !STATE_KEYS.has(k)),
);
const LIST_KEYS: ReadonlySet<string> = new Set(["after", "touches", "split_into"]);
const BOOL_KEYS: ReadonlySet<string> = new Set(["exclusive", "breaking", "parked"]);
const NOTE_KEYS: ReadonlySet<string> = new Set(["from", "date", "text"]);
/** The header's `overlap:` values; `paths` (the default) = every `touches:` entry is a path prefix. */
const OVERLAP_MODES = ["paths", "files"] as const;
export type OverlapMode = (typeof OVERLAP_MODES)[number];
const ID_RE = /^[A-Za-z0-9._-]+$/;
// The lock outlives a dead holder by this long; proper-lockfile refreshes it while held.
const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = {
  retries: 300,
  minTimeout: 10,
  maxTimeout: 100,
  randomize: true,
};
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
  /** Task keys this server does not know (written by newer code): kept on write, inert for the pick. */
  readonly unknownKeys: readonly string[];
  /** An `awaiting` line's wait, as the engine recorded it (`human_wait:`). */
  readonly humanWait?: HumanWaitRecord;
}

/**
 * The `human_wait:` mapping the engine writes on a line whose session entered a human wait state: when, which
 * session and state, the question and what to show. `answered` / `route` are written by the answer; the pick
 * then resumes the line before any pending one.
 */
export interface HumanWaitRecord {
  readonly since: string;
  readonly session: string;
  readonly state: string;
  readonly question: string;
  readonly show: readonly string[];
  readonly answered?: string;
  readonly route?: string;
}

export interface Queue {
  readonly file: string;
  /** The file's text as read: a write goes through only while the file still reads so. */
  readonly source: string;
  readonly lines: readonly QueueLine[];
  /**
   * The ids moved to `<queue>.archive.yaml` (`wf-queue --archive`) with their status: an `after:`
   * naming one reads it as that status, and a new line cannot take one's id.
   */
  readonly archived: ReadonlyMap<string, Status>;
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
  /** The task's `kind:`; `feature` when absent. */
  readonly kind: Kind;
  /** The task's `priority:` when set (`normal` = absent): the picker admits higher first. */
  readonly priority?: Priority;
  /** The task's `sweep:` when set: the command a sweep line runs over its tree. Data for the project's workflow; the pick gives it no meaning. */
  readonly sweep?: string;
  /** An answered `awaiting` line the pick resumes: its session, which keeps its state; no new session is started. */
  readonly resume?: string;
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
  /** `<ID> (<prio>) admitted ahead of exclusive <X> (<prio>)`: a same-repo line admitted in a pass that then held an exclusive line. */
  readonly overtakes?: readonly string[];
  /** The ids the header's `archive_after_days:` moved to the archive before this pick, in file order. */
  readonly archived?: readonly string[];
  /** Lines carrying a task key this server does not know, in file order. */
  readonly unknownKeys: readonly {
    readonly id: string;
    readonly keys: readonly string[];
  }[];
  /** What the curator admission did this pick (`curator: added <ID> (...)`, or why a config kept it out). */
  readonly curator?: string;
  /** The `awaiting` lines the pick did not resume, oldest wait first: `<ID> (answered <route>)` or `<ID> (since <time>)`. */
  readonly awaiting?: readonly string[];
  /** Admitted lines whose text asks for an owner's look or approval while the line has no `human_gate:` (`humanGateHint`). */
  readonly gateHints?: readonly string[];
}

/** `unknown key priority on X: ignored by this server` — one line per task with unknown keys. */
export function unknownKeyNotice(id: string, keys: readonly string[]): string {
  return `unknown key${keys.length > 1 ? "s" : ""} ${keys.join(", ")} on ${id}: ignored by this server`;
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
  const unknownKeys = Object.keys(o).filter(k => !(TASK_KEYS as readonly string[]).includes(k));
  const status = (o.status ?? "pending") as Status;
  if (!STATUSES.includes(status))
    throw new QueueError(
      `${at} (${id}): status "${String(o.status)}" is not one of ${STATUSES.join(", ")}`,
    );
  const meta: Record<string, string> = {};
  for (const k of [
    "difficulty",
    "kind",
    "priority",
    "model",
    "effort",
    "repo",
    "workflow",
    "owner",
    "sweep",
    "on_end_tell_parent",
    "owed_handed",
    "human_gate",
    "human_passed",
    "after",
    "touches",
    "split_from",
    "split_into",
    "ended",
    "restored",
    "added",
    "base",
    "text_hash",
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
  if (o.breaking === true) meta.breaking = "yes";
  const humanWait = parseHumanWait(o.human_wait, `${at} (${id})`);
  return {
    index,
    status,
    id,
    meta,
    paused: o.parked === true,
    text: o.text === undefined || o.text === null ? "" : str(o.text).trim(),
    notes: parseNotes(o.notes, `${at} (${id})`),
    unknownKeys,
    ...(humanWait ? { humanWait } : {}),
  };
}

function parseHumanWait(v: unknown, at: string): HumanWaitRecord | undefined {
  if (v === undefined || v === null) return undefined;
  const o = typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const text = (k: string): string | undefined =>
    typeof o[k] === "string" && o[k] !== "" ? o[k] : undefined;
  const since = text("since");
  const session = text("session");
  const state = text("state");
  if (since === undefined || session === undefined || state === undefined)
    throw new QueueError(
      `${at}: human_wait: is the engine's {since, session, state, question, show}`,
    );
  const answered = text("answered");
  const route = text("route");
  return {
    since,
    session,
    state,
    question: text("question") ?? "",
    show: Array.isArray(o.show) ? o.show.map(str).filter(s => s !== "") : [],
    ...(answered !== undefined ? { answered } : {}),
    ...(route !== undefined ? { route } : {}),
  };
}

/** `human_gate:` is one word: the kind of look the owner gives (`look`, `approve`). */
const HUMAN_GATE_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * Words in a line's text that ask for an owner's look or approval before the land. A line that says so without
 * `human_gate:` would land unseen: the pick and `queue_add` / `queue_edit` warn, they never refuse.
 */
const HUMAN_LOOK_RE =
  /\b(?:hold before land|look: ?true|(?:owner|user|human)(?:'s)? (?:look|approval|sign-?off)|(?:owner|user|human) (?:looks? at|approves?|compares?)|(?:wait|pause) for (?:the )?(?:owner|user|human))\b/i;

/** The phrase of `line`'s text that asks for an owner's look while the line has no `human_gate:`, or null. */
export function humanGateHint(line: QueueLine): string | null {
  if (line.meta.human_gate !== undefined) return null;
  const m = HUMAN_LOOK_RE.exec(line.text);
  return m === null ? null : m[0];
}

/** The line's gate when it is still to be passed: its `human_gate:` kind while no `human_passed:` is recorded; null otherwise. */
export function gateDue(file: string, id: string): string | null {
  const line = lineOf(readQueue(file), id);
  return line.meta.human_gate !== undefined && line.meta.human_passed === undefined
    ? line.meta.human_gate
    : null;
}

/** `queue_add` / `queue_edit`'s warning for a pending line whose text asks for an owner's look and carries no `human_gate:`. */
function gateWarnings(line: QueueLine): string[] {
  const phrase = line.status === "pending" ? humanGateHint(line) : null;
  return phrase === null ? [] : [gateHintNote(line, phrase)];
}

/**
 * `after:` gates only admission, so on a running line it holds nothing: an edit that makes the
 * line wait for a dependency that is not done (one it did not wait for before) says so.
 */
function afterRunningWarnings(
  queue: Queue,
  line: QueueLine,
  before: ReturnType<typeof blockedBy>,
): string[] {
  if (line.status !== "running") return [];
  const now = blockedBy(line, new Map(queue.lines.map(l => [l.id, l])), queue.archived);
  if (now === null) return [];
  const widened =
    now.ids.some(i => !(before?.ids ?? []).includes(i)) || (now.stuck && now.why !== before?.why);
  if (!widened) return [];
  return [
    `${line.id}: is running, and after: gates only admission — it waits for nothing now (not done: ${now.why}); the line keeps running and its driver is not told. The edit is recorded for a rerun`,
  ];
}

const gateHintNote = (line: QueueLine, phrase: string): string =>
  `${line.id}: its text asks for an owner's look ("${phrase}") but the line has no human_gate: key — it would land unseen; queue_edit set human_gate: look`;

export function parseQueue(
  text: string,
  file: string,
  archived: ReadonlyMap<string, Status> = new Map(),
): Queue {
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
    archived,
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

/**
 * The refusal of a pending line a pick would run that carries no `difficulty:`: the pane draws it
 * `?????` and the model table has no row for it. Backlog, parked, finished and parent-run (`model: —`)
 * lines need none. A write that makes a line read so is refused; lines already in the file are never.
 */
export function difficultyRequired(line: QueueLine): string | null {
  if (line.status !== "pending" || line.paused) return null;
  if ((line.meta.model ?? "").trim().startsWith("—")) return null;
  if (difficultyOf(line) !== undefined) return null;
  return `${line.id}: difficulty: <1-10> is required on a pending line (backlog, parked and model: — lines need none)`;
}

export { PRIORITIES, type Priority };

/** The line's `priority:`: `normal` when absent or `-`/`—`; null when it is not a priority. */
function priorityOf(line: QueueLine): Priority | null {
  const v = line.meta.priority?.trim().toLowerCase();
  if (!v || v === "-" || v === "—") return "normal";
  return (PRIORITIES as readonly string[]).includes(v) ? (v as Priority) : null;
}

/** Rank for sorting: urgent first; an unreadable priority ranks as normal (the pick refuses it). */
const priorityRank = (l: QueueLine): number => PRIORITIES.indexOf(priorityOf(l) ?? "normal");

/** The order the picker visits pending lines in: priority, then file order. One comparator for the pick and for `admitOrder`. */
const admissionOrder = (a: QueueLine, b: QueueLine): number =>
  priorityRank(a) - priorityRank(b) || a.index - b.index;

export const KINDS = ["bug", "feature", "research"] as const;
export type Kind = (typeof KINDS)[number];

/** The line's `kind:`: `feature` when absent or `-`/`—`; null when it is not a kind. */
function kindOf(line: QueueLine): Kind | null {
  const v = line.meta.kind?.trim().toLowerCase();
  if (!v || v === "-" || v === "—") return "feature";
  return (KINDS as readonly string[]).includes(v) ? (v as Kind) : null;
}

/** Why a `kind:` value is refused. */
const kindError = (line: QueueLine): string =>
  `kind: "${line.meta.kind}" is not one of ${KINDS.join(", ")}`;

/** The line's `workflow:`: undefined when absent or `—`; null when it is not a workflow name. */
function workflowOf(line: QueueLine): string | undefined | null {
  const v = line.meta.workflow?.trim();
  if (!v || v === "-" || v === "—") return undefined;
  return ID_RE.test(v) ? v : null;
}

/** The workflow a `kind: research` line runs when it names none (the project's own, when it has it). */
export const RESEARCH_WORKFLOW = "research-task";

/**
 * True when a session started in `repo` finds `research-task`: in the repo's own `.claude/workflows/`
 * or in the queue's project, the server tier every session also loads (`.yaml` or `.yml`).
 */
function hasResearchWorkflow(queue: Queue, repo: string): boolean {
  const roots = [repo, projectRoot(path.dirname(queue.file))];
  return roots.some(root =>
    [".yaml", ".yml"].some(ext =>
      fs.existsSync(path.join(root, ".claude", "workflows", `${RESEARCH_WORKFLOW}${ext}`)),
    ),
  );
}

/**
 * The workflow a pick starts for `line` in `repo`: its own `workflow:`; else, for `kind: research`, the
 * repo's (or the queue project's) `research-task` when it has one; else undefined (the dispatcher's `task_workflow`).
 */
function effectiveWorkflow(queue: Queue, line: QueueLine, repo: string): string | undefined {
  const own = workflowOf(line) ?? undefined;
  if (own !== undefined) return own;
  return kindOf(line) === "research" && hasResearchWorkflow(queue, repo)
    ? RESEARCH_WORKFLOW
    : undefined;
}

/** The workflow a line will run, as an answer says it: the line's own, the research pick, else the project default. */
function runsNote(queue: Queue, line: QueueLine): string[] {
  const repo = resolveRepo(queue, line);
  if (repo === null || kindOf(line) === null || workflowOf(line) === null) return [];
  const wf = effectiveWorkflow(queue, line, repo);
  if (wf !== undefined) return [`runs workflow ${wf}`];
  return kindOf(line) === "research" ? ["runs the project's default task workflow"] : [];
}

/** Warnings for a `kind: research` line whose workflow is not a research one. */
function kindWorkflowWarnings(queue: Queue, line: QueueLine): string[] {
  if (kindOf(line) !== "research") return [];
  const own = workflowOf(line);
  if (typeof own === "string" && !own.includes("research"))
    return [
      `${line.id} is kind: research but runs workflow ${own}: the pane draws ${kindMark({ kind: "research" })} and the line runs ${own}; a research line without workflow: runs ${RESEARCH_WORKFLOW}`,
    ];
  const repo = resolveRepo(queue, line);
  if (own === undefined && repo !== null && !hasResearchWorkflow(queue, repo))
    return [
      `${line.id} is kind: research but neither ${repo} nor the queue's project has .claude/workflows/${RESEARCH_WORKFLOW}.yaml: it runs the project's default task workflow`,
    ];
  return [];
}

function ownerOf(line: QueueLine): string | null {
  const v = line.meta.owner;
  if (v === undefined) return null;
  const o = stripParens(v).trim().replace(/\s+/g, " ");
  return o === "" || o === "—" ? null : o;
}

/** The line's `on_end_tell_parent:` text, trimmed; null when absent or blank. Data for the dispatcher's OWED hand-back: no pick rule reads it. */
export function owedTextOf(line: QueueLine): string | null {
  const v = line.meta.on_end_tell_parent?.trim();
  return v === undefined || v === "" ? null : v;
}

/** The line's `sweep:` command, trimmed; null when absent or blank. Carried as data: no pick rule reads it. */
function sweepOf(line: QueueLine): string | null {
  const v = line.meta.sweep?.trim();
  return v === undefined || v === "" ? null : v;
}

/** `exclusive:` with any value but an empty one or `—`: the line overlaps every other line. */
function exclusiveOf(line: QueueLine): boolean {
  const v = line.meta.exclusive?.trim();
  return v !== undefined && v !== "" && v !== "-" && v !== "—";
}

/** `breaking: true`: a format or protocol change running processes cannot follow; it runs alone in an empty window. */
function breakingOf(line: QueueLine): boolean {
  return line.meta.breaking?.trim() === "yes";
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

/** Count of git processes spawned for ignore checks (a test seam: one per repo per plan). */
export const ignoreProbes = { count: 0 };

/** One `git check-ignore --stdin -z` over `rels`: the entries it printed and its exit status. */
function checkIgnore(
  repo: string,
  rels: readonly string[],
): { out: string[]; status: number | null } {
  ignoreProbes.count++;
  const r = spawnSync("git", ["-C", repo, "check-ignore", "--stdin", "-z"], {
    input: `${rels.join("\0")}\0`,
    encoding: "utf8",
  });
  return {
    out: (r.stdout ?? "").split("\0").filter(x => x !== ""),
    status: r.status,
  };
}

/**
 * The entries of `rels` that git ignores in `repo`: ONE `git check-ignore --stdin`; empty when `repo` is no work tree.
 * Exit 0/1 is the answer. Any other exit (an entry past a symlink is fatal) keeps what was printed and
 * asks one by one about the rest, so a bad entry costs only itself.
 */
function gitIgnoredSet(repo: string, rels: readonly string[]): ReadonlySet<string> {
  if (rels.length === 0) return new Set();
  const all = checkIgnore(repo, rels);
  if (all.status === 0 || all.status === 1) return new Set(all.out);
  const found = new Set(all.out);
  for (const rel of rels) {
    if (found.has(rel)) continue;
    const one = checkIgnore(repo, [rel]);
    if (one.status === 0 && one.out.includes(rel)) found.add(rel);
  }
  return found;
}

/** Whether `t` names a path inside `repo` (git refuses the whole batch on one that is not). */
const insideRepo = (repo: string, t: string): boolean =>
  !path.isAbsolute(t) && !path.relative(repo, path.resolve(repo, t)).startsWith("..");

const isGlob = (t: string): boolean => /[*?[\]{}]/.test(t);

/** repo -> its ignored `touches:` entries over the pending repo-bound lines: one git process per repo. */
function ignoredByRepo(
  queue: Queue,
  lines: readonly QueueLine[],
): Map<string, ReadonlySet<string>> {
  const want = new Map<string, Set<string>>();
  for (const l of lines) {
    const v = l.meta.repo?.trim();
    if (!v || v === "-" || v === "—") continue;
    const repo = resolveRepo(queue, l);
    if (repo === null) continue;
    const set = want.get(repo) ?? new Set<string>();
    for (const t of touchesOf(l) ?? []) if (!isGlob(t) && insideRepo(repo, t)) set.add(t);
    want.set(repo, set);
  }
  return new Map([...want].map(([repo, set]) => [repo, gitIgnoredSet(repo, [...set])]));
}

/** The first `touches:` entry of a line that its repo's ignored set holds, or null. */
function ignoredTouch(line: QueueLine, ignored: ReadonlySet<string> | undefined): string | null {
  return (touchesOf(line) ?? []).find(t => ignored?.has(t) === true) ?? null;
}

/** Warnings for a line's `touches:` entries: git-ignored (the line runs in the parent), or a file whose directory is missing. */
function touchesWarnings(queue: Queue, line: QueueLine): string[] {
  const repo = resolveRepo(queue, line);
  if (repo === null) return [];
  const out: string[] = [];
  const v = line.meta.repo?.trim();
  const bound = !!v && v !== "-" && v !== "—";
  const ign = bound ? ignoredTouch(line, ignoredByRepo(queue, [line]).get(repo)) : null;
  if (ign !== null)
    out.push(
      `touches ${ign} is git-ignored in ${repo}: the picker treats ${line.id} as parent-run`,
    );
  for (const t of touchesOf(line) ?? []) {
    if (queue.overlap === "files" && !/[*?[\]{}]/.test(t) && !isFileEntry(t, repo))
      out.push(
        `${t} is a directory: under overlap: files it conflicts with nothing — name the files`,
      );
  }
  for (const t of touchesOf(line) ?? []) {
    if (/[*?[\]{}]/.test(t) || !(t.split("/").pop() ?? "").includes(".")) continue;
    const dir = path.dirname(path.resolve(repo, t));
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      /* missing */
    }
    if (!isDir) out.push(`touches ${t}: directory ${path.dirname(t)} does not exist in ${repo}`);
  }
  return out;
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

/** Two repo keys name one repo; a null key (a repo that resolves nowhere) counts as the same. */
function sameRepoKey(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

/**
 * The header's `exclusive_hold:` — `no` / `false` turn the hold of a waiting exclusive line off;
 * absent or any other value = on.
 */
export function exclusiveHoldOn(queue: Queue): boolean {
  const v = queue.header.exclusive_hold?.trim().toLowerCase();
  return v !== "no" && v !== "false";
}

/**
 * Why `a` and `b` may not run together, or null. `repoA`/`repoB` are their repo keys: `touches:`
 * (and its absence) compares only within one repo (a null key, a repo that resolves nowhere, counts
 * as the same) and so does `exclusive:` (it excludes its own repo only); `owner:` compares across repos.
 */
function conflict(
  a: QueueLine,
  b: QueueLine,
  mode: OverlapMode,
  repoA: string | null,
  repoB: string | null,
): string | null {
  const sameRepo = sameRepoKey(repoA, repoB);
  if (sameRepo && exclusiveOf(a)) return `exclusive ${a.id}`;
  if (sameRepo && exclusiveOf(b)) return `exclusive ${b.id}`;
  if (sameRepo) {
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

/**
 * What keeps a pending line out of a pick, as ids: `after` the queue lines its `after:` waits on that are not done, `stuck`
 * when part of that wait is no line's end (a prose condition, an unknown or archived id), `against` the line it may not run
 * beside (an overlap, a hold, a breaking line). `planPick` fills one per line it does not admit when it is asked (`PickOpts.blocks`).
 */
export interface PickBlock {
  readonly after: readonly string[];
  readonly stuck: boolean;
  readonly against?: {
    readonly how: "overlap" | "hold" | "runs-alone" | "window-not-empty";
    readonly id: string;
  };
}

/** The `split_into:` ids of a line, in order (empty when it was not split). */
function splitIntoOf(line: QueueLine): string[] {
  return (line.meta.split_into ?? "")
    .split(",")
    .map(t => t.trim())
    .filter(t => t !== "");
}

/**
 * What a split line (`failed` with `split_into:`) leaves a dependent to wait for: its slices, as the slices'
 * own ends read (a slice that was split in turn through its own slices). null = the line was not split. A split
 * line whose slices are all done lets its dependents go, so an `after:` on the parent is the slices' end.
 */
function splitWaits(
  line: QueueLine,
  byId: ReadonlyMap<string, QueueLine>,
  archived: ReadonlyMap<string, Status>,
  seen: ReadonlySet<string> = new Set(),
): { readonly waits: string[]; readonly ids: string[]; readonly stuck: boolean } | null {
  const into = splitIntoOf(line);
  if (into.length === 0) return null;
  const out = { waits: [] as string[], ids: [] as string[], stuck: false };
  for (const s of into) {
    const sl = byId.get(s);
    if (sl === undefined) {
      const gone = archived.get(s);
      if (gone === "done") continue;
      out.waits.push(gone === undefined ? `${s}?` : `${s} (${gone}, archived)`);
      out.stuck = true;
    } else if (sl.status === "done") continue;
    else {
      const deeper =
        sl.status === "failed" && !seen.has(s)
          ? splitWaits(sl, byId, archived, new Set([...seen, line.id]))
          : null;
      if (deeper !== null) {
        out.waits.push(...deeper.waits);
        out.ids.push(...deeper.ids);
        out.stuck ||= deeper.stuck;
      } else {
        out.waits.push(`${s} (${sl.status})`);
        out.ids.push(s);
      }
    }
  }
  return out;
}

/** null = every dependency is done; otherwise why the line must wait, and the queue lines whose end ends the wait. */
function blockedBy(
  line: QueueLine,
  byId: ReadonlyMap<string, QueueLine>,
  archived: ReadonlyMap<string, Status>,
): { readonly why: string; readonly ids: readonly string[]; readonly stuck: boolean } | null {
  const v = line.meta.after;
  if (v === undefined) return null;
  const waits: string[] = [];
  const ids: string[] = [];
  let stuck = false;
  // Every id token is consumed; a plain word stays and makes the residue non-empty: prose beside
  // the ids is a condition only a human can judge.
  const rest = stripParens(v).replace(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g, tok => {
    const dep = byId.get(tok);
    const gone = dep ? undefined : archived.get(tok);
    if (dep) {
      const slices = dep.status === "failed" ? splitWaits(dep, byId, archived) : null;
      if (slices !== null) {
        for (const w of slices.waits) waits.push(`${tok} (split) → ${w}`);
        for (const i of slices.ids) if (!ids.includes(i)) ids.push(i);
        if (slices.stuck) stuck = true;
      } else if (dep.status !== "done") {
        waits.push(`${tok} (${dep.status})`);
        if (!ids.includes(tok)) ids.push(tok);
      }
    } else if (gone !== undefined) {
      if (gone !== "done") {
        waits.push(`${tok} (${gone}, archived)`);
        stuck = true;
      }
    } else if (/^[A-Z]/.test(tok) && /\d/.test(tok)) {
      waits.push(`${tok}?`);
      stuck = true;
    } else {
      return tok;
    }
    return " ";
  });
  const residue = rest.replace(/[\s,+&;✅—–-]+/g, "");
  if (residue !== "") {
    waits.push(`manual: "${stripParens(v).trim()}"`);
    stuck = true;
  }
  return waits.length === 0 ? null : { why: waits.join(", "), ids, stuck };
}

/**
 * The repo a line works in, absolute: `repo:` as an absolute path; a name = the `base:` repo of
 * that basename, else the directory of that name beside the queue's project; no `repo:` = the
 * queue's project (the git root of the queue file's directory). null = the name resolves nowhere.
 */
export function resolveRepo(queue: Queue, line: QueueLine): string | null {
  return repoNamed(queue, line.meta.repo);
}

/** `resolveRepo` for a `repo:` value (undefined = the queue's project). */
export function repoNamed(queue: Queue, repo: string | undefined): string | null {
  const own = projectRoot(path.dirname(queue.file));
  const v = repo?.trim();
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
  opts: {
    readonly ignoreWindow?: boolean;
    readonly only?: string;
    /** filled with what keeps each line out that waits on other lines (not a parked, paused or malformed one) */
    readonly blocks?: Map<string, PickBlock>;
  } = {},
): Omit<PickResult, "dryRun"> {
  if (opts.only === undefined && queue.overlapError !== undefined)
    throw new QueueError(queue.overlapError);
  const byId = new Map(queue.lines.map(l => [l.id, l]));
  const running = queue.lines.filter(l => l.status === "running");
  // an awaiting line holds no window slot, but keeps its touches / owner / exclusive claim: its worktree waits for the answer
  const awaiting = queue.lines.filter(l => l.status === "awaiting");
  const taken: QueueLine[] = [...running, ...awaiting];
  const admitted: AdmittedTask[] = [];
  const reasons: { id: string; why: string; index: number }[] = [];
  const overtakes: string[] = [];
  const prio = (x: QueueLine): string => priorityOf(x) ?? "normal";
  const free = queue.batchSize - running.length;
  const holdOn = exclusiveHoldOn(queue);
  /** The pending exclusive lines waiting only for running lines of their repo: the repo key each holds. */
  const holds: { readonly id: string; readonly key: string | null }[] = [];
  const repoKeys = new Map<QueueLine, string | null>(
    taken.map(l => [l, repoKey(resolveRepo(queue, l))]),
  );
  // answered waits come back first, before any pending line: by priority, then the longest wait
  const waitingLeft: string[] = [];
  const answered = awaiting
    .filter(l => l.humanWait?.answered !== undefined)
    .sort(
      (a, b) =>
        priorityRank(a) - priorityRank(b) ||
        (a.humanWait?.since ?? "").localeCompare(b.humanWait?.since ?? "") ||
        a.index - b.index,
    );
  for (const l of opts.only === undefined ? answered : []) {
    const w = l.humanWait as HumanWaitRecord;
    const room = queue.batchSize > 0 && (opts.ignoreWindow === true || free > admitted.length);
    if (!room) {
      waitingLeft.push(`${l.id} (answered ${w.route ?? "?"}, resumes first)`);
      continue;
    }
    const repo = resolveRepo(queue, l) ?? "";
    const workflow = repo === "" ? undefined : effectiveWorkflow(queue, l, repo);
    const difficulty = difficultyOf(l) ?? undefined;
    const priority = priorityOf(l);
    admitted.push({
      id: l.id,
      model: l.meta.model ?? "opus",
      effort: l.meta.effort ?? "-",
      repo,
      ...(workflow ? { workflow } : {}),
      ...(difficulty !== undefined ? { difficulty } : {}),
      kind: kindOf(l) ?? "feature",
      ...(priority !== null && priority !== "normal" ? { priority } : {}),
      resume: w.session,
      text: l.text,
    });
  }
  for (const l of [...awaiting].sort((a, b) =>
    (a.humanWait?.since ?? "").localeCompare(b.humanWait?.since ?? ""),
  ))
    if (l.humanWait?.answered === undefined)
      waitingLeft.push(`${l.id} (since ${l.humanWait?.since ?? "?"})`);
  const ignoredIn = ignoredByRepo(
    queue,
    opts.only === undefined ? queue.lines.filter(l => l.status === "pending") : [],
  );
  const order = [...queue.lines].sort(admissionOrder);
  for (const l of order) {
    if (l.status !== "pending") continue;
    // `only`: a hand mark asks about one line; the window, a pause and parent-run are not its concern.
    if (opts.only !== undefined && l.id !== opts.only) continue;
    const hand = opts.only !== undefined;
    let why: string | null = null;
    let repo: string | null = null;
    let block: PickBlock | undefined;
    if (!hand && queue.batchSize === 0) why = "paused (batch_size 0)";
    else if (!hand && opts.ignoreWindow !== true && free <= admitted.length) why = "window full";
    else if (!hand && (l.meta.model ?? "").startsWith("—")) why = "parent-run (model —)";
    else if (l.paused) why = "parked";
    else {
      const after = blockedBy(l, byId, queue.archived);
      if (after !== null) {
        why = `after: ${after.why}`;
        block = { after: after.ids, stuck: after.stuck };
      } else {
        repo = resolveRepo(queue, l);
        if (repo === null) why = `repo: "${l.meta.repo}" resolves to no directory`;
        else if (workflowOf(l) === null)
          why = `workflow: "${l.meta.workflow}" is not a workflow name`;
        else if (difficultyOf(l) === null) why = difficultyError(l.meta.difficulty);
        else if (kindOf(l) === null) why = kindError(l);
        else if (priorityOf(l) === null)
          why = `priority: "${l.meta.priority}" is not one of ${PRIORITIES.join(", ")}`;
        else if (!hand) {
          const ign = ignoredTouch(l, ignoredIn.get(repo));
          if (ign !== null) why = `parent-run (touches ${ign} is git-ignored in its repo)`;
        }
      }
      if (why === null) {
        const key = repoKey(repo);
        const brk = taken.find(breakingOf);
        if (brk !== undefined) {
          why = `breaking ${brk.id} runs alone`;
          block = { after: [], stuck: false, against: { how: "runs-alone", id: brk.id } };
        } else if (breakingOf(l) && taken.length > 0) {
          why = `breaking: window not empty (${taken[0]?.id})`;
          block = {
            after: [],
            stuck: false,
            against: { how: "window-not-empty", id: taken[0]?.id ?? "" },
          };
        }
        const held = hand ? undefined : holds.find(h => sameRepoKey(key, h.key));
        if (held !== undefined && why === null) {
          why = `held for exclusive ${held.id}`;
          block = { after: [], stuck: false, against: { how: "hold", id: held.id } };
        }
        let overlapped = false;
        for (const t of why === null ? taken : []) {
          const c = conflict(l, t, queue.overlap, key, repoKeys.get(t) ?? null);
          if (c !== null) {
            why = `overlaps ${t.id} (${c})`;
            block = { after: [], stuck: false, against: { how: "overlap", id: t.id } };
            overlapped = true;
            break;
          }
        }
        if (
          overlapped &&
          holdOn &&
          !hand &&
          exclusiveOf(l) &&
          taken.some(r => sameRepoKey(key, repoKeys.get(r) ?? null))
        ) {
          holds.push({ id: l.id, key });
          for (const a of admitted) {
            const al = byId.get(a.id);
            if (al !== undefined && sameRepoKey(key, repoKeys.get(al) ?? null))
              overtakes.push(
                `${a.id} (${prio(al)}) admitted ahead of exclusive ${l.id} (${prio(l)})`,
              );
          }
        }
      }
    }
    if (why === null && repo !== null) {
      const workflow = effectiveWorkflow(queue, l, repo);
      const difficulty = difficultyOf(l) ?? undefined;
      const priority = priorityOf(l);
      const kind = kindOf(l) ?? "feature";
      const sweep = sweepOf(l) ?? undefined;
      admitted.push({
        id: l.id,
        model: l.meta.model ?? "opus",
        effort: l.meta.effort ?? "-",
        repo,
        ...(workflow ? { workflow } : {}),
        ...(difficulty !== undefined ? { difficulty } : {}),
        kind,
        ...(priority !== null && priority !== "normal" ? { priority } : {}),
        ...(sweep !== undefined ? { sweep } : {}),
        text: l.text,
      });
      taken.push(l);
      repoKeys.set(l, repoKey(repo));
    } else {
      reasons.push({ id: l.id, why: why ?? "?", index: l.index });
      if (block !== undefined) opts.blocks?.set(l.id, block);
    }
  }
  const gateHints = admitted.flatMap(a => {
    const line = byId.get(a.id);
    const phrase = line === undefined ? null : humanGateHint(line);
    return line === undefined || phrase === null ? [] : [gateHintNote(line, phrase)];
  });
  const code: PickCode =
    admitted.length > 0
      ? QUEUE_EXIT.ADMITTED
      : running.length > 0 || awaiting.length > 0
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
    ...(overtakes.length > 0 ? { overtakes } : {}),
    ...(waitingLeft.length > 0 ? { awaiting: waitingLeft } : {}),
    ...(gateHints.length > 0 ? { gateHints } : {}),
    reasons: reasons.sort((a, b) => a.index - b.index).map(({ id, why }) => ({ id, why })),
    unknownKeys: queue.lines
      .filter(l => l.unknownKeys.length > 0)
      .map(l => ({ id: l.id, keys: l.unknownKeys })),
  };
}

export interface QueueLineView {
  readonly id: string;
  readonly status: Status;
  readonly difficulty?: string;
  /** The line's kind, `feature` when it has none. */
  readonly kind: Kind;
  /** The kind's glyph (`kindMark`), the one the dashboard's views and the plan pane draw after the difficulty bar. */
  readonly mark: string;
  /** The workflow a pick starts for the line: its own `workflow:`, or `research-task` for a research line of a project that has it. Absent = the dispatcher's default. */
  readonly workflow?: string;
  readonly model?: string;
  readonly after?: string;
  /** The queue ids `after` names, as the picker resolves them. */
  readonly afterIds: readonly string[];
  readonly exclusive: boolean;
  readonly paused: boolean;
  readonly owner?: string;
  /** The line's `sweep:` command, when it has one. */
  readonly sweep?: string;
  /** The line's `on_end_tell_parent:` text: the step the parent owes when the line ends (done or failed). */
  readonly onEndTellParent?: string;
  readonly touches?: string;
  readonly notes: number;
  /** The date of the task's last note (a land writes one), when it has one. */
  readonly lastNoteDate?: string;
  /** The first line of the task's last note (a failed mark writes its reason there), when it has one. */
  readonly lastNote?: string;
  /** The commit the line landed as, read from its notes (`landedShaOf`): a land of a line with `repo:` set is in that repo, whose commits carry no `Slice:` trailer, so the plan pane's Landed row has no other source. */
  readonly landedSha?: string;
  /** The day (`YYYY-MM-DD`) `queue_mark` moved the line to done or failed, when it recorded one. */
  readonly ended?: string;
  /** The day (`YYYY-MM-DD`) `wf-queue --restore` brought the line back from the archive; the auto-archive counts its age from the later of this and `ended`. */
  readonly restored?: string;
  /** The ISO time `queue_add` / `wf-queue --add` wrote the line; absent on a line from before the record. */
  readonly added?: string;
  /** HEAD of the line's repo when its text, touches, owner, sweep or repo was last written (`queue_add` / `queue_edit`); absent on an older line or outside git. */
  readonly base?: string;
  /** The short hash of that text, touches, owner and sweep (`lineTextHash`); absent on an older line. */
  readonly textHash?: string;
  /** The line's `human_gate:` kind: it lands only after its task passed a human wait. */
  readonly humanGate?: string;
  /** When the task passed its human wait (`human_passed:`). */
  readonly humanPassed?: string;
  /** An `awaiting` line's wait: the question, what to show, since when, and the answer once recorded. */
  readonly humanWait?: HumanWaitRecord;
  readonly text: string;
  /** Pending lines only: `ready`, or the picker's own reason (window ignored). */
  readonly reason?: string;
  /** Pending lines the picker keeps out: the short tail a Next row draws (`waits: <id> (overlap)`, `after: <id> (running)`, `parked`, `breaking`), cut from the same refusal as `reason` (`waitTail`). */
  readonly wait?: string;
  /** A ready line's place in the picker's order (priority, then file order). */
  readonly pickOrder?: number;
  /**
   * While no pending line is admittable now: a pending line's place in the order the picker admits it once the running lines
   * have ended (it is kept out only by them). Absent on every other line.
   */
  readonly unblockOrder?: number;
  /** A pending line's place among the pending lines in the picker's visiting order (priority, then file order), whatever keeps it out now: the top of the waiting ones is the line that goes next once its wait clears. */
  readonly admitOrder?: number;
  /** Set when not `normal`. */
  readonly priority?: Priority;
}

const prioOf = (l: QueueLine): Priority | undefined => {
  const p = priorityOf(l);
  return p === null || p === "normal" ? undefined : p;
};

const lastNoteOf = (l: QueueLine): { lastNote?: string } => {
  const first = (l.notes.at(-1)?.text ?? "").trim().split("\n")[0]?.trim() ?? "";
  return first === "" ? {} : { lastNote: first };
};

/** The commit a `landed <sha>` note names (the mark's note of a land, any case; a trailing `YYYY-MM-DD;` detail follows it in some queues): the latest such note of the line, else none. */
export function landedShaOf(l: QueueLine): string | undefined {
  for (const n of [...l.notes].reverse()) {
    const m = /^landed\s+([0-9a-f]{7,40})\b/i.exec(n.text.trim());
    if (m !== null) return (m[1] ?? "").toLowerCase();
  }
  return undefined;
}

/**
 * With nothing admittable now and lines running: the ids the picker would admit once the running lines are done, by their place
 * in that pass. The pass is the picker's own, run on the queue with the running lines marked done (window ignored).
 */
function unblockedByRunning(
  queue: Queue,
  now: Pick<ReturnType<typeof planPick>, "admitted">,
): ReadonlyMap<string, number> {
  if (now.admitted.length > 0 || !queue.lines.some(l => l.status === "running")) return new Map();
  const after = planPick(
    {
      ...queue,
      lines: queue.lines.map(l => (l.status === "running" ? { ...l, status: "done" as const } : l)),
    },
    { ignoreWindow: true },
  );
  return new Map(after.admitted.map((a, i) => [a.id, i]));
}

/** `effectiveWorkflow` of a line whose repo and workflow read; undefined otherwise. */
function workflowView(queue: Queue, line: QueueLine): string | undefined {
  const repo = resolveRepo(queue, line);
  return repo === null || workflowOf(line) === null
    ? undefined
    : effectiveWorkflow(queue, line, repo);
}

/** Every line of a queue with, for each pending one, the picker's reason evaluated without the window. */
export function describeQueue(queue: Queue): {
  readonly file: string;
  readonly batchSize: number;
  /** The header's `land_branch:` (the branch the queue's lands target), set only when the header names one. */
  readonly landBranch?: string;
  /** The ids moved to the queue's archive (`<queue>.archive.yaml`), set only when there are some: a land inside the plan pane's window can be of an archived line. */
  readonly archivedIds?: readonly string[];
  readonly lines: readonly QueueLineView[];
} {
  const blocks = new Map<string, PickBlock>();
  const plan = planPick(queue, { ignoreWindow: true, blocks });
  const landBranch = queue.header.land_branch?.trim() ?? "";
  const why = new Map(plan.reasons.map(r => [r.id, r.why]));
  const fresh = plan.admitted.filter(a => a.resume === undefined);
  const ready = new Map(fresh.map((a, i) => [a.id, i]));
  const unblock = unblockedByRunning(queue, { admitted: fresh });
  const byId = new Map(queue.lines.map(l => [l.id, l]));
  const admit = new Map(
    queue.lines
      .filter(l => l.status === "pending")
      .sort(admissionOrder)
      .map((l, i) => [l.id, i]),
  );
  return {
    file: queue.file,
    batchSize: queue.batchSize,
    ...(landBranch !== "" ? { landBranch } : {}),
    ...(queue.archived.size > 0 ? { archivedIds: [...queue.archived.keys()] } : {}),
    lines: queue.lines.map(l => ({
      id: l.id,
      afterIds: afterIdsOf(l.meta.after, byId),
      status: l.status,
      ...(l.meta.difficulty !== undefined ? { difficulty: l.meta.difficulty } : {}),
      kind: kindOf(l) ?? "feature",
      mark: kindMark({ kind: kindOf(l) }),
      ...(workflowView(queue, l) !== undefined ? { workflow: workflowView(queue, l) } : {}),
      ...(l.meta.model !== undefined ? { model: l.meta.model } : {}),
      ...(l.meta.after !== undefined ? { after: l.meta.after } : {}),
      ...(l.meta.owner !== undefined ? { owner: l.meta.owner } : {}),
      ...(l.meta.sweep !== undefined ? { sweep: l.meta.sweep } : {}),
      ...(owedTextOf(l) !== null ? { onEndTellParent: owedTextOf(l) ?? "" } : {}),
      ...(l.meta.touches !== undefined ? { touches: l.meta.touches } : {}),
      exclusive: exclusiveOf(l),
      paused: l.paused,
      notes: l.notes.length,
      ...(l.notes.at(-1)?.date !== undefined ? { lastNoteDate: l.notes.at(-1)?.date } : {}),
      ...lastNoteOf(l),
      ...(landedShaOf(l) !== undefined ? { landedSha: landedShaOf(l) } : {}),
      ...(l.meta.ended !== undefined ? { ended: l.meta.ended } : {}),
      ...(l.meta.restored !== undefined ? { restored: l.meta.restored } : {}),
      ...(l.meta.added !== undefined ? { added: l.meta.added } : {}),
      ...(l.meta.base !== undefined ? { base: l.meta.base } : {}),
      ...(l.meta.text_hash !== undefined ? { textHash: l.meta.text_hash } : {}),
      ...(l.meta.human_gate !== undefined ? { humanGate: l.meta.human_gate } : {}),
      ...(l.meta.human_passed !== undefined ? { humanPassed: l.meta.human_passed } : {}),
      ...(l.humanWait !== undefined ? { humanWait: l.humanWait } : {}),
      text: l.text,
      ...(l.status === "pending"
        ? { reason: ready.has(l.id) ? "ready" : (why.get(l.id) ?? "?") }
        : {}),
      ...(l.status === "pending" && !ready.has(l.id)
        ? { wait: waitTail(why.get(l.id) ?? "?", blocks.get(l.id)?.against) }
        : {}),
      ...(ready.has(l.id) ? { pickOrder: ready.get(l.id) } : {}),
      ...(unblock.has(l.id) ? { unblockOrder: unblock.get(l.id) } : {}),
      ...(admit.has(l.id) ? { admitOrder: admit.get(l.id) } : {}),
      ...(prioOf(l) !== undefined ? { priority: prioOf(l) } : {}),
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
  return parseQueue(text, abs, archivedStatuses(abs));
}

/** The archive beside a queue: `queue.yaml` → `queue.archive.yaml`. */
export function archivePath(file: string): string {
  const abs = path.resolve(file);
  return /\.ya?ml$/i.test(abs) ? abs.replace(/\.(ya?ml)$/i, ".archive.$1") : `${abs}.archive.yaml`;
}

const archiveCache = new Map<
  string,
  { readonly stamp: string; readonly ids: Map<string, Status> }
>();

/** id → status of every line in the queue's archive (empty when there is none); re-read only when the file changed. */
function archivedStatuses(file: string): Map<string, Status> {
  const arch = archivePath(file);
  let st: fs.Stats;
  try {
    st = fs.statSync(arch);
  } catch {
    return new Map();
  }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = archiveCache.get(arch);
  if (hit?.stamp === stamp) return hit.ids;
  let doc: unknown;
  try {
    doc = YAML.parse(fs.readFileSync(arch, "utf8"));
  } catch (err) {
    throw new QueueError(`${arch}: not YAML: ${(err as Error).message}`);
  }
  const tasks = (doc as { tasks?: unknown } | null)?.tasks ?? [];
  if (!Array.isArray(tasks)) throw new QueueError(`${arch}: tasks: is a list`);
  const ids = new Map<string, Status>();
  tasks.forEach((t, i) => {
    const l = parseTask(t, i, arch);
    ids.set(l.id, l.status);
  });
  archiveCache.set(arch, { stamp, ids });
  return ids;
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
      const next = parseQueue(text, e.queue.file, e.queue.archived);
      check?.(next, answer);
      return writeText(e.queue, text) ? answer : false;
    }),
  );
}

/** The refusal of an id the queue's archive holds: a new line may not take it. */
function archivedIdError(queue: Queue, id: string): QueueError {
  return new QueueError(`${id} is already in ${archivePath(queue.file)} (archived)`);
}

/**
 * `text` must read as a queue, and none of the lines it adds to `queue` may carry an id the archive
 * holds (a line already in both files, left by a crash, stays readable).
 */
export function refuseArchivedIds(queue: Queue, text: string): void {
  const had = new Set(queue.lines.map(l => l.id));
  for (const l of parseQueue(text, queue.file, queue.archived).lines)
    if (!had.has(l.id) && queue.archived.has(l.id)) throw archivedIdError(queue, l.id);
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
      refuseArchivedIds(queue, r.text);
      return writeText(queue, r.text) ? r.answer : false;
    }),
  );
}

/** The header's `archive_after_days: N` (a whole number ≥ 0); absent = no automatic archiving. */
export function archiveAfterDays(queue: Queue): number | undefined {
  const raw = queue.header.archive_after_days?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw))
    throw new QueueError(
      `${queue.file}: archive_after_days: "${raw}" is not a whole number of days`,
    );
  return Number(raw);
}

/**
 * The header's `lessons_every: N` (a whole number ≥ 1): how many lands the dispatcher agent lets pass between its LESSONS
 * messages (it reads the key from the file, so the pick is where a bad value is refused); absent = the agent's default.
 */
export function lessonsEvery(queue: Queue): number | undefined {
  const raw = queue.header.lessons_every?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!/^[1-9]\d*$/.test(raw))
    throw new QueueError(
      `${queue.file}: lessons_every: "${raw}" is not a whole number of lands (1 or more)`,
    );
  return Number(raw);
}

/** Minutes a running task session may stand STALE before the dispatcher's `collect` raises it as a NEEDS-PARENT line. */
export const STALE_TASK_AFTER_DEFAULT_MIN = 60;

/**
 * The header's `stale_task_after: N` (a whole number of minutes ≥ 1): how long a task session may stay STALE
 * before `collect` surfaces it as a NEEDS-PARENT line; absent = `STALE_TASK_AFTER_DEFAULT_MIN`.
 */
export function staleTaskAfter(queue: Queue): number | undefined {
  const raw = queue.header.stale_task_after?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!/^[1-9]\d*$/.test(raw))
    throw new QueueError(
      `${queue.file}: stale_task_after: "${raw}" is not a whole number of minutes (1 or more)`,
    );
  return Number(raw);
}

/**
 * Pick under the lock and mark every admitted task running; `dryRun` reads without the lock or a write.
 * With the header's `archive_after_days: N`, the done / failed lines that ended more than N days ago
 * move to the archive first, under the same lock (what `archiveQueue` moves; no line without `ended:`).
 */
export async function pickQueue(
  file: string,
  opts: { readonly dryRun?: boolean } = {},
): Promise<PickResult> {
  lessonsEvery(readQueue(file));
  staleTaskAfter(readQueue(file));
  if (opts.dryRun === true) return { ...planPick(readQueue(file)), dryRun: true };
  return withQueueLock(file, () => {
    const days = archiveAfterDays(readQueue(file));
    const archived = days === undefined ? [] : archiveLocked(file, { olderThanDays: days }).moved;
    // A due curator run joins the queue as an ordinary line, so the window, the pick and the land count it.
    const curator = curatorAdmission(readQueue(file));
    return replanning(file, () => {
      const e = editable(file);
      let queue = e.queue;
      const add = curator.line;
      if (add !== undefined && !queue.lines.some(l => l.id === add.id)) {
        const node = e.doc.createNode({
          id: add.id,
          status: "pending",
          difficulty: add.difficulty,
          priority: add.priority,
          workflow: CURATOR_WORKFLOW,
          touches: [],
          text: add.text,
        }) as YAMLMap;
        setOrdered(e, node, "added", new Date().toISOString());
        e.tasks.items.push(node);
        queue = parseQueue(e.doc.toString(YAML_OUT), queue.file, queue.archived);
      }
      const plan = planPick(queue);
      if (plan.admitted.length > 0 || queue !== e.queue) {
        const ids = new Set(plan.admitted.map(a => a.id));
        for (const l of queue.lines) {
          if (!ids.has(l.id)) continue;
          if (l.status === "pending") taskNode(e, l).set("status", "running");
          if (l.status === "awaiting") {
            // resumed: the answer is on its session now, the wait record goes
            const node = taskNode(e, l);
            node.set("status", "running");
            node.delete("human_wait");
          }
        }
        if (!writeText(e.queue, e.doc.toString(YAML_OUT))) return false;
      }
      return {
        ...plan,
        dryRun: false,
        ...(archived.length > 0 ? { archived } : {}),
        ...(curator.note !== undefined ? { curator: curator.note } : {}),
      };
    });
  });
}

export interface ArchiveResult {
  readonly archive: string;
  /** The ids moved (or, on a dry run, that would move), in file order. */
  readonly moved: readonly string[];
  /** Ended lines old enough but kept: a failed line an open line's `after:` names. */
  readonly keptNamed: readonly string[];
  /** done / failed lines with no `ended:`: they stay unless `includeUnended`. */
  readonly unended: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly dryRun: boolean;
}

/** The local date `days` before `now`, `YYYY-MM-DD`. */
function daysBefore(days: number, now: Date): string {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return today(d);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The day a line's archive age counts from: its `ended:`, or the later `restored:` day of a line brought back from the archive; none without a dated `ended:`. */
function ageDay(meta: Readonly<Record<string, string>>): string | undefined {
  const ended = meta.ended;
  if (ended === undefined || !DAY_RE.test(ended)) return undefined;
  const restored = meta.restored;
  return restored !== undefined && DAY_RE.test(restored) && restored > ended ? restored : ended;
}

function archivePlan(
  queue: Queue,
  opts: {
    readonly olderThanDays: number;
    readonly includeUnended?: boolean;
    readonly now?: Date;
  },
): Pick<ArchiveResult, "moved" | "keptNamed" | "unended"> {
  const cutoff = daysBefore(opts.olderThanDays, opts.now ?? new Date());
  const byId = new Map(queue.lines.map(l => [l.id, l]));
  const named = new Set<string>();
  for (const l of queue.lines)
    if (l.status !== "done" && l.status !== "failed")
      for (const t of afterIdsOf(l.meta.after, byId)) named.add(t);
  // a split line a line waits on is waited on through its slices, at every level of the split
  const down = [...named];
  for (let t = down.pop(); t !== undefined; t = down.pop()) {
    const l = byId.get(t);
    if (l === undefined) continue;
    for (const s of splitIntoOf(l))
      if (!named.has(s)) {
        named.add(s);
        down.push(s);
      }
  }
  const moved: string[] = [];
  const keptNamed: string[] = [];
  let unended = 0;
  for (const l of queue.lines) {
    if (l.status !== "done" && l.status !== "failed") continue;
    const ended = ageDay(l.meta);
    const dated = ended !== undefined;
    if (!dated) {
      if (opts.includeUnended === true) {
        if (l.status === "failed" && named.has(l.id)) keptNamed.push(l.id);
        else moved.push(l.id);
      } else unended++;
    } else if (ended < cutoff) {
      if (l.status === "failed" && named.has(l.id)) keptNamed.push(l.id);
      else moved.push(l.id);
    }
  }
  return { moved, keptNamed, unended };
}

/**
 * Moves done and failed lines that ended before `olderThanDays` days ago into the queue's archive
 * (`archivePath`), appending, under the queue's lock. A line with no `ended:` stays unless
 * `includeUnended`; a failed line an open line's `after:` names stays. The archive is written first,
 * so a crash between the two writes leaves a line in both, and a re-run only removes it from the queue.
 */
export async function archiveQueue(
  file: string,
  opts: {
    readonly olderThanDays: number;
    readonly includeUnended?: boolean;
    readonly dryRun?: boolean;
    readonly now?: Date;
  },
): Promise<ArchiveResult> {
  if (!Number.isInteger(opts.olderThanDays) || opts.olderThanDays < 0)
    throw new QueueError("older-than is a whole number of days (0 or more)");
  const archive = archivePath(file);
  if (opts.dryRun === true) {
    const q = readQueue(file);
    const size = Buffer.byteLength(q.source);
    return {
      archive,
      ...archivePlan(q, opts),
      bytesBefore: size,
      bytesAfter: size,
      dryRun: true,
    };
  }
  return withQueueLock(file, () => archiveLocked(file, opts));
}

/** The archive move itself, for a caller already holding the queue's lock. */
function archiveLocked(
  file: string,
  opts: {
    readonly olderThanDays: number;
    readonly includeUnended?: boolean;
    readonly now?: Date;
  },
): ArchiveResult {
  const archive = archivePath(file);
  return replanning(file, () => {
    const e = editable(file);
    const plan = archivePlan(e.queue, opts);
    const bytesBefore = Buffer.byteLength(e.queue.source);
    if (plan.moved.length === 0)
      return {
        archive,
        ...plan,
        bytesBefore,
        bytesAfter: bytesBefore,
        dryRun: false,
      };
    const adoc = YAML.parseDocument(
      fs.existsSync(archive) ? fs.readFileSync(archive, "utf8") : "tasks: []\n",
    );
    const found: unknown = adoc.get("tasks", true);
    const aseq = isSeq(found) ? found : new YAMLSeq();
    if (aseq !== found) adoc.set("tasks", aseq);
    aseq.flow = false;
    const have = e.queue.archived;
    const out = new Set(plan.moved);
    let appended = 0;
    for (const l of e.queue.lines) {
      if (!out.has(l.id)) continue;
      const node = taskNode(e, l);
      if (!have.has(l.id)) {
        aseq.add(node);
        appended++;
        continue;
      }
      // held in both files (a crash between the writes): the queue's copy is the fresher one
      const at = aseq.items.findIndex(n => isMap(n) && String(n.get("id")) === l.id);
      const held = aseq.items[at];
      if (isMap(held) && JSON.stringify(held.toJSON()) !== JSON.stringify(node.toJSON())) {
        aseq.items[at] = node;
        appended++;
      }
    }
    const gone = new Set(e.queue.lines.filter(l => out.has(l.id)).map(l => l.index));
    for (let i = e.tasks.items.length - 1; i >= 0; i--) if (gone.has(i)) e.tasks.items.splice(i, 1);
    const text = e.doc.toString(YAML_OUT);
    const merged = new Map(have);
    for (const l of e.queue.lines) if (out.has(l.id)) merged.set(l.id, l.status);
    parseQueue(text, e.queue.file, merged);
    const archiveText = adoc.toString(YAML_OUT);
    if (appended > 0) {
      const tmp = `${archive}.wf-queue.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      if (fs.readFileSync(e.queue.file, "utf8") !== e.queue.source) return false;
      fs.writeFileSync(tmp, archiveText);
      fs.renameSync(tmp, archive);
    }
    if (!writeText(e.queue, text)) return false;
    return {
      archive,
      ...plan,
      bytesBefore,
      bytesAfter: Buffer.byteLength(text),
      dryRun: false,
    };
  });
}

export interface RestoreResult {
  readonly id: string;
  readonly status: Status;
  readonly archive: string;
  /** The line was already in the queue (a crash left it in both files): only the archive's copy went. */
  readonly inQueue: boolean;
}

/**
 * Moves one line, whole, from the queue's archive back into the queue (appended at the end), under
 * the queue's lock; its status and `ended:` stay as archived, and a done / failed line gets `restored:` (today), so the auto-archive counts its age from the restore. The queue is written first, so a crash
 * between the writes leaves the line in both files and a re-run only removes the archive's copy.
 */
export async function restoreQueue(file: string, id: string): Promise<RestoreResult> {
  const archive = archivePath(file);
  return withQueueLock(file, () =>
    replanning(file, () => {
      const e = editable(file);
      const status = e.queue.archived.get(id);
      if (status === undefined) throw new QueueError(`${id} is not in ${archive}`);
      const adoc = YAML.parseDocument(fs.readFileSync(archive, "utf8"));
      const found: unknown = adoc.get("tasks", true);
      const aseq = isSeq(found) ? found : new YAMLSeq();
      const at = aseq.items.findIndex(n => isMap(n) && String(n.get("id")) === id);
      const node = aseq.items[at];
      if (!isMap(node)) throw new QueueError(`${id} is not in ${archive}`);
      const inQueue = e.queue.lines.some(l => l.id === id);
      let text = e.queue.source;
      if (!inQueue) {
        if (isMap(node) && (status === "done" || status === "failed"))
          setOrdered(e, node, "restored", today());
        e.tasks.items.push(node);
        text = e.doc.toString(YAML_OUT);
      }
      aseq.items.splice(at, 1);
      const rest = new Map(e.queue.archived);
      rest.delete(id);
      parseQueue(text, e.queue.file, rest);
      const settled = inQueue
        ? fs.readFileSync(e.queue.file, "utf8") === e.queue.source
        : writeText(e.queue, text);
      if (!settled) return false;
      const tmp = `${archive}.wf-queue.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      fs.writeFileSync(tmp, adoc.toString(YAML_OUT));
      fs.renameSync(tmp, archive);
      return { id, status, archive, inQueue };
    }),
  );
}

/** The answer of an archive: what moved, what stayed and why, and the queue's size. */
export function formatArchive(r: ArchiveResult): string {
  const lines = [
    `${r.dryRun ? "would archive" : "archived"} ${r.moved.length} line(s) → ${r.archive}`,
    `queue ${r.bytesBefore} → ${r.bytesAfter} bytes`,
  ];
  if (r.keptNamed.length > 0)
    lines.push(`kept (failed, named by an open after:): ${r.keptNamed.join(", ")}`);
  if (r.unended > 0)
    lines.push(
      `kept ${r.unended} done/failed line(s) with no ended: (--include-unended moves them)`,
    );
  return lines.join("\n");
}

export interface MarkResult {
  readonly id: string;
  readonly from: Status;
  readonly to: Status;
  /** A retry of a task with `difficulty:`: the value it had and the one written (+1, at most 10). */
  readonly difficulty?: { readonly from: number; readonly to: number };
  /** The task's keys this server does not know (kept, ignored). */
  readonly unknownKeys?: readonly string[];
  /** `ifRunning`: the line was not `running`, so nothing was written (`from` = `to` = what it is). */
  readonly skipped?: true;
  /** The temporary window (`queue_header` `until`) this mark ended: the header is back to what it was before. */
  readonly windowRestored?: WindowRestored;
}

/** A temporary window that ended with its line's mark. */
export interface WindowRestored {
  readonly task: string;
  readonly from: number;
  readonly to: number;
  readonly reason: string;
}

/** The answer of a mark: `ID: failed → running`, plus the difficulty a retry raised and a window it ended. */
export function formatMark(r: MarkResult): string {
  if (r.skipped) return `${r.id}: still ${r.from}, nothing marked`;
  const d = r.difficulty;
  const bump = !d
    ? ""
    : d.to > d.from
      ? ` (difficulty ${d.from} → ${d.to})`
      : ` (difficulty ${d.to}: already the cap)`;
  const extra = r.unknownKeys?.length ? `\n${unknownKeyNotice(r.id, r.unknownKeys)}` : "";
  const w = r.windowRestored;
  const restored = w
    ? `\nbatch_size ${w.from} → ${w.to}${w.reason ? `  # ${w.reason}` : ""}  (the window set until ${w.task} done ends with it)`
    : "";
  return `${r.id}: ${r.from} → ${r.to}${bump}${extra}${restored}`;
}

/** Today as `YYYY-MM-DD` (local time): a note's date. */
export function today(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * The short hash of what a recon reads of a line: its text, touches, owner and, when it has one, its
 * sweep command (`\n`-joined, touches as the picker reads the list; a line without `sweep:` hashes as it did
 * before the key existed). Equal hashes = the brief is the one the line was written with.
 */
export function textHashOf(text: string, touches: string, owner: string, sweep = ""): string {
  const parts = [text.trim(), touches.trim(), owner.trim()];
  if (sweep.trim() !== "") parts.push(sweep.trim());
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
}

/** `textHashOf` for a parsed line. */
export const lineTextHash = (line: QueueLine): string =>
  textHashOf(line.text, line.meta.touches ?? "", line.meta.owner ?? "", line.meta.sweep ?? "");

/** `textHashOf` for a task node. */
function nodeTextHash(node: YAMLMap): string {
  const o = node.toJSON() as {
    text?: unknown;
    touches?: unknown;
    owner?: unknown;
    sweep?: unknown;
  };
  const list = Array.isArray(o.touches) ? o.touches.map(str).join(", ") : str(o.touches ?? "");
  return textHashOf(str(o.text ?? ""), list, str(o.owner ?? ""), str(o.sweep ?? ""));
}

/** HEAD of the git repo `repo`, or null (no such directory, not a repo, no commit). */
function headOf(repo: string | null): string | null {
  if (repo === null) return null;
  const r = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "-q", "HEAD"], {
    encoding: "utf8",
  });
  const sha = (r.stdout ?? "").trim();
  return r.status === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/**
 * Records where a line was written: `text_hash` of the node's text, touches, owner and sweep, and `base`,
 * HEAD of the node's repo (left out, or dropped, when that repo is not git).
 */
function stampBase(e: Editable, node: YAMLMap): void {
  setOrdered(e, node, "text_hash", nodeTextHash(node));
  const repo = node.get("repo");
  const head = headOf(repoNamed(e.queue, typeof repo === "string" ? repo : undefined));
  if (head !== null) setOrdered(e, node, "base", head);
  else if (node.has("base")) node.delete("base");
}

/** Whether `repo:` now names another directory than `was`; a re-spelling of the same repo is not a change, a name that resolves nowhere is compared as written. */
function repoChanged(queue: Queue, was: string | undefined, now: unknown): boolean {
  const next = typeof now === "string" ? now : undefined;
  const a = repoNamed(queue, was);
  const b = repoNamed(queue, next);
  return a === null || b === null ? (was?.trim() ?? "") !== (next?.trim() ?? "") : a !== b;
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

/** Sets `k` on a task node; a new key goes where TASK_KEYS orders it among the present ones. */
function setOrdered(e: Editable, node: YAMLMap, k: string, v: unknown): void {
  if (node.has(k)) {
    node.set(k, v);
    return;
  }
  const order = TASK_KEYS.indexOf(k as (typeof TASK_KEYS)[number]);
  const at = node.items.findIndex(
    p =>
      TASK_KEYS.indexOf(
        String(isScalar(p.key) ? p.key.value : p.key) as (typeof TASK_KEYS)[number],
      ) > order,
  );
  const pair = e.doc.createPair(k, v);
  if (at < 0) node.items.push(pair);
  else node.items.splice(at, 0, pair);
}

/** Why the picker would not admit this pending line (window, pause and parent-run aside); null = it would. */
function admitRefusal(queue: Queue, id: string): string | null {
  const plan = planPick(queue, { only: id });
  return plan.reasons.find(r => r.id === id)?.why ?? null;
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
  opts: {
    readonly retry?: boolean;
    readonly from?: string;
    readonly force?: string;
    /** `failed` / `released` only: a line that is not `running` is left as it is, no refusal. */
    readonly ifRunning?: boolean;
  } = {},
): Promise<MarkResult> {
  if (!ID_RE.test(id)) throw new QueueError(`refused task id "${id}"`);
  checkNote(note);
  if (opts.ifRunning === true && to !== "failed" && to !== "released")
    throw new QueueError("if-running goes with `failed` or `released` only");
  if (opts.retry === true && to !== "running")
    throw new QueueError("retry restarts a failed task: it goes with `running` only");
  const { from, to: status }: { from: Status; to: Status } =
    opts.retry === true ? { from: "failed", to: "running" } : MARK_TARGETS[to];
  return writing(file, e => {
    const line = lineOf(e.queue, id);
    if (opts.ifRunning === true && line.status !== "running")
      return { id, from: line.status, to: line.status, skipped: true };
    if (opts.retry === true && line.meta.split_into !== undefined)
      throw new QueueError(
        `${id} was split into ${splitIntoOf(line).join(", ")}: a retry would run it again beside its slices`,
      );
    if (line.status !== from) {
      const hint =
        line.status === "failed" && to === "running" ? " (retry: true restarts a failed task)" : "";
      throw new QueueError(`${id} is ${line.status}, expected ${from}${hint}`);
    }
    let forced: string | undefined;
    if (to === "running" && opts.retry !== true) {
      const why = admitRefusal(e.queue, id);
      if (why !== null) {
        const reason = opts.force?.trim();
        if (!reason)
          throw new QueueError(
            `${id} would not be admitted: ${why} (force: "<reason>" marks it anyway, the reason goes into its notes)`,
          );
        forced = `forced running over: ${why}; ${reason}`;
      }
    }
    if (to === "promoted") {
      const why = difficultyRequired({ ...line, status: "pending" });
      if (why !== null) throw new QueueError(why);
    }
    if (
      status === "done" &&
      line.meta.human_gate !== undefined &&
      line.meta.human_passed === undefined
    )
      throw new QueueError(
        `${id} carries human_gate: ${line.meta.human_gate} and has not passed its human wait: it cannot land unseen (the task's human wait state records the pass when the owner's answer is taken; removing human_gate: with queue_edit is the owner's call)`,
      );
    const node = taskNode(e, line);
    node.set("status", status);
    if (status === "done" || status === "failed") setOrdered(e, node, "ended", today());
    else {
      node.delete("ended");
      node.delete("restored");
    }
    if (forced !== undefined) addNote(e, node, forced, opts.from ?? "mark");
    const text = note?.trim();
    if (text) addNote(e, node, text, opts.from ?? "mark");
    const was = opts.retry === true ? difficultyOf(line) : undefined;
    let difficulty: MarkResult["difficulty"];
    if (typeof was === "number") {
      difficulty = { from: was, to: Math.min(was + 1, DIFFICULTY_MAX) };
      node.set("difficulty", difficulty.to);
    }
    const windowRestored = from === "running" ? endWindow(e, id) : undefined;
    return {
      id,
      from,
      to: status,
      ...(difficulty ? { difficulty } : {}),
      ...(line.unknownKeys.length > 0 ? { unknownKeys: line.unknownKeys } : {}),
      ...(windowRestored ? { windowRestored } : {}),
    };
  });
}

/** The header key a temporary window keeps what it replaced in. */
const WINDOW_UNTIL = "window_until";

interface WindowUntil {
  readonly task: string;
  readonly batch_size: number;
  readonly reason: string;
}

/** The pending revert of a temporary window (`window_until:` in the header), if the file holds a readable one. */
function windowUntilOf(header: Readonly<Record<string, string>>): WindowUntil | undefined {
  const raw = header[WINDOW_UNTIL];
  if (raw === undefined) return undefined;
  try {
    const w = JSON.parse(raw) as Partial<WindowUntil>;
    return typeof w.task === "string" && Number.isInteger(w.batch_size)
      ? { task: w.task, batch_size: w.batch_size as number, reason: w.reason ?? "" }
      : undefined;
  } catch {
    return undefined;
  }
}

/** A mark of `id` that leaves `running` ends the temporary window set until it: the window and its reason go back. */
function endWindow(e: Editable, id: string): WindowRestored | undefined {
  const w = windowUntilOf(e.queue.header);
  if (w?.task !== id) return undefined;
  e.doc.set("batch_size", w.batch_size);
  if (w.reason !== "") e.doc.set("reason", w.reason);
  else e.doc.delete("reason");
  e.doc.delete(WINDOW_UNTIL);
  return { task: id, from: e.queue.batchSize, to: w.batch_size, reason: w.reason };
}

function lineOf(queue: Queue, id: string): QueueLine {
  const line = queue.lines.find(l => l.id === id);
  const gone = queue.archived.get(id);
  if (!line && gone !== undefined)
    throw new QueueError(`${id} is archived (${gone}) in ${archivePath(queue.file)}`);
  if (!line) throw new QueueError(`no task ${id} in ${queue.file}`);
  return line;
}

/** The `after:` ids that pick would wait on as unknown (`X?`). */
function unknownAfterIds(
  after: string,
  byId: ReadonlyMap<string, QueueLine>,
  archived: ReadonlyMap<string, Status>,
): string[] {
  const unknown: string[] = [];
  for (const tok of stripParens(after).match(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g) ?? [])
    if (!byId.has(tok) && !archived.has(tok) && /^[A-Z]/.test(tok) && /\d/.test(tok))
      unknown.push(tok);
  return unknown;
}

/** The queue ids an `after:` text names, as the picker reads it (text in parentheses is prose). */
function afterIdsOf(after: string | undefined, byId: ReadonlyMap<string, QueueLine>): string[] {
  const toks = stripParens(after ?? "").match(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g) ?? [];
  return [...new Set(toks)].filter(t => byId.has(t));
}

/** A dependency path from `id` back to itself through `after:` ids, or null. */
function afterCycle(queue: Queue, id: string): string[] | null {
  const byId = new Map(queue.lines.map(l => [l.id, l]));
  const deps = (l: QueueLine): string[] => afterIdsOf(l.meta.after, byId);
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
 * cycle, `workflow:` is one word, `repo:` resolves, `difficulty:` is 1..10,
 * `kind:` and `priority:` are one of theirs, `sweep:` is one non-empty line.
 */
function checkFields(queue: Queue, line: QueueLine, keys?: ReadonlySet<string>): void {
  const has = (k: string): boolean =>
    (keys === undefined || keys.has(k)) && line.meta[k] !== undefined;
  if (has("after")) {
    const byId = new Map(queue.lines.map(l => [l.id, l]));
    const unknown = unknownAfterIds(line.meta.after, byId, queue.archived);
    if (unknown.length > 0)
      throw new QueueError(`${line.id}: after: ${unknown.join(", ")} — no such task in the queue`);
    const cycle = afterCycle(queue, line.id);
    if (cycle) throw new QueueError(`${line.id}: after: closes a cycle ${cycle.join(" → ")}`);
  }
  if (has("split_from")) {
    const from = line.meta.split_from ?? "";
    if (!ID_RE.test(from) || from === line.id)
      throw new QueueError(`${line.id}: split_from: is the id of the line this one was split from`);
    if (!queue.lines.some(l => l.id === from) && !queue.archived.has(from))
      throw new QueueError(`${line.id}: split_from: ${from} — no such task in the queue`);
  }
  if (has("workflow") && workflowOf(line) === null)
    throw new QueueError(`${line.id}: workflow: "${line.meta.workflow}" is not a workflow name`);
  if (has("repo") && resolveRepo(queue, line) === null)
    throw new QueueError(`${line.id}: repo: "${line.meta.repo}" resolves to no directory`);
  if (has("difficulty") && difficultyOf(line) === null)
    throw new QueueError(`${line.id}: ${difficultyError(line.meta.difficulty)}`);
  if (has("kind") && kindOf(line) === null) throw new QueueError(`${line.id}: ${kindError(line)}`);
  if (has("priority") && priorityOf(line) === null)
    throw new QueueError(
      `${line.id}: priority: "${line.meta.priority}" is not one of ${PRIORITIES.join(", ")}`,
    );
  if (has("human_gate") && !HUMAN_GATE_RE.test(line.meta.human_gate ?? ""))
    throw new QueueError(
      `${line.id}: human_gate: is one lower-case word, the kind of look the owner gives (\`look\`, \`approve\`)`,
    );
  if (has("sweep") && (sweepOf(line) === null || /[\n\r]/.test(line.meta.sweep ?? "")))
    throw new QueueError(`${line.id}: sweep: is one non-empty line (the command)`);
  if (
    has("on_end_tell_parent") &&
    (owedTextOf(line) === null || /[\n\r]/.test(line.meta.on_end_tell_parent ?? ""))
  )
    throw new QueueError(
      `${line.id}: on_end_tell_parent: is one non-empty line (the step the parent owes)`,
    );
}

/**
 * The `OWED-DUE:` lines of `queue`: a done or failed line carrying `on_end_tell_parent:` that has no `owed_handed:`
 * (the day the engine recorded the hand-back on the line, so no later dispatcher session repeats it). The text is the
 * owed step; `sha` is the line's `landed <sha>` note, else none.
 */
export function owedDueLines(queue: Queue): string[] {
  const out: string[] = [];
  for (const l of queue.lines) {
    if ((l.status !== "done" && l.status !== "failed") || l.meta.owed_handed !== undefined)
      continue;
    const text = owedTextOf(l);
    if (text === null) continue;
    out.push(`OWED-DUE: task=${l.id} status=${l.status} sha=${landedShaOf(l) ?? "none"}: ${text}`);
  }
  return out;
}

/**
 * The line's session entered a human wait: running → awaiting under the lock, with the wait's record (`human_wait:`);
 * a pass recorded earlier (`human_passed:`) is dropped, so a new round must be passed again. The window slot is free
 * from this write on. A line already awaiting for the same session gets the new record.
 */
export async function markAwaiting(
  file: string,
  id: string,
  wait: Omit<HumanWaitRecord, "answered" | "route">,
): Promise<void> {
  if (!ID_RE.test(id)) throw new QueueError(`refused task id "${id}"`);
  await writing(file, e => {
    const line = lineOf(e.queue, id);
    const again = line.status === "awaiting" && line.humanWait?.session === wait.session;
    if (line.status !== "running" && !again)
      throw new QueueError(`${id} is ${line.status}, expected running`);
    const node = taskNode(e, line);
    node.set("status", "awaiting");
    node.delete("human_passed");
    const { show, ...rest } = wait;
    const record = { ...rest, ...(show.length > 0 ? { show: [...show] } : {}) };
    setOrdered(e, node, "human_wait", e.doc.createNode(record));
  });
}

/** The owner's answer reached the line's session: `answered:` and `route:` on its `human_wait:`, so the pick resumes it first. */
export async function markAnswered(
  file: string,
  id: string,
  session: string,
  route: string,
  at: string = new Date().toISOString(),
): Promise<void> {
  if (!ID_RE.test(id)) throw new QueueError(`refused task id "${id}"`);
  await writing(file, e => {
    const line = lineOf(e.queue, id);
    if (line.status !== "awaiting" || line.humanWait?.session !== session)
      throw new QueueError(`${id} is ${line.status}, not awaiting session ${session}`);
    const wait = taskNode(e, line).get("human_wait", true);
    if (!isMap(wait)) throw new QueueError(`${id}: human_wait: is not a mapping`);
    wait.set("answered", at);
    wait.set("route", route);
  });
}

/** The answer was taken by a move out of the wait before a pick resumed the line: awaiting (this session) → running. */
export async function takeAwaiting(file: string, id: string, session: string): Promise<boolean> {
  if (!ID_RE.test(id)) throw new QueueError(`refused task id "${id}"`);
  // `writing` reads a `false` answer as a failed write: the answer is wrapped
  const r = await writing(file, e => {
    const line = lineOf(e.queue, id);
    if (line.status !== "awaiting" || line.humanWait?.session !== session) return { taken: false };
    const node = taskNode(e, line);
    node.set("status", "running");
    node.delete("human_wait");
    return { taken: true };
  });
  return r.taken;
}

/** A passing answer was taken: `human_passed: <time>` on a line that carries `human_gate:`; any other line is left as it is. */
export async function markHumanPassed(file: string, id: string): Promise<boolean> {
  if (!ID_RE.test(id)) throw new QueueError(`refused task id "${id}"`);
  const r = await writing(file, e => {
    const line = lineOf(e.queue, id);
    if (line.meta.human_gate === undefined) return { set: false };
    setOrdered(e, taskNode(e, line), "human_passed", new Date().toISOString());
    return { set: true };
  });
  return r.set;
}

/** The session of an awaiting line ended without its answer (an abort): awaiting → failed, with the reason as a note. */
export async function failAwaiting(
  file: string,
  id: string,
  session: string,
  note: string,
): Promise<boolean> {
  if (!ID_RE.test(id)) throw new QueueError(`refused task id "${id}"`);
  const r = await writing(file, e => {
    const line = lineOf(e.queue, id);
    if (line.status !== "awaiting" || line.humanWait?.session !== session) return { failed: false };
    const node = taskNode(e, line);
    node.set("status", "failed");
    node.delete("human_wait");
    setOrdered(e, node, "ended", today());
    addNote(e, node, note, "engine");
    return { failed: true };
  });
  return r.failed;
}

/** Records on the line, under the queue lock, that its owed step was handed to the parent (`owed_handed: <today>`); a line without the field, or already recorded, is left as it is. */
export async function markOwedHanded(file: string, id: string): Promise<boolean> {
  if (!ID_RE.test(id)) throw new QueueError(`refused task id "${id}"`);
  return writing(file, e => {
    const line = lineOf(e.queue, id);
    if (owedTextOf(line) === null || line.meta.owed_handed !== undefined) return false;
    setOrdered(e, taskNode(e, line), "owed_handed", today());
    return true;
  });
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
 * `exclusive`/`breaking`/`parked` a boolean (`no`/`false`/`""` false), `difficulty` a number when it is one,
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
  /** The workflow the line will run, set for a research line and a line with its own `workflow:`. */
  readonly runs?: string;
  /** Notes on the written line (`touches:` entries the picker cannot run in a worktree; a research line on a non-research workflow). */
  readonly warnings?: readonly string[];
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

/** The id and status of a new task, or the refusal of a key a caller may not set (the checks `addQueueLine` and `addQueueLines` share). */
function refuseNewTask(task: NewTask): { readonly id: string; readonly status: string } {
  const id = typeof task.id === "string" ? task.id.trim() : "";
  if (!ID_RE.test(id)) throw new QueueError(`refused task id "${String(task.id)}"`);
  const unknown = Object.keys(task).find(k => !(TASK_KEYS as readonly string[]).includes(k));
  if (unknown !== undefined)
    throw new QueueError(`${id}: unknown key "${unknown}" (keys: ${TASK_KEYS.join(", ")})`);
  if (task.ended !== undefined)
    throw new QueueError(
      `${id}: ended is written by queue_mark when a line ends, not set on a new one`,
    );
  if (task.restored !== undefined)
    throw new QueueError(
      `${id}: restored is written by the archive restore, not set on a new line`,
    );
  for (const k of ["added", "base", "text_hash", "owed_handed"])
    if (task[k] !== undefined)
      throw new QueueError(`${id}: ${k} is written by queue_add / queue_edit, not set`);
  for (const k of ["human_wait", "human_passed"])
    if (task[k] !== undefined)
      throw new QueueError(`${id}: ${k} is written by the engine's human wait, not set`);
  if (task.split_into !== undefined)
    throw new QueueError(
      `${id}: split_into is written by the split mark of queue_add_batch, not set`,
    );
  const status = task.status ?? "pending";
  if (status !== "pending" && status !== "backlog")
    throw new QueueError(`${id}: a new task is pending or backlog, not ${str(status)}`);
  return { id, status };
}

/** The refusal of an id the queue or its archive already holds. */
function refuseTakenId(queue: Queue, id: string): void {
  if (queue.lines.some(l => l.id === id)) throw new QueueError(`${id} is already in ${queue.file}`);
  if (queue.archived.has(id)) throw archivedIdError(queue, id);
}

/** The node of a new task: its keys in TASK_KEYS order, `added` and `base` / `text_hash` stamped. */
function newTaskNode(e: Editable, task: NewTask, id: string, status: string): YAMLMap {
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
  setOrdered(e, node, "added", new Date().toISOString());
  stampBase(e, node);
  return node;
}

/**
 * A new pending (or backlog) task under the lock: after the task `after`, before the task `before`,
 * or last. The task must read as a pick reads it: a unique id, known keys, `after:` naming only
 * tasks of the queue (and no cycle), a one-word `workflow:`, a `repo:` that resolves, a
 * `difficulty:` of 1..10 (required on a pending line, see `difficultyRequired`).
 */
export async function addQueueLine(
  file: string,
  task: NewTask,
  pos: { readonly after?: string; readonly before?: string } = {},
  opts: { readonly create?: boolean } = {},
): Promise<AddResult> {
  const { id, status } = refuseNewTask(task);
  if (pos.after !== undefined && pos.before !== undefined)
    throw new QueueError("after_id and before_id exclude each other");
  const place = (e: Editable): number => {
    refuseTakenId(e.queue, id);
    const at =
      pos.after !== undefined
        ? lineOf(e.queue, pos.after).index + 1
        : pos.before !== undefined
          ? lineOf(e.queue, pos.before).index
          : e.tasks.items.length;
    e.tasks.items.splice(at, 0, newTaskNode(e, task, id, status));
    return at;
  };
  const check = (next: Queue): void => {
    const line = lineOf(next, id);
    checkFields(next, line);
    const why = difficultyRequired(line);
    if (why !== null) throw new QueueError(why);
  };
  const abs = path.resolve(file);
  let created = false;
  if (opts.create === true && !fs.existsSync(abs)) {
    // the task is judged against the bare header BEFORE the file exists, so a refused first task
    // creates nothing and no rollback can delete a task another call wrote
    const doc = YAML.parseDocument(NEW_QUEUE);
    const tasks = doc.get("tasks", true) as YAMLSeq;
    tasks.flow = false;
    const e = {
      queue: parseQueue(NEW_QUEUE, abs, archivedStatuses(abs)),
      doc,
      tasks,
    };
    place(e);
    check(parseQueue(doc.toString(YAML_OUT), abs, e.queue.archived));
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
  const written = readQueue(abs);
  const line = lineOf(written, id);
  const warnings = [
    ...touchesWarnings(written, line),
    ...kindWorkflowWarnings(written, line),
    ...gateWarnings(line),
  ];
  const runs = runsNote(written, line)[0];
  return {
    id,
    lineNo,
    ...(created ? { created: true as const } : {}),
    ...(runs !== undefined ? { runs } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export interface AddBatchResult {
  /** The new ids, in the order written. */
  readonly ids: readonly string[];
  /** 1-based line number of the first new task in the file. */
  readonly lineNo: number;
  /** The line the split mark closed (`failed`, with `split_into:` the new ids). */
  readonly split?: string;
  /** The workflow each new line runs, as AddResult.runs. */
  readonly runs: readonly { readonly id: string; readonly runs: string }[];
  /** Notes on the written lines, as AddResult.warnings. */
  readonly warnings: readonly { readonly id: string; readonly warning: string }[];
}

/**
 * Many new tasks in ONE write under the lock, or none. Every line is judged as `addQueueLine` judges one, and
 * as one list: ids new and unique, `after:` naming a task of the queue or of the list, no cycle across both,
 * `difficulty:` on every pending line. A refusal names every failing line with its reason and writes nothing.
 * The list goes after `pos.after`, before `pos.before`, else last, in order. `split: <ID>` is the split mark: that
 * running line ends `failed` with `split_into:` the new ids and a note, and every new line gets `split_from: <ID>`,
 * all in the same write.
 */
export async function addQueueLines(
  file: string,
  tasks: readonly NewTask[],
  opts: { readonly after?: string; readonly before?: string; readonly split?: string } = {},
): Promise<AddBatchResult> {
  if (tasks.length === 0) throw new QueueError("queue_add_batch: the list of tasks is empty");
  if (opts.after !== undefined && opts.before !== undefined)
    throw new QueueError("after_id and before_id exclude each other");
  const split = opts.split?.trim();
  if (split !== undefined && !ID_RE.test(split)) throw new QueueError(`refused task id "${split}"`);
  const fail = (errs: { n: number; text: string }[], n: number, id: string, err: unknown): void => {
    const msg = (err instanceof Error ? err.message : String(err)).replace(/ \(keys: [^)]*\)$/, "");
    const own = `${id}: `;
    errs.push({
      n,
      text: `line ${n + 1}${id === "" ? "" : ` (${id})`}: ${id !== "" && msg.startsWith(own) ? msg.slice(own.length) : msg}`,
    });
  };
  const refuseAll = (errs: readonly { n: number; text: string }[]): never => {
    const lines = [...errs].sort((a, b) => a.n - b.n).map(x => `  ${x.text}`);
    throw new QueueError(
      `queue_add_batch refused, nothing written (${lines.length} problem${lines.length === 1 ? "" : "s"} in ${tasks.length} line${tasks.length === 1 ? "" : "s"}):\n${lines.join("\n")}`,
    );
  };
  const early: { n: number; text: string }[] = [];
  const heads: ({ id: string; status: string; task: NewTask } | null)[] = [];
  const seen = new Map<string, number>();
  tasks.forEach((t, n) => {
    const id =
      typeof t === "object" && t !== null && typeof t.id === "string" && ID_RE.test(t.id.trim())
        ? t.id.trim()
        : "";
    try {
      if (typeof t !== "object" || t === null || Array.isArray(t))
        throw new QueueError("is not a mapping");
      const head = refuseNewTask(t);
      if (split !== undefined && t.split_from !== undefined && str(t.split_from).trim() !== split)
        throw new QueueError(`${id}: split_from: is ${split} under split: ${split}`);
      const first = seen.get(id);
      if (first !== undefined) throw new QueueError(`${id}: the id repeats line ${first + 1}`);
      seen.set(id, n);
      heads.push({ ...head, task: split === undefined ? t : { ...t, split_from: split } });
    } catch (err) {
      fail(early, n, id, err);
      heads.push(null);
    }
  });
  let errs: { n: number; text: string }[] = [];
  const placed: { id: string; n: number }[] = [];
  const change = (e: Editable): number => {
    errs = [...early];
    placed.length = 0;
    const at =
      opts.after !== undefined
        ? lineOf(e.queue, opts.after).index + 1
        : opts.before !== undefined
          ? lineOf(e.queue, opts.before).index
          : e.tasks.items.length;
    const nodes: YAMLMap[] = [];
    heads.forEach((h, n) => {
      if (h === null) return;
      try {
        refuseTakenId(e.queue, h.id);
        nodes.push(newTaskNode(e, h.task, h.id, h.status));
        placed.push({ id: h.id, n });
      } catch (err) {
        fail(errs, n, h.id, err);
      }
    });
    let parent: QueueLine | undefined;
    if (split !== undefined) {
      try {
        parent = lineOf(e.queue, split);
        if (parent.status !== "running")
          throw new QueueError(`${split} is ${parent.status}: only a running line is marked split`);
      } catch (err) {
        errs.push({ n: -1, text: `split: ${err instanceof Error ? err.message : String(err)}` });
        parent = undefined;
      }
    }
    e.tasks.items.splice(at, 0, ...nodes);
    if (parent !== undefined && errs.length === 0) {
      const node = e.tasks.items.find(
        (n): n is YAMLMap => isMap(n) && String(n.get("id")) === split,
      ) as YAMLMap;
      node.set("status", "failed");
      setOrdered(e, node, "ended", today());
      const into = e.doc.createNode(placed.map(p => p.id)) as YAMLSeq;
      into.flow = true;
      setOrdered(e, node, "split_into", into);
      addNote(e, node, `split into ${placed.map(p => p.id).join(", ")}`, "split");
      endWindow(e, parent.id);
    }
    return at;
  };
  const check = (next: Queue): void => {
    for (const p of placed)
      try {
        const line = lineOf(next, p.id);
        checkFields(next, line);
        const why = difficultyRequired(line);
        if (why !== null) throw new QueueError(why);
      } catch (err) {
        fail(errs, p.n, p.id, err);
      }
    if (errs.length > 0) refuseAll(errs);
  };
  await writing(file, change, check);
  const abs = path.resolve(file);
  const written = readQueue(abs);
  const ids = placed.map(p => p.id);
  const runs: { id: string; runs: string }[] = [];
  const warnings: { id: string; warning: string }[] = [];
  for (const id of ids) {
    const line = lineOf(written, id);
    const r = runsNote(written, line)[0];
    if (r !== undefined) runs.push({ id, runs: r });
    for (const w of [
      ...touchesWarnings(written, line),
      ...kindWorkflowWarnings(written, line),
      ...gateWarnings(line),
    ])
      warnings.push({ id, warning: w });
  }
  return {
    ids,
    lineNo: lineNoOf(fs.readFileSync(abs, "utf8"), ids[0]),
    ...(split !== undefined ? { split } : {}),
    runs,
    warnings,
  };
}

/** The answer of a batch add: one line on what was written, then a `warning:` per note. */
export function formatAddBatch(r: AddBatchResult): string {
  const head = `${r.ids.length} task${r.ids.length === 1 ? "" : "s"} added from line ${r.lineNo}: ${r.ids.join(", ")}`;
  const split =
    r.split !== undefined
      ? `; ${r.split} marked split (failed, split_into: ${r.ids.join(", ")})`
      : "";
  const runs = r.runs.map(x => `; ${x.id}: ${x.runs}`).join("");
  return `${head}${split}${runs}${r.warnings.map(w => `\nwarning: ${w.id}: ${w.warning}`).join("")}`;
}

export interface EditResult {
  readonly id: string;
  /** The task as written (YAML). */
  readonly task: string;
  /** The workflow the line will run, as AddResult.runs (set when kind, workflow or repo was edited). */
  readonly runs?: string;
  /** Notes on the written line, as AddResult.warnings. */
  readonly warnings?: readonly string[];
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
    if (k === "ended") throw new QueueError(`${id}: ended is written by queue_mark, not set`);
    else if (k === "restored")
      throw new QueueError(`${id}: restored is written by the archive restore, not set`);
    else if (k === "added" || k === "base" || k === "text_hash" || k === "owed_handed")
      throw new QueueError(`${id}: ${k} is written by queue_add / queue_edit, not set`);
    else if (k === "human_wait" || k === "human_passed")
      throw new QueueError(`${id}: ${k} is written by the engine's human wait, not set`);
    else if (!EDIT_KEYS.has(k))
      throw new QueueError(`unknown field "${k}" (keys: ${[...EDIT_KEYS].join(", ")})`);
  const note = appendNote?.trim() || undefined;
  if (Object.keys(set).length === 0 && note === undefined)
    throw new QueueError("nothing to edit: give fields to set or a note");
  let wasMissing = false;
  let waitedBefore: ReturnType<typeof blockedBy> = null;
  const done = await writing(
    file,
    e => {
      const line = lineOf(e.queue, id);
      wasMissing = difficultyRequired(line) !== null;
      waitedBefore = blockedBy(line, new Map(e.queue.lines.map(l => [l.id, l])), e.queue.archived);
      const node = taskNode(e, line);
      for (const [k, raw] of Object.entries(set)) {
        const v = fieldValue(e, k, raw);
        if (v === null) node.delete(k);
        else setOrdered(e, node, k, v);
      }
      // the brief or the repo changed: it was written now, at this HEAD of its repo (an edit that leaves both equal keeps both)
      if (
        nodeTextHash(node) !== lineTextHash(line) ||
        repoChanged(e.queue, line.meta.repo, node.get("repo"))
      )
        stampBase(e, node);
      if (note !== undefined) addNote(e, node, note, noteFrom);
      return { id, task: new YAML.Document(node).toString(YAML_OUT).trimEnd() };
    },
    next => {
      const line = lineOf(next, id);
      checkFields(next, line, new Set(Object.keys(set)));
      // an edit is refused only when it MAKES the line lack a difficulty: a line written before the rule stays editable
      const why = wasMissing ? null : difficultyRequired(line);
      if (why !== null) throw new QueueError(why);
    },
  );
  const reads = ["touches", "repo", "kind", "workflow", "text", "human_gate"].some(k => k in set);
  const afterEdited = "after" in set;
  if (!reads && !afterEdited) return done;
  const q = readQueue(file);
  const line = lineOf(q, id);
  const warnings = [
    ...(reads
      ? [...touchesWarnings(q, line), ...kindWorkflowWarnings(q, line), ...gateWarnings(line)]
      : []),
    ...(afterEdited ? afterRunningWarnings(q, line, waitedBefore) : []),
  ];
  const runs =
    "kind" in set || "workflow" in set || "repo" in set ? runsNote(q, line)[0] : undefined;
  return {
    ...done,
    ...(runs !== undefined ? { runs } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export interface HeaderResult {
  readonly from: number;
  readonly to: number;
  readonly reason: string;
  /** A temporary window: the task whose end-mark puts `from` (and the reason before) back. */
  readonly until?: string;
  /** A temporary window still pending that this plain window replaced: its task. */
  readonly droppedUntil?: string;
}

/** `until` of a temporary window: `<TASK-ID> done`. */
const UNTIL_RE = /^(\S+) done$/;

/**
 * The header's `batch_size: N` and `reason:` under the lock: the window, `0` = the pause. With
 * `until: "<TASK-ID> done"` the window is temporary: the header keeps what it replaced as
 * `window_until:`, and the mark of that line that leaves `running` (done, failed or released) puts it
 * back. A plain window replaces a pending temporary one (its revert is dropped, the answer says so);
 * a second temporary window while one is pending is refused.
 */
export async function setQueueWindow(
  file: string,
  batchSize: number,
  reason: string,
  until?: string,
): Promise<HeaderResult> {
  if (!Number.isInteger(batchSize) || batchSize < 0)
    throw new QueueError(`batch_size is a whole number ≥ 0, not ${batchSize}`);
  const why = reason.trim();
  if (why === "" || /[\n\r]/.test(why)) throw new QueueError("the reason is one non-empty line");
  const task = until === undefined ? undefined : UNTIL_RE.exec(until.trim())?.[1];
  if (until !== undefined && (task === undefined || !ID_RE.test(task)))
    throw new QueueError(`until is "<TASK-ID> done", not "${until}"`);
  return writing(file, e => {
    const pending = windowUntilOf(e.queue.header);
    const was = { size: e.queue.batchSize, reason: e.queue.batchComment ?? "" };
    if (task !== undefined) {
      const line = lineOf(e.queue, task);
      if (line.status === "done" || line.status === "failed")
        throw new QueueError(`${task} is ${line.status}: a window until its mark would never end`);
      if (pending !== undefined)
        throw new QueueError(
          `a window until ${pending.task} done is pending (it restores batch_size ${pending.batch_size}): set a plain window first, or wait for its mark`,
        );
    }
    if (task === undefined) e.doc.delete(WINDOW_UNTIL);
    e.doc.set("batch_size", batchSize);
    if (e.doc.has("reason")) e.doc.set("reason", why);
    else {
      const top = e.doc.contents as YAMLMap;
      const at = top.items.findIndex(p => String((p.key as Scalar).value) === "batch_size");
      top.items.splice(at + 1, 0, e.doc.createPair("reason", why));
    }
    if (task !== undefined) {
      const top = e.doc.contents as YAMLMap;
      const at = top.items.findIndex(p => String((p.key as Scalar).value) === "tasks");
      top.items.splice(
        at < 0 ? top.items.length : at,
        0,
        e.doc.createPair(WINDOW_UNTIL, { task, batch_size: was.size, reason: was.reason }),
      );
    }
    return {
      from: was.size,
      to: batchSize,
      reason: why,
      ...(task !== undefined ? { until: task } : {}),
      ...(task === undefined && pending !== undefined ? { droppedUntil: pending.task } : {}),
    };
  });
}

/** `batch_size 3 → 4  # why`, plus the temporary window's end or the one a plain window replaced. */
export function formatWindow(r: HeaderResult): string {
  const base = `batch_size ${r.from} → ${r.to}  # ${r.reason}`;
  if (r.until !== undefined)
    return `${base}\nuntil ${r.until} done: the mark of ${r.until} that leaves running (done, failed or released) puts batch_size ${r.from} back`;
  if (r.droppedUntil !== undefined)
    return `${base}\nthe pending window until ${r.droppedUntil} done is dropped: ${r.droppedUntil}'s mark will not put the old window back`;
  return base;
}

/**
 * The header keys a tool may set besides the window (`batch_size` / `reason`): `archive_after_days`
 * a whole number ≥ 1, `exclusive_hold` `yes` or `no`, `overlap` a mode, `base` a list of
 * `<abs repo>=<sha>`, `land_test` / `record_file` / `land_branch` one non-empty line; each removed
 * with `null`.
 */
export const SETTABLE_HEADER_KEYS: readonly string[] = [
  "archive_after_days",
  "exclusive_hold",
  "overlap",
  "base",
  "land_test",
  "record_file",
  "land_branch",
];

export type HeaderValue = number | string | readonly string[];

export interface HeaderKeyResult {
  readonly key: string;
  /** The value before (`undefined` = the key was absent). */
  readonly from: string | undefined;
  /** The value after (`undefined` = the key is now absent). */
  readonly to: HeaderValue | undefined;
}

function checkHeaderValue(key: string, value: HeaderValue): void {
  if (key === "exclusive_hold") {
    if (value !== "yes" && value !== "no")
      throw new QueueError(`${key} is yes or no (null removes it), not ${String(value)}`);
  } else if (key === "overlap") {
    if (typeof value !== "string" || !(OVERLAP_MODES as readonly string[]).includes(value))
      throw new QueueError(
        `${key} is one of ${OVERLAP_MODES.join(", ")} (null removes it), not ${String(value)}`,
      );
  } else if (key === "base") {
    const list = typeof value === "string" ? [value] : value;
    if (typeof list === "number" || list.length === 0 || !list.every(b => /^\/\S*=\S+$/.test(b)))
      throw new QueueError(
        `${key} is a list of <absolute repo path>=<sha> entries (null removes it), not ${String(value)}`,
      );
  } else if (key === "archive_after_days") {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
      throw new QueueError(`${key} is a whole number ≥ 1 (null removes it), not ${String(value)}`);
  } else if (typeof value !== "string" || value.trim() === "" || /[\r\n]/.test(value))
    throw new QueueError(`${key} is one non-empty line (null removes it)`);
}

/**
 * One header key of {@link SETTABLE_HEADER_KEYS} under the lock: `value` set or changed, `null`
 * removes it. The window (`batch_size` / `reason`) and every other key stay as they are; an unknown
 * key and a value the key does not take are refused, nothing written.
 */
export async function setQueueHeaderKey(
  file: string,
  key: string,
  value: HeaderValue | null,
): Promise<HeaderKeyResult> {
  if (!SETTABLE_HEADER_KEYS.includes(key))
    throw new QueueError(
      `${key} is not a header key a tool sets (${SETTABLE_HEADER_KEYS.join(", ")}; the window is batch_size + reason)`,
    );
  if (value !== null) checkHeaderValue(key, value);
  const stored = value === null ? null : typeof value === "object" ? [...value] : value;
  return writing(file, e => {
    const from = e.queue.header[key]?.trim() || undefined;
    if (stored === null) e.doc.delete(key);
    else if (e.doc.has(key)) e.doc.set(key, e.doc.createNode(stored));
    else {
      const top = e.doc.contents as YAMLMap;
      const at = top.items.findIndex(p => String((p.key as Scalar).value) === "tasks");
      top.items.splice(
        at < 0 ? top.items.length : at,
        0,
        e.doc.createPair(key, e.doc.createNode(stored)),
      );
    }
    return { key, from, to: stored ?? undefined };
  });
}

/** `archive_after_days 30 → 7`, `exclusive_hold (none) → no`: what a header key set did. */
export function formatHeaderKey(r: HeaderKeyResult): string {
  return `${r.key} ${r.from ?? "(none)"} → ${r.to === undefined ? "(none)" : typeof r.to === "object" ? r.to.join(", ") : r.to}`;
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
  if (r.awaiting !== undefined && r.awaiting.length > 0)
    out.push(`awaiting a human (no slot held): ${r.awaiting.join(", ")}`);
  if (r.admitted.length === 0)
    out.push(
      r.code === QUEUE_EXIT.WAIT
        ? r.running.length === 0
          ? "nothing admitted and nothing runs: wait for a human answer (`answer`), then refill"
          : "nothing admitted: wait for a running line to end"
        : r.code === QUEUE_EXIT.PAUSED
          ? "nothing admitted and nothing runs: paused"
          : "nothing admitted and nothing runs: the queue is done (what stays pending is blocked)",
    );
  if (r.archived !== undefined && r.archived.length > 0)
    out.push(`archived ${r.archived.length} old line(s) (archive_after_days)`);
  for (const o of r.overtakes ?? []) out.push(o);
  for (const g of r.gateHints ?? []) out.push(`warning: ${g}`);
  if (r.curator !== undefined) out.push(r.curator);
  out.push(...explainLines(r.reasons, explain));
  for (const u of r.unknownKeys) out.push(unknownKeyNotice(u.id, u.keys));
  return out.join("\n");
}

/**
 * `ID\tmodel\teffort\trepo\tworkflow\tdifficulty\tkind` — one admitted line as the exec form prints it
 * (`-` = no `workflow:` / `difficulty:`; `kind` is `feature` when the line has none); a resumed wait adds an
 * eighth column `resume=<session>`: its session goes on, no new one is started.
 */
export function formatTask(a: AdmittedTask): string {
  const row = [a.id, a.model, a.effort, a.repo, a.workflow ?? "-", a.difficulty ?? "-", a.kind];
  return (a.resume === undefined ? row : [...row, `resume=${a.resume}`]).join("\t");
}
