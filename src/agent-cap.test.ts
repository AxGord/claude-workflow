import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import {
  agentCapFile,
  AGENT_TTL_MS,
  capMessage,
  handleAgentCap,
  RESERVATION_TTL_MS,
  type AgentCapPayload,
} from "./agent-cap.js";
import { projectAgentCap } from "./project-settings.js";

// ENG-AGENT-CAP-HOOK: a project's opt-in `agents.max_live` refuses an Agent spawn once that many agents
// of the session tree are live; a spawn passes again after one ends; nothing leaks; an unset cap does
// nothing at all.
const SRC = import.meta.dirname;
const HOOKS = path.resolve(SRC, "..", "hooks");
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-agent-cap-")));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
const STATE = path.join(scratch, "state");
const env = { STATE_DIR: STATE } as NodeJS.ProcessEnv;

function project(name: string, settings: string | undefined): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", "workflows"), { recursive: true });
  if (settings !== undefined)
    fs.writeFileSync(path.join(dir, ".claude", "workflows", "settings.json"), settings);
  return dir;
}
const CAP2 = project("cap2", '{"agents":{"max_live":2}}');
const OFF = project("off", undefined);
const NOKEY = project("nokey", '{"priority":"high"}');

let seq = 0;
const T0 = 1_000_000_000_000;
const base = (cwd: string, session: string): AgentCapPayload => ({ cwd, session_id: session });
/** The Agent call of the session; `by` makes it a nested spawn (the caller is an agent). */
const spawnCall = (cwd: string, session: string, now = T0, by?: string) =>
  handleAgentCap(
    {
      ...base(cwd, session),
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_use_id: `toolu_${++seq}`,
      ...(by ? { agent_id: by } : {}),
    },
    { env, now },
  );
const started = (cwd: string, session: string, agent: string, now = T0) =>
  handleAgentCap(
    { ...base(cwd, session), hook_event_name: "SubagentStart", agent_id: agent },
    { env, now },
  );
const stopped = (cwd: string, session: string, agent: string, now = T0) =>
  handleAgentCap(
    { ...base(cwd, session), hook_event_name: "SubagentStop", agent_id: agent },
    { env, now },
  );

describe("agent cap: the project setting", () => {
  it("reads agents.max_live, undefined when the file or the key is absent", () => {
    expect(projectAgentCap(CAP2)).toBe(2);
    expect(projectAgentCap(OFF)).toBeUndefined();
    expect(projectAgentCap(NOKEY)).toBeUndefined();
  });

  it.each([
    ['{"agents":{"max_live":0}}', "max_live"],
    ['{"agents":{"max_live":"4"}}', "max_live"],
    ['{"agents":{"max_live":2,"other":1}}', "agents"],
    ['{"agents":4}', "agents"],
  ])("refuses %s naming the key", (text, key) => {
    const dir = project(`bad${++seq}`, text);
    expect(() => projectAgentCap(dir)).toThrow(key);
  });
});

