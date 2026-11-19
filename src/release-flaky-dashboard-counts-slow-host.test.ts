import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnChild } from "./test-helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ENG-RELEASE-FLAKY-TESTS (ENG-DASHBOARD-TEST-TIMING-MARGIN): dashboard.test.ts asserts that the
// counts read took under 400 ms of WALL time. A host that answers an HTTP round trip slowly
// (a pool at 14/14, a loaded machine) fails it though the code is right. The slow host is
// simulated by a preload that delays every `fetch` by 450 ms; the test file, run as a contributor
// runs it, must still pass: a test of "no measuring window" does not depend on the host's speed.
describe("dashboard.test.ts on a host whose HTTP round trip takes 450 ms", () => {
  it("the counts-read case still passes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-slow-host-"));
    try {
      const preload = path.join(dir, "slow-fetch.mjs");
      fs.writeFileSync(
        preload,
        "const real = globalThis.fetch;\n" +
          "globalThis.fetch = async (...a) => { await new Promise(r => setTimeout(r, 450)); return real(...a); };\n",
      );
      const r = spawnChild(
        "npx",
        ["vitest", "run", "src/dashboard.test.ts", "-t", "with no measuring window"],
        {
          cwd: ROOT,
          timeout: 120_000,
          env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, VITEST_MAX_WORKERS: "1" },
        },
      );
      const out = `${r.stdout}\n${r.stderr}`;
      expect(out).toContain("1 passed");
      expect(r.status, out).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
