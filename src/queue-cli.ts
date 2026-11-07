#!/usr/bin/env node
// wf-queue: the exec form of queue_next / queue_mark (src/queue.ts), for a workflow's exec states.
// The queue: `<queue.yaml>` (a full path), or `--queue NAME` (.claude/batch/NAME.yaml of the cwd's project),
// or nothing (.claude/batch/queue.yaml); `wf-queue [<queue.yaml>|--queue NAME] --path` prints the resolved file.
//   wf-queue <q> [--dry-run] [--explain|--explain-all]   pick: stdout one `ID\tmodel\teffort\trepo\tworkflow\tdifficulty` per admitted task
//                                                 (set running), the summary on stderr; --explain folds
//                                                 "window full" tasks into one, --explain-all lists all
//   wf-queue <q> --done|--failed|--release|--running|--promote|--shelve <ID> [--note TEXT] [--from WHO]
//   wf-queue <q> --running <ID> --retry [--note TEXT]   a failed task again: failed → running, its difficulty +1 (≤10)
//   wf-queue <q> --header <key>                   the header's value of <key> (empty when absent)
//   wf-queue <q> --add <YAML-MAPPING> [--after <ID>|--before <ID>]       queue_add (`{id: X, touches: [a], text: …}`)
//   wf-queue <q> --edit <ID> [--set key=value]… [--append-note TEXT] [--from WHO]   queue_edit (`key=` removes)
//   wf-queue <q> --batch-size <N> --reason TEXT                   queue_header
//   wf-queue --convert <old.md|config.json> [--into <file.yaml>] [--status S] [--dry-run]
//       an old Markdown queue (or a JSON config) as YAML: printed without --into; --into a new file
//       writes it; --into an existing queue appends the old queue's open tasks with --status (default backlog)
// Exit: 0 admitted ≥1 · 10 nothing admitted, running tasks still run · 11 nothing admitted and nothing
// runs (done; what stays pending is blocked) · 12 nothing runs and batch_size is 0 (paused) · 2 error.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { appendMarkdown, jsonToYaml, markdownToYaml } from "./queue-convert.js";
import {
  QUEUE_EXIT,
  QueueError,
  addQueueLine,
  editQueueLine,
  formatMark,
  formatPickSummary,
  formatTask,
  markQueue,
  pickQueue,
  readQueue,
  rewriteQueue,
  resolveQueueFile,
  setQueueWindow,
  STATUSES,
  type MarkTarget,
  type Status,
} from "./queue.js";

const USAGE =
  "usage: wf-queue [<queue.yaml>|--queue NAME] [--dry-run] [--explain|--explain-all] | --done|--failed|--release|--running|--promote|--shelve <ID> [--retry] [--note TEXT] [--from WHO] | --header <key> | --path" +
  " | --add <YAML-MAPPING> [--after ID|--before ID] | --edit <ID> [--set key=value]… [--append-note TEXT] [--from WHO] | --batch-size <N> --reason TEXT" +
  " | --convert <old.md|config.json> [--into FILE.yaml] [--status S] [--dry-run]";

/** `--flag value` pairs after an op; a flag outside `allowed`, a missing value, or a repeat of a non-list flag is a usage error. */
function options(
  rest: readonly string[],
  allowed: readonly string[],
  lists: readonly string[] = [],
  bare: readonly string[] = [],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!allowed.includes(flag) && !bare.includes(flag)) throw new QueueError(USAGE);
    const value = bare.includes(flag) ? "" : rest[++i];
    if (value === undefined) throw new QueueError(`${flag} needs a value`);
    const prev = out.get(flag);
    if (prev && !lists.includes(flag)) throw new QueueError(`${flag} given twice`);
    out.set(flag, [...(prev ?? []), value]);
  }
  return out;
}
const MARKS: Readonly<Record<string, MarkTarget>> = {
  "--done": "done",
  "--failed": "failed",
  "--release": "released",
  "--running": "running",
  "--promote": "promoted",
  "--shelve": "shelved",
};

/** `--convert`: prints, writes or appends (under the queue's lock); returns what it printed. */
async function convert(args: readonly string[]): Promise<string> {
  const src = args[0];
  if (!src || src.startsWith("--")) throw new QueueError("--convert needs a file");
  const o = options(args.slice(1), ["--into", "--status"], [], ["--dry-run"]);
  const text = fs.readFileSync(src, "utf8");
  const status = o.get("--status")?.[0] as Status | undefined;
  if (status !== undefined && !STATUSES.includes(status))
    throw new QueueError(`--status is one of ${STATUSES.join(", ")}`);
  const into = o.get("--into")?.[0];
  const isJson = /\.json$/i.test(src);
  if (isJson && status !== undefined) throw new QueueError("--status is for a queue");
  const appending = into !== undefined && fs.existsSync(into);
  if (isJson && appending) throw new QueueError(`${into} exists: a config is converted once`);
  // the append may run more than once (a changed queue is re-read): each warning prints once
  const warned = new Set<string>();
  const warnOnce = (line: string): void => {
    if (!warned.has(line)) process.stderr.write(`wf-queue: ${line}\n`);
    warned.add(line);
  };
  if (appending) {
    const append = (cur: string) => appendMarkdown(cur, text, status ?? "backlog", src, warnOnce);
    if (o.has("--dry-run")) return append(fs.readFileSync(into, "utf8")).text;
    const added = await rewriteQueue(into, cur => {
      const r = append(cur);
      return { text: r.text, answer: r.added };
    });
    return `appended ${added} task(s) to ${path.resolve(into)}\n`;
  }
  const out = isJson ? jsonToYaml(text) : markdownToYaml(text, src, status, warnOnce);
  if (into === undefined || o.has("--dry-run")) return out;
  fs.mkdirSync(path.dirname(path.resolve(into)), { recursive: true });
  fs.writeFileSync(into, out, { flag: "wx" });
  return `wrote ${path.resolve(into)}\n`;
}

