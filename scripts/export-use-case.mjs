#!/usr/bin/env node
// Writes the snapshot the site's use-case page reads (docs/use-case-anyparse.md -> docs/use-case-anyparse.json):
// how the open-source anyparse project is run on this engine, as numbers and as the facts of its workflow files.
//
// The numbers come from the ledger (<state dir>/ledger.jsonl): the finished runs of ONE project's task pipeline
// (--project, --workflow), folded by `foldUseCase` (src/use-case.ts) into counts and sums. A line of any other
// project is never read into the fold, and the result names no task, no session, no agent and no path
// (`assertUseCaseClean` checks the text before it is written). The facts (the model table, the driver, the recon and
// split thresholds, the review rounds) are read from the project's own workflow files by `workflowFacts`, which
// refuses when a file no longer says one of them.
//
// Deterministic: the same ledger and the same workflow files give the same bytes. The window is the ledger's own
// (the first run's start to the last run's end) unless --to cuts it, so the file is a dated snapshot, not a clock.
//
//   npm run build && node scripts/export-use-case.mjs --project-dir <the anyparse checkout>
//        [--project anyparse] [--workflow slice-pipeline] [--worker slice-worker] [--model-table FILE] [--ledger FILE]
//        [--queue FILE] [--to ISO] [--every 20] [--out FILE]
//
// --project-dir  the project's checkout: its .claude/workflows hold the pipeline's and the worker's files
// --model-table  a copy of the pipeline's file whose model_table is the one in force during the ledger's window
//                (the table the costs were made on); without it the table is today's file's. The thresholds and
//                the driver are always today's files'.
// --queue        the project's queue file (default: <project-dir>/.claude/batch/queue.yaml): only its header is
//                read, for whether a waiting exclusive line holds the lines behind it (`exclusive_hold`)
// --every        lands between two curator runs: the size of the windows the lands are cut into (default 20)
// --ledger       the ledger file (default: $STATE_DIR or ~/.claude/workflow-state, then /ledger.jsonl)
// --to           runs that ended after this moment are left out (default: none)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    out[a.slice(2)] = v;
  }
  return out;
}

async function load(name) {
  const file = path.join(root, "build", name);
  if (!fs.existsSync(file)) throw new Error(`build/${name} is missing: run \`npm run build\` first`);
  return import(pathToFileURL(file).href);
}

function readLedger(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line === "") continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // a torn last line of a ledger the server was killed in
    }
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const project = args.project ?? "anyparse";
  const workflow = args.workflow ?? "slice-pipeline";
  const projectDir = args["project-dir"];
  if (!projectDir) throw new Error("--project-dir <the project's checkout> is required");
  const stateDir = process.env.STATE_DIR ?? path.join(os.homedir(), ".claude", "workflow-state");
  const ledger = args.ledger ?? path.join(stateDir, "ledger.jsonl");
  const out = args.out ?? path.join(root, "docs", `use-case-${project}.json`);
  const to = args.to === undefined ? Infinity : Date.parse(args.to);
  if (Number.isNaN(to)) throw new Error(`--to ${args.to} is not a time`);

  const { foldUseCase, workflowFacts, assertUseCaseClean } = await load("use-case.js");
  const { exclusiveHoldOn, readQueue } = await load("queue.js");
  const queue = args.queue ?? path.join(projectDir, ".claude", "batch", "queue.yaml");
  const yaml = name =>
    YAML.parse(fs.readFileSync(path.join(projectDir, ".claude", "workflows", `${name}.yaml`), "utf8"), {
      merge: true,
    });
  const every = args.every === undefined ? 20 : Number(args.every);
  if (!Number.isInteger(every) || every < 1) throw new Error(`--every ${args.every} is not a count`);
  const dated = args["model-table"];
  const snapshot = {
    project,
    task_workflow: workflow,
    table_of: dated === undefined ? "today" : "window",
    exclusive_hold: exclusiveHoldOn(readQueue(queue)),
    workflow: workflowFacts(
      yaml(workflow),
      yaml(args.worker ?? "slice-worker"),
      dated === undefined ? undefined : YAML.parse(fs.readFileSync(dated, "utf8"), { merge: true }),
    ),
    stats: foldUseCase(
      readLedger(ledger).filter(e => Date.parse(e.ended_at) <= to),
      { project, workflow, every },
    ),
  };
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  assertUseCaseClean(text);
  fs.writeFileSync(out, text);
  const s = snapshot.stats;
  console.log(
    `${path.relative(process.cwd(), out)}: ${(Buffer.byteLength(text) / 1000).toFixed(1)} KB, ${s.from.slice(0, 10)}..${s.to.slice(0, 10)}, ` +
      `${s.runs.total} runs, ${s.runs.landed} landed, $${s.cost.mean} per land over ${s.cost.measured} measured`,
  );
}

main().catch(err => {
  console.error(`export-use-case: ${err.message}`);
  process.exit(1);
});
