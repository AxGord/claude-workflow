import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { Loader } from "./loader.js";

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
  ["#### Agent types", "docs/queue.md"],
  ["#### The read-only Bash gate", "docs/queue.md"],
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
  ["## Commands", "docs/development.md"],
  ["## Architecture", "docs/development.md"],
  ["## The site", "docs/development.md"],
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
      "development",
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

/** The README's lines outside code fences, with their 1-based numbers. */
const readmeProse = (): { n: number; text: string }[] => {
  let fence = false;
  const out: { n: number; text: string }[] = [];
  read("README.md")
    .split("\n")
    .forEach((text, i) => {
      if (text.startsWith("```")) fence = !fence;
      else if (!fence) out.push({ n: i + 1, text });
    });
  return out;
};

describe("the README is a landing page, the reference lives on the site", () => {
  const SITE = "https://axgord.github.io/claude-workflow/";
  const lines = readmeProse();
  const section = (name: string): string[] => {
    const at = lines.findIndex(l => l.text === `## ${name}`);
    expect(at, `README has ## ${name}`).toBeGreaterThanOrEqual(0);
    const rest = lines.slice(at + 1);
    const end = rest.findIndex(l => l.text.startsWith("## "));
    return (end < 0 ? rest : rest.slice(0, end)).map(l => l.text);
  };

  it("has its sections in the order of a first read", () => {
    const names = lines.filter(l => l.text.startsWith("## ")).map(l => l.text.slice(3));
    expect(names).toEqual([
      "Why",
      "Features",
      "Install",
      "Quick start",
      "Documentation",
      "Contributing",
      "License",
    ]);
  });

  it("keeps every line of prose short (no wall of text; tables, HTML and link definitions are exempt)", () => {
    for (const { n, text } of lines) {
      if (/^(\||\s*<|\[[^\]]+\]: )/.test(text)) continue;
      expect(text.length, `README.md:${n} is ${text.length} chars`).toBeLessThanOrEqual(120);
    }
  });

  it("Why names three or four problems, Features is six to eight one-line bullets", () => {
    const why = section("Why").filter(l => l.startsWith("- "));
    expect(why.length).toBeGreaterThanOrEqual(3);
    expect(why.length).toBeLessThanOrEqual(4);
    const features = section("Features").filter(l => l.length > 0);
    expect(features.every(l => l.startsWith("- "))).toBe(true);
    expect(features.length).toBeGreaterThanOrEqual(6);
    expect(features.length).toBeLessThanOrEqual(8);
  });

  const links = new Map<string, string>();
  for (const m of read("README.md").matchAll(/^\[([^\]]+)\]: (\S+)$/gm)) links.set(m[1], m[2]);
  const targets = (text: string): string[] =>
    [...text.matchAll(/\]\((\S+?)\)|\]\[([^\]]+)\]/g)].map(m => m[1] ?? links.get(m[2]) ?? m[2]);

  it("every Features bullet links one page of the site", () => {
    for (const bullet of section("Features").filter(l => l.startsWith("- "))) {
      const t = targets(bullet);
      expect(t, bullet).toHaveLength(1);
      expect(t[0].startsWith(SITE), bullet).toBe(true);
    }
  });

  it("every link to the site names a page and a heading that exist", () => {
    const all = targets(read("README.md")).filter(t => t.startsWith(SITE));
    expect(all.length).toBeGreaterThan(10);
    const slug = (h: string): string =>
      h
        .replace(/^#+\s+/, "")
        .replace(/`/g, "")
        .toLowerCase()
        .replace(/[\s_~`!@#$%^&*()=+[\]{}\\|;:'",.<>/?]+/g, "-")
        .replace(/^-+|-+$/g, "");
    for (const t of all) {
      const [page, anchor] = t.slice(SITE.length).split("#");
      expect(fs.existsSync(path.join(ROOT, `docs/${page}.md`)), t).toBe(true);
      if (anchor) expect(headings(`docs/${page}.md`).map(slug), t).toContain(anchor);
    }
  });

  it("the documentation table lists every page of the site", () => {
    const rows = section("Documentation").join("\n");
    const pages = fs
      .readdirSync(path.join(ROOT, "docs"))
      .filter(f => f.endsWith(".md") && f !== "index.md")
      .map(f => f.slice(0, -3));
    for (const page of pages) expect(rows, page).toContain(`(${SITE}${page})`);
  });

  it("the Quick start workflow is a real one: it loads, has three or four states and runs an exec", () => {
    const text = section("Quick start").join("\n");
    const yaml = /```yaml\n([\s\S]*?)```/.exec(read("README.md"))?.[1] ?? "";
    expect(yaml).not.toBe("");
    const doc = YAML.parse(yaml) as { name: string; states: Record<string, { type?: string }> };
    expect(text).toContain(`.claude/workflows/${doc.name}.yaml`);
    expect(text).toContain(`workflow: "${doc.name}"`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-readme-"));
    fs.writeFileSync(path.join(dir, `${doc.name}.yaml`), yaml);
    const def = new Loader(null, dir, null).get(doc.name);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(def, "the loader accepts the README's workflow").toBeDefined();
    const states = Object.keys(def!.states);
    expect(states.length).toBeGreaterThanOrEqual(3);
    expect(states.length).toBeLessThanOrEqual(4);
    expect(states.some(s => def!.states[s].type === "exec")).toBe(true);
  });

  it("what the README no longer carries is on its page: development, the agent types, the engine's mechanics", () => {
    const dev = read("docs/development.md");
    for (const cmd of [
      "build",
      "dev",
      "test",
      "check",
      "check:ci",
      "lint",
      "lint:baseline",
      "format:check",
      "scan",
    ])
      expect(dev, `npm run ${cmd}`).toContain(cmd === "test" ? "npm test" : `npm run ${cmd}`);
    for (const file of ["src/engine.ts", "src/pool.ts", "src/replay.ts", "dashboard/", "video/"])
      expect(dev, file).toContain(`| \`${file}\``);
    for (const cmd of ["docs:replay", "docs:record", "docs:banner", "npm run video"])
      expect(dev, cmd).toContain(cmd);
    const queue = read("docs/queue.md");
    for (const t of [
      "workflow:driver",
      "workflow:recon",
      "workflow:reviewer",
      "hooks/read-only-gate.sh",
      "What this gate is and is not",
    ])
      expect(queue, t).toContain(t);
    const concepts = read("docs/concepts.md");
    for (const t of ["max depth 10", "Snapshot isolation", "Runtime overlays", "SessionStart hook"])
      expect(concepts, t).toContain(t);
    expect(read("README.md")).not.toContain("read-only-gate");
  });
});
