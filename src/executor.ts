import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StateDefinition, ActionResult } from "./types.js";
import { render } from "./template.js";

const DEFAULT_MAX_OUTPUT = 10 * 1024; // 10KB truncation limit
const DEFAULT_EXEC_TIMEOUT = 30_000;
const DEFAULT_FETCH_TIMEOUT = 5_000;
const SIGKILL_GRACE_MS = 5_000;
const EXIT_CODE_TIMEOUT = 124;
const TRIM_TRIGGER_FACTOR = 4;
const TRIM_TARGET_FACTOR = 2;

function truncate(s: string, limit: number = DEFAULT_MAX_OUTPUT): string {
  if (s.length <= limit) return s;
  return "...[truncated]\n" + s.slice(-limit);
}

export class Executor {
  async execute(state: StateDefinition, vars: Record<string, unknown>): Promise<ActionResult> {
    if (state.type === "exec") {
      if (state.background) return this._execBackground(state, vars);
      return this._exec(state, vars);
    }
    if (state.type === "fetch") {
      return this._fetch(state, vars);
    }
    throw new Error(`Unknown action type: ${state.type}`);
  }

  private _exec(state: StateDefinition, vars: Record<string, unknown>): Promise<ActionResult> {
    const command = render(state.command!, vars);
    const cwd = state.cwd ? render(state.cwd, vars) : undefined;
    const timeout = state.timeout ?? DEFAULT_EXEC_TIMEOUT;
    const maxOutput = state.max_output ?? DEFAULT_MAX_OUTPUT;

    const envVars = state.env
      ? Object.fromEntries(Object.entries(state.env).map(([k, v]) => [k, render(v, vars)]))
      : undefined;

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;

      const child = spawn("sh", ["-c", command], {
        cwd,
        env: envVars ? { ...process.env, ...envVars } : undefined,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      const killGroup = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.kill(-child.pid, signal); } catch {}
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

  private _execBackground(state: StateDefinition, vars: Record<string, unknown>): Promise<ActionResult> {
    const command = render(state.command!, vars);
    const cwd = state.cwd ? render(state.cwd, vars) : undefined;

    const envVars = state.env
      ? Object.fromEntries(Object.entries(state.env).map(([k, v]) => [k, render(v, vars)]))
      : undefined;

    const logFile = path.join(os.tmpdir(), `wf-bg-${Date.now()}.log`);
    const out = fs.openSync(logFile, "a");

    let child;
    try {
      child = spawn("sh", ["-c", command], {
        cwd,
        env: envVars ? { ...process.env, ...envVars } : undefined,
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
