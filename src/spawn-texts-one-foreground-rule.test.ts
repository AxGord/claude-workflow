import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expandRules } from "./brief-rules.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flat = (p: string) =>
  expandRules(fs.readFileSync(path.join(ROOT, p), "utf8")).replace(/\s+/g, " ");
const list = (dir: string, ext: string) =>
  fs
    .readdirSync(path.join(ROOT, dir))
    .filter(f => f.endsWith(ext))
    .map(f => `${dir}/${f}`);

// Every text an agent reads that tells it how to spawn or how to wait: bundled workflows, driver texts, agent types.
const SPAWN_TEXTS = [
  ...list("templates", ".yaml"),
  ...list("templates/drivers", ".md"),
  ...list("agents", ".md"),
  ".claude/workflows/engine-task.yaml",
];

// The one rule, word for word, wherever a text hands an agent its Bash and wait behaviour.
const RULE =
  "Never end a turn with a live background shell of your own: wait for a long command in ONE foreground call (Bash timeout up to its maximum), and a call the harness moved to the background is awaited or stopped before the turn ends.";
const CARRY_THE_RULE = [
  "templates/coding.yaml",
  "templates/bug-fix.yaml",
  "templates/debugging.yaml",
  "templates/explore.yaml",
  "templates/batch.yaml",
  "templates/code-review.yaml",
  "templates/testing.yaml",
  "templates/subagent.yaml",
  "templates/drivers/task-driver.md",
  "templates/drivers/dispatch-driver.md",
  "agents/driver.md",
];

// The only sentences where the name may stand: they say the parameter does not exist or is never used.
const NEGATIONS = [
  /Agent tool has no `run_in_background`/g,
  /A sub-agent's Agent tool has no `run_in_background`/g,
  /never with `run_in_background`/g,
];

describe("every spawn text says one thing about background shells", () => {
  for (const file of SPAWN_TEXTS) {
    it(`${file}: no sentence tells an agent to use run_in_background or to background a command`, () => {
      const text = NEGATIONS.reduce((t, re) => t.replace(re, ""), flat(file));
      expect(text).not.toContain("run_in_background");
      expect(text).not.toMatch(/background ONLY for/);
      expect(text).not.toContain("10-min foreground ceiling");
    });
  }

  it("templates/testing.yaml: the integration step starts a never-exiting app detached and names who stops it", () => {
    const text = flat("templates/testing.yaml");
    const step = text.slice(text.indexOf("Run integration verification"));
    expect(step).toMatch(
      /A never-exiting app is started DETACHED by the launcher \(`nohup <cmd> > <log> 2>&1 & echo \$! > <pid file>`.*YOU stop the app \(`kill` that pid\) after step 3/,
    );
  });

  for (const file of CARRY_THE_RULE) {
    it(`${file}: carries the one rule`, () => {
      expect(flat(file)).toContain(RULE);
    });
  }
});
