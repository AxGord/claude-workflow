#!/usr/bin/env node
// Exports the replay the documentation site's landing page plays: a window of REAL sessions of one
// open-source project, from the recorded event log (<state dir>/events/run-*.jsonl), into
// docs/public/replay/anyparse.json. Only sessions of --project (and their children) are read into the file;
// every other project's session, path and id stays in the log. The cut is `buildReplay` (src/replay.ts).
//
//   npm run build && node scripts/export-replay.mjs [--project anyparse] [--project-dir DIR]
//        [--events DIR] [--queue FILE] [--from ISO] [--hours 4] [--max-kb 300] [--out FILE]
//
// --project-dir  the project's checkout: its .claude/workflows give the stations of the workflows the sessions
//                ran, its .claude/batch/queue.yaml (or --queue) the kind of each task (default: the cwd)
// --events       the event log directory (default: $STATE_DIR or ~/.claude/workflow-state, then /events)
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
  const projectDir = path.resolve(args["project-dir"] ?? process.cwd());
  const eventsDir = args.events ?? path.join(process.env.STATE_DIR ?? path.join(os.homedir(), ".claude", "workflow-state"), "events");
  const out = path.resolve(args.out ?? path.join(root, "docs", "public", "replay", `${project}.json`));
  const { buildReplay, renderReplay } = await load("replay.js");
  const { workflowDirs } = await load("workflow-dirs.js");
  const { Loader } = await load("loader.js");
  const { computeStations } = await load("stations.js");

  const dirs = workflowDirs(process.env, projectDir);
  const loader = new Loader(dirs.bundled, dirs.global, dirs.project);
  const workflows = {};
  for (const [name, wf] of loader.getAll()) {
    workflows[name] = {
      stations: computeStations(wf),
      ...(wf.map === false ? { map: false } : {}),
      ...(wf.driver ? { driver: { model: wf.driver.model, effort: wf.driver.effort } } : {}),
    };
  }
  const file = buildReplay(readEvents(eventsDir), {
    project,
    workflows,
    taskKinds: await readKinds(args.queue ?? path.join(projectDir, ".claude", "batch", "queue.yaml")),
    ...(args.from === undefined ? {} : { from: args.from }),
    ...(args.hours === undefined ? {} : { hours: Number(args.hours) }),
    maxBytes: Number(args["max-kb"] ?? 300) * 1000,
  });
  const text = renderReplay(file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(
    `${path.relative(process.cwd(), out)}: ${(Buffer.byteLength(text) / 1000).toFixed(1)} KB, ${file.sessions.length} sessions, ${file.events.length} events, ${(file.durationMs / 3600_000).toFixed(2)} h from ${file.start}`,
  );
  // the loader watches its directories: the process ends by itself only without them
  process.exit(0);
}

main().catch(err => {
  console.error(`export-replay: ${err.message}`);
  process.exit(1);
});
