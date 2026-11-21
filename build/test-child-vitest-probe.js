/** `workers/forks.js` is vitest's forks-pool worker entry */
export const isWorker = (r) => r.argv1.endsWith("workers/forks.js");
/** the record of a process below the outermost worker, not of that worker itself */
export const isUnderOuterWorker = (r) => r.outer !== null && r.outer !== r.pid;
/** source of the preload: logs every node process to WF_PROBE_FILE and prints a stray `{` line */
export const PROBE_SOURCE = [
    'const fs = require("node:fs");',
    'const wt = require("node:worker_threads");',
    "const a1 = process.argv[1] || '';",
    "if (wt.isMainThread && a1.endsWith('workers/forks.js') && !process.env.WF_OUTER_WORKER) process.env.WF_OUTER_WORKER = String(process.pid);",
    "const outer = process.env.WF_OUTER_WORKER ? Number(process.env.WF_OUTER_WORKER) : null;",
    "const write = ev => fs.appendFileSync(process.env.WF_PROBE_FILE, JSON.stringify({pid: process.pid, ppid: process.ppid, argv1: a1, outer, ev, at: Date.now()}) + '\\n');",
    "write('start');",
    "if (wt.isMainThread) setInterval(() => write('beat'), 25).unref();",
    "if (wt.isMainThread) process.stdout.write('probe {\"noise\": true}\\n');",
].join("\n");
