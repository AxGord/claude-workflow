import { afterEach, describe, expect, it, vi } from "vitest";

const spawnFailure = new Error("spawn boom");
vi.mock("node:child_process", () => ({
  spawn: () => {
    throw spawnFailure;
  },
}));

describe("wf-run", () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  // --efficiency without a lock runs the child straight, without the pool (macOS only).
  it.runIf(process.platform === "darwin")(
    "a spawn that throws ends the run with exit 1 and the reason, never a hang",
    async () => {
      const stderr: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
        stderr.push(String(chunk));
        return true;
      });
      process.argv = ["node", "wf-run", "--efficiency", "--", "true"];
      await import("./wf-run.js");
      for (let i = 0; i < 50 && process.exitCode === undefined; i++)
        await new Promise(res => setTimeout(res, 10));
      expect(process.exitCode).toBe(1);
      expect(stderr.join("")).toContain("wf-run: spawn boom");
    },
  );
});
