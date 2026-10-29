import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StateDefinition, ActionResult, ShardResult, DetachedRun } from "./types.js";
import { DEFAULT_PRIORITY_LEVEL, RESOURCE_THREADS_BUDGET, type PriorityLevel } from "./types.js";
import { render } from "./template.js";
import { bootTimeMs, isGroupAlive, killProcessGroup, sameBoot } from "./process.js";
import {
  EX_TEMPFAIL,
  Pool,
  describeRequest,
  levelPriority,
  resolvePoolDir,
  starvationNotice,
} from "./pool.js";
import type { AcquireResult } from "./pool.js";
import type { ExecPhase } from "./progress.js";

// Plugin root (the dir holding templates/ and scripts/) — injected into every
// exec's env so templates can reference bundled scripts portably:
// command: "sh \"$WF_PLUGIN_ROOT/scripts/foo.sh\"". Works out of the box on
// any install path; no per-machine script installation.
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_MAX_OUTPUT = 10 * 1024; // 10KB truncation limit
const DEFAULT_EXEC_TIMEOUT = 30_000;
const DEFAULT_FETCH_TIMEOUT = 5_000;
const SIGKILL_GRACE_MS = 5_000;
/** The exit code of an exec killed by its `timeout` (`on_timeout` routes it). */
export const EXIT_CODE_TIMEOUT = 124;
const EXIT_CODE_ABORTED = 130;
const LEASE_LABEL_MAX = 80;
const ABORTED_WAIT = "aborted while waiting for a pool lease";
// items_command output is the shard list: never cut it to the usual tail
const ITEMS_MAX_OUTPUT = 1024 * 1024;
const TRUNCATED_MARK = "...[truncated]\n";
// the output tail a failed shard contributes to a fanout's summary
const SHARD_TAIL = 2_000;
// how often a taken-over exec is checked for its exit
const ADOPT_POLL_MS = 200;
// how often a timed-out group is checked for its death
const REAP_POLL_MS = 50;
// two boot-time readings closer than this are the same boot (clock adjustments)
// A starved wait is noticed within this long of crossing the pool's `starve_after`.
const STARVE_CHECK_MS = 10_000;
const NO_EXIT_CODE = "Process ended without writing its exit code (killed)";
// Runs the command ($1) in a child shell and writes its exit code to $2 when
// it ends, so a run whose server died still leaves its result behind.
const EXEC_WRAPPER =
  'sh -c "$1"; rc=$?; printf "%s\\n" "$rc" > "$2.tmp" && mv "$2.tmp" "$2"; exit $rc';

/** One instance of a `fanout:` exec: its id and the env that tells it which one it is. */
interface Shard {
  readonly id: string;
  readonly env: Record<string, string>;
}

/**
 * Who an exec runs for: the engine-injected identity env and the session's
 * working directory (a sub-agent's worktree, not the server's cwd).
 */
export interface ExecContext {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly rootSessionId: string;
  readonly cwd?: string;
  /** The session's priority level: a lease's priority is its value plus the step's `priority`. */
  readonly level?: PriorityLevel;
  /** The git root of the session cwd (the `project` of a lease and of its step key). */
  readonly project?: string;
  /** The running step, `workflow/state`. */
  readonly step?: string;
  /**
   * A plain or leased foreground exec reports its detached run here once it
   * started; the run's files then belong to the caller (`discardRun`).
   */
  readonly onDetached?: (run: DetachedRun) => Promise<void>;
  /** False once the session is no longer this server's to run: a granted lease is given back unused. */
  readonly mayStart?: () => boolean;
  /** Reports whether the exec is queued for a pool lease or running (progress heartbeat). */
  readonly onPhase?: (phase: ExecPhase) => void;
  /**
   * The exec's pool wait passed the pool's `starve_after` (what it waits for and what blocks it),
   * or — `undefined` — no wait of it is starved any more (granted, or given up).
   */
  readonly onStarved?: (notice: string | undefined) => void;
}

export { bootTimeMs, killProcessGroup };

function truncate(s: string, limit: number = DEFAULT_MAX_OUTPUT): string {
  if (s.length <= limit) return s;
  return TRUNCATED_MARK + s.slice(-limit);
}

