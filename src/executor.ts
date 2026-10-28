import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StateDefinition, ActionResult } from "./types.js";
import { render } from "./template.js";

// Plugin root (the dir holding templates/ and scripts/) — injected into every
// exec's env so templates can reference bundled scripts portably:
// command: "sh \"$WF_PLUGIN_ROOT/scripts/foo.sh\"". Works out of the box on
// any install path; no per-machine script installation.
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_MAX_OUTPUT = 10 * 1024; // 10KB truncation limit
const DEFAULT_EXEC_TIMEOUT = 30_000;
const DEFAULT_FETCH_TIMEOUT = 5_000;
const SIGKILL_GRACE_MS = 5_000;
const EXIT_CODE_TIMEOUT = 124;
const TRIM_TRIGGER_FACTOR = 4;
const TRIM_TARGET_FACTOR = 2;

/**
 * Who an exec runs for: the engine-injected identity env and the session's
 * working directory (a sub-agent's worktree, not the server's cwd).
 */
export interface ExecContext {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly rootSessionId: string;
  readonly cwd?: string;
}

/**
 * Signal a whole process group: every exec spawns detached (its own group),
 * so `sh -c` and everything it started die together. Falls back to the bare
 * pid for a process that is not a group leader.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  // pids come from session JSON: kill(-1) would signal every process of the
  // user, kill(0) / kill(-0) the server's own group.
  if (!Number.isInteger(pid) || pid <= 1) return;
  try { process.kill(-pid, signal); return; } catch { /* not a group leader, or gone */ }
  try { process.kill(pid, signal); } catch { /* already dead */ }
}

function truncate(s: string, limit: number = DEFAULT_MAX_OUTPUT): string {
  if (s.length <= limit) return s;
  return "...[truncated]\n" + s.slice(-limit);
}

export class Executor {
  // Foreground exec groups still running, per session — abort kills them.
  private readonly _running = new Map<string, Set<number>>();

  async execute(state: StateDefinition, vars: Record<string, unknown>, ctx?: ExecContext): Promise<ActionResult> {
    const started = performance.now();
    let result: ActionResult;
    if (state.type === "exec") {
      result = state.background ? await this._execBackground(state, vars, ctx) : await this._exec(state, vars, ctx);
    } else if (state.type === "fetch") {
      result = await this._fetch(state, vars);
    } else {
      throw new Error(`Unknown action type: ${state.type}`);
    }
    return { ...result, duration_ms: Math.round(performance.now() - started) };
  }

  /** Kill every foreground exec group still running for the session. */
  killSession(sessionId: string): void {
    const pids = this._running.get(sessionId);
    if (!pids) return;
    for (const pid of pids) killProcessGroup(pid);
    this._running.delete(sessionId);
  }

  private _track(sessionId: string | undefined, pid: number | undefined, add: boolean): void {
    if (!sessionId || !pid) return;
    let pids = this._running.get(sessionId);
    if (add) {
      if (!pids) this._running.set(sessionId, pids = new Set());
      pids.add(pid);
    } else if (pids) {
      pids.delete(pid);
      if (pids.size === 0) this._running.delete(sessionId);
    }
  }

  /** A state's cwd resolves against the session's; no state cwd runs in the session's. */
  private _cwd(state: StateDefinition, vars: Record<string, unknown>, ctx?: ExecContext): string | undefined {
    if (!state.cwd) return ctx?.cwd;
    const own = render(state.cwd, vars);
    return ctx?.cwd ? path.resolve(ctx.cwd, own) : own;
  }

  /**
   * Spawn env for exec states: process env + injected WF_PLUGIN_ROOT and the
   * session ids (WF_SESSION_ID, WF_PARENT_SESSION_ID — empty at the root,
   * WF_ROOT_SESSION_ID), overridable by the state's own rendered env: entries.
   * Single source for both foreground and background spawns so the injection
   * contract can't drift.
   */
  private _buildEnv(state: StateDefinition, vars: Record<string, unknown>, ctx?: ExecContext): NodeJS.ProcessEnv {
    const envVars = state.env
      ? Object.fromEntries(Object.entries(state.env).map(([k, v]) => [k, render(v, vars)]))
      : undefined;
    const ids = ctx
      ? {
          WF_SESSION_ID: ctx.sessionId,
          WF_PARENT_SESSION_ID: ctx.parentSessionId ?? "",
          WF_ROOT_SESSION_ID: ctx.rootSessionId,
        }
      : undefined;
    return { ...process.env, WF_PLUGIN_ROOT: PLUGIN_ROOT, ...ids, ...envVars };
  }

