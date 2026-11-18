import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const PAGES = ["getting-started", "concepts", "pool", "workflow-yaml"];
const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

interface Scan {
  /** Words of each block of consecutive prose lines; a list item, heading, table row, fence, svg or the front matter ends one. */
  blocks: number[];
  /** Words of each table cell. */
  cells: number[];
}

const scan = (page: string): Scan => {
  const lines = fs.readFileSync(path.join(ROOT, "docs", `${page}.md`), "utf8").split("\n");
  const out: Scan = { blocks: [], cells: [] };
  let fence = false;
  let svg = false;
  let cur = 0;
  const flush = (): void => {
    if (cur > 0) out.blocks.push(cur);
    cur = 0;
  };
  const front = lines[0] === "---" ? lines.indexOf("---", 1) + 1 : 0;
  for (const line of lines.slice(front)) {
    if (line.startsWith("```")) {
      flush();
      fence = !fence;
    } else if (fence) flush();
    else if (line.startsWith("<svg") || svg) {
      flush();
      svg = !line.includes("</svg>");
    } else if (line.trimStart().startsWith("|")) {
      flush();
      out.cells.push(...line.split("|").slice(1, -1).map(words));
    } else if (line.startsWith("#") || line.trim() === "") flush();
    else {
      if (/^\s*([-*]|\d+\.) /.test(line)) flush();
      cur += words(line);
    }
  }
  flush();
  return out;
};

describe("the entry pages have no unbroken text wall", () => {
  it.each(PAGES)("%s: no block of 120 words or more, no table cell over 40 words", page => {
    const { blocks, cells } = scan(page);
    expect(Math.max(...blocks), "longest unbroken block, in words").toBeLessThan(120);
    expect(Math.max(...cells, 0), "longest table cell, in words").toBeLessThanOrEqual(40);
  });

  // The one paragraph at 80-119 words is the two-ways summary that README.md mirrors verbatim.
  it("only the mirrored summary paragraph of concepts stays at 80 words or more", () => {
    const long = PAGES.map(page => [page, scan(page).blocks.filter(n => n >= 80).length]);
    expect(long).toEqual([
      ["getting-started", 0],
      ["concepts", 1],
      ["pool", 0],
      ["workflow-yaml", 0],
    ]);
  });
});
