import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const PAGE = "docs/vs-claude-code-workflow.md";
const URL = "https://axgord.github.io/claude-workflow/vs-claude-code-workflow";

describe("the page on how the plugin differs from Claude Code's built-in Workflow", () => {
  it("is linked from the nav, the sidebar and the README", () => {
    expect(fs.existsSync(path.join(ROOT, PAGE))).toBe(true);
    const config = read("docs/.vitepress/config.mts");
    expect(config.match(/link: "\/vs-claude-code-workflow"/g)).toHaveLength(2);
    expect(read("README.md").split(URL).length - 1).toBeGreaterThanOrEqual(2);
  });

  it("says it is an independent plugin, not affiliated with or endorsed by Anthropic", () => {
    expect(read(PAGE)).toContain(
      "independent plugin for Claude Code, not affiliated with or endorsed by Anthropic",
    );
    expect(read("README.md")).toContain("not affiliated with or endorsed by Anthropic");
  });

  it("gives dates, never a day count, 'first' or 'older'", () => {
    const text = `${read(PAGE)}\n${read("README.md").split("## Why")[0]}`;
    for (const d of ["1 March 2026", "20 May 2026", "28 May 2026", "v2.1.146", "v2.1.154"])
      expect(text, d).toContain(d);
    expect(text).not.toMatch(/\b\d+ days\b/);
    expect(text).not.toMatch(/\b(first|older|oldest|earlier than)\b/i);
  });

  it("states coexistence as measured and never says /workflows lists saved workflows", () => {
    const text = read(PAGE);
    expect(text).toContain("`/workflows` shows runs, not saved workflows");
    expect(text).toContain(
      "`wf-validate` on the directory reports the `.yaml` as ok and ignores the `.js`",
    );
    expect(text).not.toMatch(/no dialog|no permission/i);
    expect(text).not.toMatch(/write gate/i);
  });
});
