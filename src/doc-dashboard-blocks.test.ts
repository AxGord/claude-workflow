import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const PAGE = fs.readFileSync(path.join(ROOT, "docs/dashboard.md"), "utf8");

const wordCount = (s: string): number => s.trim().split(/\s+/).length;

/** Prose blocks of a page: consecutive lines; a list item, heading, table row, code fence or blank line ends one. */
const blocks = (md: string): { words: number; head: string }[] => {
  const out: { words: number; head: string }[] = [];
  const lines = md.split("\n");
  let i = lines[0] === "---" ? lines.indexOf("---", 1) + 1 : 0;
  let fence = false;
  let cur = 0;
  let head = "";
  const flush = (): void => {
    if (cur > 0) out.push({ words: cur, head });
    cur = 0;
  };
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith("```")) {
      flush();
      fence = !fence;
    } else if (fence || line.trim() === "" || line.trimStart().startsWith("|")) flush();
    else if (line.startsWith("#")) {
      flush();
      head = line;
    } else {
      if (/^\s*([-*]|\d+\.) /.test(line)) flush();
      cur += wordCount(line);
    }
  }
  flush();
  return out;
};

describe("docs/dashboard.md is short blocks, lists and tables, not text walls", () => {
  it("has no unbroken block of 120 words or more", () => {
    const wall = blocks(PAGE).filter(b => b.words >= 120);
    expect(wall, "blocks of 120+ words, with their section").toEqual([]);
  });

  it("has no table cell over 40 words", () => {
    const cells = PAGE.split("\n")
      .filter(l => l.trimStart().startsWith("|"))
      .flatMap(l =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split(/(?<!\\)\|/),
      )
      .filter(c => wordCount(c) > 40);
    expect(cells).toEqual([]);
  });

  it("keeps the headings the site tests and the README links rely on, and the Status Line split", () => {
    for (const h of ["## Plan pane", "### Live workflow map", "### Look", "## Status Line"])
      expect(PAGE.split("\n"), h).toContain(h);
    expect(PAGE.split("## Status Line")[1]?.split("\n## ")[0]).toMatch(/^<StatusLine \/>$/m);
  });
});
