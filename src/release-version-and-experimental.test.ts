import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

// ENG-RELEASE-0-2-0: the release commit's two invariants. (1) Every place that carries the version carries
// the same one, and CHANGELOG.md has the block `publish.yml` reads for the release notes. (2) The dispatcher
// agent is introduced as experimental wherever a user first meets it.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");
interface Manifest {
  version: string;
  packages?: Record<string, { version: string }>;
  plugins?: { version: string }[];
}
const json = (file: string): Manifest => JSON.parse(read(file)) as Manifest;

describe("the version", () => {
  const version = (): string => json("package.json").version;

  it("is the same in package.json, the lockfile, plugin.json and the marketplace entry", () => {
    const lock = json("package-lock.json");
    expect(lock.version).toBe(version());
    expect(lock.packages![""].version).toBe(version());
    expect(json(".claude-plugin/plugin.json").version).toBe(version());
    expect(json(".claude-plugin/marketplace.json").plugins![0].version).toBe(version());
  });

  it("has a CHANGELOG block the publish workflow's awk finds, with a body", () => {
    const v = version().replace(/\./g, "\\.");
    // The same pattern as the "Release notes" step of .github/workflows/publish.yml.
    const heading = new RegExp(`^## \\[?${v}\\]?`, "mu");
    const log = read("CHANGELOG.md");
    const m = heading.exec(log);
    expect(m, `no "## ${version()}" heading in CHANGELOG.md`).not.toBeNull();
    const body = log.slice(m!.index + m![0].length).split(/^## /mu)[0];
    expect(body.trim().length).toBeGreaterThan(200);
    expect(log.indexOf("## Unreleased")).toBeLessThan(m!.index);
  });
});

describe("the GitHub release body", () => {
  const notes = (version: string, file?: string): string =>
    execFileSync(
      "sh",
      [path.join(ROOT, "scripts", "release-notes.sh"), version, ...(file ? [file] : [])],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );

  it("is made by the script the publish workflow runs", () => {
    expect(read(".github/workflows/publish.yml")).toContain(
      'sh scripts/release-notes.sh "$VERSION"',
    );
  });

  it("of this version is the summary, non-empty and under GitHub's 125,000-character limit", () => {
    const body = notes(json("package.json").version);
    expect(body.trim().length).toBeGreaterThan(200);
    expect(body.length).toBeLessThan(125_000);
    expect(body).toContain("Dispatcher agent, experimental");
    expect(body).not.toContain("(ENG-RELEASE-0-2-0)");
    expect(body).toContain("/blob/v" + json("package.json").version + "/CHANGELOG.md");
  });

  it("stops at the first sub-heading, skips a longer version number and falls back to a one-line body", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-release-notes-"));
    try {
      const file = path.join(dir, "CHANGELOG.md");
      fs.writeFileSync(
        file,
        "# Changelog\n\n## Unreleased\n\n## 1.2.0 - d\n\nlead\n\n### Entries\n\n- big\n\n## [1.2.01]\n\nwrong\n\n## 1.1.0\n\n- only\n\n## 1.0.0\n\n",
      );
      expect(notes("1.2.0", file)).toMatch(
        /^\nlead\n\nFull changelog: \S+v1\.2\.0\/CHANGELOG\.md\n$/u,
      );
      expect(notes("1.1.0", file)).toContain("- only");
      expect(notes("1.0.0", file)).toMatch(/^Release v1\.0\.0\n/u);
      expect(notes("1.2.01", file)).toContain("wrong");
      expect(notes("1.2.0", file)).not.toContain("big");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the dispatcher agent is introduced as experimental", () => {
  const dispatcherDescription = (): string => {
    const fm = YAML.parse(/^---\n([\s\S]*?)\n---\n/u.exec(read("agents/dispatcher.md"))![1]) as {
      description: string;
    };
    return fm.description;
  };

  it("in the README features bullet", () => {
    const bullet = read("README.md")
      .split("\n")
      .find(l => l.startsWith("- **Subagents**"))!;
    expect(bullet).toMatch(/experimental dispatcher \(off unless `WF_DISPATCHER`\)/u);
  });

  it("in the queue page's section, with what that means", () => {
    const page = read("docs/queue.md");
    const at = page.indexOf("#### The dispatcher agent");
    expect(at).toBeGreaterThan(-1);
    const intro = page.slice(at, page.indexOf("```yaml", at));
    expect(intro).toMatch(/experimental/iu);
    expect(intro).toContain("off unless `WF_DISPATCHER` is set");
    expect(intro).toContain("may change between releases");
    expect(intro).toContain("one campaign");
  });

  it("in the comment of templates/batch.yaml", () => {
    const comment = read("templates/batch.yaml")
      .split("\n")
      .filter(l => l.startsWith("#"))
      .join("\n");
    expect(comment).toMatch(/EXPERIMENTAL/u);
    expect(comment).toContain("may change between releases");
  });

  it("in the agent's description, which stays valid front matter", () => {
    const d = dispatcherDescription();
    expect(d).toMatch(/experimental/iu);
    expect(d).toContain("WF_DISPATCHER");
    expect(d).toContain("may change between releases");
  });

  it("in the bundled authoring skill", () => {
    const skill = read("templates/skills/wf-yaml-authoring/SKILL.md");
    expect(skill).toMatch(/OPT-IN, EXPERIMENTAL/u);
    expect(skill).toContain("`workflow:dispatcher` (experimental,");
  });
});
