// Reproduces ENG-PANE-LANDED-ROW-BROKEN: a ledger over the 4 MiB $.fs.read cap leaves every Landed row with `?` for time and `—` for cost.
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
const GIT3 = ['aaa111\t07.11 13:49\tL-ONE'].join('\n')
const row3 = JSON.stringify({ workflow: 'engine-task', task: 'L-ONE', started_at: '2026-11-07T13:02:00Z', ended_at: '2026-11-07T13:49:00Z', outcome: 'completed', visits: { land: 1 }, difficulty: 4, spend: { agents: 1, usd: 1.5, input: 1, output: 1, cache_read: 1, cache_write: 1 } })
const FOREIGN = JSON.stringify({ workflow: 'other', pad: 'x'.repeat(1000) })
// the live ledger is over 4 MiB; the host rejects a read over that, as the plugin API documents
const BIG = [...Array(4400)].map(() => FOREIGN).concat(row3).join('\n')

test('Landed row keeps its start time and $ when the ledger file is over 4 MiB', async ($, on) => {
  engine(on, true, { git: GIT3, ledger: BIG })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 80 }, surface: 'terminal' })
  const all = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string)
  const mine = all.filter(t => t.includes('L-ONE') || t.includes('aaa111'))
  expect(mine.length).toBeGreaterThan(0)
  // the start is drawn in the clock's local zone, as git draws the land time
  const hm = (d: Date) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  expect(mine.join('|')).toContain(hm(new Date('2026-11-07T13:02:00Z')) + '-13:49')
  expect(mine.join('|')).toContain('$1.50')
})
`;

describe.skipIf(!HAVE_CLAUDE)(
  "ENG-PANE-LANDED-ROW-BROKEN: Landed row with a ledger over 4 MiB",
  () => {
    it("shows start time and $ (real `claude plugin test` harness)", () => {
      const dir = mkdtempSync(join(tmpdir(), "wf-pane-adaptive."));
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
  },
);
