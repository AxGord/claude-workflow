import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const text = readFileSync(resolve(__dirname, "..", "agents/driver.md"), "utf8");
const start = text.indexOf("## Design choices");
const end = text.indexOf("## Stop and hand back");

describe("driver.md decider section", () => {
  it("links the decider agent to P after DECIDED/ESCALATE", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(text.slice(start, end)).toMatch(/link_agent/u);
  });
});
