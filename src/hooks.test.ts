import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks");

/** Run a hook script with a sandboxed HOME / STATE_DIR / plugin root; its $PPID is this process. */
function runHook(script: string, env: Record<string, string>): string {
  const r = spawnSync("bash", [path.join(HOOKS, script)], { input: "{}\n", env: { ...process.env, ...env }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${script} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

async function deadPid(): Promise<number> {
  const child = spawn("true");
  await new Promise(r => child.on("exit", r));
  return child.pid!;
}

describe("hooks", () => {
  const dirs: string[] = [];
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-hook-")); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  function sandbox() {
    const root = tmp();
    const env = {
      HOME: path.join(root, "home"),
      STATE_DIR: path.join(root, "state"),
      CLAUDE_CONFIG_DIR: path.join(root, "config"),
      CLAUDE_PLUGIN_ROOT: path.join(root, "plugin"),
    };
    for (const d of Object.values(env)) fs.mkdirSync(d, { recursive: true });
    return env;
  }

  it("workflow-start.sh drops context-epoch markers of dead pids, keeps live ones and its own", async () => {
    const env = sandbox();
    const dead = await deadPid();
    const live = process.ppid; // alive, and not the hook's parent
    for (const pid of [dead, live]) fs.writeFileSync(path.join(env.STATE_DIR, `context-epoch-${pid}`), "1.1\n");
    fs.writeFileSync(path.join(env.STATE_DIR, "context-epoch-notapid"), "x");

    runHook("workflow-start.sh", env);

    const left = fs.readdirSync(env.STATE_DIR).filter(f => f.startsWith("context-epoch-")).sort();
    expect(left).toEqual([`context-epoch-${live}`, `context-epoch-${process.pid}`, "context-epoch-notapid"].sort());
  });

  it("workflow-cleanup.sh hands every session it abandons (incl. cascaded children) to ledger-cli", () => {
    const env = sandbox();
    const argsFile = path.join(env.STATE_DIR, "..", "ledger-args");
    fs.mkdirSync(path.join(env.CLAUDE_PLUGIN_ROOT, "build"));
    fs.writeFileSync(
      path.join(env.CLAUDE_PLUGIN_ROOT, "build", "ledger-cli.js"),
      `require("fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
    );
    const session = (id: string, extra: object) => ({
      session_id: id,
      stack: [{ workflow: "w", current_state: "s", state_visits: {}, total_transitions: 0 }],
      active_frame: 0,
      started_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      history: [],
      overrides: {},
      context: {},
      ...extra,
    });
    const write = (s: { session_id: string }) =>
      fs.writeFileSync(path.join(env.STATE_DIR, `${s.session_id}.json`), JSON.stringify(s));
    write(session("aaaa1111", { context: { claude_code_pid: process.pid } }));
    write(session("bbbb2222", { parent_session_id: "aaaa1111", context: { claude_code_pid: 1 } }));
    write(session("cccc3333", { context: { claude_code_pid: 1 } }));

    runHook("workflow-cleanup.sh", env);

    const args = JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[];
    expect(args).toEqual([env.STATE_DIR, "aaaa1111", "bbbb2222"]);
  });
});
