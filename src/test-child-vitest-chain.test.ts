import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isUnderOuterWorker,
  isWorker,
  PROBE_SOURCE,
  type ProbeRec,
} from "./test-child-vitest-probe.js";
import { spawnChild } from "./test-helpers.js";

// ENG-CI-CHILD-VITEST-WORKER-CHAIN-LINUX: the one-worker check in test-child-vitest.test.ts must find the
// outer worker above an inner process whatever non-node hop (npm exec's `sh -c`, which stays on Linux)
// sits between them. This builds that chain for real, with the check's own probe and rule.
describe("worker ancestry through a non-node hop", () => {
  it("finds the outer worker above an inner process that is started through sh -c", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-chain-"));
    try {
      fs.mkdirSync(path.join(dir, "workers"));
      const log = path.join(dir, "procs.jsonl");
      const probe = path.join(dir, "probe.cjs");
      fs.writeFileSync(probe, PROBE_SOURCE);
      const inner = path.join(dir, "inner.js");
      fs.writeFileSync(inner, "");
      const worker = path.join(dir, "workers", "forks.js");
      // `; exit $?` keeps the shell alive as a non-node process, as dash does under npm exec on Linux;
      // the node path and the script travel as the shell's arguments, so a path with a space stays one word
      fs.writeFileSync(
        worker,
        `require('node:child_process').execFileSync('sh', ['-c', '"$0" "$1"; exit $?', process.execPath, ${JSON.stringify(inner)}], {stdio: 'inherit', timeout: 20000});`,
      );
      const r = spawnChild(process.execPath, [worker], {
        env: { ...process.env, WF_PROBE_FILE: log, NODE_OPTIONS: `--require=${probe}` },
        timeout: 30_000,
      });
      expect(r.status).toBe(0);
      const recs = fs
        .readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(l => JSON.parse(l) as ProbeRec);
      const innerRec = recs.find(e => e.argv1 === inner);
      expect(innerRec).toBeDefined();
      expect(isUnderOuterWorker(innerRec as ProbeRec)).toBe(true);
      const workerRec = recs.find(e => isWorker(e));
      expect(workerRec).toBeDefined();
      expect(isUnderOuterWorker(workerRec as ProbeRec)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
