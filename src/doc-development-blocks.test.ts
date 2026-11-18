import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PAGE = fs.readFileSync(path.join(import.meta.dirname, "..", "docs/development.md"), "utf8");
const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;
/** A code span counts as one word and cannot hold a sentence end or a parenthesis. */
const spans = (text: string): string => text.replace(/`[^`]*`/g, "X");

interface Scan {
  /** Each block of consecutive prose lines; a list item, heading, table row, fence, svg or the front matter ends one. */
  blocks: string[];
  /** Each table cell. */
  cells: string[];
}

const scan = (md: string): Scan => {
  const lines = md.split("\n");
  const out: Scan = { blocks: [], cells: [] };
  let fence = false;
  let svg = false;
  let cur: string[] = [];
  const flush = (): void => {
    if (cur.length > 0) out.blocks.push(cur.join(" "));
    cur = [];
  };
  const front = lines[0] === "---" ? lines.indexOf("---", 1) + 1 : 0;
  for (const line of lines.slice(front)) {
    if (line.trimStart().startsWith("```")) {
      flush();
      fence = !fence;
    } else if (fence) flush();
    else if (line.startsWith("<svg") || svg) {
      flush();
      svg = !line.includes("</svg>");
    } else if (line.trimStart().startsWith("|")) {
      flush();
      out.cells.push(...line.split("|").slice(1, -1));
    } else if (line.startsWith("#") || line.trim() === "") flush();
    else {
      if (/^\s*([-*]|\d+\.) /.test(line)) flush();
      cur.push(line.trim());
    }
  }
  flush();
  return out;
};

const sentences = (block: string): string[] => spans(block).split(/(?<=[.!?])\s+(?=[A-Z`*[<(|])/);

const nestedTwoDeep = (text: string): boolean => {
  let depth = 0;
  for (const ch of spans(text)) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth >= 2) return true;
  }
  return false;
};

describe("docs/development.md is short blocks, lists and tables, not text walls", () => {
  const { blocks, cells } = scan(PAGE);

  it("has no block of 80 words or more", () => {
    expect(blocks.filter(b => words(b) >= 80).map(b => b.slice(0, 60))).toEqual([]);
  });

  it("has no table cell over 40 words", () => {
    expect(cells.filter(c => words(c) > 40).map(c => c.trim().slice(0, 60))).toEqual([]);
  });

  it("has no sentence of 60 words or more, a code span counting as one word", () => {
    const long = blocks.flatMap(sentences).filter(s => words(s) >= 60);
    expect(long.map(s => s.slice(0, 60))).toEqual([]);
  });

  it("has no parenthesis nested two deep", () => {
    expect(blocks.filter(nestedTwoDeep).map(b => b.slice(0, 60))).toEqual([]);
  });

  it("states the house style once at the top, with how each measure counts", () => {
    const headings = PAGE.split("\n").filter(l => l.startsWith("## "));
    expect(headings.slice(0, 2)).toEqual(["## House style", "## Commands"]);
    const section = PAGE.split("\n## ")[1] ?? "";
    for (const rule of [
      "fewer than 120",
      "at most 40 words",
      "fewer than 60 words",
      "nested two deep",
    ])
      expect(section, rule).toContain(rule);
  });

  it("keeps the site section on this page", () => {
    expect(PAGE.split("\n")).toContain("## The site");
  });
});
