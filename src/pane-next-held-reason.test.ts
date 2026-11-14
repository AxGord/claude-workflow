// Reproduces ENG-PANE-NEXT-HELD-REASON: with an exclusive line running, Next shows `Next (0)` / `nothing ready`
// instead of the lines the running one unblocks.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const HAVE_CLAUDE = spawnSync("claude", ["--version"], { stdio: "ignore" }).error === undefined;

const PANE_TESTS = String.raw`
test('Next: a running exclusive line and three pending lines of its repo list the two it unblocks, not the one after a pending line', async ($, on) => {
  engine(on, true)
  const saved = API_QUEUE.lines.splice(0, API_QUEUE.lines.length)
  const base = saved.find(l => l.id === 'NEXT-1')!
  const mk = (id: string, status: string, extra = {}) => ({ ...base, id, status, priority: undefined, pickOrder: undefined, ...extra })
  const held = { reason: 'overlaps EXCL-RUN (exclusive EXCL-RUN)' }
  API_QUEUE.lines.push(
    mk('EXCL-RUN', 'running', { exclusive: true, reason: undefined }),
    mk('P-1', 'pending', { ...held, unblockOrder: 0 }),
    mk('P-2', 'pending', { ...held, unblockOrder: 1 }),
    mk('P-AFTER', 'pending', { reason: 'after: P-1 (pending)' }),
  ) as never
  try {
    const all = (await paneTexts($, 100, [])).join('\n')
    expect(all).not.toContain('nothing ready')
    expect(all).toContain('Next (2)')
    expect(all).toContain('P-1')
    expect(all).toContain('P-2')
    expect(all).not.toContain('P-AFTER')
  } finally {
    API_QUEUE.lines.splice(0, API_QUEUE.lines.length, ...saved)
  }
})
`;

describe.skipIf(!HAVE_CLAUDE)("ENG-PANE-NEXT-HELD-REASON", () => {
  it("Next lists the lines the running ones unblock", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-pane-held."));
    try {
      for (const d of [".claude-plugin", "hooks", "types"])
        cpSync(join(root, d), join(dir, d), { recursive: true });
      rmSync(join(dir, "hooks", "plan-pane.test.tsx"));
      const real = readFileSync(join(root, "hooks", "plan-pane.test.tsx"), "utf8");
      const start = real.indexOf("async function paneTexts");
      const header = real.slice(0, real.indexOf("\ntest("));
      expect(start).toBeGreaterThan(0);
      const fn = real.slice(start, real.indexOf("\n}\n", start) + 3);
      writeFileSync(join(dir, "hooks", "held.test.tsx"), header + "\n" + fn + "\n" + PANE_TESTS);
      const r = spawnSync("claude", ["plugin", "test", dir], { encoding: "utf8" });
      expect(r.error).toBeUndefined();
      expect(r.stdout + r.stderr, "the pane tests").not.toMatch(/\(fail\)/);
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
