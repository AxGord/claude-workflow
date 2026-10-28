import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks");

/** Run a hook script with a sandboxed HOME / STATE_DIR / plugin root; its $PPID is this process. */
function runHook(script: string, env: Record<string, string>, payload: object = {}): string {
  const r = spawnSync("bash", [path.join(HOOKS, script)], { input: JSON.stringify(payload) + "\n", env: { ...process.env, ...env }, encoding: "utf8" });
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
  const writer = (stateDir: string) => (s: { session_id: string }) =>
    fs.writeFileSync(path.join(stateDir, `${s.session_id}.json`), JSON.stringify(s));
  const read = (stateDir: string, id: string) => JSON.parse(fs.readFileSync(path.join(stateDir, `${id}.json`), "utf8"));

  it("workflow-cleanup.sh suspends this process's sessions and their children (stamped with the ending conversation), ends none", () => {
    const env = sandbox();
    // a ledger-cli stub: nothing may be handed to it any more — no session ends here
    const argsFile = path.join(env.STATE_DIR, "..", "ledger-args");
    fs.mkdirSync(path.join(env.CLAUDE_PLUGIN_ROOT, "build"));
    fs.writeFileSync(
      path.join(env.CLAUDE_PLUGIN_ROOT, "build", "ledger-cli.js"),
      `require("fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
    );
    const write = writer(env.STATE_DIR);
    write(session("aaaa1111", { context: { claude_code_pid: process.pid }, claude_session_id: "old-conv" }));
    write(session("bbbb2222", { parent_session_id: "aaaa1111", context: { claude_code_pid: 1 } }));
    write(session("cccc3333", { context: { claude_code_pid: 1 } }));
    fs.writeFileSync(path.join(env.STATE_DIR, `claude-session-${process.pid}`), "conv-9\n");

    runHook("workflow-cleanup.sh", env, { session_id: "conv-9", reason: "prompt_input_exit" });

    for (const id of ["aaaa1111", "bbbb2222"]) {
      const s = read(env.STATE_DIR, id);
      expect(s.suspended_at).toBeTruthy();
      expect(s.outcome).toBeUndefined();
      expect(s.stack).toHaveLength(1);
      expect(s.claude_session_id).toBe("conv-9");
      expect(s.history.at(-1).event).toBe("suspend");
    }
    expect(read(env.STATE_DIR, "cccc3333").suspended_at).toBeUndefined();
    expect(fs.existsSync(argsFile)).toBe(false);
    expect(fs.existsSync(path.join(env.STATE_DIR, `claude-session-${process.pid}`))).toBe(false);
  });

  it("workflow-start.sh records the conversation id and, on resume, lists that conversation's suspended root sessions", () => {
    const env = sandbox();
    const write = writer(env.STATE_DIR);
    const at = { suspended_at: "2026-10-28T00:00:00.000Z" };
    write(session("aaaa1111", { ...at, claude_session_id: "conv-9", stack: [{ workflow: "batch", current_state: "collect", state_visits: {}, total_transitions: 0 }] }));
    write(session("bbbb2222", { ...at, claude_session_id: "conv-9", parent_session_id: "aaaa1111" }));
    write(session("cccc3333", { ...at, claude_session_id: "other" }));
    write(session("dddd4444", { claude_session_id: "conv-9" }));

    const out = runHook("workflow-start.sh", env, { session_id: "conv-9", source: "resume" });
    expect(fs.readFileSync(path.join(env.STATE_DIR, `claude-session-${process.pid}`), "utf8").trim()).toBe("conv-9");
    expect(out).toContain("do NOT call start()");
    expect(out).toContain('aaaa1111: batch @ collect → mcp__plugin_workflow_wf__resume({ session_id: "aaaa1111" })');
    expect(out).not.toContain("bbbb2222");
    expect(out).not.toContain("cccc3333");
    expect(out).not.toContain("dddd4444");

    const fresh = runHook("workflow-start.sh", env, { session_id: "conv-9", source: "startup" });
    expect(fresh).not.toContain("aaaa1111");
    expect(fresh).toContain("Call mcp__plugin_workflow_wf__start");
  });
});
