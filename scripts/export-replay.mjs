#!/usr/bin/env node
// Exports the replay the documentation site's landing page plays: a window of REAL sessions of the open-source
// projects (anyparse, and the engine's own, mcp-workflow-engine, whose tasks the same dispatcher drives), from the
// recorded event log (<state dir>/events/run-*.jsonl), into docs/public/replay/anyparse.json. Only sessions of
// --project and --also (and their children) are read into the file; every other project's session, path and id
// stays in the log. The cut is `buildReplay` (src/replay.ts).
//
// The tasks of those sessions get their real spend from the ledger (<state dir>/ledger.jsonl, `spend.usd` summed over
// every run of the line, as the plan pane reads it): the same allowlist, a row whose task is not a task of the replay
// is never read into the file, and a task with no measured spend carries none (the pane draws `—`).
//
// The queue the plan pane shows (Next, Waiting) comes from the queue file (--queue, default the project's own): the engine's
// own pick (`planPick`, `describeQueue`, the code `wf-queue` and `queue_next` run) over the file rolled back to the window's
// start (the lines that ran at or after the window start set back to pending), written as ids, difficulty, priority, kind and one of a fixed
// set of reasons (after X, overlaps X, parked, parent-run) for the lines of --project and --also only, never a line's text or
// notes; the replay moves them Waiting -> Next -> Running as the sessions start and end. A line added to the queue after the
// window cannot be rebuilt (the file's `queue.note` says so). `--queue none` writes no queue section.
//
// The machine's thread pool over the same window comes from the pool's log (<pool dir>/pool.log.1 and pool.log): a
// lease or waiter keeps its label only when it names a session or slice of the replay (an ALLOWLIST: the pool is
// shared by every project on the machine), every other one is a thread count in a row of leases the log does not name (this
// project's or another's: a sample lists no holders, only an overrun or backfill line names one). Before anything is written
// `assertReplayClean` checks the result (every label on the allowlist, no absolute path, no pid) and a violation
// refuses the write. Only a window the pool log covers is chosen.
//
//   npm run build && node scripts/export-replay.mjs [--project anyparse] [--also mcp-workflow-engine] [--project-dir DIR]
//        [--workflows DIR,DIR] [--events DIR] [--ledger FILE|none] [--pool DIR|none] [--queue FILE|none] [--from ISO] [--hours 4]
//        [--max-kb 300] [--out FILE]
//
// --project-dir  the project's checkout: its .claude/workflows give the stations of the workflows the sessions
//                ran, its .claude/batch/queue.yaml (or --queue) the kind of each task (default: the cwd)
// --workflows    more `.claude/workflows` directories, comma separated: a workflow of a kept --also project that lives in its
//                own directory (the engine's `engine-task`) takes its stations from there; a name already loaded keeps its own
// --also         more projects kept the same way, comma separated (default mcp-workflow-engine; `none` keeps --project alone)
// --queue        the queue file: the kind of each task and the queue the pane shows (default: <project-dir>/.claude/batch/queue.yaml)
// --ledger       the ledger file (default: <state dir>/ledger.jsonl); `none` writes no spend
// --events       the event log directory (default: $STATE_DIR or ~/.claude/workflow-state, then /events)
// --pool         the pool directory (default: $WF_POOL_DIR or ~/.claude/workflow-pool); `none` writes no pool
// --from/--hours the window; without --from the best window of that length is chosen (a land, a split,
//                review rounds, several lanes at once) that fits --max-kb
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

function readEvents(dir) {
  const events = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith(".jsonl")).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (line === "") continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // a torn last line of a log the server was killed in
      }
    }
  }
  return events;
}

/** The pool log's lines, the older file first; a pool directory with no log is no lines. */
function readPoolLog(dir) {
  const lines = [];
  for (const f of ["pool.log.1", "pool.log"]) {
    const file = path.join(dir, f);
    if (fs.existsSync(file)) lines.push(...fs.readFileSync(file, "utf8").split("\n"));
  }
  return lines;
}

/** The pool's load threshold: its config's `load_threshold`, else the pool's own default. */
async function readThreshold(dir, fallback) {
  const file = path.join(dir, "config.yaml");
  if (!fs.existsSync(file)) return fallback;
  const YAML = (await import("yaml")).default;
  const t = YAML.parse(fs.readFileSync(file, "utf8"))?.load_threshold;
  return typeof t === "number" ? t : fallback;
}

