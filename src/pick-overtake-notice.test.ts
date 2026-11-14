import { describe, expect, it } from "vitest";
import { formatPickSummary, parseQueue, planPick } from "./queue.js";

const line = (id: string, touches: string, extra = "") =>
  `  - {id: ${id}, status: pending, touches: [${touches}], repo: /tmp/wf-repo${extra}}\n`;
const pick = (tasks: string) =>
  planPick(
    parseQueue(
      `batch_size: 5\noverlap: files\ntasks:\n${tasks}`,
      "/tmp/hold-proj/.claude/batch/q.yaml",
    ),
  );

describe("a pick names a line admitted ahead of a held exclusive (ENG-PICK-OVERTAKE-EXCLUSIVE-NOTICE)", () => {
  it("a high line admitted first, an exclusive normal line held: the notice shows", () => {
    const r = pick(line("H", "a.ts", ", priority: high") + line("E", "a.ts", ", exclusive: true"));
    expect(r.admitted.map(a => a.id)).toEqual(["H"]);
    expect(r.overtakes).toEqual(["H (high) admitted ahead of exclusive E (normal)"]);
    expect(formatPickSummary({ ...r, dryRun: false }, false)).toContain(
      "H (high) admitted ahead of exclusive E (normal)",
    );
  });
  it("no exclusive line: no notice", () => {
    const r = pick(line("H", "a.ts", ", priority: high") + line("E", "a.ts"));
    expect(r.overtakes).toBeUndefined();
    expect(formatPickSummary({ ...r, dryRun: false }, false)).not.toContain("ahead of");
  });
});
