// The one-time converters to YAML: an old Markdown queue (`- [m] ID | key: value | … | text |`
// lines under `## Tasks`) into the YAML queue (src/queue.ts), and a hand-edited JSON config
// (pool `config.json`, `pool-gate.json`, `read-only-commands.json`) into the same document as YAML.
// The Markdown line parser lives only here: nothing else reads the old format.
import YAML, { Scalar, type YAMLMap, type YAMLSeq } from "yaml";
import { QueueError, STATUSES, type Status, TASK_KEYS, parseQueue, splitList } from "./queue.js";

// `- [m] [⏸ ]ID | fields…`, or `- [m] ID free text` (no `|`: everything after the id is the text).
const LINE_RE = /^- \[(.)\] (⏸\s*)?([A-Za-z0-9._-]+)(?: \|(.*)|\s+(.*))?$/;
const ROW_RE = /^- \[.\] /;
const META_KEYS = new Set([
  "model",
  "effort",
  "after",
  "touches",
  "owner",
  "repo",
  "workflow",
  "exclusive",
  "difficulty",
  "kind",
  "priority",
]);
// A field this long is the line's prose; `⏸` inside prose is a mention, not a pause.
const PROSE_MIN = 160;
const HEADER_RE = /^([a-z_]+):\s*(.*?)\s*$/;
const STATUS_OF: Readonly<Record<string, Status>> = {
  " ": "pending",
  ">": "running",
  x: "done",
  "!": "failed",
};
/** A field that opens with `(<who> <YYYY-MM-DD>…)` is a dated note, not more of the brief. */
const NOTE_RE = /^\(([A-Za-z][\w-]*)[\s,]+(\d{4}-\d{2}-\d{2})[^)]*\)/;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const EMPTY = new Set(["", "—", "-", "|"]);

interface OldNote {
  readonly from: string;
  readonly date?: string;
  readonly text: string;
}

/** One converted task, its keys in TASK_KEYS order. */
export interface ConvertedTask {
  readonly id: string;
  status: Status;
  readonly fields: Record<string, unknown>;
  readonly notes: OldNote[];
}

function note(from: string, text: string): OldNote {
  const date = DATE_RE.exec(text)?.[1];
  return { from, ...(date ? { date } : {}), text };
}

/** One old task line; null when the row is not one. */
export function convertLine(row: string): ConvertedTask | null {
  const m = LINE_RE.exec(row);
  if (!m) return null;
  const fields = [...(m[5] !== undefined ? [m[5]] : (m[4] ?? "").split(" | "))].map(f =>
    f
      .trim()
      .replace(/\s*\|$/, "")
      .trim(),
  );
  const meta: Record<string, string> = {};
  const lead: string[] = [];
  const prose: string[] = [];
  let parked = m[2] !== undefined;
  let inProse = false;
  for (const f of fields) {
    const km = /^([a-z]+):\s*(.*)$/s.exec(f);
    if (km && META_KEYS.has(km[1])) {
      if (!(km[1] in meta)) meta[km[1]] = km[2].trim();
      if (km[1] === "after" && f.includes("⏸")) parked = true;
      continue;
    }
    if (EMPTY.has(f)) continue;
    if (f.length >= PROSE_MIN) inProse = true;
    if (!inProse && f.includes("⏸")) parked = true;
    // a field before any metadata field is a mark's note (queue_mark wrote it right after the id)
    (Object.keys(meta).length === 0 ? lead : prose).push(f);
  }
  const notes: OldNote[] = [];
  if (prose.length === 0 && lead.length > 0) prose.push(lead.pop() as string);
  for (const f of lead) notes.push(note("mark", f));
  const text: string[] = [];
  for (const f of prose) {
    const n = text.length > 0 ? NOTE_RE.exec(f) : null;
    if (n) notes.push({ from: n[1], date: n[2], text: f });
    else text.push(f);
  }
  let status = STATUS_OF[m[1]];
  if (status === undefined) {
    status = "done";
    notes.push({ from: "convert", text: `was [${m[1]}] in the Markdown queue` });
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === "after" || k === "touches") {
      const list = splitList(v.replace(/⏸/g, ""));
      if (k === "touches" || list.length > 0) out[k] = list;
    } else if (k === "exclusive") {
      if (!EMPTY.has(v)) out.exclusive = true;
    } else if (k === "difficulty") out.difficulty = /^\d+$/.test(v) ? Number(v) : v;
    else out[k] = v;
  }
  if (parked) out.parked = true;
  if (text.length > 0) out.text = text.join("\n\n");
  return { id: m[3], status, fields: out, notes };
}

export interface ConvertedQueue {
  readonly header: Record<string, unknown>;
  /** Header comments: `batch_size:`'s goes to `reason:`, the others stay comments. */
  readonly comments: Record<string, string>;
  readonly preamble: string;
  readonly tasks: ConvertedTask[];
  /** Done rows with no readable id, skipped (`line N: <row>`): the caller names them. */
  readonly skipped: string[];
}

