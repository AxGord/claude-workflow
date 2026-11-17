import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), "utf8");

describe("docs: counts and cross-references match the tree", () => {
  it("the README's bundled-skills count is the number of directories in templates/skills", () => {
    const skills = fs
      .readdirSync(path.join(ROOT, "templates/skills"), { withFileTypes: true })
      .filter(d => d.isDirectory()).length;
    expect(skills).toBeGreaterThan(0);
    const m = /\*\*(\d+) bundled skills\*\*/.exec(read("README.md"));
    expect(m, "README names a bundled-skills count").not.toBeNull();
    expect(Number(m?.[1])).toBe(skills);
  });

  it("the README's bundled-workflows count is the number of workflow files in templates", () => {
    const wfs = fs
      .readdirSync(path.join(ROOT, "templates"))
      .filter(f => f.endsWith(".yaml")).length;
    expect(wfs).toBeGreaterThan(0);
    const m = /\*\*(\d+) bundled workflows\*\*/.exec(read("README.md"));
    expect(m, "README names a bundled-workflows count").not.toBeNull();
    expect(Number(m?.[1])).toBe(wfs);
  });

  it("the CLAUDE.md Inheritance paragraph points at a heading that exists where it points", () => {
    const para = read("CLAUDE.md")
      .split("\n")
      .find(l => l.startsWith("**Inheritance (`extends:`)**"));
    expect(para).toBeDefined();
    const readmeHasHeading = /^#+\s+`extends:`/m.test(read("README.md"));
    const docHasHeading = /^#+\s+`extends:`/m.test(read("docs/workflow-yaml.md"));
    expect(docHasHeading).toBe(true);
    // the paragraph's README § "`extends:`" reference must resolve: the heading is in README, or the paragraph names docs/workflow-yaml.md
    expect(readmeHasHeading || para?.includes("docs/workflow-yaml.md")).toBe(true);
  });
});
