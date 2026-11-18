import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("a worker never ends its turn with live background work", () => {
  const batch = read("templates/batch-task.yaml");
  const cut = batch.indexOf("You review task");
  const worker = batch.slice(0, cut);
  const reviewerText = batch.slice(cut);
  const liveness = read("templates/skills/task-delegation/references/agent-liveness.md");

  it("worker rules: stop or await every background task before the one line", () => {
    expect(worker).toMatch(
      /never\s+end\s+your\s+turn\s+while\s+anything\s+you\s+started\s+is\s+alive/i,
    );
  });

  it("worker rules: a wait loop ends on failure too, not on the success marker alone", () => {
    expect(worker).toMatch(/until[\s\S]{0,300}(kill -0|timeout|death)/i);
    expect(liveness).toMatch(/wait loop[\s\S]{0,300}(FAILED|timeout|exit)/i);
  });

  it("reviewer prompt carries the rule too", () => {
    expect(reviewerText).toMatch(/read-only gate refuses a redirect[\s\S]{0,200}unverified/i);
    expect(reviewerText).toMatch(
      /never\s+end\s+your\s+turn\s+while\s+anything\s+you\s+started\s+is\s+alive/i,
    );
  });

  for (const f of ["agents/driver.md", "templates/drivers/task-driver.md"]) {
    const text = read(f).replace(/\s+/g, " ");
    const rule = text.slice(text.indexOf('On a notification that says the agent "is waiting'));

    it(`${f}: a notification that the agent waits on its own background work gets the WAITING line, never a ping`, () => {
      const bullet = rule.slice(0, rule.indexOf(" - "));
      expect(bullet).toMatch(/answer with the WAITING line only/i);
      expect(bullet).toMatch(/Never ping on it/);
      expect(bullet).not.toMatch(/finish or kill/i);
    });

    it(`${f}: a WAITING turn with no notification probes the agent once, on a signal, not a clock`, () => {
      expect(text).toMatch(
        /LATER wake that comes after a `\[Subagent hand-back\]` and before the awaited agent's notification/,
      );
      expect(text).toMatch(/hand-back turn itself is never that wake/);
      expect(text).toMatch(/The hand-back turn itself never probes/);
      expect(text).not.toMatch(/\[Subagent hand-back\]` with no notification after it/);
      expect(text).toMatch(/PROBE it — SendMessage/);
      expect(text).toMatch(/no clock and never poll/i);
    });
  }
});
