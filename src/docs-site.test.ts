import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Headings (outside code fences) of a markdown file, with their `#` prefix. */
const headings = (rel: string): string[] => {
  let fence = false;
  const out: string[] = [];
  for (const line of read(rel).split("\n")) {
    if (line.startsWith("```")) fence = !fence;
    else if (!fence && /^#{2,4} /.test(line)) out.push(line);
  }
  return out;
};

// Every section the README had before the docs site, and the one page it lives on now.
const MOVED: [string, string][] = [
  ["## Features", "README.md"],
  ["## Quick Start", "docs/getting-started.md"],
  ["### From Community Plugins (recommended)", "docs/getting-started.md"],
  ["### From this repository", "docs/getting-started.md"],
  ["### From npm", "docs/getting-started.md"],
  ["### Manual (for development)", "docs/getting-started.md"],
  ["### Install channels", "docs/getting-started.md"],
  ["## Recommended CLAUDE.md Snippet", "docs/getting-started.md"],
  ["## Recommended Permissions", "docs/getting-started.md"],
  ["## How It Works", "docs/concepts.md"],
  ["## Workflow YAML", "docs/workflow-yaml.md"],
  ["## Action States", "docs/action-states.md"],
  ["### Restart: suspend and resume", "docs/action-states.md"],
  ["### `exec` \u2014 run a shell command", "docs/action-states.md"],
  ["### Heavy work \u2014 the machine-wide thread pool", "docs/action-states.md"],
  ["#### Pool gate \u2014 agents' heavy Bash commands through the pool", "docs/action-states.md"],
  ["### `fetch` \u2014 make an HTTP request", "docs/action-states.md"],
  ["### Routing", "docs/action-states.md"],
  ["### Fan-out \u2014 one command, many shards", "docs/action-states.md"],
  ["### Template variables", "docs/action-states.md"],
  ["### `revisit_prompt` \u2014 per-visit data on a revisit", "docs/action-states.md"],
  ["### Stations \u2014 the columns of the live workflow map", "docs/action-states.md"],
  ["### Guards and the exhausted route", "docs/action-states.md"],
  ["### Question states \u2014 `ask: parent`", "docs/action-states.md"],
  ["### Stall detection \u2014 `stale_after`", "docs/action-states.md"],
  ["### Strict schema", "docs/action-states.md"],
  ["### Ledger", "docs/action-states.md"],
  ["## Three-Tier Loading", "docs/workflow-yaml.md"],
  ["### `extends:` \u2014 inherit a workflow", "docs/workflow-yaml.md"],
  ["### Task queue \u2014 `batch`, `queue_next`, `queue_add`, `wf-queue`", "docs/queue.md"],
  ["#### Difficulty \u2192 model and effort (`model_table:`)", "docs/queue.md"],
  ["#### The task's driver (`driver:`)", "docs/queue.md"],
  ["### When a project should have its own workflow", "docs/workflow-yaml.md"],
  ["## Bundled Workflows", "docs/concepts.md"],
  ["## Bundled Skills", "docs/concepts.md"],
  ["## MCP Tools", "docs/concepts.md"],
  ["## Plan pane", "docs/dashboard.md"],
  ["## Dashboard", "docs/dashboard.md"],
  ["### Live workflow map", "docs/dashboard.md"],
  ["### Look", "docs/dashboard.md"],
  ["### REST API", "docs/dashboard.md"],
  ["## Configuration", "docs/getting-started.md"],
  ["## Status Line", "docs/dashboard.md"],
  ["## Development", "README.md"],
  ["### Architecture", "README.md"],
  ["## Calibration report", "docs/queue.md"],
  ["## License", "README.md"],
];

describe("docs site: the README sections live on exactly one page", () => {
  const pages = [
    "README.md",
    ...fs
      .readdirSync(path.join(ROOT, "docs"))
      .filter(f => f.endsWith(".md"))
      .map(f => `docs/${f}`),
  ];
  const where = new Map<string, string[]>();
  for (const page of pages) {
    for (const h of headings(page)) where.set(h, [...(where.get(h) ?? []), page]);
  }
  for (const [heading, page] of MOVED) {
    it(`${heading} is on ${page} only`, () => {
      expect(where.get(heading)).toEqual([page]);
    });
  }
});

describe("docs site: the VitePress setup", () => {
  const config = read("docs/.vitepress/config.mts");
  it("is a project page under the repository name, with local search and dead-link checking", () => {
    expect(config).toContain('base: "/claude-workflow/"');
    expect(config).toContain('provider: "local"');
    expect(config).toContain("ignoreDeadLinks: false");
  });
  it("keeps {{mustache}} text away from Vue", () => {
    expect(config).toContain('attrSet("v-pre"');
  });
  it("is built by npm run docs:build, vitepress a devDependency", () => {
    const pkg = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.scripts["docs:build"]).toBe("vitepress build docs");
    expect(pkg.devDependencies.vitepress).toBeDefined();
  });
  it("has the landing page and the sidebar names every page", () => {
    expect(read("docs/index.md")).toContain("layout: home");
    for (const page of [
      "getting-started",
      "concepts",
      "workflow-yaml",
      "action-states",
      "queue",
      "dashboard",
      "faq",
    ]) {
      expect(fs.existsSync(path.join(ROOT, `docs/${page}.md`))).toBe(true);
      expect(config).toContain(`link: "/${page}"`);
    }
  });
});

describe("docs site: page links with an anchor point at a heading of that page", () => {
  // VitePress slug: lowercase, runs of whitespace, underscore and punctuation become "-".
  const slug = (h: string): string =>
    h
      .replace(/^#+\s+/, "")
      .replace(/`/g, "")
      .toLowerCase()
      .replace(/[\s_~`!@#$%^&*()=+[\]{}\\|;:'",.<>/?]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const pages = fs.readdirSync(path.join(ROOT, "docs")).filter(f => f.endsWith(".md"));
  for (const page of pages) {
    const links = [...read(`docs/${page}`).matchAll(/\]\(\/([a-z-]+)#([^)\s]+)\)/g)];
    for (const [, target, anchor] of links) {
      it(`${page} -> /${target}#${anchor}`, () => {
        const slugs = headings(`docs/${target}.md`).map(slug);
        expect(slugs).toContain(decodeURIComponent(anchor));
      });
    }
  }
});
