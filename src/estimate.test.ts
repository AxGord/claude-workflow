import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Estimates, MAX_AGE_MS, p90 } from "./estimate.js";
import { cleanupDir } from "./test-helpers.js";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const line = (execs: object[], ended_at = new Date(NOW - 1000).toISOString()): string =>
  JSON.stringify({ session_id: "s", ended_at, execs }) + "\n";
const run = (ms: number, extra: object = {}): object => ({
  state: "build",
  duration_ms: ms,
  exit_code: 0,
  threads_granted: 4,
  step_key: "/p|wf|build",
  ...extra,
});

describe("estimate", () => {
  it("p90 is the nearest rank; fewer than 3 samples → none", () => {
    expect(p90([1, 2])).toBeUndefined();
    expect(p90([3, 1, 2])).toBe(3);
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
  });

  it("keys by step and threads; skips failures, fanouts, old runs; reads the appended tail", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-est-"));
    try {
      const fp = path.join(dir, "ledger.jsonl");
      fs.writeFileSync(
        fp,
        line([run(100), run(200), run(9999, { exit_code: 1 }), run(9999, { shards: [] })]) +
          line([run(9999)], new Date(NOW - MAX_AGE_MS - 1).toISOString()) +
          "not json\n",
      );
      const est = new Estimates(fp);
      expect(est.lookup("/p|wf|build", 4, NOW)).toBeUndefined();
      fs.appendFileSync(fp, line([run(300), run(50, { threads_granted: 8 })]));
      expect(est.lookup("/p|wf|build", 4, NOW)).toBe(300);
      expect(est.lookup("/p|wf|build", 8, NOW)).toBeUndefined();
      // a line written in two parts is read once it is whole
      const tail = line([run(400)]);
      fs.appendFileSync(fp, tail.slice(0, 10));
      expect(est.lookup("/p|wf|build", 4, NOW)).toBe(300);
      fs.appendFileSync(fp, tail.slice(10));
      expect(est.lookup("/p|wf|build", 4, NOW)).toBe(400);
      // a replaced ledger is read from the start
      fs.writeFileSync(fp, line([run(1), run(2), run(3)]));
      expect(est.lookup("/p|wf|build", 4, NOW)).toBe(3);
      expect(new Estimates(path.join(dir, "none")).lookup("/p|wf|build", 4, NOW)).toBeUndefined();
    } finally {
      cleanupDir(dir);
    }
  });
});
