import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// ENG-PAGES-DEPLOY-RESILIENT: a GitHub-side 500 of deploy-pages failed the run on a commit that changed nothing the
// site reads. The workflow now runs only when a site input changed, deploys twice, and uses the Node 24 majors. What
// only a real run proves: the 500 itself, the 60 s wait, and that the path filter matches GitHub's globs.
const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  "continue-on-error"?: boolean;
}
interface Workflow {
  on: { push: { branches: string[]; paths?: string[] }; workflow_dispatch?: unknown };
  jobs: Record<string, { steps: Step[]; environment?: { url?: string } }>;
}
const pages = (): Workflow => parse(read(".github/workflows/pages.yml")) as Workflow;

const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** GitHub's path filter: `**` crosses a `/`, `*` and `?` do not. */
const globMatches = (pattern: string, file: string): boolean => {
  const body = pattern
    .split("**")
    .map(part => part.split("*").map(escapeRe).join("[^/]*").replaceAll("\\?", "[^/]"))
    .join(".*");
  return new RegExp(`^${body}$`).test(file);
};

describe("pages.yml: runs only when the site's inputs changed", () => {
  it("filters the push by paths, keeps workflow_dispatch, and lists the workflow itself", () => {
    const { push, workflow_dispatch } = pages().on;
    expect(workflow_dispatch).toBeDefined();
    expect(push.paths).toEqual(
      expect.arrayContaining([
        "docs/**",
        "package.json",
        "package-lock.json",
        ".github/workflows/pages.yml",
      ]),
    );
  });

  it("covers every path the site's config and theme import from outside docs/", () => {
    const paths = pages().on.push.paths ?? [];
    // a bare directory import is covered by a `dir/**` entry (types/) or a `dir/*.ext` one (the config reads templates/)
    const covered = (rel: string): boolean =>
      paths.some(
        p =>
          globMatches(p, rel) ||
          globMatches(p, `${rel}/index`) ||
          new RegExp(`^${escapeRe(rel)}/\\*\\.\\w+$`).test(p),
      );
    const imports = new Set<string>();
    const dirs = ["docs/.vitepress", "docs/.vitepress/theme"];
    for (const dir of dirs) {
      for (const f of fs.readdirSync(path.join(ROOT, dir))) {
        if (!/\.(ts|mts|vue)$/.test(f)) continue;
        for (const m of read(`${dir}/${f}`).matchAll(/["'](\.\.\/[^"']+)["']/g)) {
          const rel = path.posix.normalize(path.posix.join(dir, m[1])).replace(/\?raw$/, "");
          // "../.." alone is the dev server's fs.allow (the repo root), not an input
          if (rel !== "." && !rel.startsWith("docs/")) imports.add(rel);
        }
      }
    }
    expect(imports.size).toBeGreaterThan(0);
    for (const rel of imports) expect(covered(rel), rel).toBe(true);
  });

  it("does not run for the files of a skills-only commit (c6bbbfb): a `*` does not cross a `/`", () => {
    const paths = pages().on.push.paths ?? [];
    const skillsOnly = [
      "templates/skills-history.txt",
      "templates/skills-stack/hxq/SKILL.md",
      "templates/skills-stack/hxq-write/SKILL.md",
      "templates/skills-stack/hxq/references/commands.md",
      "templates/skills/x/SKILL.md",
    ];
    for (const file of skillsOnly)
      expect(
        paths.filter(p => globMatches(p, file)),
        file,
      ).toEqual([]);
  });

  it("runs for a bundled workflow at the top of templates/", () => {
    const paths = pages().on.push.paths ?? [];
    for (const file of ["templates/batch.yaml", "templates/x.yml"]) {
      expect(
        paths.some(p => globMatches(p, file)),
        file,
      ).toBe(true);
    }
  });
});

describe("pages.yml: the deploy is tried twice", () => {
  const steps = (): Step[] => pages().jobs.deploy?.steps ?? [];

  it("the first deploy-pages step tolerates a failure; the second runs only after one and does not", () => {
    const deploys = steps().filter(s => s.uses?.startsWith("actions/deploy-pages@"));
    expect(deploys).toHaveLength(2);
    const [first, second] = deploys as [Step, Step];
    expect(first["continue-on-error"]).toBe(true);
    expect(second["continue-on-error"]).toBeUndefined();
    expect(second.if).toContain(`steps.${first.id}.outcome == 'failure'`);
  });

  it("waits 60 s between them, only when the first failed", () => {
    const list = steps();
    const wait = list.find(s => s.run?.includes("sleep 60"));
    expect(wait?.if).toContain("outcome == 'failure'");
    const at = (pred: (s: Step) => boolean): number => list.findIndex(pred);
    expect(at(s => s === wait)).toBeGreaterThan(at(s => s.id === "deployment"));
    expect(at(s => s === wait)).toBeLessThan(at(s => s.id === "deployment_retry"));
  });

  it("the environment url reads the page url of whichever deploy ran", () => {
    const url = pages().jobs.deploy?.environment?.url ?? "";
    expect(url).toContain("steps.deployment_retry.outputs.page_url");
    expect(url).toContain("steps.deployment.outputs.page_url");
  });
});

describe("pages.yml: the Pages actions run on Node 24", () => {
  it("uses configure-pages v6, upload-pages-artifact v5 and deploy-pages v5", () => {
    const text = read(".github/workflows/pages.yml");
    expect(text).toContain("actions/configure-pages@v6");
    expect(text).toContain("actions/upload-pages-artifact@v5");
    expect(text).not.toMatch(/actions\/configure-pages@v[0-5]\b/);
    expect(text).not.toMatch(/actions\/upload-pages-artifact@v[0-4]\b/);
    expect(text).not.toMatch(/actions\/deploy-pages@v[0-4]\b/);
  });
});
