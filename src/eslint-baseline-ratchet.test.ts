import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("eslint baseline ratchet", () => {
  it("npm run lint leaves no fixed-but-still-baselined findings", () => {
    const run = spawnSync(process.execPath, [join(root, "scripts/lint-new.mjs")], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toMatch(/fixed - run --update-baseline/);
  }, 300_000);
});