describe("agent cap: the refusal", () => {
  it("passes N spawns, refuses the N+1th naming the cap and the setting, and passes again after a stop", () => {
    const s = "sess-basic";
    expect(spawnCall(CAP2, s)).toBeUndefined();
    expect(started(CAP2, s, "a1")).toBeUndefined();
    expect(spawnCall(CAP2, s)).toBeUndefined();
    expect(started(CAP2, s, "a2")).toBeUndefined();
    const refused = spawnCall(CAP2, s);
    expect(refused?.permissionDecision).toBe("deny");
    expect(refused?.permissionDecisionReason).toBe(capMessage(2));
    expect(refused?.permissionDecisionReason).toContain("agents.max_live");
    expect(refused?.permissionDecisionReason).toMatch(/Wait for a running agent to finish/);
    // a refused spawn takes no slot
    stopped(CAP2, s, "a1");
    expect(spawnCall(CAP2, s)).toBeUndefined();
    expect(spawnCall(CAP2, s)?.permissionDecision).toBe("deny");
  });

  it("counts the reservations of one message: no SubagentStart has arrived yet", () => {
    const s = "sess-parallel";
    expect(spawnCall(CAP2, s)).toBeUndefined();
    expect(spawnCall(CAP2, s)).toBeUndefined();
    expect(spawnCall(CAP2, s)?.permissionDecision).toBe("deny");
  });

  it("a SubagentStart claims the reservation: an agent is counted once", () => {
    const s = "sess-claim";
    spawnCall(CAP2, s);
    spawnCall(CAP2, s);
    started(CAP2, s, "x1");
    started(CAP2, s, "x2");
    expect(spawnCall(CAP2, s)?.permissionDecision).toBe("deny");
    stopped(CAP2, s, "x2");
    expect(spawnCall(CAP2, s)).toBeUndefined();
  });

  it("a nested spawn counts toward the session's tree, and its agent's stop frees a slot", () => {
    const s = "sess-nested";
    spawnCall(CAP2, s);
    started(CAP2, s, "root");
    expect(spawnCall(CAP2, s, T0, "root")).toBeUndefined();
    started(CAP2, s, "child");
    expect(spawnCall(CAP2, s, T0, "child")?.permissionDecision).toBe("deny");
    expect(spawnCall(CAP2, s)?.permissionDecision).toBe("deny");
    stopped(CAP2, s, "child");
    expect(spawnCall(CAP2, s, T0, "root")).toBeUndefined();
  });

  it("another session has its own count", () => {
    spawnCall(CAP2, "sess-own-a");
    spawnCall(CAP2, "sess-own-a");
    expect(spawnCall(CAP2, "sess-own-a")?.permissionDecision).toBe("deny");
    expect(spawnCall(CAP2, "sess-own-b")).toBeUndefined();
  });

  it("an unset cap never refuses and keeps no state", () => {
    for (const dir of [OFF, NOKEY]) {
      for (let i = 0; i < 6; i++)
        expect(spawnCall(dir, `sess-off-${path.basename(dir)}`)).toBeUndefined();
      started(dir, `sess-off-${path.basename(dir)}`, "z");
      expect(fs.existsSync(agentCapFile(`sess-off-${path.basename(dir)}`, env))).toBe(false);
    }
  });

  it("a tool that is not an agent spawn, and a payload with no session, pass untouched", () => {
    const s = "sess-tools";
    for (let i = 0; i < 4; i++)
      expect(
        handleAgentCap(
          { ...base(CAP2, s), hook_event_name: "PreToolUse", tool_name: "Bash" },
          { env, now: T0 },
        ),
      ).toBeUndefined();
    expect(
      handleAgentCap({ cwd: CAP2, hook_event_name: "PreToolUse", tool_name: "Agent" }, { env }),
    ).toBeUndefined();
    expect(spawnCall(CAP2, s)).toBeUndefined();
    expect(spawnCall(CAP2, s)).toBeUndefined();
  });

  it("the Task tool name is an agent spawn too", () => {
    const s = "sess-task";
    const task = () =>
      handleAgentCap(
        { ...base(CAP2, s), hook_event_name: "PreToolUse", tool_name: "Task", tool_use_id: "t" },
        { env, now: T0 },
      );
    task();
    task();
    expect(task()?.permissionDecision).toBe("deny");
  });
});

