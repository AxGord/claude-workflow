// Reproduces ENG-PANE-ADAPTIVE: the plan pane's Running and Landed rows when a row does not fit the pane's width.
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
const GIT2 = ['aaa111\t08.11 13:49\tL-ONE', 'bbb222\t08.11 09:10\tL-NOLEDGER', 'ccc333\t08.11 00:20\tL-MIDNIGHT'].join('\n')
const run = (task: string, started: string, difficulty?: number) =>
  JSON.stringify({ workflow: 'engine-task', task, started_at: started, ...(difficulty ? { difficulty } : {}) })
const LEDGER2 = [run('L-ONE', '2026-11-08T13:02:00Z', 4), run('L-MIDNIGHT', '2026-11-05T12:00:00Z')].join('\n')
const COLUMNS = 38
const LONG_ID = 'RUN-2-AN-IDENTIFIER-THAT-IS-LONG'

async function rowsAt($: any, on: any, widths: number[]): Promise<string[][]> {
  engine(on, true, { git: GIT2, ledger: LEDGER2 })
  API_QUEUE.lines.push({ ...API_QUEUE.lines[0]!, id: LONG_ID } as never)
  try {
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    const out: string[][] = []
    for (const columns of widths) {
      const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: columns }, surface: 'terminal' })
      out.push((await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string))
      await ui.unmount()
    }
    return out
  } finally {
    API_QUEUE.lines.pop()
  }
}
const rows = async ($: any, on: any, columns: number): Promise<string[]> => (await rowsAt($, on, [columns]))[0]!
const textOf = (all: string[], id: string) => all.filter(t => t.includes(id) && /^ +\S/.test(t))

test('Running: one row too long for the pane puts EVERY running row on two lines, the state on an indented second line', async ($, on) => {
  const all = await rows($, on, COLUMNS)
  const short = textOf(all, 'RUN-1')
  // RUN-1 fits on its own (29 cells); the section is laid out as one because RUN-2's row (56 cells) does not
  expect(short).toHaveLength(1)
  expect(short[0]).not.toContain('no pipeline')
  const second = all.filter(t => /^ {3,}\S/.test(t) && t.includes('no pipeline'))
  expect(second.length).toBe(2)
  // no row reaches past the pane: the long id is cut with an ellipsis, never wrapped
  for (const t of all.filter(t => t.includes('RUN-'))) expect(cells(t)).toBeLessThanOrEqual(COLUMNS)
  expect(all.some(t => t.includes('RUN-2') && t.includes('…'))).toBe(true)
})

test('Landed: one row too long for the pane puts EVERY landed row on two lines, the id on an indented second line', async ($, on) => {
  const all = await rows($, on, COLUMNS)
  // L-ONE fits (36 cells); L-NOLEDGER (41) and L-MIDNIGHT (47) do not
  const one = all.filter(t => t.includes('L-ONE'))
  expect(one.length).toBeGreaterThan(0)
  for (const t of one) {
    expect(t).not.toContain('aaa111')
    expect(t).toMatch(/^ {5,}\S/)
  }
  expect(all.some(t => t.includes('aaa111') && !t.includes('L-ONE'))).toBe(true)
  for (const t of all.filter(t => /L-(ONE|NOLEDGER|MIDNIGHT)|aaa111|bbb222|ccc333/.test(t))) expect(cells(t)).toBeLessThanOrEqual(COLUMNS)
})

// the same rows (RUN-2's is 56 cells, the widest Landed row 47) at a width where everything fits
const one = (all: string[]) => {
  for (const id of ['RUN-1', 'RUN-2']) expect(all.some(t => t.includes(id) && /^ +\S/.test(t) && t.includes('no pipeline'))).toBe(true)
  expect(all.some(t => t.includes('L-ONE') && t.includes('aaa111'))).toBe(true)
  expect(all.some(t => t.includes('L-NOLEDGER') && t.includes('bbb222'))).toBe(true)
  expect(all.some(t => t.includes('L-MIDNIGHT') && t.includes('ccc333'))).toBe(true)
  expect(all.some(t => /^ {3,}\S/.test(t) && t.includes('no pipeline') && !t.includes('RUN-'))).toBe(false)
}
const two = (all: string[]) => {
  expect(all.some(t => t.includes('RUN-') && t.includes('no pipeline'))).toBe(false)
  expect(all.some(t => t.includes('L-ONE') && t.includes('aaa111'))).toBe(false)
  expect(all.filter(t => /^ {3,}\S/.test(t) && t.includes('no pipeline'))).toHaveLength(2)
}

test('Running and Landed: when every row fits the pane they stay one line each', async ($, on) => {
  one(await rows($, on, 60))
})

test('a width change flips the form on the same rows: one line at 60, two at 38, one again at 60', async ($, on) => {
  const [wide, narrow, wideAgain] = await rowsAt($, on, [60, COLUMNS, 60])
  one(wide!)
  two(narrow!)
  one(wideAgain!)
})

test('Landed at a pane narrower than its first line cuts that line with an ellipsis: no row reaches column 0', async ($, on) => {
  const all = await rows($, on, 22)
  const mine = all.filter(t => /L-(ONE|NOLEDGER|MIDNIGHT)|\d\d:\d\d|RUN-/.test(t))
  expect(mine.length).toBeGreaterThan(0)
  for (const t of mine) expect(cells(t)).toBeLessThanOrEqual(22)
  expect(all.some(t => /\d\d:\d\d-/.test(t) && t.includes('…'))).toBe(true)
})
`;

describe.skipIf(!HAVE_CLAUDE)(
  "ENG-PANE-ADAPTIVE: plan pane rows that do not fit the pane width",
  () => {
    it("lay out the whole section as two lines (run in the real `claude plugin test` harness)", () => {
      const dir = mkdtempSync(join(tmpdir(), "wf-pane-adaptive."));
      try {
        for (const d of [".claude-plugin", "hooks", "types"])
          cpSync(join(root, d), join(dir, d), { recursive: true });
        rmSync(join(dir, "hooks", "plan-pane.test.tsx"));
        const real = readFileSync(join(root, "hooks", "plan-pane.test.tsx"), "utf8");
        const header = real.slice(0, real.indexOf("\ntest("));
        writeFileSync(join(dir, "hooks", "adaptive.test.tsx"), header + "\n" + PANE_TESTS);
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
