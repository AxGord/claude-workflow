import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "./engine.js";
import { Executor, bootTimeMs } from "./executor.js";
import { isGroupAlive } from "./process.js";
import { formatResume, registerTools } from "./tools.js";
import { projectRoot } from "./pool.js";
import { pickUpConversation } from "./takeover.js";
import { InMemoryStorage, createTestLoader, cleanupDir, SIMPLE_WORKFLOW } from "./test-helpers.js";
import type { DetachedRun, SessionState } from "./types.js";

async function deadPid(): Promise<number> {
  const child = spawn("true");
  await new Promise(r => child.on("exit", r));
  return child.pid!;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A live process group that is none of the engine's business. */
function foreignGroup(): number {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid!;
}

describe("suspend / resume", () => {
  const dirs: string[] = [];
  const tmp = (prefix: string) => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) cleanupDir(d);
  });

  function mount(workflows: Record<string, object>, stateDir?: string) {
    const storage = new InMemoryStorage();
    const result = createTestLoader(workflows);
    dirs.push(result.dir);
    const runDir = tmp("wf-runs-");
    const engine = new Engine(
      storage,
      result.loader,
      new Executor(undefined, runDir),
      stateDir ? { stateDir } : {},
    );
    /** A second server over the same state: what `claude --resume` starts. */
    const restart = () =>
      new Engine(
        storage,
        result.loader,
        new Executor(undefined, runDir),
        stateDir ? { stateDir } : {},
      );
    return { storage, engine, restart, loader: result.loader, runDir };
  }

  /** As the old process that owned the session had exited. */
  async function orphan(storage: InMemoryStorage, ids: string[]): Promise<void> {
    const pid = await deadPid();
    for (const id of ids) {
      const s = storage.read(id)!;
      await storage.write(id, { ...s, context: { ...s.context, claude_code_pid: pid } });
    }
  }

  it("the startup reaper suspends a dead process's sessions (stack, children kept, no ledger); past the TTL it abandons them", async () => {
    const { storage, engine } = mount({ simple: SIMPLE_WORKFLOW });
    const root = await engine.start("simple");
    const child = await engine.start("simple", undefined, root.sessionId);
    await orphan(storage, [root.sessionId, child.sessionId]);

    const now = Date.now();
    expect(await engine.reapOrphanedSessions(now)).toEqual({
      suspended: [root.sessionId, child.sessionId],
      expired: [],
    });
    for (const id of [root.sessionId, child.sessionId]) {
      const s = storage.read(id)!;
      expect(s.suspended_at).toBeDefined();
      expect(s.stack).toHaveLength(1);
      expect(s.outcome).toBeUndefined();
      expect(s.history.at(-1)!.event).toBe("suspend");
    }
    expect(storage.ledger).toEqual([]);

    expect(await engine.reapOrphanedSessions(now + 6 * DAY_MS)).toEqual({
      suspended: [],
      expired: [],
    });
    const later = await engine.reapOrphanedSessions(now + 7 * DAY_MS + 1);
    expect(later.expired).toContain(root.sessionId);
    expect(storage.read(root.sessionId)!.outcome).toBe("abandoned");
    expect(storage.read(child.sessionId)!.outcome).toBe("abandoned");
    expect(storage.read(root.sessionId)!.history.at(-1)!.event).toBe("expire");
    expect(storage.ledger.map(l => (l as { session_id: string }).session_id).sort()).toEqual(
      [root.sessionId, child.sessionId].sort(),
    );
  });

  it("the startup reaper leaves a session the resume hook handed to a live process after the reaper read it", async () => {
    const { storage, engine } = mount({ simple: SIMPLE_WORKFLOW });
    const { sessionId } = await engine.start("simple");
    await orphan(storage, [sessionId]);
    const update = storage.update.bind(storage);
    storage.update = async (id, change) => {
      const s = storage.read(id)!;
      await storage.write(id, { ...s, context: { ...s.context, claude_code_pid: process.ppid } });
      return update(id, change);
    };
    expect((await engine.reapOrphanedSessions()).suspended).toEqual([]);
    expect(storage.read(sessionId)!.suspended_at).toBeUndefined();
  });

  it("start records the conversation id the SessionStart hook wrote for this process", async () => {
    const stateDir = tmp("wf-state-");
    fs.writeFileSync(path.join(stateDir, `claude-session-${process.ppid}`), "conv-123\n");
    const { storage, engine } = mount({ simple: SIMPLE_WORKFLOW }, stateDir);
    const { sessionId } = await engine.start("simple");
    expect(storage.read(sessionId)!.claude_session_id).toBe("conv-123");
  });

  it("resume hands the session and its sub-tree to this process; the children stay suspended until their agents resume them", async () => {
    const { storage, engine, restart } = mount({ simple: SIMPLE_WORKFLOW });
    const root = await engine.start("simple");
    const child = await engine.start("simple", undefined, root.sessionId);
    await engine.linkAgent(child.sessionId, "agent-7");
    await orphan(storage, [root.sessionId, child.sessionId]);
    await engine.reapOrphanedSessions();

    const next = restart();
    expect(() => next.assertNotSuspended(root.sessionId)).toThrow(/suspended.*resume/);
    const r = await next.resume(root.sessionId);
    expect(r.status.currentStateName).toBe("start");
    const resumed = storage.read(root.sessionId)!;
    expect(resumed.suspended_at).toBeUndefined();
    expect(resumed.context.claude_code_pid).toBe(process.ppid);
    expect(resumed.history.at(-1)!.event).toBe("resume");
    expect(r.suspendedChildren.map(c => c.session_id)).toEqual([child.sessionId]);
    expect(storage.read(child.sessionId)!.context.claude_code_pid).toBe(process.ppid);
    expect(storage.read(child.sessionId)!.suspended_at).toBeDefined();

    const text = formatResume(r);
    expect(text).toContain(`agent-7 → ${child.sessionId} → simple @ start`);
    expect(text).toContain(
      `SendMessage({ to: "agent-7", message: "Continue: call mcp__plugin_workflow_wf__resume({ session_id: '${child.sessionId}' })`,
    );

    // the agent continues its own session
    await next.resume(child.sessionId);
    expect(storage.read(child.sessionId)!.suspended_at).toBeUndefined();
    await next.transition(child.sessionId, "next");
    expect(storage.read(child.sessionId)!.outcome).toBe("completed");
  });

  it("resume refuses a session another live process owns, and an ended one", async () => {
    const { storage, engine } = mount({ simple: SIMPLE_WORKFLOW });
    const { sessionId } = await engine.start("simple");
    const s = storage.read(sessionId)!;
    await storage.write(sessionId, {
      ...s,
      context: { ...s.context, claude_code_pid: process.pid },
    });
    await expect(engine.resume(sessionId)).rejects.toThrow(/active in PID/);
    await storage.write(sessionId, s);
    await engine.transition(sessionId, "next");
    await expect(engine.resume(sessionId)).rejects.toThrow(/has ended/);
  });

  it("listSuspended filters by the project (git root) of the session cwd", async () => {
    const { storage, engine } = mount({ simple: SIMPLE_WORKFLOW });
    const a = tmp("wf-proj-a-");
    const b = tmp("wf-proj-b-");
    const sa = await engine.start("simple", undefined, "p1", a);
    const sb = await engine.start("simple", undefined, "p2", b);
    await engine.suspend(sa.sessionId);
    await engine.suspend(sb.sessionId);
    expect(engine.listSuspended(projectRoot(a)).map(s => s.session_id)).toEqual([sa.sessionId]);
    expect(
      engine
        .listSuspended()
        .map(s => s.session_id)
        .sort(),
    ).toEqual([sa.sessionId, sb.sessionId].sort());
    expect(storage.read(sa.sessionId)!.stack).toHaveLength(1);
  });

  it("the transition tool refuses a suspended session and names resume", async () => {
    const { storage, engine, loader } = mount({ simple: SIMPLE_WORKFLOW });
    const handlers = new Map<
      string,
      (args: object) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
    >();
    const server = {
      registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h),
    };
    registerTools(server as never, engine, {} as never, loader, storage);
    const { sessionId } = await engine.start("simple");
    await engine.suspend(sessionId);
    const r = await handlers.get("transition")!({ session_id: sessionId, transition: "next" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(`resume({ session_id: "${sessionId}" })`);
    const ok = await handlers.get("resume")!({ session_id: sessionId });
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0].text).toContain(`RESUMED: ${sessionId}`);
    expect(
      (await handlers.get("transition")!({ session_id: sessionId, transition: "next" })).isError,
    ).toBeUndefined();
  });

  it("link_agent during an exec survives the exec's routed write", async () => {
    const { storage, engine } = mount({
      w: {
        initial: "start",
        states: {
          start: { prompt: "go", transitions: { next: "run" } },
          run: { type: "exec", command: "sleep 0.4", on_success: "end_ok", on_error: "end_ok" },
          end_ok: { prompt: "ok", transitions: { done: "end" } },
          end: { terminal: true, outcome: "complete" },
        },
      },
    });
    const { sessionId } = await engine.start("w");
    const pending = engine.transition(sessionId, "next");
    for (let i = 0; i < 100 && !storage.read(sessionId)!.running_exec; i++)
      await new Promise(r => setTimeout(r, 10));
    await engine.linkAgent(sessionId, "agent-x");
    await pending;
    expect(storage.read(sessionId)!.agent_id).toBe("agent-x");
  });

  it("abort of a suspended session spares the recorded pgid once its exit code is written (the pid may be reused)", async () => {
    const work = tmp("wf-reuse-");
    const { storage, engine } = mount({ simple: SIMPLE_WORKFLOW });
    const { sessionId } = await engine.start("simple");
    const pgid = foreignGroup();
    try {
      const rc = path.join(work, "rc");
      fs.writeFileSync(rc, "0\n");
      const s = storage.read(sessionId)!;
      await storage.write(sessionId, {
        ...s,
        suspended_at: new Date().toISOString(),
        running_exec: {
          pgid,
          out: path.join(work, "o"),
          err: path.join(work, "e"),
          rc,
          started_at: new Date().toISOString(),
          boot_ms: bootTimeMs(),
          frame: 0,
          state: "start",
        },
      });
      await engine.abort(sessionId);
      await new Promise(r => setTimeout(r, 300)); // a signalled child is reaped by now
      expect(isGroupAlive(pgid)).toBe(true);
      expect(fs.existsSync(rc)).toBe(false);
    } finally {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  });

  it("a result that cannot be routed drops the run's files and record", async () => {
    const m = mount({
      w: {
        initial: "start",
        max_transitions: 1,
        states: {
          start: { prompt: "go", transitions: { next: "run" } },
          run: { type: "exec", command: "true", on_success: "end", on_error: "end" },
          end: { terminal: true, outcome: "complete" },
        },
      },
    });
    const { sessionId } = await m.engine.start("w");
    await expect(m.engine.transition(sessionId, "next")).rejects.toThrow(/Max transitions/);
    expect(m.storage.read(sessionId)!.running_exec).toBeUndefined();
    expect(fs.readdirSync(m.runDir)).toEqual([]);
  });

  it("server start removes day-old run files no session references, and keeps referenced ones", async () => {
    const m = mount({ simple: SIMPLE_WORKFLOW });
    const { sessionId } = await m.engine.start("simple");
    const file = (n: string) => path.join(m.runDir, n);
    for (const n of ["old.out", "kept.out", "kept.err", "kept.rc", "new.out"])
      fs.writeFileSync(file(n), "");
    const old = new Date(Date.now() - 2 * DAY_MS);
    for (const n of ["old.out", "kept.out", "kept.err", "kept.rc"])
      fs.utimesSync(file(n), old, old);
    const s = m.storage.read(sessionId)!;
    await m.storage.write(sessionId, {
      ...s,
      running_exec: {
        pgid: 999_999,
        out: file("kept.out"),
        err: file("kept.err"),
        rc: file("kept.rc"),
        started_at: old.toISOString(),
        boot_ms: 0,
        frame: 0,
        state: "start",
      },
    });
    await m.engine.reapOrphanedSessions();
    expect(fs.readdirSync(m.runDir).sort()).toEqual(["kept.err", "kept.out", "kept.rc", "new.out"]);
  });

  describe("an exec in flight when the process exited", () => {
    const gate = (command: string, timeout = 20_000) => ({
      initial: "start",
      states: {
        start: { prompt: "go", transitions: { next: "gate" } },
        gate: {
          type: "exec",
          command,
          timeout,
          cases: { "0": "green", "3": "red" },
          default: "red",
        },
        green: { prompt: "GREEN {{stdout}}", transitions: { done: "end" } },
        red: { prompt: "RED {{exit_code}}", transitions: { done: "end" } },
        end: { terminal: true, outcome: "complete" },
      },
    });

    /** Start the gate under an owner that is "gone", wait for its run record, suspend it as SessionEnd would. */
    async function startGate(m: ReturnType<typeof mount>) {
      const { sessionId } = await m.engine.start("w");
      await orphan(m.storage, [sessionId]);
      const first = m.engine.transition(sessionId, "next").catch((e: Error) => e);
      for (let i = 0; i < 200 && !m.storage.read(sessionId)!.running_exec; i++)
        await new Promise(r => setTimeout(r, 10));
      const run = m.storage.read(sessionId)!.running_exec!;
      expect(run).toMatchObject({ state: "gate", frame: 0 });
      await m.engine.suspend(sessionId);
      return { sessionId, first, run };
    }

    it("still running: resume waits for it and routes its result", async () => {
      const m = mount({ w: gate("sleep 0.6; echo done") });
      const { sessionId, first } = await startGate(m);
      const r = await m.restart().resume(sessionId);
      expect(r.status.currentStateName).toBe("green");
      expect(r.status.prompt).toContain("GREEN done");
      const s = m.storage.read(sessionId)!;
      expect(s.running_exec).toBeUndefined();
      expect((await first) as Error).toBeInstanceOf(Error);
      expect(fs.readdirSync(m.runDir)).toEqual([]);
    });

    it("finished while nobody owned the session: resume takes the recorded exit code and output", async () => {
      const m = mount({ w: gate("sleep 0.5; echo out; exit 3") });
      const { sessionId, first, run } = await startGate(m);
      expect(((await first) as Error).message).toMatch(/suspended while its action state ran/);
      expect(fs.readFileSync(run.rc, "utf8").trim()).toBe("3");
      const r = await m.restart().resume(sessionId);
      expect(r.status.currentStateName).toBe("red");
      expect(r.status.prompt).toContain("RED 3");
      expect(m.storage.read(sessionId)!.last_action_result!.stdout).toContain("out");
    });

    function tools(
      engine: Engine,
      storage: InMemoryStorage,
      loader: ReturnType<typeof mount>["loader"],
    ) {
      const handlers = new Map<
        string,
        (args: object) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
      >();
      const server = {
        registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h),
      };
      registerTools(server as never, engine, {} as never, loader, storage);
      return (name: string, args: object) => handlers.get(name)!(args);
    }

    /** What the SessionStart hook of `claude --resume` does: pick the conversation's sessions up for this process. */
    async function pickUp(m: ReturnType<typeof mount>, sessionId: string): Promise<void> {
      const s = m.storage.read(sessionId)!;
      await m.storage.write(sessionId, { ...s, claude_session_id: "conv-1" });
      const roots = await pickUpConversation(
        m.storage,
        "conv-1",
        process.ppid,
        new Date().toISOString(),
      );
      expect(roots.map(r => r.session_id)).toEqual([sessionId]);
    }

    it("picked up by the hook: the first status() takes the exec over and routes it, once", async () => {
      const m = mount({ w: gate("sleep 0.6; echo done") });
      const { sessionId, first } = await startGate(m);
      await pickUp(m, sessionId);
      const next = m.restart();
      expect(next.hasOrphanedExec(sessionId)).toBe(true);
      const call = tools(next, m.storage, m.loader);
      const r = await call("status", { session_id: sessionId });
      expect(r.content[0].text).toContain("EXEC IN FLIGHT TAKEN OVER");
      expect(r.content[0].text).toContain("GREEN done");
      expect(m.storage.read(sessionId)!.running_exec).toBeUndefined();
      expect(next.hasOrphanedExec(sessionId)).toBe(false);
      const again = await call("status", { session_id: sessionId });
      expect(again.content[0].text).not.toContain("TAKEN OVER");
      expect((await first) as Error).toBeInstanceOf(Error);
    });

    it("picked up by the hook: a transition() first finishes the exec and is not taken", async () => {
      const m = mount({ w: gate("sleep 0.5; echo out; exit 3") });
      const { sessionId, first } = await startGate(m);
      await first;
      await pickUp(m, sessionId);
      const call = tools(m.restart(), m.storage, m.loader);
      const r = await call("transition", { session_id: sessionId, transition: "done" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("RED 3");
      expect(r.content[0].text).toContain('Transition "done" was NOT taken');
      expect(m.storage.read(sessionId)!.stack[0].current_state).toBe("red");
    });

    it("no orphan: an exec another live process runs, or a suspended session's", async () => {
      const m = mount({ w: gate("true") });
      const { sessionId } = await m.engine.start("w");
      const s = m.storage.read(sessionId)!;
      const stuck = (pid: number, suspended_at?: string): SessionState => ({
        ...s,
        stack: [{ ...s.stack[0], current_state: "gate" }],
        context: { ...s.context, claude_code_pid: pid },
        running_exec: {
          pgid: 999_999,
          out: "/x/o",
          err: "/x/e",
          rc: "/x/rc",
          started_at: "",
          boot_ms: 0,
          frame: 0,
          state: "gate",
        },
        ...(suspended_at ? { suspended_at } : {}),
      });
      await m.storage.write(sessionId, stuck(process.pid));
      expect(m.engine.hasOrphanedExec(sessionId)).toBe(false);
      await m.storage.write(sessionId, stuck(process.ppid, new Date().toISOString()));
      expect(m.engine.hasOrphanedExec(sessionId)).toBe(false);
      await m.storage.write(sessionId, stuck(process.ppid));
      expect(m.engine.hasOrphanedExec(sessionId)).toBe(true);
    });

    it("a chain that threw (suspended mid-exec) leaves no in-flight mark: picked up again, its exec is an orphan", async () => {
      const m = mount({ w: gate("sleep 0.3") });
      const { sessionId } = await m.engine.start("w");
      const pending = m.engine.transition(sessionId, "next").catch((e: Error) => e);
      for (let i = 0; i < 200 && !m.storage.read(sessionId)!.running_exec; i++)
        await new Promise(r => setTimeout(r, 10));
      await m.engine.suspend(sessionId);
      expect(((await pending) as Error).message).toMatch(/suspended while its action state ran/);
      await pickUp(m, sessionId);
      expect(m.engine.hasOrphanedExec(sessionId)).toBe(true);
    });

    it("this server's own exec is never taken for an orphan", async () => {
      const m = mount({ w: gate("sleep 0.4") });
      const { sessionId } = await m.engine.start("w");
      const pending = m.engine.transition(sessionId, "next");
      for (let i = 0; i < 200 && !m.storage.read(sessionId)!.running_exec; i++)
        await new Promise(r => setTimeout(r, 10));
      expect(m.storage.read(sessionId)!.running_exec).toBeDefined();
      expect(m.engine.hasOrphanedExec(sessionId)).toBe(false);
      expect((await pending).currentStateName).toBe("green");
    });

    it("neither process nor result (the machine rebooted): resume runs the step again", async () => {
      const work = tmp("wf-rerun-");
      const counter = path.join(work, "runs");
      const m = mount({ w: gate(`echo x >> "${counter}"; exit 0`) });
      const { sessionId } = await m.engine.start("w");
      // the state as SessionEnd left it on a machine that then rebooted
      const s = m.storage.read(sessionId)!;
      const lost: DetachedRun = {
        pgid: 999_999,
        out: path.join(work, "o"),
        err: path.join(work, "e"),
        rc: path.join(work, "rc"),
        started_at: new Date().toISOString(),
        boot_ms: 0,
      };
      const stuck: SessionState = {
        ...s,
        stack: [{ ...s.stack[0], current_state: "gate" }],
        running_exec: { ...lost, frame: 0, state: "gate" },
        suspended_at: new Date().toISOString(),
      };
      await m.storage.write(sessionId, stuck);
      const r = await m.restart().resume(sessionId);
      expect(r.status.currentStateName).toBe("green");
      expect(fs.readFileSync(counter, "utf8")).toBe("x\n");
    });
  });
});

