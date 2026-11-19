import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks",
  "workflow-start.sh",
);

describe("workflow-start.sh without jq", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A PATH directory holding every tool of /bin and /usr/bin except jq. */
  function pathWithoutJq(root: string): string {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    for (const dir of ["/bin", "/usr/bin"])
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (name === "jq" || fs.existsSync(path.join(bin, name))) continue;
        try {
          fs.symlinkSync(path.join(dir, name), path.join(bin, name));
        } catch {
          /* a racing duplicate */
        }
      }
    return bin;
  }

  it("says visibly that it skipped its work for lack of jq, naming jq", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-hook-nojq-"));
    dirs.push(root);
    const env = {
      HOME: path.join(root, "home"),
      STATE_DIR: path.join(root, "state"),
      CLAUDE_CONFIG_DIR: path.join(root, "config"),
      CLAUDE_PLUGIN_ROOT: path.join(root, "plugin"),
      CLAUDE_SKILLS_DIR: path.join(root, "skills"),
      PATH: pathWithoutJq(root),
    };
    for (const d of [env.HOME, env.STATE_DIR, env.CLAUDE_CONFIG_DIR, env.CLAUDE_PLUGIN_ROOT])
      fs.mkdirSync(d, { recursive: true });

    const r = spawnSync("/bin/bash", [HOOK], {
      input: JSON.stringify({ source: "resume", session_id: "abc123" }) + "\n",
      env,
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    // the fresh-start line is still printed
    expect(r.stdout).toContain("mcp__plugin_workflow_wf__start");
    // the skipped plan resume, resume pickup and conversation stamp are said, with the way out
    expect(r.stdout + r.stderr).toMatch(/jq/i);
    expect(r.stdout).toMatch(/plan resume/);
    expect(r.stdout).toMatch(/Install jq/);
  });

  it("is listed as an install prerequisite in README and the getting-started page", () => {
    const root = path.resolve(path.dirname(HOOK), "..");
    for (const doc of ["README.md", path.join("docs", "getting-started.md")])
      expect(fs.readFileSync(path.join(root, doc), "utf8"), doc).toMatch(
        /Prerequisites[^\n]*\n?[^\n]*`jq`/,
      );
  });
});
