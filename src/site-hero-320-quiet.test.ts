import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Running the 320 px hero test must leave no console output: a stray console.log shows as a "stdout |" block in vitest's report.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("the 320 px hero test run", () => {
  it("prints nothing to stdout", () => {
    const r = spawnSync(
      "node",
      ["node_modules/vitest/vitest.mjs", "run", "src/site-hero-320.test.ts"],
      { cwd: ROOT, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } },
    );
    const report = `${r.stdout}${r.stderr}`;
    // with no browser installed (a clean CI image) the run skips its tests: nothing prints, and nothing failed
    expect(report, "the run itself completed").toMatch(/Tests\s+(\d+ passed|\d+ skipped)/);
    expect(report, "no test of the run failed").not.toMatch(/\d+ failed/);
    expect(report, "no console output in the run").not.toMatch(/^stdout \|/m);
  }, 240_000);

  it("the real-browser site tests share one helper module, none copies its browser lookup, server or docs build", () => {
    const src = path.join(ROOT, "src");
    const copies = fs
      .readdirSync(src)
      .filter(f => /^site-.*\.test\.ts$/.test(f) && f !== "site-hero-320-quiet.test.ts")
      .filter(f =>
        /function browserPath|http\.createServer|vitepress\.js/.test(
          fs.readFileSync(path.join(src, f), "utf8"),
        ),
      );
    expect(copies, "tests that define their own browserPath, server or docs build").toEqual([]);
  });
});