describe("Executor detached runs", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) cleanupDir(d);
  });

  it("a foreground exec writes to files, not pipes to the server, so the server's exit cannot break them", async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-runs-"));
    dirs.push(runDir);
    const executor = new Executor(undefined, runDir);
    // a pipe (or the socketpair node uses for stdio "pipe") breaks when the server dies; a file does not
    const r = await executor.execute(
      {
        type: "exec",
        command:
          "[ -f /dev/stdout ] && echo file || echo stream; [ -f /dev/stderr ] && echo file >&2 || echo stream >&2",
      },
      {},
    );
    expect(r.stdout!.trim()).toBe("file");
    expect(r.stderr!.trim()).toBe("file");
    expect(fs.readdirSync(runDir)).toEqual([]);
  });

  it("onDetached gets the run's group and files, which outlive the result for the caller", async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-runs-"));
    dirs.push(runDir);
    const executor = new Executor(undefined, runDir);
    let run: DetachedRun | undefined;
    const r = await executor.execute(
      { type: "exec", command: "echo hi; exit 4" },
      {},
      {
        sessionId: "s",
        rootSessionId: "s",
        onDetached: async d => {
          run = d;
        },
      },
    );
    expect(r.exit_code).toBe(4);
    expect(r.stdout).toBe("hi\n");
    expect(run!.pgid).toBeGreaterThan(1);
    expect(fs.readFileSync(run!.rc, "utf8").trim()).toBe("4");
    const again = await new Executor(undefined, runDir).adopt(run!, {
      type: "exec",
      command: "unused",
    });
    expect(again).toMatchObject({ exit_code: 4, stdout: "hi\n", success: false });
    Executor.discardRun(run!);
    expect(fs.readdirSync(runDir)).toEqual([]);
  });

  it("adopt kills a taken-over run past its timeout (counted from its start) and reports 124", async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-runs-"));
    dirs.push(runDir);
    const executor = new Executor(undefined, runDir);
    let run: DetachedRun | undefined;
    const pending = executor.execute(
      { type: "exec", command: "sleep 30", timeout: 60_000 },
      {},
      {
        sessionId: "s",
        rootSessionId: "s",
        onDetached: async d => {
          run = d;
        },
      },
    );
    for (let i = 0; i < 100 && !run; i++) await new Promise(r => setTimeout(r, 10));
    const r = await new Executor(undefined, runDir).adopt(run!, {
      type: "exec",
      command: "sleep 30",
      timeout: 300,
    });
    expect(r).toMatchObject({ exit_code: 124, error: "Process timed out" });
    await pending;
  });

  it("a timed-out command that ignores SIGTERM is SIGKILLed after the grace, before the step resolves", async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-runs-"));
    dirs.push(runDir);
    let run: DetachedRun | undefined;
    const r = await new Executor(undefined, runDir).execute(
      { type: "exec", command: "trap '' TERM; sleep 30", timeout: 300 },
      {},
      {
        sessionId: "s",
        rootSessionId: "s",
        onDetached: async d => {
          run = d;
        },
      },
    );
    expect(r.exit_code).toBe(124);
    const alive = isGroupAlive(run!.pgid);
    if (alive) process.kill(-run!.pgid, "SIGKILL");
    expect(alive).toBe(false);
  }, 15_000);

  it("a run that fails to spawn leaves no files, even with a caller that would own them", async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-runs-"));
    dirs.push(runDir);
    const r = await new Executor(undefined, runDir).execute(
      { type: "exec", command: "true", cwd: path.join(runDir, "missing") },
      {},
      {
        sessionId: "s",
        rootSessionId: "s",
        onDetached: async () => {},
      },
    );
    expect(r.success).toBe(false);
    expect(fs.readdirSync(runDir)).toEqual([]);
  });

  it("adopt does not wait for a live pgid recorded under another boot: the step runs again", async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-runs-"));
    dirs.push(runDir);
    const pgid = foreignGroup();
    try {
      const run: DetachedRun = {
        pgid,
        out: path.join(runDir, "o"),
        err: path.join(runDir, "e"),
        rc: path.join(runDir, "rc"),
        started_at: new Date().toISOString(),
        boot_ms: bootTimeMs() - 3 * DAY_MS,
      };
      expect(
        await new Executor(undefined, runDir).adopt(run, {
          type: "exec",
          command: "x",
          timeout: 200,
        }),
      ).toBeNull();
      expect(isGroupAlive(pgid)).toBe(true);
    } finally {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  });

  it("the run dir is owner-only", async () => {
    const runDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wf-runs-")), "exec");
    dirs.push(path.dirname(runDir));
    await new Executor(undefined, runDir).execute({ type: "exec", command: "true" }, {});
    expect(fs.statSync(runDir).mode & 0o777).toBe(0o700);
  });
});
