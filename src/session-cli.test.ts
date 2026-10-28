import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Storage } from "./storage.js";
import { activeReport, pickupReport } from "./session-cli.js";
import type { SessionState } from "./types.js";

async function deadPid(): Promise<number> {
  const child = spawn("true");
  await new Promise(r => child.on("exit", r));
  return child.pid!;
}

const AT = "2026-10-28T12:00:00.000Z";

function session(id: string, extra: Partial<SessionState> & { pid?: number }): SessionState {
  const { pid, ...rest } = extra;
  return {
    session_id: id,
    stack: [{ workflow: "w", current_state: "s", state_visits: {}, total_transitions: 0 }],
    active_frame: 0,
    started_at: AT,
    updated_at: AT,
    history: [],
    overrides: {},
    context: { claude_code_pid: pid ?? 1 },
    ...rest,
  };
}

describe("session-cli (SessionStart hook)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const storage = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-cli-"));
    dirs.push(d);
    return new Storage(d);
  };

  it("pickup hands the conversation's suspended and crashed sessions, with their sub-trees, to the new process", async () => {
    const st = storage();
    const dead = await deadPid();
    const me = process.pid;
    const susp = { suspended_at: AT, claude_session_id: "conv-9" };
    await st.write(
      "aaaa1111",
      session("aaaa1111", {
        ...susp,
        pid: dead,
        stack: [
          { workflow: "master", current_state: "route", state_visits: {}, total_transitions: 0 },
          { workflow: "batch", current_state: "collect", state_visits: {}, total_transitions: 0 },
        ],
        active_frame: 1,
      }),
    );
    await st.write(
      "bbbb2222",
      session("bbbb2222", {
        ...susp,
        pid: dead,
        parent_session_id: "aaaa1111",
        agent_id: "agent-7",
      }),
    );
    // a grandchild SessionEnd stamped too, and one it never reached (still suspended by the reaper only)
    await st.write(
      "cccc3333",
      session("cccc3333", { suspended_at: AT, pid: dead, parent_session_id: "bbbb2222" }),
    );
    // crash: never suspended, owner gone, same conversation
    await st.write(
      "dddd4444",
      session("dddd4444", {
        claude_session_id: "conv-9",
        pid: dead,
        running_exec: {
          pgid: 999_999,
          out: "/x/o",
          err: "/x/e",
          rc: "/x/rc",
          started_at: AT,
          boot_ms: 0,
          frame: 0,
          state: "s",
        },
      }),
    );
    // another conversation, and a live process running this one
    await st.write(
      "eeee5555",
      session("eeee5555", { suspended_at: AT, claude_session_id: "other" }),
    );
    await st.write(
      "ffff6666",
      session("ffff6666", { claude_session_id: "conv-9", pid: process.ppid }),
    );

    const text = await pickupReport(st, "conv-9", me, AT);

    for (const id of ["aaaa1111", "bbbb2222", "cccc3333", "dddd4444"]) {
      const s = st.read(id)!;
      expect(s.context.claude_code_pid).toBe(me);
      expect(s.suspended_at).toBeUndefined();
      expect(s.claude_session_id).toBe("conv-9");
    }
    expect(st.read("aaaa1111")!.history.at(-1)).toEqual({ frame: 1, event: "resume", at: AT });
    expect(st.read("dddd4444")!.history).toEqual([]);
    expect(st.read("eeee5555")!.suspended_at).toBe(AT);
    expect(st.read("ffff6666")!.context.claude_code_pid).toBe(process.ppid);

    expect(text).toContain("Do NOT call start() or resume()");
    expect(text).toContain(
      "picked up: aaaa1111 @ batch @ collect (stack: master @ route > batch @ collect)",
    );
    expect(text).toContain("picked up: dddd4444 @ w @ s");
    expect(text).toContain("exec in flight: s — the first status() / transition()");
    expect(text).toContain("agent-7 → bbbb2222 → w @ s");
    expect(text).toContain(
      `SendMessage({ to: "agent-7", message: "Continue: call mcp__plugin_workflow_wf__status({ session_id: 'bbbb2222' }) — your own session, picked up after a restart — NOT start(), NOT resume()`,
    );
    expect(text).toContain("cccc3333");
    expect(text).not.toContain("picked up: bbbb2222");
    expect(text).not.toContain("eeee5555");
    expect(text).not.toContain("ffff6666");

    // a second SessionStart finds nothing left to pick up
    expect(await pickupReport(st, "conv-9", me, AT)).toBe("");
  });

  it("pickup leaves a child whose parent another live process runs, and a live descendant of a picked-up root", async () => {
    const st = storage();
    const dead = await deadPid();
    const live = process.ppid;
    // an explicit resume() of P in live process B re-owned C and left it suspended
    await st.write("aaaa1111", session("aaaa1111", { claude_session_id: "conv-B", pid: live }));
    await st.write(
      "bbbb2222",
      session("bbbb2222", {
        suspended_at: AT,
        claude_session_id: "conv-9",
        pid: live,
        parent_session_id: "aaaa1111",
      }),
    );
    // a picked-up root whose child a live process runs unsuspended
    await st.write(
      "cccc3333",
      session("cccc3333", { suspended_at: AT, claude_session_id: "conv-9", pid: dead }),
    );
    await st.write(
      "dddd4444",
      session("dddd4444", {
        claude_session_id: "conv-9",
        pid: live,
        parent_session_id: "cccc3333",
      }),
    );

    const text = await pickupReport(st, "conv-9", process.pid, AT);

    expect(st.read("bbbb2222")!.context.claude_code_pid).toBe(live);
    expect(st.read("bbbb2222")!.suspended_at).toBe(AT);
    expect(st.read("cccc3333")!.context.claude_code_pid).toBe(process.pid);
    expect(st.read("dddd4444")!.context.claude_code_pid).toBe(live);
    expect(text).toContain("picked up: cccc3333");
    expect(text).not.toContain("bbbb2222");
    expect(text).not.toContain("dddd4444");
  });

  it("active lists this process's active sessions as a tree, nothing else", async () => {
    const st = storage();
    const me = process.pid;
    await st.write(
      "aaaa1111",
      session("aaaa1111", {
        pid: me,
        stack: [
          { workflow: "batch", current_state: "collect", state_visits: {}, total_transitions: 0 },
        ],
      }),
    );
    await st.write(
      "bbbb2222",
      session("bbbb2222", { pid: me, parent_session_id: "aaaa1111", agent_id: "agent-7" }),
    );
    await st.write("cccc3333", session("cccc3333", { pid: me, suspended_at: AT }));
    await st.write("dddd4444", session("dddd4444", { pid: process.ppid }));
    await st.write("eeee5555", session("eeee5555", { pid: me, stack: [] }));

    const text = activeReport(st, me);
    expect(text.split("\n").slice(1, 3)).toEqual([
      "  aaaa1111: batch @ collect",
      "    ↳ bbbb2222: w @ s [agent agent-7]",
    ]);
    for (const id of ["cccc3333", "dddd4444", "eeee5555"]) expect(text).not.toContain(id);
    expect(activeReport(st, process.ppid)).toContain("dddd4444");
    expect(activeReport(st, 2)).toBe("");
  });
});
