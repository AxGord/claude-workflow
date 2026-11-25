import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ENG-DISPATCHER-WAKES-DRIVER-ONLY: the shipped driver instructions carry the wake rules.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), "utf8");

describe("stale notice", () => {
  it("does not call a silent agent gone", () => {
    expect(read("src/tools.ts")).not.toContain("no answer → abort its session");
  });
});

describe("driver instructions: wake the driver only", () => {
  it("the dispatcher treats an undelivered waiting driver as waiting and spawns only after a failed SendMessage", () => {
    const t = read("templates/drivers/dispatch-driver.md");
    expect(t).toContain("ended without delivering a report");
    expect(t).toContain("Wake only the driver");
    expect(t).toContain("only after a SendMessage to the");
    expect(t).not.toContain("ends again with no line → it is gone");
    expect(t).not.toContain("no answer or gone →");
  });
  it.each(["templates/drivers/task-driver.md", "agents/driver.md"])(
    "%s re-wakes its own worker after a usage limit",
    f => {
      const t = read(f);
      expect(t).toContain("usage limit");
      expect(t).toContain("SendMessage the SAME worker");
    },
  );
});