export class Executor {
  // Foreground exec groups still running, per session — abort kills them.
  private readonly _running = new Map<string, Set<number>>();
  // Execs still queued for a pool lease, per session — abort withdraws them.
  private readonly _waiting = new Map<string, Set<AbortController>>();
  // Fanouts still starting shards, per session — abort stops the rest from starting.
  private readonly _fanouts = new Map<string, Set<AbortController>>();
  /** The machine-wide thread pool `resource:` execs lease from. */
  readonly pool: Pool;

  /** Where foreground execs write their output and exit code. */
  readonly runDir: string;

  /** How often a lease wait checks whether it is starved (`ExecContext.onStarved`). */
  readonly starveCheckMs: number;

  constructor(
    pool: Pool = new Pool(resolvePoolDir()),
    runDir: string = path.join(os.tmpdir(), "wf-exec"),
    starveCheckMs: number = STARVE_CHECK_MS,
  ) {
    this.pool = pool;
    this.runDir = runDir;
    this.starveCheckMs = starveCheckMs;
  }

  async execute(
    state: StateDefinition,
    vars: Record<string, unknown>,
    ctx?: ExecContext,
  ): Promise<ActionResult> {
    const started = performance.now();
    let result: ActionResult;
    if (state.type === "exec") {
      if (state.fanout) result = await this._execFanout(state, vars, ctx);
      else if (state.background) result = await this._execBackground(state, vars, ctx);
      else if (state.resource) result = await this._execLeased(state, vars, ctx);
      else result = await this._exec(state, vars, ctx, undefined, undefined, ctx?.onDetached);
    } else if (state.type === "fetch") {
      result = await this._fetch(state, vars);
    } else {
      throw new Error(`Unknown action type: ${state.type}`);
    }
    // duration_ms is the run; the wait for a lease is wait_ms beside it.
    return {
      ...result,
      duration_ms: Math.round(performance.now() - started) - (result.wait_ms ?? 0),
    };
  }

  /** Kill every foreground exec group still running for the session and withdraw its lease waits. */
  killSession(sessionId: string): void {
    for (const ac of this._fanouts.get(sessionId) ?? []) ac.abort();
    this._fanouts.delete(sessionId);
    for (const ac of this._waiting.get(sessionId) ?? []) ac.abort();
    this._waiting.delete(sessionId);
    const pids = this._running.get(sessionId);
    if (!pids) return;
    for (const pid of pids) killProcessGroup(pid);
    this._running.delete(sessionId);
  }

  /**
   * A lock name may name a session value (`"{{context.cwd}}-land"`); what it renders to stays one
   * word (whitespace becomes `_`), and one that renders empty keeps its template text.
   */
  private static _lockName(name: string, vars: Record<string, unknown>): string {
    const rendered = render(name, vars).replace(/\s+/g, "_");
    return rendered === "" ? name : rendered;
  }

