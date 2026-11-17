import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// ENG-TEST-CHILD-VITEST-OUTPUT-AND-WORKERS: a test that spawns a child `vitest` must (1) not depend on
// the child's stdout being nothing but the JSON report, and (2) run the child on one worker, not at
// vitest's default parallelism inside a gate that leased fewer threads. This runs the real hygiene test
// (src/test-git-no-sign.test.ts) with a node preload that prints a `{` line first and records every
// process, and reads back what the child did.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = "src/test-git-no-sign.test.ts";

interface Rec {
  pid: number;
  ppid: number;
  argv1: string;
  ev: "start" | "beat";
  at: number;
}

let outerReport: {
  testResults: { status: string; assertionResults: { failureMessages: string[] }[] }[];
};
let recs: Rec[];

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-childvitest-"));
  const probe = path.join(dir, "probe.cjs");
  const log = path.join(dir, "procs.jsonl");
  const out = path.join(dir, "out.json");
  fs.writeFileSync(
    probe,
    [
      'const fs = require("node:fs");',
      'const wt = require("node:worker_threads");',
      "const write = ev => fs.appendFileSync(process.env.WF_PROBE_FILE, JSON.stringify({pid: process.pid, ppid: process.ppid, argv1: process.argv[1], ev, at: Date.now()}) + '\\n');",
      "write('start');",
      "if (wt.isMainThread) setInterval(() => write('beat'), 25).unref();",
      "if (wt.isMainThread) process.stdout.write('probe {\"noise\": true}\\n');",
    ].join("\n"),
  );
  spawnSync(
    "npx",
    ["vitest", "run", "--maxWorkers=1", "--reporter=json", `--outputFile=${out}`, TARGET],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, WF_PROBE_FILE: log, NODE_OPTIONS: `--require=${probe}` },
    },
  );
  outerReport = JSON.parse(fs.readFileSync(out, "utf8")) as typeof outerReport;
  recs = fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l) as Rec);
}, 600_000);

const isWorker = (r: Rec): boolean => r.argv1.endsWith("workers/forks.js");

describe("a test that spawns a child vitest", () => {
  it("reads the report from a file, so a stray `{` on stdout does not break it", () => {
    const t = outerReport.testResults[0];
    expect(t.status, t.assertionResults.flatMap(a => a.failureMessages).join("\n")).toBe("passed");
  });

  it("runs the child on one worker at a time", () => {
    const first = new Map<number, Rec>();
    for (const r of recs) if (!first.has(r.pid)) first.set(r.pid, r);
    const underWorker = (r: Rec): boolean => {
      for (let p = first.get(r.ppid); p; p = first.get(p.ppid)) if (isWorker(p)) return true;
      return false;
    };
    // a worker is killed without a goodbye: it lived from its first record to its last heartbeat
    const spans = [...first.values()]
      .filter(r => isWorker(r) && underWorker(r))
      .map(r => ({
        from: r.at,
        to: Math.max(...recs.filter(e => e.pid === r.pid).map(e => e.at)),
      }));
    expect(spans.length).toBeGreaterThan(0);
    const live = Math.max(
      ...spans.map(s => spans.filter(o => o.from < s.to && s.from < o.to).length),
    );
    expect(live).toBeLessThanOrEqual(1);
  });
});
