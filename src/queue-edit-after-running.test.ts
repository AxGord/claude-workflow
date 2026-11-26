import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { editQueueLine } from "./queue.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function queue(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-queue-after-running-"));
  dirs.push(dir);
  const file = path.join(dir, "q.yaml");
  const line = (id: string, status: string): string =>
    `  - id: ${id}\n    status: ${status}\n    difficulty: 3\n    touches: [ ${id.toLowerCase()} ]\n    text: line ${id}\n`;
  // PEND would draw a touches warning (a missing directory) and a gate warning (an owner's look, no human_gate) from any other edit
  const pend =
    "  - id: PEND\n    status: pending\n    difficulty: 3\n    touches: [ no-such-dir/file.ts ]\n    text: HOLD BEFORE LAND\n";
  fs.writeFileSync(
    file,
    `batch_size: 2\ntasks:\n${line("DEP", "pending")}${line("FIN", "done")}${line("RUN", "running")}${pend}`,
  );
  return file;
}

const answer = (r: unknown): string => JSON.stringify(r);

describe("queue_edit of after: on a running line", () => {
  it("answers that after: gates nothing now, naming the dependency that is not done", async () => {
    const r = await editQueueLine(queue(), "RUN", { after: "DEP" });
    expect(r.task).toContain("after: [ DEP ]"); // the edit is still recorded
    expect((r.warnings ?? []).join("\n")).toMatch(/DEP/);
    expect(answer(r)).toMatch(/keeps running/);
    expect((r.warnings ?? []).length).toBeGreaterThan(0);
  });

  it("gives no notice when every new dependency is already done", async () => {
    const r = await editQueueLine(queue(), "RUN", { after: "FIN" });
    expect(r.warnings ?? []).toEqual([]);
    expect(answer(r)).not.toMatch(/keeps running/);
  });

  it("leaves the answer for a pending line unchanged: no touches or gate warnings from an after-only edit", async () => {
    const f = queue();
    // the control: the line does draw both warnings when another key is edited
    const other = await editQueueLine(f, "PEND", { difficulty: 4 });
    expect(other.warnings ?? []).toEqual([]);
    const touched = await editQueueLine(f, "PEND", { touches: "no-such-dir/file.ts" });
    expect((touched.warnings ?? []).length).toBeGreaterThan(1);
    const r = await editQueueLine(f, "PEND", { after: "DEP" });
    expect(r.warnings ?? []).toEqual([]);
    expect(answer(r)).not.toMatch(/keeps running/);
  });
});