  /**
   * An exec with `resource:` waits for a pool lease (the same admission as
   * `wf-run`), runs with `WF_THREADS` = the threads granted, and releases it.
   * No lease within `wait_timeout` exits 75. The lease's priority is the
   * session level's plus the step's own.
   */
  private async _execLeased(
    state: StateDefinition,
    vars: Record<string, unknown>,
    ctx?: ExecContext,
    shard?: Shard,
  ): Promise<ActionResult> {
    const resource = state.resource!;
    const budget = (n: number | typeof RESOURCE_THREADS_BUDGET): number =>
      n === RESOURCE_THREADS_BUDGET ? this.pool.config().budget : n;
    const asked = resource.threads;
    const flexible = typeof asked === "object" ? asked : undefined;
    const threads =
      typeof asked === "object" ? budget(asked.max) : asked === undefined ? 0 : budget(asked);
    // A max the budget clamps below the min still runs: the min clamps with it.
    const minThreads = flexible ? Math.min(flexible.min, threads) : undefined;
    const command = render(state.command!, vars);
    const locks = resource.locks?.map(l => Executor._lockName(l, vars));
    const ac = new AbortController();
    const sessionId = ctx?.sessionId ?? "";
    let waits = this._waiting.get(sessionId);
    if (!waits) this._waiting.set(sessionId, (waits = new Set()));
    waits.add(ac);
    let got: AcquireResult;
    let starved: string | undefined;
    ctx?.onPhase?.("lease");
    try {
      got = await this.pool.acquire(
        {
          threads,
          minThreads,
          waitFullMs:
            flexible && resource.wait_full !== undefined ? resource.wait_full * 1000 : undefined,
          locks,
          priority: Executor._priority(state, ctx),
          level: ctx?.level,
          label: (shard ? `[${shard.id}] ${command}` : command).slice(0, LEASE_LABEL_MAX),
          cwd: this._cwd(state, vars, ctx) ?? process.cwd(),
          project: ctx?.project,
          step: ctx?.step,
          sessionId,
        },
        {
          waitTimeoutMs:
            resource.wait_timeout === undefined ? undefined : resource.wait_timeout * 1000,
          signal: ac.signal,
          progressMs: this.starveCheckMs,
          onProgress: (self, view) => {
            if (starved) return;
            starved = starvationNotice(self, view, Date.now());
            if (starved) ctx?.onStarved?.(shard ? `[${shard.id}] ${starved}` : starved);
          },
        },
      );
    } finally {
      waits.delete(ac);
      if (waits.size === 0 && this._waiting.get(sessionId) === waits)
        this._waiting.delete(sessionId);
      if (starved) ctx?.onStarved?.(undefined);
    }
    const wait_ms = got.waitMs;
    ctx?.onPhase?.("run");
    // An abort that landed while the grant was being written: give it back, do not run.
    if (got.status === "granted" && (ac.signal.aborted || ctx?.mayStart?.() === false)) {
      await got.lease.release();
      return {
        type: "exec",
        success: false,
        stdout: "",
        stderr: ABORTED_WAIT,
        exit_code: EXIT_CODE_ABORTED,
        error: ABORTED_WAIT,
        wait_ms,
      };
    }
    if (got.status !== "granted") {
      const busy =
        got.status === "timeout"
          ? `busy: ${describeRequest({ threads, min_threads: minThreads, locks }, got.view.budget)} not free within ${resource.wait_timeout}s ` +
            `(held ${got.view.held}/${got.view.budget}, external ${got.view.external.toFixed(1)})`
          : ABORTED_WAIT;
      return {
        type: "exec",
        success: false,
        stdout: "",
        stderr: busy,
        exit_code: got.status === "timeout" ? EX_TEMPFAIL : EXIT_CODE_ABORTED,
        error: busy,
        wait_ms,
      };
    }
    try {
      const leased = {
        ...(got.lease.threads > 0 ? { WF_THREADS: String(got.lease.threads) } : {}),
        ...shard?.env,
      };
      // a fanout shard is not taken over on its own: a resumed fanout runs again
      const detached = shard ? undefined : ctx?.onDetached;
      return {
        ...(await this._exec(state, vars, ctx, leased, pgid => got.lease.attach(pgid), detached)),
        wait_ms,
        threads_granted: got.lease.threads,
      };
    } finally {
      await got.lease.release();
    }
  }