describe("agent cap: the counter lock", () => {
  it("waits for a lock another process holds, then counts", async () => {
    const file = agentCapFile("sess-locked", env);
    const lock = `${file}.lock`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(lock);
    const holder = spawn(process.execPath, [
      "-e",
      `setTimeout(() => require("fs").rmSync(${JSON.stringify(lock)}, { recursive: true }), 400)`,
    ]);
    const t = Date.now();
    expect(spawnCall(CAP2, "sess-locked", T0)).toBeUndefined();
    expect(Date.now() - t).toBeGreaterThanOrEqual(300);
    await new Promise(r => holder.on("close", r));
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("breaks a lock whose holder died long ago", () => {
    const file = agentCapFile("sess-stale", env);
    fs.mkdirSync(`${file}.lock`, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${file}.lock`, old, old);
    expect(spawnCall(CAP2, "sess-stale", T0)).toBeUndefined();
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });
});

describe("agent cap: nothing leaks", () => {
  it("a reservation no SubagentStart claimed stops counting after its TTL", () => {
    const s = "sess-ttl-res";
    spawnCall(CAP2, s);
    spawnCall(CAP2, s);
    expect(spawnCall(CAP2, s, T0 + RESERVATION_TTL_MS - 1)?.permissionDecision).toBe("deny");
    expect(spawnCall(CAP2, s, T0 + RESERVATION_TTL_MS + 1)).toBeUndefined();
  });

  it("a started agent that died with no stop event stops counting after the silence TTL", () => {
    const s = "sess-ttl-agent";
    spawnCall(CAP2, s);
    started(CAP2, s, "d1");
    spawnCall(CAP2, s);
    started(CAP2, s, "d2");
    expect(spawnCall(CAP2, s, T0 + AGENT_TTL_MS - 1)?.permissionDecision).toBe("deny");
    expect(spawnCall(CAP2, s, T0 + AGENT_TTL_MS + 1)).toBeUndefined();
  });

  it("an agent whose own transcript is still written keeps counting past the TTL", () => {
    const s = "sess-ttl-alive";
    const dir = path.join(scratch, "transcripts", s, "subagents");
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const main = path.join(scratch, "transcripts", `${s}.jsonl`);
    for (const id of ["l1", "l2"]) {
      spawnCall(CAP2, s, now - 2 * AGENT_TTL_MS);
      handleAgentCap(
        {
          ...base(CAP2, s),
          hook_event_name: "SubagentStart",
          agent_id: id,
          transcript_path: main,
        },
        { env, now: now - 2 * AGENT_TTL_MS },
      );
    }
    fs.writeFileSync(path.join(dir, "agent-l1.jsonl"), "{}\n"); // l1 wrote just now, l2 is silent
    expect(spawnCall(CAP2, s, now)).toBeUndefined();
    expect(spawnCall(CAP2, s, now)?.permissionDecision).toBe("deny");
  });

  it("sweeps the counter file of a session nobody touched for days", () => {
    const old = agentCapFile("sess-old", env);
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, '{"entries":[]}');
    const longAgo = new Date(Date.now() - 5 * 24 * 60 * 60_000);
    fs.utimesSync(old, longAgo, longAgo);
    spawnCall(CAP2, "sess-sweeper", Date.now());
    expect(fs.existsSync(old)).toBe(false);
  });
});

describe("agent cap: the hook script", () => {
  const plugin = path.join(scratch, "plugin");
  const script = path.join(plugin, "hooks", "agent-cap-gate.sh");
  beforeAll(async () => {
    fs.mkdirSync(path.join(plugin, "hooks"), { recursive: true });
    fs.copyFileSync(path.join(HOOKS, "agent-cap-gate.sh"), script);
    fs.chmodSync(script, 0o755);
    fs.writeFileSync(path.join(plugin, "package.json"), '{"type":"module"}');
    await build({
      entryPoints: [path.join(SRC, "agent-cap-hook.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node18",
      banner: {
        js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
      },
      outfile: path.join(plugin, "build", "agent-cap-hook.js"),
      logLevel: "silent",
    });
  });

  const payload = (cwd: string, session: string, event = "PreToolUse") => ({
    hook_event_name: event,
    tool_name: "Agent",
    tool_use_id: `toolu_${++seq}`,
    session_id: session,
    cwd,
  });
  const run = (p: object, e: NodeJS.ProcessEnv = env) =>
    spawnSync("sh", [script], {
      input: JSON.stringify(p),
      encoding: "utf8",
      env: { ...process.env, ...e },
    });

  it("answers a deny the harness reads, as a PreToolUse hookSpecificOutput", () => {
    const s = "sess-script";
    expect(run(payload(CAP2, s)).stdout).toBe("");
    expect(run(payload(CAP2, s)).stdout).toBe("");
    const r = run(payload(CAP2, s));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(capMessage(2));
    // SubagentStop of an unknown agent prints nothing
    expect(run({ ...payload(CAP2, s, "SubagentStop"), agent_id: "nobody" }).stdout).toBe("");
  });

  it("parallel spawns of one message: exactly the cap passes", async () => {
    const dir = project("cap3", '{"agents":{"max_live":3}}');
    const results = await Promise.all(
      Array.from(
        { length: 10 },
        () =>
          new Promise<string>(resolve => {
            const child = spawn("sh", [script], { env: { ...process.env, ...env } });
            let out = "";
            child.stdout.on("data", d => (out += String(d)));
            child.on("close", () => resolve(out));
            child.stdin.end(JSON.stringify(payload(dir, "sess-race")));
          }),
      ),
    );
    expect(results.filter(o => o.includes('"deny"'))).toHaveLength(7);
    expect(results.filter(o => o === "")).toHaveLength(3);
  });

  it("a project with no max_live exits at once with no output, and needs no build", () => {
    const bare = path.join(scratch, "bare-plugin", "hooks");
    fs.mkdirSync(bare, { recursive: true });
    fs.copyFileSync(path.join(HOOKS, "agent-cap-gate.sh"), path.join(bare, "agent-cap-gate.sh"));
    for (const dir of [OFF, NOKEY]) {
      const r = spawnSync("sh", [path.join(bare, "agent-cap-gate.sh")], {
        input: JSON.stringify(payload(dir, "sess-fast")),
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
    }
  });

  it("a settings file the gate cannot read lets the call pass with one stderr line", () => {
    const dir = project("broken", '{"agents":{"max_live":0}}');
    const r = run(payload(dir, "sess-broken"));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^agent-cap-gate: .*max_live.* — the call passes as is\n$/);
  });

  it("a worktree (its .git is a file) goes to the gate, whose settings live in the main checkout", () => {
    const main = project("wt-main", '{"agents":{"max_live":1}}');
    const wt = path.join(scratch, "wt-tree");
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${main}/.git/worktrees/wt-tree\n`);
    fs.mkdirSync(path.join(main, ".git", "worktrees", "wt-tree"), { recursive: true });
    expect(run(payload(wt, "sess-wt")).stdout).toBe("");
    expect(run(payload(wt, "sess-wt")).stdout).toContain('"deny"');
  });
});

describe("agent cap: the declarations", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(HOOKS, "hooks.json"), "utf8")) as {
    hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  };
  const gate = (event: string) =>
    hooks.hooks[event]?.filter(e => e.hooks.some(h => h.command.includes("agent-cap-gate.sh")));

  it("hooks.json wires the gate to the Agent spawn, SubagentStart and SubagentStop", () => {
    expect(gate("PreToolUse")?.map(e => e.matcher)).toEqual(["Agent|Task"]);
    expect(gate("SubagentStart")).toHaveLength(1);
    expect(gate("SubagentStop")).toHaveLength(1);
  });

  it("Getting started and Queue say the cap counts the dispatcher and the drivers", () => {
    for (const page of ["getting-started", "queue"]) {
      const text = fs.readFileSync(path.resolve(SRC, "..", "docs", `${page}.md`), "utf8");
      expect(text).toMatch(/dispatcher, every driver and every parent waiting on its child/);
    }
  });

  it.each(["coding", "bug-fix", "code-review"])(
    "the bundled %s fan-out names the cap, and no state says 'Launch ALL'",
    name => {
      const text = fs.readFileSync(path.resolve(SRC, "..", "templates", `${name}.yaml`), "utf8");
      expect(text).toContain("`agents.max_live`");
      const flat = text.replace(/\s+/g, " ");
      expect(flat).toContain("EVERY live agent of the session tree");
      expect(flat).toContain("next wave, never skipped");
      expect(text).not.toContain("Launch ALL");
      expect(text).not.toContain("Launch up to 8 batch agents");
    },
  );
});
