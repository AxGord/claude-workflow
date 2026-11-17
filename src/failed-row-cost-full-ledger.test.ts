// Repro of ENG-FAILED-ROW-COST-FULL-LEDGER: the Failed header sums the whole ledger, but a failed row's $cost read
// ledger-recent.jsonl only, so a line whose runs left the 30-day window showed `—` and the rows no longer added up to the header.
// Runs the pane's own refresh (the session.start handler of hooks/plan-pane.tsx) against a fake plugin host; the host refuses
// a read of ledger.jsonl as the real plugin API does (over 4 MiB), so the full ledger reaches the pane through the engine only.
import { describe, expect, it, vi } from "vitest";

const atoms = new Map<string, { key: string; value: unknown }>();
const writes: { key: string; value: unknown }[] = [];
vi.mock("claude-code", () => ({
  atom: (d: { key: string }, init: unknown) => {
    const a = { key: d.key, value: init };
    atoms.set(d.key, a);
    return a;
  },
  read: (_$: unknown, a: { value: unknown }) => Promise.resolve(a.value),
  update: (_$: unknown, a: { key: string; value: unknown }, f: (v: unknown) => unknown) => {
    a.value = f(a.value);
    writes.push({ key: a.key, value: a.value });
    return Promise.resolve();
  },
}));

const QUEUE = "/proj/.claude/batch/queue.yaml";
const NOW = Date.parse("2026-11-07T10:05:00Z");
const day = (d: string) => `${d}T12:00:00Z`;

const failedLine = (id: string, ended: string) => ({
  id,
  afterIds: [],
  status: "failed",
  kind: "bug",
  mark: " ",
  exclusive: false,
  paused: false,
  notes: 1,
  lastNoteDate: ended,
  lastNote: "x",
  ended,
  text: "t",
});
const API_QUEUE = {
  batchSize: 3,
  lines: [
    failedLine("FAIL-OLD-RUNS", "2026-11-07"),
    failedLine("FAIL-NEW-RUNS", "2026-11-06"),
    failedLine("FAIL-NO-SPEND", "2026-11-06"),
    // ended before the Failed window: a row folded under "+N older", counted by no header
    failedLine("FAIL-ANCIENT", "2026-10-01"),
  ],
};

const run = (task: string, ended: string, usd?: number) =>
  JSON.stringify({
    workflow: "engine-task",
    task,
    started_at: ended,
    ended_at: ended,
    outcome: "abandoned",
    visits: { work: 1 },
    ...(usd === undefined ? {} : { spend: { usd } }),
  });
// the 30-day window of ledger-recent.jsonl holds only the new run; the old runs exist only in the full ledger
const OLD_ROW = run("FAIL-OLD-RUNS", day("2026-09-20"), 7.5);
const NEW_ROW = run("FAIL-NEW-RUNS", day("2026-11-06"), 3);
// a run of a line with no recorded spend, older than the window: the line is unmeasured, never $0.00
const NO_SPEND_ROW = run("FAIL-NO-SPEND", day("2026-09-21"));
const ANCIENT_ROW = run("FAIL-ANCIENT", day("2026-08-01"), 4.25);
const RECENT = `${NEW_ROW}\n`;
const FULL = `${OLD_ROW}\n${NO_SPEND_ROW}\n${ANCIENT_ROW}\n${NEW_ROW}\n`;

const session = JSON.stringify({
  session_id: "wf-root",
  claude_session_id: "c1",
  started_at: "2026-11-07T10:00:00Z",
  context: { queue_file: QUEUE },
  stack: [{ workflow: "batch", current_state: "dispatch", state_visits: { dispatch: 1 } }],
  history: [],
});

