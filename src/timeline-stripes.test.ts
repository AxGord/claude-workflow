import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "components.css"),
  "utf8",
);

// .tl-wait is position:absolute and sizes itself against its nearest positioned ancestor. The legend
// re-declares .tl-seg as static, so the legend's pool-wait swatch (left:0;right:0) is laid out against
// the page and paints its stripes over everything.
describe("timeline pool-wait stripes", () => {
  it("the legend swatch keeps a positioned containing block for .tl-wait", () => {
    const rule = /\.tl-legend\s+\.tl-seg\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    expect(rule).not.toMatch(/position\s*:\s*static/);
  });
});
