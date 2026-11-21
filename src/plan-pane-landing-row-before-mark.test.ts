// Reproduces ENG-PANE-LANDING-ROW-BEFORE-MARK: a commit with a `Slice:` trailer for a queue line that is still `running`
// (the land's merge commit exists, the ledger and the queue mark do not yet) is drawn as a Landed row `? — sha SLICE`.
// The pane is a `claude plugin test` component, which vitest cannot import: the test copies the plugin to a scratch
// folder, adds the failing pane test beside the real header of hooks/plan-pane.test.tsx, and runs it in the real harness.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const HAVE_CLAUDE = spawnSync("claude", ["--version"], { stdio: "ignore" }).error === undefined;

// RUN-1 is the fixture's `status: running` line; the ledger has no landed run of it (the land has not ended yet).
const PANE_TESTS = String.raw`
const GIT_LANDING = ['bdd1f06\t07.11 10:04\tRUN-1'].join('\n')

test('a commit with a Slice trailer for a line still running is not drawn as a Landed row', async ($, on) => {
  engine(on, true, { git: GIT_LANDING, ledger: '' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100 }, surface: 'terminal' })
  const all = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string)
  // the line is in the running group
  expect(all.join('|')).toContain('RUN-1')
  // and its merge commit is no Landed row (the row would carry the sha)
  expect(all.filter(t => t.includes('bdd1f06'))).toEqual([])
})
`;

describe.skipIf(!HAVE_CLAUDE)(
  "ENG-PANE-LANDING-ROW-BEFORE-MARK: Landed row for a line still running",
  () => {
    it("draws no Landed row for a running line (real `claude plugin test` harness)", () => {
      const dir = mkdtempSync(join(tmpdir(), "wf-pane-landing."));
      try {
        for (const d of [".claude-plugin", "hooks", "types"])
          cpSync(join(root, d), join(dir, d), { recursive: true });
        rmSync(join(dir, "hooks", "plan-pane.test.tsx"));
        const real = readFileSync(join(root, "hooks", "plan-pane.test.tsx"), "utf8");
        const header = real.slice(0, real.indexOf("\ntest("));
        writeFileSync(join(dir, "hooks", "landing.test.tsx"), header + "\n" + PANE_TESTS);
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