async function main(args: string[]): Promise<number> {
  if (args[0] === "--convert") {
    process.stdout.write(await convert(args.slice(1)));
    return 0;
  }
  let sel: { file?: string; queue?: string };
  if (args[0] === "--queue") {
    const name = args[1];
    if (!name || name.startsWith("--")) throw new QueueError(USAGE);
    sel = { queue: name };
    args.splice(0, 2);
  } else if (args[0] === undefined || args[0].startsWith("--")) {
    sel = {};
  } else {
    sel = { file: args.shift() };
  }
  const file = resolveQueueFile(sel);
  const op = args[0];
  if (op !== undefined && op in MARKS) {
    const id = args[1];
    if (!id) throw new QueueError(`${op} needs a task id`);
    const o = options(
      args.slice(2),
      ["--note", "--from"],
      [],
      op === "--running" ? ["--retry"] : [],
    );
    const from = o.get("--from")?.[0];
    const r = await markQueue(file, id, MARKS[op], o.get("--note")?.[0], {
      retry: o.has("--retry"),
      ...(from !== undefined ? { from } : {}),
    });
    process.stdout.write(`${formatMark(r)}\n`);
    return 0;
  }
  if (op === "--path") {
    if (args.length !== 1) throw new QueueError(USAGE);
    process.stdout.write(file);
    return 0;
  }
  if (op === "--header") {
    if (!args[1] || args.length !== 2) throw new QueueError(USAGE);
    process.stdout.write(readQueue(file).header[args[1]] ?? "");
    return 0;
  }
  if (op === "--add") {
    if (!args[1]) throw new QueueError("--add needs a task (a YAML mapping)");
    const o = options(args.slice(2), ["--after", "--before"]);
    let task: unknown;
    try {
      task = YAML.parse(args[1]);
    } catch (err) {
      throw new QueueError(`--add: not YAML: ${(err as Error).message}`);
    }
    if (typeof task !== "object" || task === null || Array.isArray(task))
      throw new QueueError("--add takes a YAML mapping: {id: X, touches: [a], text: …}");
    const r = await addQueueLine(
      file,
      task as Record<string, unknown>,
      {
        after: o.get("--after")?.[0],
        before: o.get("--before")?.[0],
      },
      { create: sel.file === undefined },
    );
    process.stdout.write(
      `${r.id}: added at line ${r.lineNo}${r.created ? `; the queue did not exist — created ${file}` : ""}\n`,
    );
    return 0;
  }
  if (op === "--edit") {
    if (!args[1]) throw new QueueError("--edit needs a task id");
    const o = options(args.slice(2), ["--set", "--append-note", "--from"], ["--set"]);
    const set: Record<string, string> = {};
    for (const kv of o.get("--set") ?? []) {
      const eq = kv.indexOf("=");
      if (eq <= 0) throw new QueueError(`--set takes key=value, not "${kv}"`);
      set[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    const r = await editQueueLine(
      file,
      args[1],
      set,
      o.get("--append-note")?.[0],
      o.get("--from")?.[0],
    );
    process.stdout.write(`${r.task}\n`);
    return 0;
  }
  if (op === "--batch-size") {
    const o = options(args.slice(2), ["--reason"]);
    const n = args[1] !== undefined && /^\d+$/.test(args[1]) ? Number(args[1]) : Number.NaN;
    if (Number.isNaN(n)) throw new QueueError("--batch-size needs a whole number");
    const reason = o.get("--reason")?.[0];
    if (reason === undefined) throw new QueueError("--batch-size needs --reason TEXT");
    const r = await setQueueWindow(file, n, reason);
    process.stdout.write(`batch_size ${r.from} → ${r.to}  # ${r.reason}\n`);
    return 0;
  }
  const unknown = args.find(a => a !== "--dry-run" && a !== "--explain" && a !== "--explain-all");
  if (unknown !== undefined) throw new QueueError(`unknown argument ${unknown}\n${USAGE}`);
  const r = await pickQueue(file, { dryRun: args.includes("--dry-run") });
  for (const a of r.admitted) process.stdout.write(`${formatTask(a)}\n`);
  process.stderr.write(
    `${formatPickSummary(r, args.includes("--explain-all") ? "all" : args.includes("--explain"))}\n`,
  );
  return r.code;
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`wf-queue: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = QUEUE_EXIT.ERROR;
  },
);
