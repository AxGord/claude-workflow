import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** The docs a maintainer reads to install the plugin from a checkout. */
const pages = (): string[] =>
  ["docs/getting-started.md", "CONTRIBUTING.md"].filter(p => fs.existsSync(path.join(ROOT, p)));

describe("docs: installing the plugin from a development checkout", () => {
  it("documents CLAUDE_CODE_PLUGIN_DIRS in the user settings env as the permanent way", () => {
    const text = read("docs/getting-started.md");
    expect(text).toContain("CLAUDE_CODE_PLUGIN_DIRS");
    expect(text).toContain("settings.json");
  });

  it("says to disable the marketplace copy, so two `workflow` plugins do not load", () => {
    const text = read("docs/getting-started.md");
    expect(text).toMatch(/disable[^\n]*(marketplace|workflow@)/i);
  });

  it("names the symptom of the stale-cache fallback", () => {
    const text = read("docs/getting-started.md");
    expect(text).toContain("not found");
    expect(text).toMatch(/plugins\/cache/);
  });

  it("holds no absolute user path", () => {
    for (const p of pages()) expect(read(p), p).not.toMatch(/\/Users\/|\/home\/[a-z]/);
  });
});
