import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Loader } from "./loader.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("land_timeout retry count: README matches the loaded batch-task", () => {
  it("README's stated retries equal land_timeout's max_visits", () => {
    const def = new Loader(
      path.join(ROOT, "templates"),
      fs.mkdtempSync(path.join(os.tmpdir(), "wf-lt-")),
      null,
    ).get("batch-task")!.states.land_timeout;
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const row = readme.split("\n").find(l => l.startsWith("| `project_land`"))!;
    const words: Record<string, number> = { once: 1, twice: 2 };
    const said = words[/retry (once|twice)/.exec(row)![1]];
    // each visit of land_timeout re-runs project_land, so max_visits visits = max_visits retries
    expect(said).toBe(def.max_visits);
  });
});
