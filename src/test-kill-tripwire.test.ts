import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardKill } from "./test-kill-tripwire.js";
import { cleanupDir, isSignalablePid } from "./test-helpers.js";

// A test that signals pid 0 (an empty pid-file read becomes Number("") === 0) signals its whole
// process group: the gate died with 137 (ENG-TEST-KILL-ZERO-GUARD). The vitest setup file must refuse
// a signal to pid 0 in every test process. SIGURG stands in for SIGKILL: its default action is
// ignore, so a test run that has no tripwire yet fails here without killing anyone.
describe("process.kill tripwire in the test process", () => {
  it("refuses a non-zero signal to pid 0 instead of delivering it to the process group", () => {
    let outcome = "delivered to the process group";
    try {
      process.kill(0, "SIGURG");
    } catch {
      outcome = "refused";
    }
    expect(outcome).toBe("refused");
  });
});

describe("guardKill", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) cleanupDir(dir);
    dir = undefined;
  });
  const setup = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-kill-tripwire-"));
    const file = path.join(dir, "tripwire.log");
    const underlying = vi.fn(() => true);
    const kill = guardKill(
      underlying as unknown as typeof process.kill,
      file,
      () => new Date("2026-11-28T00:00:00.000Z"),
    );
    return { file, underlying, kill };
  };

  it("throws on kill(0, SIGKILL), writes the time and the caller's stack, and never reaches the underlying kill", () => {
    const { file, underlying, kill } = setup();
    expect(() => kill(0, "SIGKILL")).toThrow(/refused/);
    expect(underlying).not.toHaveBeenCalled();
    const entry = fs.readFileSync(file, "utf8");
    expect(entry).toContain("2026-11-28T00:00:00.000Z process.kill(0, SIGKILL) refused");
    expect(entry).toContain("test-kill-tripwire.test.ts");
  });

  it("refuses pid 1, -1 and -0 with any non-zero signal, a default signal included", () => {
    const { file, underlying, kill } = setup();
    for (const pid of [1, -1, -0]) expect(() => kill(pid, "SIGTERM")).toThrow(/refused/);
    expect(() => kill(0)).toThrow(/refused/);
    expect(underlying).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8").match(/refused\n/g)).toHaveLength(4);
  });

  it("passes the liveness probe (signal 0) and a signal to an ordinary pid through", () => {
    const { file, underlying, kill } = setup();
    expect(kill(0, 0)).toBe(true);
    expect(kill(1, 0)).toBe(true);
    expect(kill(4242, "SIGKILL")).toBe(true);
    expect(underlying).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("isSignalablePid", () => {
  it("refuses pid 0 and 1, a negative, a fraction and NaN; accepts an ordinary pid", () => {
    for (const pid of [0, 1, -1, 2.5, Number.NaN, Number("")]) {
      expect(isSignalablePid(pid)).toBe(false);
    }
    expect(isSignalablePid(2)).toBe(true);
    expect(isSignalablePid(31337)).toBe(true);
  });
});
