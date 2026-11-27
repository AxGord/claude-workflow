import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { ROOT } from "./site-browser-helpers.js";

// ENG-TASK-ENGINE-WORKER-GUIDE: an agent of an engine slice run from another project's session loaded that
// project's CLAUDE.md and memory and never saw this repository's rules. The engine-task prompts that spawn an agent
// now name the worker guide and the engine's memory index, and say the other project's rules do not apply.

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const states = (
  parse(read(".claude/workflows/engine-task.yaml")) as {
    states: Record<string, { prompt: string }>;
  }
).states;

/** The spawned agent's own prompt: the indented block under the state prompt's first "prompt:" line. */
const spawned = (state: string): string => {
  const text = states[state]?.prompt ?? "";
  const from = text.search(/^ {2}\S/m);
  expect(from, `${state}: no indented agent prompt`).toBeGreaterThanOrEqual(0);
  return text.slice(from);
};

describe("the engine worker guide", () => {
  it("is a file under 6 KB", () => {
    expect(Buffer.byteLength(read("docs/worker-guide.md"))).toBeLessThan(6 * 1024);
  });

  it("says where the code rules, the commit rules, the public rules and the decisions record live", () => {
    const guide = read("docs/worker-guide.md");
    for (const needle of [
      "check-leased.sh",
      "check:ci",
      "CHANGELOG.md",
      "docs/decisions.md",
      "MEMORY.md",
      "Never push",
      "/Users/",
      "do not apply",
    ])
      expect(guide, needle).toContain(needle);
  });

  it("holds the engine's placement map: a check goes to a pin, memory only by the last row, never status", () => {
    const guide = read("docs/worker-guide.md");
    for (const needle of [
      "knowledge-placement",
      "a vitest pin or a script check, never a prose rule or a memory file",
      "`why-memory:`",
      "Status of work (what shipped, what is left) goes to the commit message, never to memory",
    ])
      expect(guide, needle).toContain(needle);
    expect(guide).toContain(
      "| A call of the user | his quote and the date in the slice's queue line |",
    );
    expect(read("docs/development.md")).toContain("the engine's own placement map");
    expect(read("docs/concepts.md")).not.toContain("an open question, not solved");
  });

  it.each(["repro", "work", "review"])(
    "the %s agent prompt names the guide and the memory index",
    state => {
      const prompt = spawned(state);
      expect(prompt).toContain("{{context.wt}}/docs/worker-guide.md");
      expect(prompt).toContain("memory/MEMORY.md");
      expect(prompt).toMatch(/\.hx` gates\) do not apply to engine code/);
    },
  );

  it("a fresh worker of the rebase conflict reads the guide too", () => {
    expect(states.rebase_fix?.prompt).toContain("{{context.wt}}/docs/worker-guide.md");
  });

  it("the guide and the decisions record are not pages of the site", () => {
    const config = read("docs/.vitepress/config.mts");
    expect(config).toMatch(/srcExclude:[^\]]*"worker-guide\.md"[^\]]*"decisions\.md"/);
  });
});

describe("docs/decisions.md", () => {
  const lines = read("docs/decisions.md")
    .split("\n")
    .filter(l => l.trim() !== "" && !l.startsWith("#"));

  it("holds the seed line for the worker-liveness refutation", () => {
    expect(
      lines.some(
        l =>
          l.includes("link_agent(P, worker)") &&
          l.includes("refuted") &&
          l.endsWith("→ ENG-REVISIT-WORKER-LIVENESS"),
      ),
    ).toBe(true);
  });

  it("keeps every record line to 300 characters", () => {
    for (const l of lines.slice(1)) expect(l.length, l.slice(0, 40)).toBeLessThanOrEqual(300);
  });
});
