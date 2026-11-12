// Reproduces ENG-PANE-PRIORITY-NO-PAD: a short id is padded to the widest id before its priority glyph.
// The pane is a `claude plugin test` component (hooks/*.test.tsx), which vitest cannot import; so this test copies
// the plugin to a scratch folder, adds the failing pane tests (below, as text) beside the real header of
// hooks/plan-pane.test.tsx (its `engine()` stand-ins), and runs the pane in the real harness.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
// Without `claude` on PATH (CI, `npm run check:ci`) the pane's tests are skipped, as `npm run test:pane` skips them.
const HAVE_CLAUDE = spawnSync("claude", ["--version"], { stdio: "ignore" }).error === undefined;

const PANE_TESTS = String.raw`
async function paneTexts($: any, columns: number): Promise<string[]> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: columns }, surface: 'terminal' })
  const all = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string)
  await ui.unmount()
  return all
}
test('Next: the priority glyph follows the id after ONE space, a short id is not padded to a column', async ($, on) => {
  engine(on, true)
  const long = { ...API_QUEUE.lines.find(l => l.id === 'NEXT-1')!, id: 'NEXT-WITH-A-LONG-ID' }
  API_QUEUE.lines.push(long as never)
  try {
    const wide = await paneTexts($, 100)
    expect(wide.some(t => /NEXT-2 ↑/.test(t)), wide.join('|')).toBe(true)
    expect(wide.some(t => /NEXT-2 {2,}↑/.test(t))).toBe(false)
  } finally {
    API_QUEUE.lines.pop()
  }
})
`;

describe.skipIf(!HAVE_CLAUDE)("ENG-PANE-PRIORITY-NO-PAD: priority glyph right after the id", () => {
  it("one space between id and glyph (real `claude plugin test` harness)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-pane-nopad."));
    try {
      for (const d of [".claude-plugin", "hooks", "types"])
        cpSync(join(root, d), join(dir, d), { recursive: true });
      rmSync(join(dir, "hooks", "plan-pane.test.tsx"));
      const real = readFileSync(join(root, "hooks", "plan-pane.test.tsx"), "utf8");
      const header = real
        .slice(0, real.indexOf("\ntest("))
        // the host rejects a read over 4 MiB; the engine's ledger-recent.jsonl holds only the recent lines
        .replace(
          "on('fs.read', (_: unknown, e: { path: string }) => ({",
          "on('fs.read', (_: unknown, e: { path: string }) => (e.path.endsWith('/ledger.jsonl') && (landed?.ledger ?? '').length > 4 * 1024 * 1024 ? (() => { throw new Error('over 4 MiB') })() : {",
        )
        .replace(
          "value: e.path.endsWith('ledger.jsonl') ? (landed?.ledger ?? '')",
          "value: e.path.endsWith('ledger-recent.jsonl') ? (landed?.ledger ?? '').split('\\n').slice(-1).join('') : e.path.endsWith('ledger.jsonl') ? (landed?.ledger ?? '')",
        )
        .replace(
          "...(landed ? [{ name: 'ledger.jsonl', kind: 'file', size: 9, mtimeMs: 1 }] : []),",
          "...(landed ? [{ name: 'ledger.jsonl', kind: 'file', size: 9, mtimeMs: 1 }, { name: 'ledger-recent.jsonl', kind: 'file', size: 9, mtimeMs: 1 }] : []),",
        );
      writeFileSync(join(dir, "hooks", "landed.test.tsx"), header + "\n" + PANE_TESTS);
      const r = spawnSync("claude", ["plugin", "test", dir], { encoding: "utf8" });
      expect(r.error).toBeUndefined();
      expect(r.stdout + r.stderr, "the pane tests").not.toMatch(/\(fail\)/);
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
