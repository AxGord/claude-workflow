import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { docWords as words, scanDoc } from "./test-helpers.js";

const PAGE = fs.readFileSync(path.join(import.meta.dirname, "..", "docs/development.md"), "utf8");
/** A code span counts as one word and cannot hold a sentence end or a parenthesis. */
const spans = (text: string): string => text.replace(/`[^`]*`/g, "X");

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
  const { blocks } = scanDoc(PAGE);

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
