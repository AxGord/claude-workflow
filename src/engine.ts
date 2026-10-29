import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  SessionState,
  StackFrame,
  HistoryEntry,
  WorkflowDefinition,
  StateDefinition,
  WorkflowOverrides,
  ActionResult,
  SessionOutcome,
  PriorityLevel,
  DetachedRun,
  RunningExec,
  PendingAction,
} from "./types.js";
import {
  MAX_STACK_DEPTH,
  DEFAULT_MAX_TRANSITIONS,
  KEEP_TERMINAL_SESSIONS,
  DEFAULT_PRIORITY_LEVEL,
  DEFAULT_SUSPENDED_TTL_DAYS,
  PriorityLevelSchema,
} from "./types.js";
import { projectRoot } from "./pool.js";
import type { Storage } from "./storage.js";
import type { Loader } from "./loader.js";
import type { ExecContext } from "./executor.js";
import type { ExecPhase } from "./progress.js";
import { EXIT_CODE_TIMEOUT, Executor } from "./executor.js";
import { killProcessGroup } from "./process.js";
import { ledgerEntry, rootSessionIdOf } from "./ledger.js";
import { render } from "./template.js";
import { currentProgress, startHeartbeat } from "./progress.js";
import { activeSubtree, takeOver } from "./takeover.js";

function stripOptionalPrefix(s: string): string {
  return s.replace(/^\?/, "");
}

export interface TransitionResult {
  readonly prompt: string;
  readonly warnings: string[];
  readonly autoTransitions: string[];
}

export interface TaskOp {
  readonly action: "create" | "complete";
  readonly subject: string;
}

export interface StatusResult {
  readonly sessionId: string;
  readonly stack: StackFrame[];
  readonly activeFrame: number;
  readonly currentState: StateDefinition;
  readonly currentStateName: string;
  readonly currentWorkflow: string;
  readonly availableTransitions: Record<string, string>;
  readonly prompt: string;
  readonly history: HistoryEntry[];
  readonly context: Record<string, unknown>;
  readonly taskOps: TaskOp[];
  readonly visitCount: number;
  readonly forcePrompt?: boolean;
}

/** Where a move actually lands once `on_exhausted` routes are followed. */
interface EnteredTarget {
  readonly name: string;
  readonly state: StateDefinition | undefined;
  readonly visits: number;
  /** History detail when the move was rerouted past an exhausted state. */
  readonly exhausted?: string;
}

const MAX_ACTION_CHAIN = 20;
const TERMINAL_PROMPT_DIVIDER = "\n\n---\n\n";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface EngineOptions {
  /** `$STATE_DIR`: where the SessionStart hook writes `claude-session-<claude pid>` (the conversation id). */
  readonly stateDir?: string;
  /** A suspended session nobody resumed for this many days is abandoned. */
  readonly suspendedTtlDays?: number;
}

/** What `resume` hands back: the session's status and its suspended descendants, whose agents must resume them. */
export interface ResumeResult {
  readonly status: StatusResult;
  readonly suspendedChildren: SessionState[];
}

export class Engine {
  private static readonly GLOBAL_WORKFLOWS = new Set([
    "coding",
    "debugging",
    "bug-fix",
    "new-feature",
    "code-review",
    "explore",
    "web-research",
    "planning",
    "testing",
    "reflection",
    "investigate",
    "master",
    "file-code",
    "file-review",
    "lint-review",
    "subagent",
    "review-push",
    "github-init",
    "docs",
    "batch",
    "batch-task",
  ]);

  private readonly _storage: Storage;
  private readonly _loader: Loader;
  private readonly _executor: Executor;
  // Snapshot: sessions keep the workflow version they started with
  private readonly _snapshots: Map<string, Map<string, WorkflowDefinition>> = new Map();
  // Sessions whose processes the abort tool killed ahead of its queued abort:
  // their running action chain must stop, not route the killed exec's result.
  private readonly _aborting = new Set<string>();
  // Sessions whose action state this server is running: their `running_exec`
  // is this server's own, never one to take over.
  private readonly _inFlight = new Set<string>();
  private readonly _options: EngineOptions;

  constructor(storage: Storage, loader: Loader, executor: Executor, options: EngineOptions = {}) {
    this._storage = storage;
    this._loader = loader;
    this._executor = executor;
    this._options = options;
  }

