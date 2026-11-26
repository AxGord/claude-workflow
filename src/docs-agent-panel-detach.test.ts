import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ENG-DOC-AGENT-PANEL-DETACH: the panel's drawing (cosmetic) and a report's routing are two behaviours, and the
// docs must not teach the old stories (a resume detaches, top level means lost, a driver ending WAITING is gone).
const DOCS = path.resolve(import.meta.dirname, "..", "docs");
const read = (f: string): string => fs.readFileSync(path.join(DOCS, f), "utf8");

describe("the agent panel docs", () => {
  it("faq separates drawing from routing and names the upstream issue", () => {
    const faq = read("faq.md");
    expect(faq).toContain("### The panel's drawing (cosmetic)");
    expect(faq).toContain("### Where its report goes (routing)");
    expect(faq).toContain("anthropics/claude-code#112440");
    expect(faq).toContain("No resume causes it");
    expect(faq).toContain("not a runaway and not lost");
    expect(faq).toContain("`parent_answer`");
  });

  it("faq does not claim the refuted stories", () => {
    const faq = read("faq.md");
    expect(faq).not.toMatch(/resume causes the detach|a parked driver keeps its worker nested/i);
  });

  it("dashboard says health is the state and the STALE line, not the panel row", () => {
    const d = read("dashboard.md");
    expect(d).toContain("### Workers in Claude Code's agent panel");
    expect(d).toContain("STALE line");
  });

  it("queue no longer says a driver with no last line is re-spawned from driver_call", () => {
    const q = read("queue.md");
    expect(q).not.toContain("is pinged once, then re-spawned");
    expect(q).toContain("only after a `SendMessage` to the driver fails with an error");
  });
});
