import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");

describe("ENG-SKILL-OPS-REPAIR: bundled skills after the parent's live repair", () => {
  it("bundled hxq references/ops.md carries each top-level section once", () => {
    const text = readFileSync(
      join(root, "templates", "skills-stack", "hxq", "references", "ops.md"),
      "utf8",
    );
    const headings = text.split("\n").filter(l => l.startsWith("## "));
    const dup = headings.filter((h, i) => headings.indexOf(h) !== i);
    expect(dup).toEqual([]);
  });
});
