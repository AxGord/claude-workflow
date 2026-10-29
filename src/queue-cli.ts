#!/usr/bin/env node
// wf-queue: the exec form of queue_next / queue_mark (src/queue.ts), for a workflow's exec states.
//   wf-queue <queue.md> [--dry-run] [--explain|--explain-all]   pick: stdout one `ID\tmodel\teffort\trepo\tworkflow` per admitted line
//                                                 (marked `[>]`), the summary on stderr; --explain folds
//                                                 "window full" lines into one, --explain-all lists all
//   wf-queue <queue.md> --done|--failed|--release|--running <ID> [--note TEXT]
//   wf-queue <queue.md> --running <ID> --retry [--note TEXT]   a failed line again: `[!]`→`[>]`
//   wf-queue <queue.md> --header <key>            the header's value of <key> (empty when absent)
//   wf-queue <queue.md> --add <LINE> [--after <ID>|--before <ID>]       queue_add
//   wf-queue <queue.md> --edit <ID> [--set key=value]… [--append-note TEXT]   queue_edit (`key=` removes)
//   wf-queue <queue.md> --batch-size <N> --reason TEXT                   queue_header
// Exit: 0 admitted ≥1 · 10 nothing admitted, `[>]` lines still run · 11 nothing admitted and nothing
// runs (done; what stays pending is blocked) · 12 nothing runs and batch_size is 0 (paused) · 2 error.
import {
  QUEUE_EXIT,
  QueueError,
  addQueueLine,
  editQueueLine,
  formatPickSummary,
  formatTask,
  markQueue,
  pickQueue,
  readQueue,
  setQueueWindow,
  type MarkTarget,
} from "./queue.js";

const USAGE =
  "usage: wf-queue <queue.md> [--dry-run] [--explain|--explain-all] | --done|--failed|--release|--running <ID> [--retry] [--note TEXT] | --header <key>" +
  " | --add <LINE> [--after ID|--before ID] | --edit <ID> [--set key=value]… [--append-note TEXT] | --batch-size <N> --reason TEXT";

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
};

async function main(args: string[]): Promise<number> {
  const file = args.shift();
  if (!file || file.startsWith("--")) throw new QueueError(USAGE);
  const op = args[0];
  if (op !== undefined && op in MARKS) {
    const id = args[1];
    if (!id) throw new QueueError(`${op} needs a task id`);
    const o = options(args.slice(2), ["--note"], [], op === "--running" ? ["--retry"] : []);
    const r = await markQueue(file, id, MARKS[op], o.get("--note")?.[0], {
      retry: o.has("--retry"),
    });
    process.stdout.write(`${r.id}: [${r.from}] → [${r.to}]\n`);
    return 0;
  }
  if (op === "--header") {
    if (!args[1] || args.length !== 2) throw new QueueError(USAGE);
    process.stdout.write(readQueue(file).header[args[1]] ?? "");
    return 0;
  }
  if (op === "--add") {
    if (!args[1]) throw new QueueError("--add needs a line");
    const o = options(args.slice(2), ["--after", "--before"]);
    const r = await addQueueLine(file, args[1], {
      after: o.get("--after")?.[0],
      before: o.get("--before")?.[0],
    });
    process.stdout.write(`${r.id}: added at line ${r.lineNo}\n`);
    return 0;
  }
  if (op === "--edit") {
    if (!args[1]) throw new QueueError("--edit needs a task id");
    const o = options(args.slice(2), ["--set", "--append-note"], ["--set"]);
    const set: Record<string, string> = {};
    for (const kv of o.get("--set") ?? []) {
      const eq = kv.indexOf("=");
      if (eq <= 0) throw new QueueError(`--set takes key=value, not "${kv}"`);
      set[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    const r = await editQueueLine(file, args[1], set, o.get("--append-note")?.[0]);
    process.stdout.write(`${r.line}\n`);
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
