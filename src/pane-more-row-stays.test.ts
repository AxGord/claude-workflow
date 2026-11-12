// Reproduces ENG-PANE-MORE-ROW-STAYS: opening a capped list moves its `+N more` toggle row to the list's end.
// Runs the pane in the real `claude plugin test` harness (see plan-pane-adaptive.test.ts for the pattern).
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const HAVE_CLAUDE = spawnSync("claude", ["--version"], { stdio: "ignore" }).error === undefined;

const PANE_TESTS = String.raw`
test('Waiting: the +N more toggle row keeps its index when the list opens', async ($, on) => {
  engine(on, true)
  const extra = Array.from({ length: 30 }, (_, i) => ({ ...API_QUEUE.lines.find(l => l.id === 'WAIT-1')!, id: 'W-' + String(i).padStart(2, '0') }))
  API_QUEUE.lines.push(...(extra as never[]))
  try {
    const open = await paneTexts($, 100, ['tab-waiting', 'fold-waiting-more'])
    const closed = await paneTexts($, 100, ['fold-waiting-more'])
    const at = (all: string[]) => all.findIndex(t => /^[▾▸] \+\d+ more$/.test(t))
    expect(at(closed)).toBeGreaterThanOrEqual(0)
    expect(at(open)).toBe(at(closed))
  } finally {
    API_QUEUE.lines.splice(-30)
  }
})
`;

describe.skipIf(!HAVE_CLAUDE)("ENG-PANE-MORE-ROW-STAYS", () => {
  it("the toggle row index is identical open vs closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-pane-more."));
    try {
      for (const d of [".claude-plugin", "hooks", "types"])
        cpSync(join(root, d), join(dir, d), { recursive: true });
      rmSync(join(dir, "hooks", "plan-pane.test.tsx"));
      const real = readFileSync(join(root, "hooks", "plan-pane.test.tsx"), "utf8");
      const start = real.indexOf("async function paneTexts");
      const header = real.slice(0, real.indexOf("\ntest("));
      expect(start).toBeGreaterThan(0);
      const fn = real.slice(start, real.indexOf("\n}\n", start) + 3);
      writeFileSync(join(dir, "hooks", "more.test.tsx"), header + "\n" + fn + "\n" + PANE_TESTS);
      const r = spawnSync("claude", ["plugin", "test", dir], { encoding: "utf8" });
      expect(r.error).toBeUndefined();
      expect(r.stdout + r.stderr, "the pane tests").not.toMatch(/\(fail\)/);
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
