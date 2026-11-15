import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const files = ["agents/driver.md", "templates/drivers/task-driver.md"];

describe("ENG-DRIVER-HANDBACK-AFTER-NEEDS-PARENT", () => {
  for (const f of files) {
    const text = readFileSync(resolve(__dirname, "..", f), "utf8");
    const i = text.indexOf("[handback-send-enforce]");
    const rule = text.slice(i, text.indexOf("\n- On a notification", i));

    it(`${f}: the WAITING-only answer is limited to a last line that is a WAITING line`, () => {
      expect(i).toBeGreaterThan(-1);
      expect(rule).toMatch(/last line/u);
      expect(rule).toMatch(/NEEDS-PARENT, LANDED or CLOSED/u);
      expect(rule).toMatch(/IS the request/u);
    });

    it(`${f}: the stop-and-hand-back heading says SubagentHandback, not reply`, () => {
      expect(text).not.toMatch(/reply with ONE line, then stop/u);
    });
  }
});
