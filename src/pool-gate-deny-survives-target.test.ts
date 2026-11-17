import { afterAll, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { poolGateOutput } from "./pool-gate-run.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgd-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function project(name: string, yaml: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "workflows", "pool-gate.yaml"), yaml);
  return dir;
}

const caller = project("caller", "rules:\n  - match: git stash\n    deny: no git stash here\n");
const target = project(
  "target",
  "rules:\n  - match: npx vitest run\n    threads: 1\n    pass: env:VITEST_MAX_WORKERS\n",
);

const run = (command: string, cwd: string) =>
  poolGateOutput(command, { command }, cwd, { PATH: "/usr/bin:/bin" }, () => {});

describe("deny of the session's project survives a cd into a worktree with its own config", () => {
  it("control: the deny applies without a cd", () => {
    expect(run("git stash list", caller)?.permissionDecision).toBe("deny");
  });
  it("denies `cd <target> && git stash list` from the caller's project", () => {
    expect(run(`cd ${target} && git stash list`, caller)?.permissionDecision).toBe("deny");
  });

  describe("a malformed config drops only its own side", () => {
    const bad = project("bad", "{ rules: ");
    const targetDeny = project(
      "target-deny",
      "rules:\n  - match: git stash\n    deny: target says no\n",
    );
    const lines: string[] = [];
    const runLogged = (command: string, cwd: string) => {
      lines.length = 0;
      return poolGateOutput(command, { command }, cwd, { PATH: "/usr/bin:/bin" }, l =>
        lines.push(l),
      );
    };

    it("a malformed caller config: the target's deny still refuses, one stderr line", () => {
      const out = runLogged(`cd ${targetDeny} && git stash list`, bad);
      expect(out?.permissionDecision).toBe("deny");
      expect(out?.permissionDecisionReason).toBe("pool-gate: target says no");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^pool-gate: config ignored — .*pool-gate\.yaml: /);
    });

    it("a malformed target config: the caller's deny still refuses, one stderr line", () => {
      const out = runLogged(`cd ${bad} && git stash list`, caller);
      expect(out?.permissionDecision).toBe("deny");
      expect(out?.permissionDecisionReason).toBe("pool-gate: no git stash here");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^pool-gate: config ignored — .*pool-gate\.yaml: /);
    });

    it("the same malformed config as caller and target: one stderr line, the command passes", () => {
      expect(runLogged("git stash list", bad)).toBeUndefined();
      expect(lines).toHaveLength(1);
    });
  });
});
