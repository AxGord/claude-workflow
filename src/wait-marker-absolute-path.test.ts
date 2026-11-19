import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The wait recipe the shipped prompts teach is EXECUTED here from a cwd that is not the task's logs
// directory (Claude Code resets an agent's shell cwd to the project root after a call that cds outside
// the working directories). A relative marker lands in that cwd; an absolute one lands in the logs dir.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = [
  "templates/batch-task.yaml",
  ".claude/workflows/engine-task.yaml",
  "docs/queue.md",
];
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("the detached-wait recipe in the shipped prompts and docs", () => {
  for (const rel of SOURCES) {
    it(`${rel}: starting it from the project root leaves the root untouched`, () => {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      const recipe = /`(nohup sh -c [^`]+)`/.exec(text)?.[1];
      expect(recipe, "the start recipe is in the file").toBeDefined();

      const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-wait-")));
      dirs.push(base);
      const projectRoot = path.join(base, "project");
      const wt = path.join(base, "wt");
      // the logs directory of a task: `<wt>.log` in the bundled batch template, `<wt>-logs` in engine-task
      const logs = `${wt}-logs`;
      const logsBatch = `${wt}.log`;
      for (const d of [projectRoot, wt, logs, logsBatch]) fs.mkdirSync(d);
      const where = () => [logs, logsBatch].flatMap(d => fs.readdirSync(d));

      const cmd = (recipe as string)
        .replaceAll("<cmd>", "false")
        .replaceAll("{{context.wt}}", wt)
        .replaceAll("<logs dir>", logs);
      expect(cmd, "the marker, log and pid are named by an absolute path").not.toMatch(
        /[ >]L\.(done|log|pid)/,
      );
      execFileSync("sh", ["-c", cmd], { cwd: projectRoot, stdio: "ignore" });
      // the detached job finishes at once; give it a moment to write its marker
      const deadline = Date.now() + 5000;
      while (
        Date.now() < deadline &&
        !/\.done/.test(fs.readdirSync(projectRoot).concat(where()).join(" "))
      ) {
        execFileSync("sleep", ["0.1"]);
      }
      execFileSync("sleep", ["0.3"]);

      expect(fs.readdirSync(projectRoot), "files the recipe dropped into the project root").toEqual(
        [],
      );
      expect(where().sort(), "the marker, log and pid land in the task's logs directory").toEqual([
        "L.done",
        "L.log",
        "L.pid",
      ]);
    });
  }

  it("no shipped prompt, doc or bundled skill teaches a relative L.done, L.log or L.pid", () => {
    const files = [
      ...SOURCES,
      "templates/skills/task-delegation/references/agent-liveness.md",
      "templates/skills/task-delegation/SKILL.md",
      "README.md",
    ];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(text.match(/(?<![\w/}>])L\.(done|log|pid)\b/g), rel).toBeNull();
    }
  });
});