/** The queue's `kind` per line id; a queue that cannot be read is no kinds. */
async function readKinds(file) {
  if (!fs.existsSync(file)) return {};
  const YAML = (await import("yaml")).default;
  const doc = YAML.parse(fs.readFileSync(file, "utf8"));
  const kinds = {};
  for (const line of Array.isArray(doc?.tasks) ? doc.tasks : []) {
    if (typeof line?.id === "string" && typeof line.kind === "string") kinds[line.id] = line.kind;
  }
  return kinds;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const project = args.project ?? "anyparse";
  const also = (args.also ?? "mcp-workflow-engine").split(",").filter(p => p !== "" && p !== "none");
  const stateDir = process.env.STATE_DIR ?? path.join(os.homedir(), ".claude", "workflow-state");
  const ledgerFile = args.ledger === undefined ? path.join(stateDir, "ledger.jsonl") : args.ledger === "none" ? undefined : path.resolve(args.ledger);
  const ledger = ledgerFile !== undefined && fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, "utf8") : undefined;
  const projectDir = path.resolve(args["project-dir"] ?? process.cwd());
  const eventsDir = args.events ?? path.join(stateDir, "events");
  const out = path.resolve(args.out ?? path.join(root, "docs", "public", "replay", `${project}.json`));
  const { assertReplayClean, buildReplay, renderReplay } = await load("replay.js");
  const { workflowDirs } = await load("workflow-dirs.js");
  const { Loader } = await load("loader.js");
  const { computeStations } = await load("stations.js");
  const { resolvePoolDir, RESERVED_CORES } = await load("pool.js");
  const { readQueue } = await load("queue.js");
  const { captureReplayQueue } = await load("replay-queue.js");

  const dirs = workflowDirs(process.env, projectDir);
  const loader = new Loader(dirs.bundled, dirs.global, dirs.project);
  const workflows = {};
  const entry = wf => ({
    stations: computeStations(wf),
    ...(wf.map === false ? { map: false } : {}),
    ...(wf.driver ? { driver: { model: wf.driver.model, effort: wf.driver.effort } } : {}),
  });
  for (const [name, wf] of loader.getAll()) {
    workflows[name] = entry(wf);
  }
  for (const extra of (args.workflows ?? "").split(",").filter(d => d !== "")) {
    for (const [name, wf] of new Loader(dirs.bundled, dirs.global, path.resolve(extra)).getAll()) {
      if (Object.hasOwn(workflows, name)) continue;
      workflows[name] = entry(wf);
    }
  }
  const queueFile = args.queue === "none" ? undefined : path.resolve(args.queue ?? path.join(projectDir, ".claude", "batch", "queue.yaml"));
  let queue;
  if (queueFile !== undefined && fs.existsSync(queueFile)) {
    try {
      queue = readQueue(queueFile);
    } catch (err) {
      // a queue the pick cannot read still gives the kinds; the replay then has no queue section
      console.error(`export-replay: no queue section, ${err.message}`);
    }
  }
  const poolDir = args.pool === undefined ? resolvePoolDir(process.env) : args.pool === "none" ? undefined : path.resolve(args.pool);
  const poolLines = poolDir === undefined ? [] : readPoolLog(poolDir);
  const file = buildReplay(readEvents(eventsDir), {
    project,
    also,
    workflows,
    ...(ledger === undefined ? {} : { ledger }),
    taskKinds: queueFile === undefined ? {} : await readKinds(queueFile),
    ...(queue === undefined ? {} : { queue: ranSince => captureReplayQueue(queue, ranSince, [project, ...also]) }),
    ...(args.from === undefined ? {} : { from: args.from }),
    ...(args.hours === undefined ? {} : { hours: Number(args.hours) }),
    maxBytes: Number(args["max-kb"] ?? 300) * 1000,
    ...(poolDir === undefined || poolLines.length === 0
      ? {}
      : { pool: { lines: poolLines, threshold: await readThreshold(poolDir, RESERVED_CORES) } }),
  });
  assertReplayClean(file, [os.homedir()]);
  const text = renderReplay(file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(
    `${path.relative(process.cwd(), out)}: ${(Buffer.byteLength(text) / 1000).toFixed(1)} KB, ${file.sessions.length} sessions, ${file.events.length} events, ${Object.keys(file.spend ?? {}).length} tasks with spend, ${file.queue?.lines.length ?? 0} queue lines, ${file.pool?.frames.length ?? 0} pool samples, ${(file.durationMs / 3600_000).toFixed(2)} h from ${file.start}`,
  );
  // the loader watches its directories: the process ends by itself only without them
  process.exit(0);
}

main().catch(err => {
  console.error(`export-replay: ${err.message}`);
  process.exit(1);
});
