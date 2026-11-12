import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupDir } from "./test-helpers.js";

describe("wf-run records the run time of a lease in the pool's history", () => {
  const argv = process.argv;
  const poolDir = process.env.WF_POOL_DIR;
  let dir: string | undefined;
  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
    if (poolDir === undefined) delete process.env.WF_POOL_DIR;
    else process.env.WF_POOL_DIR = poolDir;
    if (dir) cleanupDir(dir);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const wfRun = async (...args: string[]): Promise<number | string | undefined> => {
    vi.resetModules();
    process.argv = ["node", "wf-run", ...args];
    process.exitCode = undefined;
    await import("./wf-run.js");
    for (let i = 0; i < 200 && process.exitCode === undefined; i++)
      await new Promise(res => setTimeout(res, 20));
    return process.exitCode;
  };

  it("a command that exits 0 is recorded under its label key, one that fails is not", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-run-hist-"));
    fs.writeFileSync(
      path.join(dir, "config.yaml"),
      JSON.stringify({ budget: 6, load_threshold: 0 }),
    );
    process.env.WF_POOL_DIR = dir;
    expect(await wfRun("--threads", "1", "--label", "build ENG-ONE", "--", "sleep", "0.05")).toBe(
      0,
    );
    expect(await wfRun("--threads", "1", "--label", "build ENG-TWO", "--", "false")).toBe(1);
    const state = JSON.parse(fs.readFileSync(path.join(dir, "pool.json"), "utf8")) as {
      history?: Record<string, number[]>;
    };
    expect(Object.keys(state.history ?? {})).toEqual(["build *"]);
    expect(state.history?.["build *"]).toHaveLength(1);
  });
});
