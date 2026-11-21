// Reproduces ENG-PANE-LANDED-SHA-OTHER-REPO: a landed queue line with `repo:` set (an engine line lands in the engine repo, not
// the queue's repo) draws `—` for its sha in the Landed tree. The pane reads `Slice:`-trailer commits of the PROJECT repo's land
// branch only; the line is then found by the ledger fallback, which writes sha '—'. The one source is the line's queue mark note
// (`landed <sha>`), which /api/queue carries as `landedSha`.
// The pane runs in the real `claude plugin test` harness (see pane-landed-after-restart.test.ts for the pattern).
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { describeQueue, parseQueue } from "./queue.js";

const root = resolve(import.meta.dirname, "..");
const HAVE_CLAUDE = spawnSync("claude", ["--version"], { stdio: "ignore" }).error === undefined;

const PANE_TESTS = String.raw`
const ENG_SHA = 'eee5555'
const row = (task: string, started: string, ended: string, usd: number) =>
  JSON.stringify({ workflow: 'engine-task', task, started_at: started, ended_at: ended, outcome: 'completed', visits: { land: 1 }, difficulty: 3, spend: { agents: 1, usd, input: 1, output: 1, cache_read: 1, cache_write: 1 } })
const LEDGER = [row('DONE-1', '2026-11-07T09:20:00Z', '2026-11-07T10:00:00Z', 1.5), row('OLD-1', '2026-11-07T08:10:00Z', '2026-11-07T09:00:00Z', 2.5)].join('\n')

// the queue repo (/proj) holds no commit of DONE-1: it landed in the line's own repo, and the queue's answer carries the sha its
// notes name (landedSha)
const git = (e: unknown) => (JSON.stringify(e).includes('"branch"') ? 'main\n' : '')

test('a landed line with repo: set draws its sha, not a dash', async ($, on) => {
  const done = (API_QUEUE as any).lines.find((l: any) => l.id === 'DONE-1')
  done.landedSha = ENG_SHA
  engine(on, true, { git: git as never, ledger: LEDGER })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 120 }, surface: 'terminal' })
  const all = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string)
  // eslint-disable-next-line no-console
  console.log('PANE TEXTS: ' + JSON.stringify(all.filter(t => /DONE-1|OLD-1|eee5555|—/.test(t))))
  expect(all.join('|'), 'the land sha of DONE-1').toContain(ENG_SHA)
  await ui.unmount()
  delete done.landedSha // the fixture is shared with the next test
})

test('a pre-trailer land of a line with no repo still draws a dash', async ($, on) => {
  engine(on, true, { git: ((e: unknown) => (JSON.stringify(e).includes('"branch"') ? 'main\n' : '')) as never, ledger: LEDGER })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 120 }, surface: 'terminal' })
  const all = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string)
  expect(all.filter(t => /—.*(DONE-1|OLD-1)/.test(t)).length).toBeGreaterThan(0)
  await ui.unmount()
})
`;

describe.skipIf(!HAVE_CLAUDE)(
  "ENG-PANE-LANDED-SHA-OTHER-REPO: Landed sha of a line that landed in another repo",
  () => {
    it("draws the sha of a landed line with repo: set (real `claude plugin test` harness)", () => {
      const dir = mkdtempSync(join(tmpdir(), "wf-pane-sha-other."));
      try {
        for (const d of [".claude-plugin", "hooks", "types"])
          cpSync(join(root, d), join(dir, d), { recursive: true });
        rmSync(join(dir, "hooks", "plan-pane.test.tsx"));
        const real = readFileSync(join(root, "hooks", "plan-pane.test.tsx"), "utf8");
        const header = real.slice(0, real.indexOf("\ntest("));
        writeFileSync(join(dir, "hooks", "sha-other.test.tsx"), header + "\n" + PANE_TESTS);
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

describe("ENG-PANE-LANDED-SHA-OTHER-REPO: /api/queue carries the land sha a line's notes name", () => {
  const yaml = (notes: string) =>
    `batch_size: 2\ntasks:\n  - id: A\n    status: done\n    difficulty: 3\n    repo: /eng\n    text: t\n${notes}`;
  const shaOf = (notes: string) =>
    describeQueue(parseQueue(yaml(notes), "/tmp/q.yaml")).lines[0]?.landedSha;

  it("reads `landed <sha>` and `LANDED <sha> <date>; ...` of the latest such note, lower-cased", () => {
    expect(shaOf("    notes:\n      - from: mark\n        text: landed abddf46\n")).toBe("abddf46");
    expect(
      shaOf(
        "    notes:\n      - text: 'LANDED 8D04C296A 2026-11-10; impact suite'\n      - text: landed 1234567\n      - text: later remark\n",
      ),
    ).toBe("1234567");
  });

  it("is absent for a land with no sha in its notes (a pre-trailer land stays a dash)", () => {
    expect(
      shaOf("    notes:\n      - text: landed somewhere\n      - text: landed abc\n"),
    ).toBeUndefined();
    expect(shaOf("")).toBeUndefined();
  });
});
