#!/usr/bin/env node
// wf-queue: the exec form of queue_next / queue_mark (src/queue.ts), for a workflow's exec states.
//   wf-queue <queue.md> [--dry-run] [--explain|--explain-all]   pick: stdout one `ID\tmodel\teffort\trepo` per admitted line
//                                                 (marked `[>]`), the summary on stderr; --explain folds
//                                                 "window full" lines into one, --explain-all lists all
//   wf-queue <queue.md> --done|--failed|--release|--running <ID> [--note TEXT]
//   wf-queue <queue.md> --header <key>            the header's value of <key> (empty when absent)
// Exit: 0 admitted ≥1 · 10 nothing admitted, `[>]` lines still run · 11 nothing admitted and nothing
// runs (done; what stays pending is blocked) · 12 nothing runs and batch_size is 0 (paused) · 2 error.
import {
  QUEUE_EXIT,
  QueueError,
  formatPickSummary,
  formatTask,
  markQueue,
  pickQueue,
  readQueue,
  type MarkTarget,
} from "./queue.js";

const USAGE =
  "usage: wf-queue <queue.md> [--dry-run] [--explain|--explain-all] | --done|--failed|--release|--running <ID> [--note TEXT] | --header <key>";
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
    const rest = args.slice(2);
    if (rest.length > 0 && (rest[0] !== "--note" || rest.length !== 2)) throw new QueueError(USAGE);
    const r = await markQueue(file, id, MARKS[op], rest[1]);
    process.stdout.write(`${r.id}: [${r.from}] → [${r.to}]\n`);
    return 0;
  }
  if (op === "--header") {
    if (!args[1] || args.length !== 2) throw new QueueError(USAGE);
    process.stdout.write(readQueue(file).header[args[1]] ?? "");
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
