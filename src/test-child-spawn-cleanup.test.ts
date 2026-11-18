import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnChild } from "./test-helpers.js";

// ENG-TEST-CHILD-SPAWN-TIMEOUT-CLEANUP: the tests that spawn a child vitest must remove the temp
// directories they make, and give the child a timeout that fails with its own output. This runs src/test-child-vitest.test.ts (which itself runs
// src/test-git-no-sign.test.ts) with TMPDIR pointing at a fresh directory and reads what is left.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("tests that spawn a child vitest clean up after themselves", () => {
  it("leave none of their mkdtemp directories behind", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-spawncleanup-"));
    try {
      const r = spawnSync(
        "npx",
        ["vitest", "run", "--maxWorkers=1", "src/test-child-vitest.test.ts"],
        {
          cwd: ROOT,
          encoding: "utf8",
          env: { ...process.env, TMPDIR: tmp },
          timeout: 240_000,
        },
      );
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const left = fs.readdirSync(tmp).filter(n => /^wf-(nosign|childvitest)-/.test(n));
      expect(left).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 280_000);

  it("spawnChild fails a hung child at its timeout, with the child's own output", () => {
    const hang = 'process.stderr.write("child says hello\\n"); setTimeout(() => {}, 60000)';
    expect(() => spawnChild("node", ["-e", hang], { timeout: 1500 })).toThrow(
      /ETIMEDOUT[\s\S]*child says hello/,
    );
  });

  it("every test that spawns a child vitest goes through spawnChild with a timeout", () => {
    for (const file of [
      "test-child-vitest",
      "test-git-no-sign",
      "ci-browser-red",
      "ci-shallow-clone-tests",
    ]) {
      const text = fs.readFileSync(path.join(ROOT, "src", `${file}.test.ts`), "utf8");
      expect([file, /\bspawnSync\(/.test(text)]).toEqual([file, false]);
      expect([file, /spawnChild\([^;]*?timeout: \d[\d_]*/s.test(text)]).toEqual([file, true]);
    }
  });
});
