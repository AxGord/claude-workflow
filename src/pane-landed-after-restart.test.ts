// Reproduces ENG-PANE-LANDED-AFTER-RESTART: the Landed section draws a land as `????? ※ — ?` (no difficulty pips, no cost, no start)
// although the ledger holds its row with `difficulty`, `spend` and `started_at`. The row of a git land is joined to the ledger
// through `ledgerRunsOf`/`ledgerSpendOf`, which read only the `slice-pipeline` / `engine-task` workflows; a queue whose task
// workflow is another one (here `golf-task`, a sibling project's) gets every git-found land blank, whatever the process age.
// The pane is a `claude plugin test` component (see plan-pane-landed-row.test.ts for the pattern): the test copies the plugin to a
// scratch folder, adds the failing pane test beside the real header of hooks/plan-pane.test.tsx, and runs the pane in the real harness.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const HAVE_CLAUDE = spawnSync("claude", ["--version"], { stdio: "ignore" }).error === undefined;

const PANE_TESTS = String.raw`
const GIT = ['aaa111\t07.11 10:00\tG-ONE', 'bbb222\t07.11 09:00\tG-TWO'].join('\n')
const rowOf = (task: string, started: string, ended: string, difficulty: number, usd: number) =>
  JSON.stringify({ workflow: 'golf-task', task, started_at: started, ended_at: ended, outcome: 'completed', visits: { land: 1 }, difficulty, spend: { usd } })
const LEDGER = [rowOf('G-ONE', '2026-11-07T09:20:00Z', '2026-11-07T10:00:00Z', 4, 1.5), rowOf('G-TWO', '2026-11-07T08:10:00Z', '2026-11-07T09:00:00Z', 6, 2.5)].join('\n')

test('a land found in git draws its difficulty, start and cost from the ledger row of its task, whatever the task workflow', async ($, on) => {
  engine(on, true, { git: GIT, ledger: LEDGER })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 120 }, surface: 'terminal' })
  const all = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string)
  // eslint-disable-next-line no-console
  console.log('PANE TEXTS: ' + JSON.stringify(all.filter(t => /\?\?\?\?\?|▰|\$|G-ONE|G-TWO|aaa111|bbb222/.test(t))))
  expect(all.filter(t => t.includes('?????')), 'rows drawn with unknown difficulty').toEqual([])
  expect(all.join('|')).toContain('$1.50')
  expect(all.join('|')).toContain('$2.50')
  await ui.unmount()
})
`;

describe.skipIf(!HAVE_CLAUDE)(
  "ENG-PANE-LANDED-AFTER-RESTART: Landed rows blank beside a ledger that knows them",
  () => {
    it("draws difficulty, start and cost of a git land whose task ran in another workflow (real `claude plugin test` harness)", () => {
      const dir = mkdtempSync(join(tmpdir(), "wf-pane-after-restart."));
      try {
        for (const d of [".claude-plugin", "hooks", "types"])
          cpSync(join(root, d), join(dir, d), { recursive: true });
        rmSync(join(dir, "hooks", "plan-pane.test.tsx"));
        const real = readFileSync(join(root, "hooks", "plan-pane.test.tsx"), "utf8");
        const header = real.slice(0, real.indexOf("\ntest("));
        writeFileSync(join(dir, "hooks", "after-restart.test.tsx"), header + "\n" + PANE_TESTS);
        const r = spawnSync("claude", ["plugin", "test", dir], { encoding: "utf8" });
        expect(r.error).toBeUndefined();
        expect(r.stdout + r.stderr, "the pane test").not.toMatch(/\(fail\)/);
        expect(r.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
