import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");

/** The `## Install` section of README.md, up to the next `## ` heading. */
const installSection = (): string => {
  const text = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const from = text.indexOf("\n## Install\n");
  if (from < 0) throw new Error("README.md: no Install section");
  const next = text.indexOf("\n## ", from + 1);
  return text.slice(from, next < 0 ? undefined : next);
};

describe("README: the Install section links the getting-started page once", () => {
  it("holds one [Getting started] link, not two adjacent ones", () => {
    const links = [...installSection().matchAll(/\[Getting started\]\([^)]*getting-started\)/g)];
    expect(links).toHaveLength(1);
  });
});
