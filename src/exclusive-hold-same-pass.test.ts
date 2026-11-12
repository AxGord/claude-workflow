import { describe, expect, it } from "vitest";
import { parseQueue, planPick } from "./queue.js";

const line = (id: string, touches: string, extra = "") =>
  `  - {id: ${id}, status: pending, touches: [${touches}], repo: /tmp/wf-repo${extra}}\n`;
const pick = (header: string) =>
  planPick(
    parseQueue(
      `${header}\ntasks:\n` +
        line("H", "shared", ", priority: high") +
        line("E", "shared", ", exclusive: true") +
        line("N1", "n1") +
        line("N2", "n2"),
      "/tmp/hold-proj/.claude/batch/q.yaml",
    ),
  );

describe("exclusive hold counts lines admitted in the same pass (ENG-EXCLUSIVE-HOLD-SAME-PASS)", () => {
  it("empty window: only the high line is admitted, the exclusive is held and starves nothing behind it", () => {
    const r = pick("batch_size: 5");
    expect(r.admitted.map(a => a.id)).toEqual(["H"]);
    expect(r.reasons.find(x => x.id === "N1")?.why).toBe("held for exclusive E");
  });
  it("exclusive_hold: no keeps today's behaviour", () => {
    expect(pick("batch_size: 5\nexclusive_hold: no").admitted.map(a => a.id)).toEqual([
      "H",
      "N1",
      "N2",
    ]);
  });
});