describe("ENG-FAILED-ROW-COST-FULL-LEDGER", () => {
  it("a failed line whose ledger rows are older than the recent window still shows its cost on its row", async () => {
    const { register } = (await import("../hooks/plan-pane.tsx")) as {
      register: (on: unknown) => void;
    };
    const handlers: Record<string, (...a: unknown[]) => unknown> = {};
    const on = (ev: string, ...rest: unknown[]) => {
      handlers[ev] = rest[rest.length - 1] as (...a: unknown[]) => unknown;
      return { catch: () => undefined };
    };
    register(on);
    const files: Record<string, string> = {
      "/state/wf-root.json": session,
      "/state/ledger-recent.jsonl": RECENT,
    };
    const asked: string[] = [];
    const ok = <T>(v: T) => Promise.resolve(v);
    const tasksOf = (url: string) => decodeURIComponent(url.split("tasks=")[1] ?? "");
    const $ = {
      clock: { now: () => ok(NOW), every: () => undefined },
      session: { id: () => ok("c1") },
      env: { get: (n: string) => ok(n === "WF_STATE_DIR" ? "/state" : undefined) },
      fs: {
        list: () =>
          ok([
            { name: "wf-root.json", kind: "file", size: session.length, mtimeMs: NOW - 1000 },
            { name: "ledger-recent.jsonl", kind: "file", size: RECENT.length, mtimeMs: NOW - 500 },
            { name: "ledger.jsonl", kind: "file", size: FULL.length, mtimeMs: NOW - 500 },
          ]),
        read: (p: string) =>
          p === "/state/ledger.jsonl"
            ? Promise.reject(new Error("file over 4 MiB"))
            : ok(files[p] ?? ""),
      },
      http: {
        fetch: (url: string) => {
          if (url.includes("/api/queue?file="))
            return ok({ status: 200, ok: true, headers: {}, text: JSON.stringify(API_QUEUE) });
          if (url.includes("/api/ledger-rows?tasks=")) {
            asked.push(tasksOf(url));
            // the engine's answer: every ledger row of the named lines, from the whole ledger
            const ids = new Set(tasksOf(url).split(","));
            const rows = FULL.split("\n").filter(
              l => l !== "" && ids.has((JSON.parse(l) as { task: string }).task),
            );
            return ok({ status: 200, ok: true, headers: {}, text: rows.join("\n") });
          }
          return ok({ status: 404, ok: false, headers: {}, text: "{}" });
        },
      },
      process: { run: () => ok({ exitCode: 1, stdout: "", stderr: "" }) },
      ui: { status: () => undefined, panes: () => ok([]) },
      command: { register: () => ok({}) },
    };
    await handlers["session.start"]($, { cwd: "/proj" }, (e: unknown) => Promise.resolve(e));
    for (let i = 0; i < 100 && !writes.some(w => w.key === "snapshot"); i++)
      await new Promise(r => setTimeout(r, 10));
    const snap = writes.find(w => w.key === "snapshot")!.value as {
      queue: {
        failedLines: { id: string; usd?: number; recent: boolean }[];
        failedSpend?: { usd: number; parentUsd: number; missing: number; unmeasured?: number };
      };
    };
    const lines = snap.queue.failedLines;
    const rows = Object.fromEntries(lines.map(l => [l.id, l.usd]));
    // each row shows its own whole-ledger cost; an older line (folded under "+N older") reads the same source,
    // and a line with a run of no recorded spend shows no cost at all, never $0.00
    expect(rows).toEqual({
      "FAIL-OLD-RUNS": 7.5,
      "FAIL-NEW-RUNS": 3,
      "FAIL-NO-SPEND": undefined,
      "FAIL-ANCIENT": 4.25,
    });
    expect(
      lines
        .filter(l => l.recent)
        .map(l => l.id)
        .sort(),
    ).toEqual(["FAIL-NEW-RUNS", "FAIL-NO-SPEND", "FAIL-OLD-RUNS"]);
    // the header leaves the unmeasured line out and names it; the counted rows add up to it
    const counted = lines.filter(l => l.recent).reduce((a, l) => a + (l.usd ?? 0), 0);
    expect(counted).toBe(10.5);
    expect(snap.queue.failedSpend).toEqual({
      usd: counted,
      parentUsd: 0,
      missing: 0,
      unmeasured: 1,
    });
  });
});
