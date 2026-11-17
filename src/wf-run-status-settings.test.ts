import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const SRC = path.dirname(fileURLToPath(import.meta.url));

describe("wf-run --status with a malformed project settings file", () => {
  let cli = "";
  beforeAll(async () => {
    cli = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wf-run-bin-")), "wf-run.cjs");
    await build({
      entryPoints: [path.join(SRC, "wf-run.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node18",
      outfile: cli,
      logLevel: "silent",
    });
  });

  it("exits 0 with the status: status needs no priority", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-proj-")));
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, ".claude", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".claude", "workflows", "settings.json"),
      '{ "priority": "max" ',
    );
    const pool = fs.mkdtempSync(path.join(os.tmpdir(), "wf-pool-"));
    fs.writeFileSync(
      path.join(pool, "config.yaml"),
      JSON.stringify({ budget: 10, load_threshold: 1000 }),
    );
    const base = { ...process.env };
    for (const key of ["WF_PRIORITY", "WF_PRIORITY_LEVEL", "WF_SESSION_ID"]) delete base[key];
    const res = spawnSync(process.execPath, [cli, "--status"], {
      cwd: root,
      env: { ...base, WF_POOL_DIR: pool },
      encoding: "utf8",
    });
    expect(res.stderr).not.toContain("settings.json");
    expect(res.status).toBe(0);
  });
});
