import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SETTABLE_HEADER_KEYS } from "./queue.js";

// ENG-TASKFILE-WRITE-HOOK: the queue-write hook denies a hand edit of a queue file, so no bundled
// template may tell an agent to write one, and every header key a template has an agent set must be
// one `queue_header` / `wf-queue --header-set` takes.
const templates = path.resolve(import.meta.dirname, "..", "templates");
const files = [
  ...fs.readdirSync(templates).filter(f => f.endsWith(".yaml")),
  ...fs.readdirSync(path.join(templates, "drivers")).map(f => path.join("drivers", f)),
];
const text = (f: string) => fs.readFileSync(path.join(templates, f), "utf8");

// What a template may say about a hand edit: the user's own, a refusal, or unrelated work.
const ALLOWED = [
  /never edit the queue file by hand/i,
  /a hand edit of the file is not noticed/i,
  /never empty it by hand/i,
  /driven by hand/i,
  /never per land, never by hand/i,
  /or their own edit/i,
  /the user may\s*$/i,
];

describe("bundled templates and the queue-write hook", () => {
  it("no template tells an agent to write a queue header or file by hand", () => {
    const bad: string[] = [];
    for (const f of files) {
      const lines = text(f).split("\n");
      lines.forEach((line, i) => {
        if (!/by hand|hand edit/i.test(line)) return;
        if (ALLOWED.some(re => re.test(line))) return;
        if (/queue|header|land_test|record_file|base:/i.test(line))
          bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it("batch.yaml's plan_queue sets base, land_test and record_file through queue_header, all settable", () => {
    const batch = text("batch.yaml");
    const plan = batch.slice(batch.indexOf("  plan_queue:"), batch.indexOf("\n  pick:"));
    expect(plan).toContain("`queue_header` call");
    for (const key of ["base", "land_test", "record_file"]) {
      expect(plan).toContain(`${key}:`);
      expect(SETTABLE_HEADER_KEYS).toContain(key);
    }
    expect(plan).toContain("Never edit the queue file by hand");
    expect(text("master.yaml")).toMatch(/`base:`, `land_test:`, through `queue_header`/);
  });
});
