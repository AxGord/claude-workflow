import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PAGE = fs.readFileSync(path.join(import.meta.dirname, "..", "docs/dashboard.md"), "utf8");

describe("docs/dashboard.md keeps its anchors", () => {
  it("keeps the headings the site tests and the README links rely on, and the Status Line split", () => {
    for (const h of ["## Plan pane", "### Live workflow map", "### Look", "## Status Line"])
      expect(PAGE.split("\n"), h).toContain(h);
    expect(PAGE.split("## Status Line")[1]?.split("\n## ")[0]).toMatch(/^<StatusLine \/>$/m);
  });
});
