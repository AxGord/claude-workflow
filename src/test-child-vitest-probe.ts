// The node preload and the ancestry rule of src/test-child-vitest.test.ts. A worker is told apart from
// the processes below it by an env var the outermost worker sets on itself and every descendant
// inherits, not by walking ppid through the probe's records: those hold node processes only, and a
// non-node hop between the outer worker and the inner vitest (npm exec's `sh -c`, which stays on
// Linux) cuts such a walk.
export interface ProbeRec {
  pid: number;
  ppid: number;
  argv1: string;
  /** pid of the outermost `workers/forks.js` process this one runs under or is; null outside one */
  outer: number | null;
  ev: "start" | "beat";
  at: number;
}

/** `workers/forks.js` is vitest's forks-pool worker entry */
export const isWorker = (r: Pick<ProbeRec, "argv1">): boolean =>
  r.argv1.endsWith("workers/forks.js");

/** the record of a process below the outermost worker, not of that worker itself */
export const isUnderOuterWorker = (r: Pick<ProbeRec, "pid" | "outer">): boolean =>
  r.outer !== null && r.outer !== r.pid;

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
