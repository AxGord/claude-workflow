// A task queue in a Markdown file, shared by every project: the header (up to `## Tasks`) holds
// `batch_size: N` (the window; `0` = paused, a `# comment` on the same line says why) and other
// `key: value` lines; each task is `- [m] ID | key: value | … | free text |`. The file is the only
// truth: a pick re-reads it under a lock beside it and changes nothing but `[m]` marks.
//
// Admission (`planPick`, pure): free = batch_size minus the `[>]` lines; a `[ ]` line in file
// order is admitted when its model is not `—` (parent-run), no `⏸` stands in its metadata or its
// `after:`, every `after:` id is `[x]`, its `repo:` resolves, and it overlaps neither a `[>]` line
// nor a line admitted earlier in the same pick (`touches:` path prefixes on a `/` boundary,
// `owner:` equal or a `.`-prefix; a line without `touches:` overlaps everything).
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
const META_KEYS = new Set(["model", "effort", "after", "touches", "owner", "repo"]);
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
}

export interface AdmittedTask {
  readonly id: string;
  readonly model: string;
  readonly effort: string;
  /** Absolute path of the repo the task works in. */
  readonly repo: string;
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
  const batchComment = bs[2]?.trim() || undefined;
  return { file, rows, lines, batchSize: Number(bs[1]), batchComment, header, baseRepos };
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

function ownerOf(line: QueueLine): string | null {
  const v = line.meta.owner;
  if (v === undefined) return null;
  const o = stripParens(v).trim().replace(/\s+/g, " ");
  return o === "" || o === "—" ? null : o;
}

const pathOverlap = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const ownerOverlap = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

function conflict(a: QueueLine, b: QueueLine): string | null {
  const ta = touchesOf(a);
  const tb = touchesOf(b);
  if (ta === null || tb === null) return "no touches:";
  for (const x of ta) for (const y of tb) if (pathOverlap(x, y)) return `touches ${x} ~ ${y}`;
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

/** The admission pass over a parsed queue; writes nothing. */
export function planPick(queue: Queue): Omit<PickResult, "dryRun"> {
  const byId = new Map(queue.lines.map(l => [l.id, l]));
  const running = queue.lines.filter(l => l.mark === ">");
  const taken: QueueLine[] = [...running];
  const admitted: AdmittedTask[] = [];
  const reasons: { id: string; why: string }[] = [];
  const free = queue.batchSize - running.length;
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
      }
      if (why === null) {
        for (const t of taken) {
          const c = conflict(l, t);
          if (c !== null) {
            why = `overlaps ${t.id} (${c})`;
            break;
          }
        }
      }
    }
    if (why === null && repo !== null) {
      admitted.push({
        id: l.id,
        model: l.meta.model ?? "opus",
        effort: l.meta.effort ?? "-",
        repo,
        text: l.text,
      });
      taken.push(l);
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

/** One line's mark under the lock, only from the mark `to` expects; `note` lands right after the id. */
export async function markQueue(
  file: string,
  id: string,
  to: MarkTarget,
  note?: string,
): Promise<MarkResult> {
  if (!ID_RE.test(id)) throw new QueueError(`refused task id "${id}"`);
  // A note is one free-text field: a `|`, a leading `key:` or a `⏸` would rewrite the line's metadata.
  if (note !== undefined && /[\n\r|⏸]|^\s*[a-z]+:/.test(note))
    throw new QueueError("a note is one line without `|`, `⏸` or a leading `key:`");
  const { from, to: mark } = MARK_TARGETS[to];
  return withQueueLock(file, () =>
    replanning(file, () => {
      const queue = readQueue(file);
      const line = queue.lines.find(l => l.id === id);
      if (!line) throw new QueueError(`no line ${id} in ${queue.file}`);
      if (line.mark !== from) throw new QueueError(`${id} is [${line.mark}], expected [${from}]`);
      const rows = [...queue.rows];
      setMark(rows, line, mark, note?.trim() || undefined);
      return writeRows(queue, rows) ? { id, from, to: mark } : false;
    }),
  );
}

/** The pick's summary: counts, a pause, why nothing was admitted, and (with `explain`) why each pending line waits. */
export function formatPickSummary(r: PickResult, explain: boolean): string {
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
  if (explain) for (const x of r.reasons) out.push(`  ${x.id}: ${x.why}`);
  return out.join("\n");
}

/** `ID\tmodel\teffort\trepo` — one admitted line as the exec form prints it. */
export function formatTask(a: AdmittedTask): string {
  return [a.id, a.model, a.effort, a.repo].join("\t");
}
