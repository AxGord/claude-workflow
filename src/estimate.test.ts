import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Estimates, MAX_AGE_MS, curveOf, p90 } from "./estimate.js";
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

  it("curveOf keeps the known sizes and fits a + b/k through them for the rest", () => {
    const c = curveOf(
      new Map([
        [2, 540],
        [8, 180],
      ]),
      2,
      8,
    )!;
    expect([c[2], c[8]]).toEqual([540, 180]);
    // 60 serial + 960 / k
    expect(c[4]).toBeCloseTo(300);
    expect(c[6]).toBeCloseTo(220);
    // a size outside the known ones is read off the same curve
    expect(
      curveOf(
        new Map([
          [2, 540],
          [8, 180],
        ]),
        1,
        3,
      )![1],
    ).toBeCloseTo(1020);
    // one known size cannot make a curve, unless it is the whole range
    expect(curveOf(new Map([[4, 300]]), 2, 8)).toBeUndefined();
    expect(curveOf(new Map([[4, 300]]), 4, 4)).toEqual({ 4: 300 });
    // a time that grows with the threads is noise: the mean, flat
    const flat = curveOf(
      new Map([
        [2, 100],
        [8, 300],
      ]),
      2,
      8,
    )!;
    expect([flat[3], flat[5]]).toEqual([200, 200]);
    // a negative serial part is refit as purely parallel
    const par = curveOf(
      new Map([
        [2, 100],
        [4, 10],
      ]),
      2,
      8,
    )!;
    expect(par[8]).toBeGreaterThan(0);
    expect(par[8]).toBeLessThan(par[3]);
  });

  it("curve reads the sizes the ledger has for the step, only those with 3 runs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-est-"));
    try {
      const fp = path.join(dir, "ledger.jsonl");
      const at = (ms: number, threads: number): object => run(ms, { threads_granted: threads });
      fs.writeFileSync(
        fp,
        line([at(540, 2), at(540, 2), at(540, 2), at(180, 8), at(180, 8), at(180, 8), at(1, 5)]),
      );
      const est = new Estimates(fp);
      const c = est.curve("/p|wf|build", 2, 8, NOW)!;
      expect([c[2], c[8]]).toEqual([540, 180]);
      expect(c[4]).toBeCloseTo(300);
      expect(est.curve("/p|wf|other", 2, 8, NOW)).toBeUndefined();
      expect(est.curve("/p|wf|build", 2, 2, NOW)).toEqual({ 2: 540 });
    } finally {
      cleanupDir(dir);
    }
  });
});