  /**
   * A `fanout:` exec: one instance per shard (`count`) or per line of
   * `items_command`, each under its own lease of `threads_each` threads —
   * the pool hands them out as threads free up, at most `max_parallel` at
   * once (default: as many as the budget runs side by side). Exit 0 only
   * if every shard exits 0; otherwise the failing shards' shared exit code
   * (all timed out → 124), or 1 when they differ. `timeout` bounds each
   * shard's run. Abort withdraws the waiting shards, kills the
   * running ones and starts no more.
   */
  private async _execFanout(
    state: StateDefinition,
    vars: Record<string, unknown>,
    ctx?: ExecContext,
  ): Promise<ActionResult> {
    const fanout = state.fanout!;
    const run: StateDefinition = {
      ...state,
      fanout: undefined,
      resource: { threads: fanout.threads_each },
    };
    let shards: Shard[];
    if (fanout.items_command !== undefined) {
      const listed = await this._exec(
        { ...run, command: fanout.items_command, max_output: ITEMS_MAX_OUTPUT },
        vars,
        ctx,
      );
      if (!listed.success || listed.stdout!.startsWith(TRUNCATED_MARK)) {
        const why = listed.success
          ? `items_command printed over ${ITEMS_MAX_OUTPUT} bytes`
          : `items_command failed: ${listed.error}`;
        const maxOutput = state.max_output ?? DEFAULT_MAX_OUTPUT;
        return {
          ...listed,
          success: false,
          exit_code: listed.success ? 1 : listed.exit_code,
          stdout: truncate(listed.stdout ?? "", maxOutput),
          stderr: truncate(`${why}\n${listed.stderr ?? ""}`, maxOutput),
          error: why,
        };
      }
      shards = listed
        .stdout!.split("\n")
        .map(line => line.replace(/\r$/, ""))
        .filter(line => line.trim() !== "")
        .map(line => ({ id: line, env: { WF_ITEM: line } }));
    } else {
      const n = fanout.count!;
      shards = Array.from({ length: n }, (_, i) => ({
        id: `${i + 1}/${n}`,
        env: { WF_SHARD: `${i + 1}/${n}` },
      }));
    }

    const sessionId = ctx?.sessionId ?? "";
    // Shards share the session: it is starved while ANY shard's wait is (the latest notice shown).
    const starvedShards = new Map<number, string>();
    const report = ctx?.onStarved;
    const shardCtx = (i: number): ExecContext | undefined =>
      ctx && report
        ? {
            ...ctx,
            onStarved: notice => {
              if (notice !== undefined) {
                starvedShards.set(i, notice);
                report(notice);
              } else if (starvedShards.delete(i) && starvedShards.size === 0) report(undefined);
            },
          }
        : ctx;
    const ac = new AbortController();
    let mine = this._fanouts.get(sessionId);
    if (!mine) this._fanouts.set(sessionId, (mine = new Set()));
    mine.add(ac);
    const results: ShardResult[] = [];
    const tails: string[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < shards.length && !ac.signal.aborted) {
        const i = next++;
        const started = performance.now();
        const r = await this._execLeased(run, vars, shardCtx(i), shards[i]);
        const wait_ms = r.wait_ms ?? 0;
        results[i] = {
          shard: shards[i].id,
          exit_code: r.exit_code ?? 1,
          duration_ms: Math.round(performance.now() - started) - wait_ms,
          wait_ms,
          ...(r.threads_granted !== undefined ? { threads_granted: r.threads_granted } : {}),
        };
        if (r.exit_code !== 0)
          tails[i] =
            `--- shard ${shards[i].id}: exit ${r.exit_code}${r.exit_code === EXIT_CODE_TIMEOUT ? " (timed out)" : ""} ---\n` +
            `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-SHARD_TAIL);
      }
    };
    try {
      // Unbounded, every shard would queue in the pool at once and stand ahead
      // of other sessions; by default only as many as the budget can run.
      const budget = this.pool.config().budget;
      const parallel =
        fanout.max_parallel ??
        Math.max(1, Math.floor(budget / Math.min(fanout.threads_each, budget)));
      await Promise.all(Array.from({ length: Math.min(parallel, shards.length) }, worker));
    } finally {
      mine.delete(ac);
      if (mine.size === 0 && this._fanouts.get(sessionId) === mine) this._fanouts.delete(sessionId);
    }
    // shards an abort kept from starting
    for (let i = 0; i < shards.length; i++)
      if (!results[i])
        results[i] = {
          shard: shards[i].id,
          exit_code: EXIT_CODE_ABORTED,
          duration_ms: 0,
          wait_ms: 0,
        };

    const failed = results.filter(r => r.exit_code !== 0);
    const codes = new Set(failed.map(r => r.exit_code));
    const exit_code = failed.length === 0 ? 0 : codes.size === 1 ? failed[0].exit_code : 1;
    const summary =
      `fanout: ${results.length - failed.length}/${results.length} ok` +
      (failed.length > 0 ? `, ${failed.length} failed (exit ${[...codes].join(", ")})` : "");
    return {
      type: "exec",
      success: exit_code === 0,
      stdout: truncate(
        [summary, ...tails.filter(t => t !== undefined)].join("\n"),
        state.max_output ?? DEFAULT_MAX_OUTPUT,
      ),
      stderr: "",
      exit_code,
      error: failed.length > 0 ? summary : undefined,
      shards: results,
    };
  }

  /** A session exec's pool priority (`WF_PRIORITY`): its level's value plus the step's `resource.priority`. */
  private static _priority(state: StateDefinition, ctx?: ExecContext): number {
    return levelPriority(ctx?.level ?? DEFAULT_PRIORITY_LEVEL, state.resource?.priority ?? 0);
  }

  private _track(sessionId: string | undefined, pid: number | undefined, add: boolean): void {
    if (!sessionId || !pid) return;
    let pids = this._running.get(sessionId);
    if (add) {
      if (!pids) this._running.set(sessionId, (pids = new Set()));
      pids.add(pid);
    } else if (pids) {
      pids.delete(pid);
      if (pids.size === 0) this._running.delete(sessionId);
    }
  }

  /** A state's cwd resolves against the session's; no state cwd runs in the session's. */
  private _cwd(
    state: StateDefinition,
    vars: Record<string, unknown>,
    ctx?: ExecContext,
  ): string | undefined {
    if (!state.cwd) return ctx?.cwd;
    const own = render(state.cwd, vars);
    return ctx?.cwd ? path.resolve(ctx.cwd, own) : own;
  }

  /**
   * Spawn env for exec states: process env + injected WF_PLUGIN_ROOT, the
   * session ids (WF_SESSION_ID, WF_PARENT_SESSION_ID — empty at the root,
   * WF_ROOT_SESSION_ID, WF_PRIORITY = the session level's priority plus the
   * step's, WF_PRIORITY_LEVEL = that level) and, under a lease with threads,
   * WF_THREADS (and a fanout shard's WF_SHARD or WF_ITEM) — overridable by
   * the state's own rendered env: entries. An inherited WF_THREADS /
   * WF_PRIORITY / WF_PRIORITY_LEVEL / WF_SHARD / WF_ITEM is dropped: they
   * describe this exec's own session, lease and shard only.
   * Single source for both foreground and background spawns so the injection
   * contract can't drift.
   */
  private _buildEnv(
    state: StateDefinition,
    vars: Record<string, unknown>,
    ctx?: ExecContext,
    leased?: Record<string, string>,
  ): NodeJS.ProcessEnv {
    const envVars = state.env
      ? Object.fromEntries(Object.entries(state.env).map(([k, v]) => [k, render(v, vars)]))
      : undefined;
    const ids = ctx
      ? {
          WF_SESSION_ID: ctx.sessionId,
          WF_PARENT_SESSION_ID: ctx.parentSessionId ?? "",
          WF_ROOT_SESSION_ID: ctx.rootSessionId,
          WF_PRIORITY: String(Executor._priority(state, ctx)),
          WF_PRIORITY_LEVEL: ctx.level ?? DEFAULT_PRIORITY_LEVEL,
        }
      : undefined;
    const {
      WF_THREADS: _threads,
      WF_PRIORITY: _priority,
      WF_PRIORITY_LEVEL: _level,
      WF_SHARD: _shard,
      WF_ITEM: _item,
      ...base
    } = process.env;
    return { ...base, WF_PLUGIN_ROOT: PLUGIN_ROOT, ...ids, ...leased, ...envVars };
  }

  /**
   * A foreground exec: `sh -c` in its own process group, detached from the
   * server — output to files, exit code to a file — so it survives the
   * server's exit and `adopt` can take its result over. With `detached` the
   * run's files are left to the caller; otherwise they are removed here.
   */
  private _exec(
    state: StateDefinition,
    vars: Record<string, unknown>,
    ctx?: ExecContext,
    leased?: Record<string, string>,
    onSpawn?: (pgid: number) => Promise<void>,
    detached?: (run: DetachedRun) => Promise<void>,
  ): Promise<ActionResult> {
    const command = render(state.command!, vars);
    const cwd = this._cwd(state, vars, ctx);
    const timeout = state.timeout ?? DEFAULT_EXEC_TIMEOUT;
    const maxOutput = state.max_output ?? DEFAULT_MAX_OUTPUT;
    // run output may hold anything a command prints: owner-only
    fs.mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
    const base = path.join(
      this.runDir,
      `${ctx?.sessionId || "exec"}-${randomBytes(6).toString("hex")}`,
    );
    const files = { out: `${base}.out`, err: `${base}.err`, rc: `${base}.rc` };
    const startedAt = new Date().toISOString();

    return new Promise(resolve => {
      let killed = false;
      const outFd = fs.openSync(files.out, "w");
      const errFd = fs.openSync(files.err, "w");
      let child;
      try {
        child = spawn("sh", ["-c", EXEC_WRAPPER, "wf-exec", command, files.rc], {
          cwd,
          env: this._buildEnv(state, vars, ctx, leased),
          stdio: ["ignore", outFd, errFd],
          detached: true,
        });
      } finally {
        fs.closeSync(outFd);
        fs.closeSync(errFd);
      }
      this._track(ctx?.sessionId, child.pid, true);
      // The lease names the child's group too, so a server that dies mid-exec does not free it.
      if (child.pid && onSpawn) onSpawn(child.pid).catch(() => {});
      // The result waits for the record: written after it, the record would outlive the run.
      const recorded =
        child.pid && detached
          ? detached({
              pgid: child.pid,
              ...files,
              started_at: startedAt,
              boot_ms: bootTimeMs(),
            }).catch(() => {})
          : Promise.resolve();

      const killGroup = (signal: NodeJS.Signals) => {
        if (child.pid) killProcessGroup(child.pid, signal);
      };

      let killedAt: number | undefined;
      const timer = setTimeout(() => {
        killed = true;
        killedAt = Date.now();
        killGroup("SIGTERM");
      }, timeout);

      const finish = (result: ActionResult) => {
        this._track(ctx?.sessionId, child.pid, false);
        clearTimeout(timer);
        // a run that failed to spawn has no process to take over: its files go too
        if (!detached || !child.pid) Executor.discardRun(files);
        // ast-grep-ignore: then-without-catch -- `recorded` cannot reject: its failure is caught where it is made
        void recorded.then(() => resolve(result));
      };

      // Building the result reads the run's files and can throw; thrown inside a
      // handler it would be lost (or kill the server) and the exec never settle.
      const resultOf = (exit_code: number, error?: string): ActionResult => {
        try {
          return Executor._runResult(files, maxOutput, exit_code, error);
        } catch (err) {
          return {
            type: "exec",
            success: false,
            stdout: "",
            stderr: "",
            exit_code: 1,
            error: `Reading the exec result failed: ${(err as Error).message}`,
          };
        }
      };

      child.on("close", (code: number | null) => {
        if (!killed) {
          let exit_code: number;
          try {
            exit_code = Executor._readExitCode(files.rc) ?? code ?? 1;
          } catch {
            exit_code = code ?? 1;
          }
          finish(resultOf(exit_code));
          return;
        }
        // The wrapper dies of the SIGTERM even when the command ignores it:
        // the run is over only once the whole group is gone (SIGKILL after the grace).
        // A failed reap still ends the step: unhandled, it would kill the server and the exec would never settle.
        const timedOut = (error: string) => finish(resultOf(EXIT_CODE_TIMEOUT, error));
        void Executor._reapGroup(child.pid!, killedAt!).then(
          () => timedOut("Process timed out"),
          (err: unknown) =>
            timedOut(`Process timed out; reaping its group failed: ${(err as Error).message}`),
        );
      });

      child.on("error", err => {
        finish({ ...resultOf(1), error: err.message });
      });
    });
  }

  /**
   * Take over a foreground exec another server started (`ExecContext.onDetached`):
   * its exit code already written → that result; its group still running →
   * wait for it (abort kills it; past the state's `timeout`, counted from its
   * start, it is killed and exits 124); neither — it never finished, e.g. the
   * machine rebooted → null, the caller runs the step again.
   */
  async adopt(
    run: DetachedRun,
    state: StateDefinition,
    ctx?: ExecContext,
  ): Promise<ActionResult | null> {
    const maxOutput = state.max_output ?? DEFAULT_MAX_OUTPUT;
    const started = Date.parse(run.started_at);
    const done = (exit_code: number, error?: string): ActionResult => ({
      ...Executor._runResult(run, maxOutput, exit_code, error),
      duration_ms: Math.max(0, Date.now() - started),
    });
    const alive = () => Executor.sameBoot(run) && isGroupAlive(run.pgid);

    const first = Executor._readExitCode(run.rc);
    if (first !== undefined) return done(first);
    if (!alive()) {
      // it may have written its code between the two reads
      const late = Executor._readExitCode(run.rc);
      return late === undefined ? null : done(late);
    }

    const deadline = started + (state.timeout ?? DEFAULT_EXEC_TIMEOUT);
    this._track(ctx?.sessionId, run.pgid, true);
    try {
      let killedAt: number | undefined;
      for (;;) {
        const code = Executor._readExitCode(run.rc);
        const ended = code !== undefined || !isGroupAlive(run.pgid);
        if (ended && killedAt !== undefined) return done(EXIT_CODE_TIMEOUT, "Process timed out");
        if (code !== undefined) return done(code);
        if (ended) return done(1, NO_EXIT_CODE);
        const now = Date.now();
        if (killedAt === undefined && now >= deadline) {
          killedAt = now;
          killProcessGroup(run.pgid, "SIGTERM");
        } else if (killedAt !== undefined && now - killedAt >= SIGKILL_GRACE_MS) {
          killProcessGroup(run.pgid, "SIGKILL");
        }
        await new Promise(r => setTimeout(r, ADOPT_POLL_MS));
      }
    } finally {
      this._track(ctx?.sessionId, run.pgid, false);
    }
  }

  /** Wait for a group sent SIGTERM at `termAt` to die; SIGKILL it once the grace has passed. */
  private static async _reapGroup(pgid: number, termAt: number): Promise<void> {
    let killSent = false;
    for (;;) {
      if (!isGroupAlive(pgid)) return;
      const since = Date.now() - termAt;
      if (!killSent && since >= SIGKILL_GRACE_MS) {
        killProcessGroup(pgid, "SIGKILL");
        killSent = true;
      } else if (killSent && since >= SIGKILL_GRACE_MS + SIGKILL_GRACE_MS) {
        return; // unkillable (uninterruptible sleep): stop waiting, the group is not ours to hold the step for
      }
      await new Promise(r => setTimeout(r, REAP_POLL_MS));
    }
  }

  /**
   * Remove run files under `runDir` older than `maxAgeMs` that no session
   * references any more (left by a server killed between a run's end and its
   * routing). Returns the files removed.
   */
  sweepRuns(referenced: ReadonlySet<string>, maxAgeMs: number, now: number = Date.now()): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.runDir);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const name of names) {
      const file = path.join(this.runDir, name);
      if (referenced.has(file)) continue;
      try {
        if (now - fs.statSync(file).mtimeMs < maxAgeMs) continue;
        fs.rmSync(file, { force: true });
        removed.push(file);
      } catch {
        /* gone meanwhile */
      }
    }
    return removed;
  }

  /** Remove a run's files (a missing one is fine). */
  static discardRun(run: Pick<DetachedRun, "out" | "err" | "rc">): void {
    for (const f of [run.out, run.err, run.rc, `${run.rc}.tmp`]) fs.rmSync(f, { force: true });
  }

  /** The run started under this boot of the machine, so its pgid still names it. */
  static sameBoot(run: Pick<DetachedRun, "boot_ms">): boolean {
    return sameBoot(run.boot_ms);
  }

  /** What became of a detached run: still running, ended with its exit code written, or gone without one. */
  static fate(run: Pick<DetachedRun, "pgid" | "rc" | "boot_ms">): "running" | "finished" | "lost" {
    if (Executor._readExitCode(run.rc) !== undefined) return "finished";
    if (Executor.sameBoot(run) && isGroupAlive(run.pgid)) return "running";
    // it may have written its code between the two reads
    return Executor._readExitCode(run.rc) !== undefined ? "finished" : "lost";
  }

  private static _readExitCode(file: string): number | undefined {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8").trim();
    } catch {
      return undefined;
    }
    const code = Number.parseInt(text, 10);
    return Number.isInteger(code) ? code : undefined;
  }

  /** The last `limit` bytes of a file, marked when cut; a missing file reads empty. */
  private static _readTail(file: string, limit: number): string {
    let fd: number;
    try {
      fd = fs.openSync(file, "r");
    } catch {
      return "";
    }
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, limit);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      return (size > limit ? TRUNCATED_MARK : "") + buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  private static _runResult(
    run: Pick<DetachedRun, "out" | "err">,
    maxOutput: number,
    exit_code: number,
    error?: string,
  ): ActionResult {
    return {
      type: "exec",
      success: exit_code === 0,
      stdout: Executor._readTail(run.out, maxOutput),
      stderr: Executor._readTail(run.err, maxOutput),
      exit_code,
      error: error ?? (exit_code !== 0 ? `Exit code ${exit_code}` : undefined),
    };
  }

  private _execBackground(
    state: StateDefinition,
    vars: Record<string, unknown>,
    ctx?: ExecContext,
  ): Promise<ActionResult> {
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

  private async _fetch(
    state: StateDefinition,
    vars: Record<string, unknown>,
  ): Promise<ActionResult> {
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
