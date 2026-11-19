import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { docWords, scanDoc } from "./test-helpers.js";

const DOCS = path.resolve(import.meta.dirname, "..", "docs");
const PAGES = fs
  .readdirSync(DOCS)
  .filter(f => f.endsWith(".md"))
  .sort();

/** The blocks that may run to 80 words or more, by page, each named by its opening text and why it stays. */
const EXEMPT: Record<string, { starts: string; why: string }[]> = {
  "concepts.md": [
    { starts: "**Two ways to use it.**", why: "the summary paragraph README.md mirrors verbatim" },
  ],
};

const head = (s: string): string => s.slice(0, 60);
const scan = (page: string) => scanDoc(fs.readFileSync(path.join(DOCS, page), "utf8"));

describe("every docs page is short blocks, lists and tables, not text walls", () => {
  it("scans every page of docs/, the action-states, development and use-case pages included", () => {
    for (const page of ["action-states.md", "development.md", "queue.md", "use-case-anyparse.md"])
      expect(PAGES, page).toContain(page);
  });

  it("names only exemptions that exist", () => {
    for (const [page, list] of Object.entries(EXEMPT))
      for (const e of list)
        expect(
          scan(page).blocks.some(b => b.startsWith(e.starts) && docWords(b) >= 80),
          `${page}: ${e.starts}`,
        ).toBe(true);
  });

  it.each(PAGES)("%s: no block of 120 words or more, no table cell over 40 words", page => {
    const { blocks, cells } = scan(page);
    expect(blocks.filter(b => docWords(b) >= 120).map(head)).toEqual([]);
    expect(cells.filter(c => docWords(c) > 40).map(c => head(c.trim()))).toEqual([]);
  });

  it.each(PAGES)("%s: no block of 80 words or more outside the listed exemptions", page => {
    const exempt = (EXEMPT[page] ?? []).map(e => e.starts);
    const long = scan(page).blocks.filter(b => docWords(b) >= 80);
    expect(long.filter(b => !exempt.some(s => b.startsWith(s))).map(head)).toEqual([]);
  });
});