  private _exec(state: StateDefinition, vars: Record<string, unknown>, ctx?: ExecContext): Promise<ActionResult> {
    const command = render(state.command!, vars);
    const cwd = this._cwd(state, vars, ctx);
    const timeout = state.timeout ?? DEFAULT_EXEC_TIMEOUT;
    const maxOutput = state.max_output ?? DEFAULT_MAX_OUTPUT;

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;

      const child = spawn("sh", ["-c", command], {
        cwd,
        env: this._buildEnv(state, vars, ctx),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      this._track(ctx?.sessionId, child.pid, true);

      const killGroup = (signal: NodeJS.Signals) => {
        if (child.pid) killProcessGroup(child.pid, signal);
      };

      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        killed = true;
        killGroup("SIGTERM");
        sigkillTimer = setTimeout(() => killGroup("SIGKILL"), SIGKILL_GRACE_MS);
      }, timeout);

      // Keep only the tail — no memory explosion on large output
      const accumulate = (buf: string, chunk: Buffer): string => {
        buf += chunk.toString();
        return buf.length > maxOutput * TRIM_TRIGGER_FACTOR ? buf.slice(-maxOutput * TRIM_TARGET_FACTOR) : buf;
      };
      child.stdout!.on("data", (chunk: Buffer) => { stdout = accumulate(stdout, chunk); });
      child.stderr!.on("data", (chunk: Buffer) => { stderr = accumulate(stderr, chunk); });

      child.on("close", (code: number | null) => {
        this._track(ctx?.sessionId, child.pid, false);
        clearTimeout(timer);
        clearTimeout(sigkillTimer);
        const exit_code = killed ? EXIT_CODE_TIMEOUT : (code ?? 1);
        resolve({
          type: "exec",
          success: exit_code === 0,
          stdout: truncate(stdout, maxOutput),
          stderr: truncate(stderr, maxOutput),
          exit_code,
          error: killed ? "Process timed out" : (exit_code !== 0 ? `Exit code ${exit_code}` : undefined),
        });
      });

      child.on("error", (err) => {
        this._track(ctx?.sessionId, child.pid, false);
        clearTimeout(timer);
        clearTimeout(sigkillTimer);
        resolve({
          type: "exec",
          success: false,
          stdout: truncate(stdout, maxOutput),
          stderr: truncate(stderr, maxOutput),
          exit_code: 1,
          error: err.message,
        });
      });
    });
  }

  private _execBackground(state: StateDefinition, vars: Record<string, unknown>, ctx?: ExecContext): Promise<ActionResult> {
    const command = render(state.command!, vars);
    const cwd = this._cwd(state, vars, ctx);

    const logFile = path.join(os.tmpdir(), `wf-bg-${Date.now()}.log`);
    const out = fs.openSync(logFile, "a");

    let child;
    try {
      child = spawn("sh", ["-c", command], {
        cwd,
        env: this._buildEnv(state, vars, ctx),
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.unref();
    } finally {
      fs.closeSync(out);
    }

    if (!child.pid) {
      return Promise.resolve({
        type: "exec",
        success: false,
        error: "Failed to start background process",
      });
    }

    return Promise.resolve({
      type: "exec",
      success: true,
      pid: child.pid,
      stdout: `Background process started (PID ${child.pid}), log: ${logFile}`,
    });
  }

  private async _fetch(state: StateDefinition, vars: Record<string, unknown>): Promise<ActionResult> {
    const url = render(state.url!, vars);
    const method = state.method ?? "GET";
    const timeout = state.timeout ?? DEFAULT_FETCH_TIMEOUT;
    const headers = state.headers
      ? Object.fromEntries(Object.entries(state.headers).map(([k, v]) => [k, render(v, vars)]))
      : undefined;
    const body = state.body ? render(state.body, vars) : undefined;

    const maxRetries = state.retry?.max ?? 1;
    const retryInterval = state.retry?.interval ?? 1000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        const res = await fetch(url, {
          method,
          headers,
          body: method !== "GET" && method !== "HEAD" ? body : undefined,
          signal: controller.signal,
        });

        clearTimeout(timer);
        const resBody = truncate(await res.text());

        return {
          type: "fetch",
          success: res.ok,
          status: res.status,
          body: resBody,
          error: res.ok ? undefined : `HTTP ${res.status}`,
        };
      } catch (err) {
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, retryInterval));
          continue;
        }
        return {
          type: "fetch",
          success: false,
          error: (err as Error).message,
        };
      }
    }

    // Unreachable, but satisfies TS
    return { type: "fetch", success: false, error: "Max retries exceeded" };
  }
}