/** An old Markdown queue, parsed for conversion. */
export function convertMarkdown(text: string, file = "<queue.md>"): ConvertedQueue {
  const rows = text.split("\n");
  const tasksAt = rows.findIndex(r => r.trim() === "## Tasks");
  if (tasksAt < 0) throw new QueueError(`${file}: no "## Tasks" line`);
  const header: Record<string, unknown> = {};
  const comments: Record<string, string> = {};
  const prose: string[] = [];
  const bases: string[] = [];
  for (const row of rows.slice(0, tasksAt)) {
    const m = HEADER_RE.exec(row);
    if (!m) {
      prose.push(row);
      continue;
    }
    const [, key, raw] = m;
    if (key === "base") {
      bases.push(raw);
      continue;
    }
    if (key in header) continue;
    const c = /^(.*?)\s+#\s*(.*)$/.exec(raw);
    const value = key === "batch_size" || key === "overlap" ? (c?.[1] ?? raw) : raw;
    header[key] = key === "batch_size" && /^\d+$/.test(value) ? Number(value) : value;
    if (c && key === "batch_size") header.reason = c[2];
    else if (c && key === "overlap") comments[key] = c[2];
  }
  if (bases.length > 0) header.base = bases;
  if (typeof header.batch_size !== "number")
    throw new QueueError(`${file}: no "batch_size: N" line in the header`);
  const tasks: ConvertedTask[] = [];
  const seen = new Set<string>();
  const refused: string[] = [];
  const skipped: string[] = [];
  for (const [i, row] of rows.slice(tasksAt + 1).entries()) {
    let t = convertLine(row);
    if (!t) {
      const at = `line ${tasksAt + 2 + i}: ${row.slice(0, 60)}`;
      // a done row without an id is history: skipped and named; an open one refuses the conversion
      if (/^- \[[x\-~]\] /.test(row)) skipped.push(at);
      else if (ROW_RE.test(row)) refused.push(at);
      continue;
    }
    // an id the old format let stand twice gets a suffix: the YAML queue keeps ids unique
    if (seen.has(t.id)) {
      let n = 2;
      while (seen.has(`${t.id}-${n}`)) n++;
      t = { ...t, id: `${t.id}-${n}` };
      t.notes.push({ from: "convert", text: `renamed: the id stood twice in the Markdown queue` });
    }
    seen.add(t.id);
    tasks.push(t);
  }
  // a task row the converter cannot read is never dropped in silence
  if (refused.length > 0)
    throw new QueueError(
      `${file}: ${refused.length} task row(s) not converted:\n  ${refused.join("\n  ")}`,
    );
  return { header, comments, preamble: prose.join("\n").trim(), tasks, skipped };
}

function taskNode(doc: YAML.Document, t: ConvertedTask): YAMLMap {
  const node = doc.createNode({ id: t.id, status: t.status }) as YAMLMap;
  for (const k of TASK_KEYS) {
    const v = t.fields[k];
    if (v === undefined) continue;
    if (k === "text") {
      const s = new Scalar(v);
      s.type = Scalar.BLOCK_LITERAL;
      node.set(k, s);
    } else if (Array.isArray(v)) {
      const seq = doc.createNode(v) as YAMLSeq;
      seq.flow = true;
      node.set(k, seq);
    } else node.set(k, v);
  }
  if (t.notes.length > 0) node.set("notes", doc.createNode(t.notes));
  return node;
}

/** Tasks that are not done take `status` (the converter's `--status`). */
function restatus(tasks: ConvertedTask[], status: Status | undefined): ConvertedTask[] {
  if (status === undefined) return tasks;
  for (const t of tasks) if (t.status !== "done") t.status = status;
  return tasks;
}

/** A whole Markdown queue as YAML text (checked to read back as a queue). */
export function markdownToYaml(
  text: string,
  file?: string,
  status?: Status,
  warn: (line: string) => void = () => {},
): string {
  const q = convertMarkdown(text, file);
  for (const at of q.skipped) warn(`skipped a done row with no id: ${at}`);
  const doc = new YAML.Document({});
  const top = doc.contents as YAMLMap;
  for (const [k, v] of Object.entries(q.header)) {
    const node = doc.createNode(v);
    if (q.comments[k] !== undefined) (node as Scalar).comment = ` ${q.comments[k]}`;
    top.add(doc.createPair(k, node));
  }
  if (q.preamble !== "") {
    const s = new Scalar(q.preamble);
    s.type = Scalar.BLOCK_LITERAL;
    top.add(doc.createPair("preamble", s));
  }
  const tasks = doc.createNode([]) as YAMLSeq;
  tasks.flow = false;
  for (const t of restatus(q.tasks, status)) tasks.items.push(taskNode(doc, t));
  top.add(doc.createPair("tasks", tasks));
  const out = doc.toString({ lineWidth: 0 });
  parseQueue(out, file ?? "<converted>");
  return out;
}

/**
 * `into` (a YAML queue's text) with the open (not done) tasks of the Markdown queue `text`
 * appended under `status`; an id already in `into` is refused. Comments and order of `into` stay.
 */
export function appendMarkdown(
  into: string,
  text: string,
  status: Status = "backlog",
  file?: string,
  warn: (line: string) => void = () => {},
): { text: string; added: number } {
  if (!STATUSES.includes(status)) throw new QueueError(`status "${status}" is not a status`);
  const have = new Set(parseQueue(into, "<into>").lines.map(l => l.id));
  const old = convertMarkdown(text, file);
  for (const at of old.skipped) warn(`skipped a done row with no id: ${at}`);
  const add = restatus(
    old.tasks.filter(t => t.status !== "done"),
    status,
  );
  if (add.length === 0) throw new QueueError(`${file ?? "the queue"}: no open task to append`);
  const dup = add.find(t => have.has(t.id));
  if (dup) throw new QueueError(`${dup.id} is already in the queue`);
  const doc = YAML.parseDocument(into);
  let tasks = doc.get("tasks", true) as YAMLSeq | undefined;
  if (tasks === undefined || !("items" in tasks)) {
    tasks = doc.createNode([]);
    doc.set("tasks", tasks);
  }
  tasks.flow = false;
  for (const t of add) tasks.items.push(taskNode(doc, t));
  const out = doc.toString({ lineWidth: 0 });
  parseQueue(out, file ?? "<converted>");
  return { text: out, added: add.length };
}

/** A JSON config's text as the same document in YAML. */
export function jsonToYaml(text: string): string {
  return YAML.stringify(JSON.parse(text) as unknown, { lineWidth: 0 });
}
