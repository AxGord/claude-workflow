import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ENG-TEST-GIT-NO-SIGN-GUARD: the user's global git config signs commits, and the gpg agent fails
// under the gate's parallel load. A test that commits in a temp fixture must not depend on it.
const SRC = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));
const COMMITS = /\bgit\w*\(\s*(?:[\w.]+,\s*)?"(?:commit|tag)"/;

describe("a test that runs git commit or git tag does not sign", () => {
  it("every such test file passes under a global git config that signs and whose gpg always fails", () => {
    const files = fs
      .readdirSync(SRC)
      .filter(f => f.endsWith(".test.ts") && f !== SELF)
      .filter(f => COMMITS.test(fs.readFileSync(path.join(SRC, f), "utf8")));
    expect(files.length).toBeGreaterThan(3);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-nosign-"));
    const cfg = path.join(dir, "gitconfig");
    fs.writeFileSync(
      cfg,
      "[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = true\n[tag]\n\tgpgSign = true\n[gpg]\n\tprogram = /usr/bin/false\n",
    );
    const r = spawnSync(
      "npx",
      ["vitest", "run", "--reporter=json", ...files.map(f => path.join("src", f))],
      {
        cwd: path.join(SRC, ".."),
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1" },
      },
    );
    const report = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as {
      testResults: { name: string; status: string }[];
    };
    const failed = report.testResults
      .filter(t => t.status !== "passed")
      .map(t => path.basename(t.name));
    expect(failed).toEqual([]);
  }, 300_000);
});
