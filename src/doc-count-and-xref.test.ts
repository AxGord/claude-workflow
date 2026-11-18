import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), "utf8");

describe("docs: counts and cross-references match the tree", () => {
  it("the README's bundled-skills count is the number of directories in templates/skills and templates/skills-stack, and it names the default share", () => {
    const count = (set: string): number =>
      fs
        .readdirSync(path.join(ROOT, "templates", set), { withFileTypes: true })
        .filter(d => d.isDirectory()).length;
    const standard = count("skills");
    const stack = count("skills-stack");
    expect(standard).toBeGreaterThan(0);
    expect(stack).toBeGreaterThan(0);
    const readme = read("README.md");
    const m = /\*\*(\d+) bundled skills\*\*/.exec(readme);
    expect(m, "README names a bundled-skills count").not.toBeNull();
    expect(Number(m?.[1])).toBe(standard + stack);
    expect(readme).toContain(`(${standard} by default, ${stack} on request)`);
    const concepts = read("docs/concepts.md");
    expect(concepts).toContain(`ships ${standard + stack} of them in two sets`);
    expect(concepts).toContain(`**The default set (${standard})**`);
    expect(concepts).toContain(`**The stack pack (${stack})**`);
    // one line per skill in each table
    const section = (title: string): string => {
      const from = concepts.indexOf(`### ${title}`);
      return concepts.slice(from, concepts.indexOf("\n###", from + 4));
    };
    for (const [set, title] of [
      ["skills", "The default set"],
      ["skills-stack", "The stack pack"],
    ] as const) {
      const rows = [...section(title).matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map(r => r[1]).sort();
      const dirs = fs
        .readdirSync(path.join(ROOT, "templates", set), { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
      expect(rows).toEqual(dirs);
    }
    expect(read("docs/index.md")).toContain(
      `A new machine gets ${standard} universal skills; the ${stack} for`,
    );
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
