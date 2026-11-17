import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertUnderTmp } from "./test-helpers.js";

// ENG-TEST-ABORT-EXEC-GROUP-FLAKE: a test whose setup timed out under load wrote `b.txt` into the
// repo cwd, because the worktree path it wrote through was empty.
const SRC = path.dirname(fileURLToPath(import.meta.url));

describe("a test writes only inside its own temp dir", () => {
  it("assertUnderTmp refuses an empty path, the cwd, a relative path and a path outside the temp dir", () => {
    const tmp = fs.realpathSync(os.tmpdir());
    for (const bad of ["", ".", process.cwd(), "b.txt", path.join(SRC, ".."), tmp, "/"])
      expect(() => assertUnderTmp(bad), JSON.stringify(bad)).toThrow(/not under the temp dir/);
    const inside = path.join(tmp, "wf-x", "wt");
    expect(assertUnderTmp(inside)).toBe(inside);
  });

  it("every worktree path a test of the batch template or the driver block writes through is checked first", () => {
    for (const file of ["batch-template.test.ts", "driver-block-agent-type.test.ts"]) {
      const text = fs.readFileSync(path.join(SRC, file), "utf8");
      const decls = text.match(/const wt = /g)?.length ?? 0;
      const checked = text.match(/const wt = assertUnderTmp\(/g)?.length ?? 0;
      expect([file, decls > 0, checked]).toEqual([file, true, decls]);
    }
  });
});
