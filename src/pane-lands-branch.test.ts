// Reproduces ENG-PANE-LANDS-BRANCH: the plan pane's Landed section reads `git log … main` only, and only commits with a `Slice:` trailer.
// Runs the pane in the real `claude plugin test` harness (see pane-more-row-stays.test.ts for the pattern).
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const HAVE_CLAUDE = spawnSync("claude", ["--version"], { stdio: "ignore" }).error === undefined;

const PANE_TESTS = String.raw`
const ranOf = (task: string, ended: string, usd: number) =>
  JSON.stringify({ workflow: 'engine-task', task, started_at: '2026-11-07T08:00:00Z', ended_at: ended, outcome: 'completed', visits: { land: 1 },
    spend: { agents: 1, usd, input: 1, output: 1, cache_read: 1, cache_write: 1 } })

test('Landed reads the queue repo\'s checked-out branch, not a hard-coded main', async ($, on) => {
  // a repo whose lands are on its checked-out integration branch; local main has none
  const git = (e: unknown) => {
    const req = JSON.stringify(e)
    if (req.includes('"branch"')) return 'golf-int\n'
    return req.includes('"golf-int"') ? 'aaa111\t07.11 13:49\tL-ONE\nbbb222\t07.11 09:10\tL-TWO' : ''
  }
  engine(on, true, { git: git as never, ledger: '' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✓ Landed · 14d \(2\)/ })).toBeDefined()
  await ui.unmount()
})

test('a land with no Slice trailer is found through the ledger\'s completed task rows', async ($, on) => {
  engine(on, true, { git: 'ccc333\t07.11 08:00\t', ledger: ranOf('DONE-1', '2026-11-07T11:50:00Z', 1.5) })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✓ Landed · 14d \(1\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /DONE-1/ })).toBeDefined()
  await ui.unmount()
})
`;

describe.skipIf(!HAVE_CLAUDE)("ENG-PANE-LANDS-BRANCH", () => {
  it("Landed follows the land branch and falls back to the ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-pane-lands."));
    try {
      for (const d of [".claude-plugin", "hooks", "types"])
        cpSync(join(root, d), join(dir, d), { recursive: true });
      rmSync(join(dir, "hooks", "plan-pane.test.tsx"));
      const real = readFileSync(join(root, "hooks", "plan-pane.test.tsx"), "utf8");
      const header = real.slice(0, real.indexOf("\ntest("));
      writeFileSync(join(dir, "hooks", "lands.test.tsx"), header + "\n" + PANE_TESTS);
      const r = spawnSync("claude", ["plugin", "test", dir], { encoding: "utf8" });
      expect(r.error).toBeUndefined();
      expect(r.stdout + r.stderr, "the pane tests").not.toMatch(/\(fail\)/);
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