  /** The id of the Claude Code conversation this server's process runs, as the SessionStart hook recorded it. */
  private _claudeSessionId(): string | undefined {
    if (!this._options.stateDir) return undefined;
    try {
      const id = fs
        .readFileSync(path.join(this._options.stateDir, `claude-session-${process.ppid}`), "utf8")
        .trim();
      return id || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve the active session for the current Claude Code PID.
   * Exactly one active session → its ID. More than one (e.g. parallel
   * sub-agents sharing the parent's ppid) → throw: picking one silently
   * would corrupt a sibling's session.
   */
  public resolveSessionId(sessionId?: string): string {
    if (sessionId) return sessionId;
    const pid = process.ppid;
    const active = this._storage
      .readAll()
      .filter(s => s.context.claude_code_pid === pid && s.stack.length > 0);
    if (active.length === 0) throw new Error("No active session found. Call start first.");
    if (active.length > 1) {
      const candidates = active.map(s => `${s.session_id} (${s.stack[0].workflow})`).join(", ");
      throw new Error(
        `Multiple active sessions for this process: ${candidates}. Pass session_id explicitly.`,
      );
    }
    return active[0].session_id;
  }

  private static _isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e?.code === "EPERM";
    }
  }

  /**
   * Check if the session belongs to the current Claude Code process.
   * When force=true, skip the check but warn if the owner process is still alive.
   * Returns a warning string if force was used, undefined otherwise.
   */
  /** A suspended session takes no step until `resume` hands it to a live process. */
  public assertNotSuspended(sessionId: string): void {
    const session = this._storage.read(sessionId);
    if (session?.suspended_at)
      throw new Error(
        `Session "${sessionId}" is suspended (since ${session.suspended_at}). Call resume({ session_id: "${sessionId}" }) first.`,
      );
  }

  public assertOwnership(sessionId: string, force?: boolean): string | undefined {
    const session = this._storage.read(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    const ownerPid = session.context.claude_code_pid;
    const currentPid = process.ppid;
    if (ownerPid !== undefined && ownerPid !== currentPid) {
      if (!force) {
        throw new Error(
          `Session "${sessionId}" belongs to PID ${ownerPid} (current: ${currentPid}). Use force: true to override.`,
        );
      }
      if (Engine._isPidAlive(ownerPid as number)) {
        return `Warning: session "${sessionId}" belongs to PID ${ownerPid} which is still alive. Proceeding due to force: true.`;
      }
    }
  }

  public async start(
    workflowName: string,
    actor?: string,
    parentSessionId?: string,
    cwd?: string,
    priority?: PriorityLevel,
  ): Promise<StatusResult> {
    if (cwd !== undefined) Engine._assertSessionCwd(cwd);
    if (priority !== undefined) PriorityLevelSchema.parse(priority);

    // Guard: prevent duplicate top-level sessions from the same Claude Code process.
    // Sub-agent sessions (with parent_session_id) are exempt — they run alongside the parent.
    if (!parentSessionId) {
      const pid = process.ppid;
      const active = this._storage
        .readAll()
        .filter(
          s => s.context.claude_code_pid === pid && !s.parent_session_id && s.stack.length > 0,
        );
      if (active.length > 0) {
        // Idempotent start: return existing session with a short message
        // instead of the full state prompt. This prevents sub-agents
        // (who inherit the "call start() first" rule) from seeing
        // transition instructions and hijacking the parent session.
        const existing = active[0];
        const frame = existing.stack[existing.active_frame];
        const status = this._buildStatus(existing, []);
        return {
          ...status,
          prompt:
            `Session already active: ${existing.session_id} (${frame.workflow} @ ${frame.current_state}). ` +
            `If you are a sub-agent, pass parent_session_id to start your own session. ` +
            `If you lost context, call status() to re-read the full prompt.`,
        };
      }
    }

    let sessionId: string;
    do {
      sessionId = randomBytes(4).toString("hex");
    } while (this._storage.read(sessionId));
    const workflows = this._workflowsAt(cwd);
    const wf = workflows.get(workflowName);
    if (!wf) throw new Error(`Workflow "${workflowName}" not found`);

    // Snapshot all workflows for this session
    this._snapshots.set(sessionId, workflows);

    const now = new Date().toISOString();
    const frame: StackFrame = {
      workflow: workflowName,
      current_state: wf.initial,
      state_visits: { [wf.initial]: 1 },
      total_transitions: 0,
    };

    const globalKey = `${workflowName}:${wf.initial}`;
    const parent = parentSessionId ? this._storage.read(parentSessionId) : null;
    const rootSessionId = parentSessionId
      ? rootSessionIdOf(parent ?? { session_id: parentSessionId })
      : sessionId;
    const claudeSessionId = this._claudeSessionId();
    const session: SessionState = {
      session_id: sessionId,
      ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
      root_session_id: rootSessionId,
      priority: priority ?? parent?.priority ?? DEFAULT_PRIORITY_LEVEL,
      stack: [frame],
      active_frame: 0,
      started_at: now,
      updated_at: now,
      history: [{ frame: 0, event: "start", workflow: workflowName, at: now, actor }],
      overrides: {},
      context: { claude_code_pid: process.ppid, cwd: cwd ?? process.cwd() },
      global_state_visits: { [globalKey]: 1 },
      ...(claudeSessionId ? { claude_session_id: claudeSessionId } : {}),
    };

    await this._storage.write(sessionId, session);

    // Check if initial state is a skill gate, sub_workflow, or action
    const initialState = this._resolveState(session, workflowName, wf.initial);
    if (this._isSkillGate(initialState)) {
      return this._handleSkillGate(session, initialState!, []);
    }
    if (initialState?.sub_workflow) {
      return this._pushSubWorkflow(session, initialState, []);
    }
    if (this._isActionState(initialState)) {
      return this._executeActionState(session, initialState!, []);
    }

    return this._buildStatus(session, []);
  }

  public async transition(
    sessionId: string,
    transitionName: string,
    actor?: string,
  ): Promise<StatusResult> {
    const session = this._storage.read(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    if (session.stack.length === 0)
      throw new Error(`Session "${sessionId}" has no active workflow`);

    // Session is waiting for children to complete — try to resolve
    if (session.pending_pop) {
      const result = await this.retryPendingPop(sessionId);
      if (result) return result;
      throw new Error(this._formatChildrenBlockError(sessionId));
    }

    const frame = session.stack[session.active_frame];
    const wf = this._getWorkflow(sessionId, frame.workflow);
    const state = this._resolveState(session, frame.workflow, frame.current_state);

    if (!state)
      throw new Error(`State "${frame.current_state}" not found in workflow "${frame.workflow}"`);
    // terminal states without transitions are truly final; with transitions they allow re-entry
    if (state.terminal && (!state.transitions || Object.keys(state.transitions).length === 0)) {
      throw new Error(`Cannot transition from terminal state "${frame.current_state}"`);
    }

    const transitions = state.transitions ?? {};
    const requested = transitions[transitionName];
    if (!requested) {
      const available = Object.keys(transitions).join(", ");
      throw new Error(`Transition "${transitionName}" not available. Available: ${available}`);
    }

    // Check max_transitions
    const maxTransitions = wf.max_transitions ?? DEFAULT_MAX_TRANSITIONS;
    if (frame.total_transitions >= maxTransitions) {
      throw new Error(
        `Max transitions (${maxTransitions}) reached for workflow "${frame.workflow}"`,
      );
    }

    const now = new Date().toISOString();

    const {
      name: targetStateName,
      state: targetState,
      visits: targetVisits,
      exhausted,
    } = this._enterTarget(session, frame, requested);

    const updatedFrame: StackFrame = {
      ...frame,
      current_state: targetStateName,
      state_visits: { ...frame.state_visits, [targetStateName]: targetVisits },
      total_transitions: frame.total_transitions + 1,
    };

    const historyEntry: HistoryEntry = {
      frame: session.active_frame,
      from: frame.current_state,
      to: targetStateName,
      via: transitionName,
      at: now,
      actor,
      ...(exhausted ? { detail: exhausted } : {}),
    };

    const globalKey = `${frame.workflow}:${targetStateName}`;
    const prevGlobal = session.global_state_visits ?? {};

    // Mark skill gate skills as loaded when transitioning from a skill gate state
    const skillUpdate = state?.skills?.length
      ? {
          loaded_skills: {
            ...(session.loaded_skills ?? {}),
            ...Object.fromEntries(
              state.skills.map(s => [stripOptionalPrefix(s), session.skill_epoch ?? 0]),
            ),
          },
        }
      : {};

    let updated: SessionState = {
      ...session,
      ...skillUpdate,
      stack: session.stack.map((f, i) => (i === session.active_frame ? updatedFrame : f)),
      updated_at: now,
      history: [...session.history, historyEntry],
      global_state_visits: { ...prevGlobal, [globalKey]: (prevGlobal[globalKey] ?? 0) + 1 },
    };

    await this._storage.write(sessionId, updated);

    const taskOps: TaskOp[] = [];
    if (state?.task) {
      taskOps.push({ action: "complete", subject: state.task });
    }

    // Check if target is terminal
    if (targetState?.terminal) {
      const hasTransitions =
        targetState.transitions && Object.keys(targetState.transitions).length > 0;
      if (!hasTransitions) {
        // Hard terminal — pop stack as usual
        const outcome = targetState.outcome === "fail" ? "fail" : "complete";
        return this._popStack(updated, outcome, taskOps);
      }
      // Soft terminal — mark in session, stay in state
      updated = { ...updated, soft_terminal: true };
      await this._storage.write(sessionId, updated);
      return this._buildStatus(updated, taskOps);
    }

    // Clear soft_terminal if leaving a soft-terminal state
    if (updated.soft_terminal) {
      updated = { ...updated, soft_terminal: false };
      await this._storage.write(sessionId, updated);
    }

    // Order: skill_gate → sub_workflow → action
    if (this._isSkillGate(targetState)) {
      return this._handleSkillGate(updated, targetState!, taskOps);
    }

    if (targetState?.sub_workflow) {
      return this._pushSubWorkflow(updated, targetState, taskOps);
    }

    if (this._isActionState(targetState)) {
      return this._executeActionState(updated, targetState!, taskOps);
    }

    return this._buildStatus(updated, taskOps);
  }

  /** A session cwd must be an absolute path of an existing directory. */
  private static _assertSessionCwd(cwd: string): void {
    if (!path.isAbsolute(cwd)) throw new Error(`cwd must be an absolute path, got "${cwd}"`);
    let isDir = false;
    try {
      isDir = fs.statSync(cwd).isDirectory();
    } catch {
      /* missing */
    }
    if (!isDir) throw new Error(`cwd "${cwd}" is not an existing directory`);
  }

  /**
   * Kill a session's background exec groups and its in-flight foreground
   * execs — also one a dead server left running (`running_exec`, under this
   * boot only: after a reboot its pgid names some other process).
   */
  private _killSessionProcesses(session: SessionState): void {
    for (const pid of Object.values(session.background_pids ?? {})) killProcessGroup(pid);
    this._executor.killSession(session.session_id);
    const run = session.running_exec;
    if (run) {
      // a written exit code means the run is over and its pgid may be anyone's by now
      if (Executor.sameBoot(run) && !fs.existsSync(run.rc)) killProcessGroup(run.pgid);
      Executor.discardRun(run);
    }
  }

  /**
   * Kill the processes of an active session and of its active descendants
   * without touching session state. The abort tool calls this BEFORE queueing
   * behind the session's own running transition, whose foreground exec would
   * otherwise hold the abort until it exits. A finished session is left alone:
   * its recorded pids may have been reused.
   */
  public killSessionTree(sessionId: string): void {
    const session = this._storage.read(sessionId);
    if (!session || session.stack.length === 0) return;
    this._aborting.add(sessionId);
    this._killSessionProcesses(session);
    for (const child of this._getActiveChildren(sessionId)) this.killSessionTree(child.session_id);
  }

  public async abort(sessionId: string, event: string = "abort"): Promise<void> {
    const session = this._storage.read(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    // Already ended: no second ledger line, no outcome rewrite, no kill of stale pids.
    if (session.stack.length === 0) {
      this._aborting.delete(sessionId);
      return;
    }

    this._killSessionProcesses(session);

    const now = new Date().toISOString();
    const updated: SessionState = {
      ...session,
      stack: [],
      active_frame: -1,
      updated_at: now,
      history: [...session.history, { frame: session.active_frame, event, at: now }],
      outcome: "abandoned",
    };

    await this._storage.write(sessionId, updated);
    await this._finalize(updated);
    await this._cascadeAbandonChildren(sessionId);
    this._pruneTerminal();

    // If this was a child session, try to unblock the parent's pending completion
    if (session.parent_session_id) await this.retryPendingPop(session.parent_session_id);
  }

  /**
   * Set the priority level of a session and of its active descendants (a
   * child started later inherits it), then re-rank their waiting pool
   * entries at once; running leases are not touched. Runs outside the
   * session's queue: an exec of it may be waiting for the very lease this
   * re-ranks — the action chain keeps the level it finds after the exec,
   * and each session is changed under its file lock, so a session that ended
   * meanwhile stays ended.
   */
  public async setPriority(
    sessionId: string,
    level: PriorityLevel,
  ): Promise<{ sessions: string[]; moved: number }> {
    PriorityLevelSchema.parse(level);
    const session = this._storage.read(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    if (session.stack.length === 0)
      throw new Error(`Session "${sessionId}" has ended (${session.outcome ?? "completed"})`);
    const tree = [session];
    for (let i = 0; i < tree.length; i++) tree.push(...this._getActiveChildren(tree[i].session_id));
    const ids: string[] = [];
    for (const { session_id: id } of tree) {
      const set = await this._storage.update(id, cur =>
        cur && cur.stack.length > 0 ? { ...cur, priority: level } : null,
      );
      if (set) ids.push(id);
    }
    const moved = await this._executor.pool.reprioritize(new Set(ids), level);
    return { sessions: ids, moved };
  }

  public getStatus(sessionId: string): StatusResult {
    const session = this._storage.read(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    return this._buildStatus(session, []);
  }

  /**
   * Retry a deferred pop. Called by Modifier after overlays change,
   * in case on_complete/on_fail was added to the parent state.
   * Returns the new status if pop succeeded, or null if still pending.
   */
  public async retryPendingPop(sessionId: string): Promise<StatusResult | null> {
    const session = this._storage.read(sessionId);
    if (!session?.pending_pop) return null;

    // Clear pending_pop before retrying to avoid infinite loops
    const cleared: SessionState = { ...session, pending_pop: undefined };
    await this._storage.write(sessionId, cleared);

    try {
      const result = await this._popStack(cleared, session.pending_pop.outcome, []);
      // Check if _popStack re-parked (pop still couldn't resolve)
      const afterPop = this._storage.read(sessionId);
      if (afterPop?.pending_pop) return null;
      return result;
    } catch {
      // Still can't pop — re-park
      const reparked: SessionState = { ...cleared, pending_pop: session.pending_pop };
      await this._storage.write(sessionId, reparked);
      return null;
    }
  }

  /**
   * On server start: suspend the active sessions whose owner process is gone
   * (a Claude Code that crashed past its SessionEnd hook), abandon — with
   * a ledger line — every session left suspended longer than the TTL, and
   * remove exec run files older than a day that no session references.
   */
  public async reapOrphanedSessions(
    now: number = Date.now(),
  ): Promise<{ suspended: string[]; expired: string[] }> {
    const suspended: string[] = [];
    const expired: string[] = [];
    const ttlMs = (this._options.suspendedTtlDays ?? DEFAULT_SUSPENDED_TTL_DAYS) * DAY_MS;
    const sessions = this._storage.readAll().filter(s => s.stack?.length > 0);
    const referenced = new Set(
      sessions.flatMap(s =>
        s.running_exec ? [s.running_exec.out, s.running_exec.err, s.running_exec.rc] : [],
      ),
    );
    this._executor.sweepRuns(referenced, DAY_MS, now);
    for (const session of sessions) {
      if (session.suspended_at) {
        if (now - Date.parse(session.suspended_at) < ttlMs) continue;
        // the resume hook may have picked it up since readAll
        if (!this._storage.read(session.session_id)?.suspended_at) continue;
        await this.abort(session.session_id, "expire");
        expired.push(session.session_id);
        continue;
      }
      const pid = session.context.claude_code_pid;
      if (typeof pid !== "number" || Engine._isPidAlive(pid)) continue;
      if (await this._suspendOne(session.session_id, new Date(now).toISOString(), pid))
        suspended.push(session.session_id);
    }
    return { suspended, expired };
  }

  /**
   * Suspend a session and its active descendants: the stack, context and
   * children stay as they are and no ledger line is written — the session has
   * not ended. Running execs are left running (`resume` takes them over).
   */
  public async suspend(sessionId: string): Promise<string[]> {
    const now = new Date().toISOString();
    const done: string[] = [];
    for (const id of activeSubtree(this._storage, sessionId))
      if (await this._suspendOne(id, now)) done.push(id);
    return done;
  }

  /**
   * `deadOwner`: suspend only while the session still belongs to that process —
   * the SessionStart hook of a resumed conversation may have handed it to the
   * new one since the caller read it.
   */
  private async _suspendOne(sessionId: string, at: string, deadOwner?: number): Promise<boolean> {
    const set = await this._storage.update(sessionId, cur =>
      cur &&
      cur.stack.length > 0 &&
      !cur.suspended_at &&
      (deadOwner === undefined || cur.context.claude_code_pid === deadOwner)
        ? {
            ...cur,
            suspended_at: at,
            updated_at: at,
            history: [...cur.history, { frame: cur.active_frame, event: "suspend", at }],
          }
        : null,
    );
    return set !== null;
  }

  /**
   * Hand a suspended session — or one whose owner process is gone — to this
   * process: it and its active descendants become owned by it, the session
   * itself is no longer suspended (each descendant stays suspended until its
   * own agent resumes it). A session stopped inside an action state finishes
   * it now: a foreground exec still running is waited for, one that finished
   * meanwhile gives its recorded result, one that left neither runs again.
   */
  public async resume(sessionId: string): Promise<ResumeResult> {
    const session = this._storage.read(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    if (session.stack.length === 0)
      throw new Error(`Session "${sessionId}" has ended (${session.outcome ?? "completed"})`);
    const pid = process.ppid;
    const owner = session.context.claude_code_pid;
    if (
      !session.suspended_at &&
      owner !== pid &&
      typeof owner === "number" &&
      Engine._isPidAlive(owner)
    )
      throw new Error(`Session "${sessionId}" is active in PID ${owner}, not suspended.`);

    const now = new Date().toISOString();
    await takeOver(
      this._storage,
      sessionId,
      { pid, claudeSessionId: this._claudeSessionId() },
      now,
      "root",
    );
    const resumed = this._storage.read(sessionId)!;
    // the old server's snapshot died with it: the session continues on the workflows loaded now
    if (!this._snapshots.has(sessionId))
      this._snapshots.set(sessionId, this._workflowsAt(Engine._cwdOf(resumed)));
    const suspendedChildren = activeSubtree(this._storage, sessionId)
      .slice(1)
      .map(id => this._storage.read(id))
      .filter((s): s is SessionState => !!s?.suspended_at);

    const frame = resumed.stack[resumed.active_frame];
    const state = this._resolveState(resumed, frame.workflow, frame.current_state);
    const status =
      this._isActionState(state) && !resumed.pending_pop
        ? await this._executeActionState(resumed, state!, [], 0, resumed.running_exec)
        : this._buildStatus(resumed, []);
    return { status, suspendedChildren };
  }

  /**
   * The session is owned by this process and stopped in an action state a
   * previous server began and never routed — the SessionStart hook of a
   * resumed conversation hands sessions over without a server. Cheap: no lock, no exec.
   */
  public hasOrphanedExec(sessionId: string): boolean {
    return this.orphanedStep(sessionId) !== undefined;
  }

  /**
   * What `adoptOrphanedExec` will do: `exec` — take over the exec a previous
   * server left running or its recorded result; `rerun` — run the step again,
   * its exec never started (`pending_action`) or is gone without a result.
   */
  public orphanedStep(sessionId: string): "exec" | "rerun" | undefined {
    const found = this._orphanedExec(this._storage.read(sessionId));
    if (!found) return undefined;
    return found.run && Executor.fate(found.run) !== "lost" ? "exec" : "rerun";
  }

  /**
   * Finish the action state of a session `hasOrphanedExec` names: wait for
   * its exec, take its recorded result, or run it again — as `resume` does.
   * Null when there is nothing to take over (any more). Call it inside the
   * session's queue.
   */
  public async adoptOrphanedExec(sessionId: string): Promise<StatusResult | null> {
    const session = this._storage.read(sessionId);
    const found = this._orphanedExec(session);
    if (!found) return null;
    if (!this._snapshots.has(sessionId))
      this._snapshots.set(sessionId, this._workflowsAt(Engine._cwdOf(session!)));
    return this._executeActionState(session!, found.state, [], 0, found.run);
  }

  private _orphanedExec(
    session: SessionState | null,
  ): { state: StateDefinition; run?: RunningExec } | undefined {
    if (!session || session.stack.length === 0 || session.suspended_at) return undefined;
    if (session.pending_pop || this._inFlight.has(session.session_id)) return undefined;
    if (session.context.claude_code_pid !== process.ppid) return undefined;
    const frame = session.stack[session.active_frame];
    const here = (at?: { frame: number; state: string }): boolean =>
      at?.frame === session.active_frame && at.state === frame?.current_state;
    const run = here(session.running_exec) ? session.running_exec : undefined;
    if (!run && !here(session.pending_action)) return undefined;
    const state = this._resolveState(session, frame.workflow, frame.current_state);
    return state && this._isActionState(state) ? { state, run } : undefined;
  }

  /** Record the Agent-tool id of the sub-agent that drives a session, for a parent's resume. */
  public async linkAgent(sessionId: string, agentId: string): Promise<void> {
    const set = await this._storage.update(sessionId, cur =>
      cur ? { ...cur, agent_id: agentId } : null,
    );
    if (!set) throw new Error(`Session "${sessionId}" not found`);
  }

  /** Suspended sessions, oldest first: those whose cwd lies in `projectRootPath` (its git root), or all. */
  public listSuspended(projectRootPath?: string): SessionState[] {
    return this._storage
      .readAll()
      .filter(s => s.stack?.length > 0 && !!s.suspended_at)
      .filter(
        s =>
          projectRootPath === undefined ||
          projectRoot(typeof s.context.cwd === "string" ? s.context.cwd : process.cwd()) ===
            projectRootPath,
      )
      .sort((a, b) => a.suspended_at!.localeCompare(b.suspended_at!));
  }

  public async setContext(
    sessionId: string,
    key: string,
    value: unknown,
    actor?: string,
  ): Promise<void> {
    const session = this._storage.read(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);

    const now = new Date().toISOString();
    const updated: SessionState = {
      ...session,
      context: { ...session.context, [key]: value },
      updated_at: now,
      history: [
        ...session.history,
        { frame: session.active_frame, event: "context_set", at: now, actor },
      ],
    };

    await this._storage.write(sessionId, updated);
  }

  private _isActionState(state: StateDefinition | undefined): boolean {
    return state?.type === "exec" || state?.type === "fetch";
  }

  private _isSkillGate(state: StateDefinition | undefined): boolean {
    return (state?.skills?.length ?? 0) > 0;
  }

  private async _handleSkillGate(
    session: SessionState,
    state: StateDefinition,
    taskOps: TaskOp[],
    depth: number = 0,
    actionPrompt?: string,
  ): Promise<StatusResult> {
    if (depth >= MAX_ACTION_CHAIN) {
      throw new Error(`Auto-transition chain exceeded max depth (${MAX_ACTION_CHAIN})`);
    }

    const epoch = session.skill_epoch ?? 0;
    const loaded = session.loaded_skills ?? {};
    const missing = state.skills!.filter(s => (loaded[stripOptionalPrefix(s)] ?? -1) < epoch);

    if (missing.length > 0) {
      const required: string[] = [];
      const optional: string[] = [];
      for (const s of missing) {
        if (s.startsWith("?")) optional.push(stripOptionalPrefix(s));
        else required.push(s);
      }

      const lines: string[] = [];
      if (required.length > 0) {
        lines.push(
          `Load the following skills before proceeding:\n${required.map(s => `  - Skill("${s}")`).join("\n")}`,
        );
      }
      if (optional.length > 0) {
        lines.push(
          `Load these skills if available (skip if not found):\n${optional.map(s => `  - Skill("${s}")`).join("\n")}`,
        );
      }
      lines.push("After loading all skills, transition to continue.");

      const parts: string[] = [];
      if (actionPrompt) parts.push(actionPrompt);
      if (state.prompt) parts.push(state.prompt);
      parts.push(lines.join("\n\n"));
      return this._buildStatus(session, taskOps, parts.join("\n\n"));
    }

    // All skills loaded — auto-transition through
    const transitions = state.transitions ?? {};
    const transitionNames = Object.keys(transitions);
    if (transitionNames.length === 0) {
      throw new Error(`Skill gate state has no transitions defined`);
    }

    const transitionName = transitionNames[0];

    const frame = session.stack[session.active_frame];
    const wf = this._getWorkflow(session.session_id, frame.workflow);
    const maxTransitions = wf.max_transitions ?? DEFAULT_MAX_TRANSITIONS;
    if (frame.total_transitions >= maxTransitions) {
      throw new Error(
        `Max transitions (${maxTransitions}) reached for workflow "${frame.workflow}"`,
      );
    }

    const {
      name: targetStateName,
      state: resolvedTarget,
      visits: targetVisits,
      exhausted,
    } = this._enterTarget(session, frame, transitions[transitionName]);

    const now = new Date().toISOString();
    const updatedFrame: StackFrame = {
      ...frame,
      current_state: targetStateName,
      state_visits: { ...frame.state_visits, [targetStateName]: targetVisits },
      total_transitions: frame.total_transitions + 1,
    };

    const historyEntry: HistoryEntry = {
      frame: session.active_frame,
      from: frame.current_state,
      to: targetStateName,
      event: "skill_gate",
      at: now,
      ...(exhausted ? { detail: exhausted } : {}),
    };

    const globalKey = `${frame.workflow}:${targetStateName}`;
    const prevGlobal = session.global_state_visits ?? {};

    let updated: SessionState = {
      ...session,
      stack: session.stack.map((f, i) => (i === session.active_frame ? updatedFrame : f)),
      updated_at: now,
      history: [...session.history, historyEntry],
      global_state_visits: { ...prevGlobal, [globalKey]: (prevGlobal[globalKey] ?? 0) + 1 },
    };

    await this._storage.write(session.session_id, updated);

    if (resolvedTarget?.terminal) {
      const hasTransitions =
        resolvedTarget.transitions && Object.keys(resolvedTarget.transitions).length > 0;
      if (!hasTransitions) {
        const outcome = resolvedTarget.outcome === "fail" ? "fail" : "complete";
        return this._popStack(updated, outcome, taskOps);
      }
      updated = { ...updated, soft_terminal: true };
      await this._storage.write(session.session_id, updated);
      return this._buildStatus(updated, taskOps, actionPrompt);
    }

    if (this._isSkillGate(resolvedTarget)) {
      return this._handleSkillGate(updated, resolvedTarget!, taskOps, depth + 1, actionPrompt);
    }

    if (resolvedTarget?.sub_workflow) {
      return this._pushSubWorkflow(updated, resolvedTarget, taskOps);
    }

    if (this._isActionState(resolvedTarget)) {
      return this._executeActionState(updated, resolvedTarget!, taskOps);
    }

    return this._buildStatus(updated, taskOps, actionPrompt);
  }

  /**
   * The state a move into `requested` enters. Past its max_visits the move
   * follows that state's `on_exhausted` route, and on through the next one's
   * while it is exhausted too; a state without the route refuses the move.
   */
  private _enterTarget(session: SessionState, frame: StackFrame, requested: string): EnteredTarget {
    const passed: string[] = [];
    let name = requested;
    let state = this._resolveState(session, frame.workflow, name);
    let visits = (frame.state_visits[name] ?? 0) + 1;
    while (state?.max_visits && visits > state.max_visits) {
      const next = state.on_exhausted;
      if (!next) throw new Error(`State "${name}" max_visits (${state.max_visits}) exceeded`);
      passed.push(name);
      if (passed.includes(next))
        throw new Error(`on_exhausted routes loop: ${[...passed, next].join(" → ")}`);
      name = next;
      state = this._resolveState(session, frame.workflow, name);
      visits = (frame.state_visits[name] ?? 0) + 1;
    }
    const exhausted =
      passed.length > 0 ? `max_visits exhausted: ${passed.join(", ")} → ${name}` : undefined;
    return { name, state, visits, exhausted };
  }

  private _buildTemplateVars(session: SessionState): Record<string, unknown> {
    // visits/root_workflow let action states route on engine-known facts
    // (fix loops taken, running as a spawned sub-agent) with no agent turn.
    const vars: Record<string, unknown> = {
      session_id: session.session_id,
      parent_session_id: session.parent_session_id ?? "",
      context: session.context,
      visits: session.stack[session.active_frame].state_visits,
      root_workflow: session.stack[0].workflow,
    };
    const ar = session.last_action_result;
    if (ar) {
      if (ar.stdout !== undefined) vars.stdout = ar.stdout;
      if (ar.stderr !== undefined) vars.stderr = ar.stderr;
      if (ar.exit_code !== undefined) vars.exit_code = ar.exit_code;
      if (ar.status !== undefined) vars.status = ar.status;
      if (ar.body !== undefined) vars.body = ar.body;
      if (ar.error !== undefined) vars.error = ar.error;
      if (ar.pid !== undefined) vars.pid = ar.pid;
      if (ar.wait_ms !== undefined) vars.wait_ms = ar.wait_ms;
    }
    return vars;
  }

  /**
   * Run an action state and route its result. `adopt` = the foreground exec
   * a previous server left running in this state (`resume`): its result is
   * taken over, and the state runs again only when it left none.
   */
  private async _executeActionState(
    session: SessionState,
    state: StateDefinition,
    taskOps: TaskOp[],
    depth: number = 0,
    adopt?: RunningExec,
  ): Promise<StatusResult> {
    const id = session.session_id;
    // the outermost call of a chain owns the mark until its routed write is done
    if (this._inFlight.has(id)) return this._runActionState(session, state, taskOps, depth, adopt);
    this._inFlight.add(id);
    try {
      return await this._runActionState(session, state, taskOps, depth, adopt);
    } finally {
      this._inFlight.delete(id);
    }
  }

  private async _runActionState(
    session: SessionState,
    state: StateDefinition,
    taskOps: TaskOp[],
    depth: number,
    adopt: RunningExec | undefined,
  ): Promise<StatusResult> {
    if (depth >= MAX_ACTION_CHAIN) {
      throw new Error(`Action chain exceeded max depth (${MAX_ACTION_CHAIN})`);
    }

    const vars = this._buildTemplateVars(session);
    const frameIndex = session.active_frame;
    const stateName = session.stack[frameIndex].current_state;
    // Recorded in the session while it runs, so a server that exits mid-exec
    // leaves a resume what it needs to take the run over.
    let run: DetachedRun | undefined;
    // A lease granted after the session left this server (suspended, picked up
    // by another process) is given back: the new owner runs the step.
    let refused = false;
    const phaseSink: { set?: (phase: ExecPhase) => void } = {};
    const execCtx: ExecContext = {
      ...this._execContext(session),
      onPhase: phase => phaseSink.set?.(phase),
      mayStart: () => {
        const cur = this._storage.read(session.session_id);
        const mine =
          !!cur &&
          cur.stack.length > 0 &&
          !cur.suspended_at &&
          cur.context.claude_code_pid === session.context.claude_code_pid;
        if (!mine) refused = true;
        return mine;
      },
      onDetached: async detached => {
        run = detached;
        const record: RunningExec = { ...detached, frame: frameIndex, state: stateName };
        await this._storage.update(session.session_id, cur =>
          cur && cur.stack.length > 0 ? { ...cur, running_exec: record } : null,
        );
      },
    };
    const own =
      adopt && adopt.frame === frameIndex && adopt.state === stateName ? adopt : undefined;
    // Recorded before the exec waits for a lease or spawns: a server gone before
    // `running_exec` is written leaves its new owner the step to run again.
    const mark = session.pending_action;
    if (mark?.frame !== frameIndex || mark.state !== stateName) {
      const pending: PendingAction = {
        frame: frameIndex,
        state: stateName,
        at: new Date().toISOString(),
      };
      await this._storage.update(session.session_id, cur =>
        cur && cur.stack.length > 0 ? { ...cur, pending_action: pending } : null,
      );
    }
    let result: ActionResult | null;
    // tells the waiting tool call's client the exec is alive (only when it asked for progress)
    const beat = startHeartbeat(currentProgress(), stateName);
    phaseSink.set = beat.setPhase;
    try {
      result = own ? await this._executor.adopt(own, state, execCtx) : null;
      if (own) run = own;
      if (!result) {
        if (own) Executor.discardRun(own);
        if (this._aborting.has(session.session_id))
          throw new Error(
            `Session "${session.session_id}" ended while its action state ran (aborting)`,
          );
        result = await this._executor.execute(state, vars, execCtx);
      }
    } catch (err) {
      // the step failed in this live server: nothing for a later owner to run again
      await this._storage.update(session.session_id, cur =>
        cur?.pending_action &&
        !cur.suspended_at &&
        cur.context.claude_code_pid === session.context.claude_code_pid
          ? { ...cur, pending_action: undefined }
          : null,
      );
      throw err;
    } finally {
      beat.stop();
    }
    // its aborted-wait result must not route: the session is another owner's now
    if (refused)
      throw new Error(
        `Session "${session.session_id}" is no longer this server's to run: its step was not started; the owner that took it over runs it`,
      );

    // An exec can run for seconds, and other writers land meanwhile: a
    // parent's abort cascade (writing the pre-exec copy back would resurrect
    // an abandoned session) or a context_set for this session. Narrows the
    // race to one write's latency; a storage-level compare-and-set would
    // close it.
    const current = this._storage.read(session.session_id);
    const aborting = this._aborting.has(session.session_id);
    if (!current || current.stack.length === 0 || aborting) {
      if (result.pid) killProcessGroup(result.pid);
      if (run) Executor.discardRun(run);
      const why = !current ? "deleted" : current.stack.length === 0 ? current.outcome : "aborting";
      throw new Error(`Session "${session.session_id}" ended while its action state ran (${why})`);
    }
    // Suspended, or resumed by another process meanwhile: the run's files stay
    // for whoever resumes it — routing here would race that process.
    if (
      current.suspended_at ||
      current.context.claude_code_pid !== session.context.claude_code_pid
    ) {
      const why = current.suspended_at
        ? "suspended"
        : `taken over by PID ${current.context.claude_code_pid}`;
      throw new Error(
        `Session "${session.session_id}" was ${why} while its action state ran; resume() takes its result over`,
      );
    }

    // Determine target state
    let routedName: string | undefined;
    let detail: string;

    if (
      state.on_timeout !== undefined &&
      result.type === "exec" &&
      result.exit_code === EXIT_CODE_TIMEOUT
    ) {
      // a run cut by its timeout is not a failure of the work: its own route
      routedName = state.on_timeout;
      detail = `exit ${EXIT_CODE_TIMEOUT} (timeout)`;
    } else if (state.cases) {
      const key =
        result.type === "exec" ? String(result.exit_code ?? 1) : String(result.status ?? 0);
      routedName = state.cases[key] ?? state.default;
      detail =
        result.type === "exec" ? `exit ${result.exit_code}` : `HTTP ${result.status ?? "err"}`;
    } else {
      routedName = result.success ? state.on_success : state.on_error;
      detail =
        result.type === "exec"
          ? `exit ${result.exit_code ?? "?"}`
          : result.success
            ? `HTTP ${result.status}`
            : (result.error ?? "error");
    }

    // A result that cannot be routed is reported, not kept for a resume to retake.
    const unroutable = async (err: Error): Promise<never> => {
      if (run) Executor.discardRun(run);
      await this._storage.update(session.session_id, cur =>
        cur?.running_exec || cur?.pending_action
          ? { ...cur, running_exec: undefined, pending_action: undefined }
          : null,
      );
      throw err;
    };

    if (!routedName) {
      return unroutable(
        new Error(
          `Action state has no target for result: ${detail}. ` +
            `Configure cases/default or on_success/on_error.`,
        ),
      );
    }

    const frame = session.stack[session.active_frame];
    const now = new Date().toISOString();

    // Check max_transitions
    const wf = this._getWorkflow(session.session_id, frame.workflow);
    const maxTransitions = wf.max_transitions ?? DEFAULT_MAX_TRANSITIONS;
    if (frame.total_transitions >= maxTransitions) {
      return unroutable(
        new Error(`Max transitions (${maxTransitions}) reached for workflow "${frame.workflow}"`),
      );
    }

    let entered: EnteredTarget;
    try {
      entered = this._enterTarget(session, frame, routedName);
    } catch (err) {
      return unroutable(err as Error);
    }
    const { name: targetStateName, visits: targetVisits, exhausted } = entered;

    // A rerouted move shows the exhausted-route state's own prompt: the action's
    // prompt was written for the state it routes to by default.
    const promptTemplate = exhausted
      ? undefined
      : result.success
        ? state.success_prompt
        : state.error_prompt;
    const actionPrompt = promptTemplate
      ? render(promptTemplate, { ...vars, ...result })
      : undefined;

    const updatedFrame: StackFrame = {
      ...frame,
      current_state: targetStateName,
      state_visits: { ...frame.state_visits, [targetStateName]: targetVisits },
      total_transitions: frame.total_transitions + 1,
    };

    const historyEntry: HistoryEntry = {
      frame: session.active_frame,
      from: frame.current_state,
      to: targetStateName,
      event: "action",
      detail: exhausted ? `${detail}; ${exhausted}` : detail,
      at: now,
      ...(result.type === "exec" && result.exit_code !== undefined
        ? { exit_code: result.exit_code }
        : {}),
      ...(result.duration_ms !== undefined ? { duration_ms: result.duration_ms } : {}),
      ...(result.wait_ms !== undefined ? { wait_ms: result.wait_ms } : {}),
      ...(result.threads_granted !== undefined ? { threads_granted: result.threads_granted } : {}),
      // The time-model key of a leased step: project (the session cwd's git root) | workflow | state.
      ...(state.resource || state.fanout
        ? { step_key: `${execCtx.project}|${frame.workflow}|${frame.current_state}` }
        : {}),
      ...(result.shards ? { shards: result.shards } : {}),
    };

    const globalKey = `${frame.workflow}:${targetStateName}`;
    const prevGlobal = session.global_state_visits ?? {};

    // Save background PID if applicable
    let bgPids = session.background_pids;
    if (result.pid) {
      bgPids = { ...(bgPids ?? {}), [`${frame.current_state}:${Date.now()}`]: result.pid };
    }

    // Auto context_set from action state definition (rendered with action result vars).
    // Based on the re-read copy: a context_set that landed during the exec survives.
    let ctx = current.context;
    if (result.success && state.context_set) {
      const renderVars = { ...vars, ...result };
      const entries = Object.entries(state.context_set).map(
        ([k, v]) => [k, render(v, renderVars)] as const,
      );
      ctx = { ...ctx, ...Object.fromEntries(entries) };
    }

    let updated: SessionState = {
      ...session,
      context: ctx,
      // set_priority runs outside the session's queue: the level written during the exec wins.
      ...(current.priority ? { priority: current.priority } : {}),
      // so do link_agent and the conversation id a resume stamps
      agent_id: current.agent_id,
      claude_session_id: current.claude_session_id,
      stack: session.stack.map((f, i) => (i === session.active_frame ? updatedFrame : f)),
      updated_at: now,
      history: [...session.history, historyEntry],
      global_state_visits: { ...prevGlobal, [globalKey]: (prevGlobal[globalKey] ?? 0) + 1 },
      last_action_result: result,
      background_pids: bgPids,
      running_exec: undefined,
      pending_action: undefined,
    };

    await this._storage.write(session.session_id, updated);
    if (run) Executor.discardRun(run);

    // Check target state
    const targetState = this._resolveState(updated, frame.workflow, targetStateName);

    if (targetState?.terminal) {
      const hasTransitions =
        targetState.transitions && Object.keys(targetState.transitions).length > 0;
      if (!hasTransitions) {
        const outcome = targetState.outcome === "fail" ? "fail" : "complete";
        return this._popStack(updated, outcome, taskOps);
      }
      updated = { ...updated, soft_terminal: true };
      await this._storage.write(session.session_id, updated);
      return this._buildStatus(updated, taskOps, actionPrompt);
    }

    if (this._isSkillGate(targetState)) {
      return this._handleSkillGate(updated, targetState!, taskOps, 0, actionPrompt);
    }

    if (targetState?.sub_workflow) {
      return this._pushSubWorkflow(updated, targetState, taskOps);
    }

    // Chain: if target is also an action state, recurse
    if (this._isActionState(targetState)) {
      return this._executeActionState(updated, targetState!, taskOps, depth + 1);
    }

    return this._buildStatus(updated, taskOps, actionPrompt);
  }

  private async _pushSubWorkflow(
    session: SessionState,
    state: StateDefinition,
    taskOps?: TaskOp[],
  ): Promise<StatusResult> {
    const subName = state.sub_workflow!;
    const wf = this._getWorkflow(session.session_id, subName);

    if (session.stack.length >= MAX_STACK_DEPTH) {
      throw new Error(`Max stack depth (${MAX_STACK_DEPTH}) reached — cannot push "${subName}"`);
    }

    const now = new Date().toISOString();
    const newFrame: StackFrame = {
      workflow: subName,
      current_state: wf.initial,
      state_visits: { [wf.initial]: 1 },
      total_transitions: 0,
    };

    const newStack = [...session.stack, newFrame];
    const globalKey = `${subName}:${wf.initial}`;
    const prevGlobal = session.global_state_visits ?? {};
    const updated: SessionState = {
      ...session,
      stack: newStack,
      active_frame: newStack.length - 1,
      updated_at: now,
      history: [
        ...session.history,
        { frame: newStack.length - 1, event: "push", workflow: subName, at: now },
      ],
      global_state_visits: { ...prevGlobal, [globalKey]: (prevGlobal[globalKey] ?? 0) + 1 },
    };

    await this._storage.write(session.session_id, updated);

    // Check if the initial state of sub_workflow is itself a skill gate, sub_workflow, or action
    const initialState = this._resolveState(updated, subName, wf.initial);
    if (this._isSkillGate(initialState)) {
      return this._handleSkillGate(updated, initialState!, taskOps ?? []);
    }
    if (initialState?.sub_workflow) {
      return this._pushSubWorkflow(updated, initialState, taskOps);
    }
    if (this._isActionState(initialState)) {
      return this._executeActionState(updated, initialState!, taskOps ?? []);
    }

    return this._buildStatus(updated, taskOps);
  }

  /**
   * Pop after entering a hard terminal state. Renders the terminal state's
   * prompt (if any) and prepends it to the resulting status prompt so final
   * instructions (report contracts, push steps) are not discarded — both on
   * pop-to-parent and on root completion.
   */
  private async _popStack(
    session: SessionState,
    outcome: "complete" | "fail",
    taskOps?: TaskOp[],
  ): Promise<StatusResult> {
    const frame = session.stack[session.active_frame];
    const terminalState = this._resolveState(session, frame.workflow, frame.current_state);
    const terminalPrompt = terminalState?.prompt
      ? render(terminalState.prompt, this._buildTemplateVars(session))
      : undefined;

    const result = await this._popStackCore(session, outcome, taskOps);
    if (!terminalPrompt) return result;

    // Parked (pending_pop): the status already shows the terminal state's own
    // prompt — prepending would duplicate it. The retry re-enters this wrapper.
    if (this._storage.read(session.session_id)?.pending_pop) return result;

    return {
      ...result,
      prompt: `${terminalPrompt}${TERMINAL_PROMPT_DIVIDER}${result.prompt}`,
      // The terminal prompt is new information even when the parent state is
      // a revisit — bypass the revisit compression in the tool formatter.
      forcePrompt: true,
    };
  }

  private async _popStackCore(
    session: SessionState,
    outcome: "complete" | "fail",
    taskOps?: TaskOp[],
  ): Promise<StatusResult> {
    const now = new Date().toISOString();

    if (session.stack.length <= 1) {
      // Guard: block completion if child sessions are still active
      const activeChildren = this._getActiveChildren(session.session_id);
      if (activeChildren.length > 0) {
        const parked: SessionState = {
          ...session,
          pending_pop: { outcome },
          updated_at: now,
        };
        await this._storage.write(session.session_id, parked);
        throw new Error(this._formatChildrenBlockError(session.session_id, activeChildren));
      }

      // Top-level workflow ended: a failure terminal keeps its outcome
      const updated: SessionState = {
        ...session,
        stack: [],
        active_frame: -1,
        updated_at: now,
        history: [...session.history, { frame: 0, event: outcome, at: now }],
        outcome: outcome === "fail" ? "failed" : "completed",
      };
      await this._storage.write(session.session_id, updated);
      await this._finalize(updated);
      await this._cascadeAbandonChildren(session.session_id);
      this._pruneTerminal();
      return this._buildStatus(updated, taskOps);
    }

    // Pop current frame, return to parent
    const newStack = session.stack.slice(0, -1);
    const parentIdx = newStack.length - 1;
    const parentFrame = newStack[parentIdx];
    const parentWf = this._getWorkflow(session.session_id, parentFrame.workflow);
    const parentState = this._resolveState(
      session,
      parentFrame.workflow,
      parentFrame.current_state,
    );

    // Determine next state in parent
    const nextStateName = outcome === "complete" ? parentState?.on_complete : parentState?.on_fail;
    if (!nextStateName) {
      // Parent doesn't have on_complete/on_fail yet — park as pending_pop.
      // modify can add it later, which will retry the pop.
      const parked: SessionState = {
        ...session,
        pending_pop: { outcome },
        updated_at: now,
      };
      await this._storage.write(session.session_id, parked);
      return this._buildStatus(parked, taskOps);
    }

    const nextVisits = (parentFrame.state_visits[nextStateName] ?? 0) + 1;
    const updatedParent: StackFrame = {
      ...parentFrame,
      current_state: nextStateName,
      state_visits: { ...parentFrame.state_visits, [nextStateName]: nextVisits },
      total_transitions: parentFrame.total_transitions + 1,
    };

    newStack[parentIdx] = updatedParent;

    const globalKey = `${parentFrame.workflow}:${nextStateName}`;
    const prevGlobal = session.global_state_visits ?? {};
    const updated: SessionState = {
      ...session,
      stack: newStack,
      active_frame: parentIdx,
      updated_at: now,
      history: [
        ...session.history,
        { frame: session.active_frame, event: "pop", at: now },
        {
          frame: parentIdx,
          from: parentFrame.current_state,
          to: nextStateName,
          via: `on_${outcome}`,
          at: now,
        },
      ],
      global_state_visits: { ...prevGlobal, [globalKey]: (prevGlobal[globalKey] ?? 0) + 1 },
    };

    await this._storage.write(session.session_id, updated);

    // Check if the new parent state is also a sub_workflow or terminal
    const nextState = this._resolveState(updated, parentFrame.workflow, nextStateName);
    if (nextState?.terminal) {
      const hasTransitions = nextState.transitions && Object.keys(nextState.transitions).length > 0;
      if (!hasTransitions) {
        // Pre-check: if recursive pop would reach top-level, guard children
        if (updated.stack.length === 1) {
          const activeChildren = this._getActiveChildren(session.session_id);
          if (activeChildren.length > 0) {
            const nextOutcome = nextState.outcome === "fail" ? "fail" : "complete";
            const parked: SessionState = {
              ...updated,
              pending_pop: { outcome: nextOutcome },
              updated_at: now,
            };
            await this._storage.write(session.session_id, parked);
            throw new Error(this._formatChildrenBlockError(session.session_id, activeChildren));
          }
        }
        const nextOutcome = nextState.outcome === "fail" ? "fail" : "complete";
        return this._popStack(updated, nextOutcome, taskOps);
      }
      // Soft terminal in parent after pop
      const softUpdated = { ...updated, soft_terminal: true };
      await this._storage.write(session.session_id, softUpdated);
      return this._buildStatus(softUpdated, taskOps);
    }
    if (this._isSkillGate(nextState)) {
      return this._handleSkillGate(updated, nextState!, taskOps ?? []);
    }

    if (nextState?.sub_workflow) {
      return this._pushSubWorkflow(updated, nextState, taskOps);
    }

    if (this._isActionState(nextState)) {
      return this._executeActionState(updated, nextState!, taskOps ?? []);
    }

    return this._buildStatus(updated, taskOps);
  }

  private _formatChildrenBlockError(
    parentSessionId: string,
    activeChildren?: SessionState[],
  ): string {
    const children = activeChildren ?? this._getActiveChildren(parentSessionId);
    const details = children
      .map(c => {
        const f = c.stack[c.active_frame];
        return `  - ${c.session_id}: ${f.workflow} @ ${f.current_state} (${f.total_transitions} transitions)`;
      })
      .join("\n");
    return (
      `Cannot complete: ${children.length} child session(s) still active:\n${details}\n` +
      `Abort them via abort or investigate why they didn't finish.`
    );
  }

  private _getActiveChildren(parentSessionId: string): SessionState[] {
    return this._storage
      .readAll()
      .filter(s => s.parent_session_id === parentSessionId && s.stack.length > 0);
  }

  private async _cascadeAbandonChildren(parentSessionId: string): Promise<void> {
    const now = new Date().toISOString();
    const children = this._getActiveChildren(parentSessionId);
    for (const child of children) {
      this._killSessionProcesses(child);
      const updated: SessionState = {
        ...child,
        stack: [],
        active_frame: -1,
        updated_at: now,
        history: [
          ...child.history,
          { frame: child.active_frame, event: "cascade_abandon", at: now },
        ],
        outcome: "abandoned",
      };
      await this._storage.write(child.session_id, updated);
      await this._finalize(updated);
      await this._cascadeAbandonChildren(child.session_id);
    }
  }

  /**
   * A session just ended (its final state is written): drop its cached
   * snapshot and append its ledger line. A ledger failure never fails the end.
   */
  private async _finalize(session: SessionState): Promise<void> {
    this._snapshots.delete(session.session_id);
    this._aborting.delete(session.session_id);
    try {
      await this._storage.appendLedger(ledgerEntry(session));
    } catch (err) {
      console.error(`Ledger append failed for ${session.session_id}:`, err);
    }
  }

  private _execContext(session: SessionState): ExecContext {
    const cwd = typeof session.context.cwd === "string" ? session.context.cwd : undefined;
    const frame = session.stack[session.active_frame];
    return {
      sessionId: session.session_id,
      parentSessionId: session.parent_session_id,
      rootSessionId: rootSessionIdOf(session),
      cwd,
      level: session.priority ?? DEFAULT_PRIORITY_LEVEL,
      project: projectRoot(cwd ?? process.cwd()),
      step: `${frame.workflow}/${frame.current_state}`,
    };
  }

  /**
   * Cap retained terminal sessions so the state dir keeps only the most
   * recent few for history. Call once after a finalize + its cascade, not
   * per child — a full STATE_DIR scan per child is quadratic.
   */
  private _pruneTerminal(): void {
    this._storage.pruneTerminal(KEEP_TERMINAL_SESSIONS);
  }

  private _getProjectWorkflows(sessionId: string): Array<{ name: string; description?: string }> {
    const snapshot = this._snapshots.get(sessionId);
    const workflows = snapshot ?? this._loader.getAll();
    const result: Array<{ name: string; description?: string }> = [];
    for (const [name, wf] of workflows) {
      if (!Engine.GLOBAL_WORKFLOWS.has(name)) result.push({ name, description: wf.description });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  private _getWorkflow(sessionId: string, name: string): WorkflowDefinition {
    // Try snapshot first, fallback to loader. No snapshot (a session this server neither started nor
    // resumed) and a project of its own: that project's workflows become its snapshot.
    let snapshot = this._snapshots.get(sessionId);
    if (!snapshot) {
      const session = this._storage.read(sessionId);
      const own = session ? this._projectLoaderAt(Engine._cwdOf(session)) : undefined;
      if (own) this._snapshots.set(sessionId, (snapshot = this._overlay(own)));
    }
    const wf = snapshot?.get(name) ?? this._loader.get(name);
    if (!wf) throw new Error(`Workflow "${name}" not found`);
    return wf;
  }

  /**
   * The workflows a session started in `cwd` sees: the server's, with the workflows the project of
   * `cwd` defines itself laid over them by name — when that project (a worktree counts as its main
   * checkout) has a `.claude/workflows/` that is neither the server's project tier nor its global one.
   */
  private _workflowsAt(cwd: string | undefined): Map<string, WorkflowDefinition> {
    const own = this._projectLoaderAt(cwd);
    return own ? this._overlay(own) : this._loader.getAll();
  }

  private _overlay(own: Loader): Map<string, WorkflowDefinition> {
    const all = this._loader.getAll();
    for (const [name, wf] of own.projectWorkflows()) all.set(name, wf);
    return all;
  }

  /** The loader of `cwd`'s project when it has workflows of its own the server does not load. */
  private _projectLoaderAt(cwd: string | undefined): Loader | undefined {
    if (cwd === undefined) return undefined;
    const dir = path.join(projectRoot(cwd), ".claude", "workflows");
    if (dir === this._loader.projectDir || dir === this._loader.globalDir) return undefined;
    return fs.existsSync(dir) ? this._loader.forProject(dir) : undefined;
  }

  private static _cwdOf(session: SessionState): string | undefined {
    return typeof session.context.cwd === "string" ? session.context.cwd : undefined;
  }

  private _resolveState(
    session: SessionState,
    workflowName: string,
    stateName: string,
  ): StateDefinition | undefined {
    // Check added states first (they may not exist in base YAML)
    const overrides = session.overrides[workflowName];
    if (overrides?.add_states?.[stateName]) {
      return overrides.add_states[stateName];
    }

    const wf = this._getWorkflow(session.session_id, workflowName);
    const base = wf.states[stateName];
    if (!base) return undefined;

    // Apply overrides
    if (!overrides) return base;

    // Check modified states
    const mods = overrides.modify_states?.[stateName];
    if (!mods) {
      // Apply transition overrides
      return this._applyTransitionOverrides(base, workflowName, stateName, overrides);
    }

    const merged = { ...base, ...mods };
    return this._applyTransitionOverrides(merged, workflowName, stateName, overrides);
  }

  private _applyTransitionOverrides(
    state: StateDefinition,
    _workflowName: string,
    stateName: string,
    overrides: WorkflowOverrides,
  ): StateDefinition {
    let transitions = { ...(state.transitions ?? {}) };

    // Add transitions
    if (overrides.add_transitions) {
      for (const t of overrides.add_transitions) {
        if (t.from === stateName) transitions[t.name] = t.to;
      }
    }

    // Remove transitions
    if (overrides.remove_transitions) {
      for (const t of overrides.remove_transitions) {
        if (t.from === stateName) delete transitions[t.name];
      }
    }

    return { ...state, transitions };
  }

  /** What a session sitting in an action state is doing there: an action state has no prompt of its own. */
  private _actionNote(session: SessionState, state: StateDefinition): string {
    const frame = session.stack[session.active_frame];
    const head = `[${state.type} state "${frame.current_state}"`;
    if (this._inFlight.has(session.session_id))
      return `${head}: running in this server — its result moves the session on]`;
    const here = (at?: { frame: number; state: string }): boolean =>
      at?.frame === session.active_frame && at.state === frame.current_state;
    const owner = session.context.claude_code_pid;
    if (here(session.running_exec) || here(session.pending_action)) {
      if (
        !session.suspended_at &&
        typeof owner === "number" &&
        owner !== process.ppid &&
        Engine._isPidAlive(owner)
      )
        return `${head}: running in PID ${owner}]`;
      return `${head}: begun by a server that is gone — ${session.suspended_at ? "resume()" : "status() / transition() of this session"} takes it over or runs it again]`;
    }
    return `${head}: not running — its last run was not routed; resume({ session_id: "${session.session_id}" }) runs it again]`;
  }

  private _buildStatus(
    session: SessionState,
    taskOps?: TaskOp[],
    actionPrompt?: string,
  ): StatusResult {
    if (session.stack.length === 0) {
      const outcome: SessionOutcome = session.outcome ?? "completed";
      const msg = `Workflow ${outcome}.`;
      const stateName = `(${outcome})`;
      return {
        sessionId: session.session_id,
        stack: [],
        activeFrame: -1,
        currentState: { prompt: msg, terminal: true },
        currentStateName: stateName,
        currentWorkflow: "(none)",
        availableTransitions: {},
        prompt: msg,
        history: session.history,
        context: session.context,
        taskOps: taskOps ?? [],
        visitCount: 0,
      };
    }

    const frame = session.stack[session.active_frame];
    const state = this._resolveState(session, frame.workflow, frame.current_state);
    const vars = this._buildTemplateVars(session);
    const rawPrompt =
      actionPrompt ??
      state?.prompt ??
      (this._isActionState(state)
        ? this._actionNote(session, state!)
        : `[sub_workflow: ${state?.sub_workflow ?? "unknown"}]`);
    let prompt = render(rawPrompt, vars);

    if (state?.include_workflows) {
      const projectWorkflows = this._getProjectWorkflows(session.session_id);
      if (projectWorkflows.length > 0) {
        prompt +=
          "\n\nAvailable workflows:\n" +
          projectWorkflows
            .map(w => `- ${w.name} — ${w.description ?? "(no description)"}`)
            .join("\n");
      }
    }

    const currentTaskOps = [...(taskOps ?? [])];
    if (state?.task) {
      currentTaskOps.push({ action: "create", subject: state.task });
    }

    return {
      sessionId: session.session_id,
      stack: session.stack,
      activeFrame: session.active_frame,
      currentState: state ?? { prompt: "Unknown state" },
      currentStateName: frame.current_state,
      currentWorkflow: frame.workflow,
      availableTransitions: state?.transitions ?? {},
      prompt,
      history: session.history,
      context: session.context,
      taskOps: currentTaskOps,
      visitCount:
        session.global_state_visits?.[`${frame.workflow}:${frame.current_state}`] ??
        frame.state_visits[frame.current_state] ??
        0,
      forcePrompt: actionPrompt !== undefined,
    };
  }
}
