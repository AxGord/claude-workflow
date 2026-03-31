import { randomBytes } from "node:crypto";
import type {
  SessionState,
  StackFrame,
  HistoryEntry,
  WorkflowDefinition,
  StateDefinition,
  WorkflowOverrides,
  ActionResult,
} from "./types.js";
import { MAX_STACK_DEPTH, DEFAULT_MAX_TRANSITIONS } from "./types.js";
import type { Storage } from "./storage.js";
import type { Loader } from "./loader.js";
import type { Executor } from "./executor.js";
import { render } from "./template.js";

function stripOptionalPrefix(s: string): string {
  return s.replace(/^\?/, '');
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

const MAX_ACTION_CHAIN = 20;

export class Engine {
  private static readonly GLOBAL_WORKFLOWS = new Set([
    "coding", "debugging", "bug-fix", "new-feature", "code-review",
    "explore", "web-research", "planning", "testing", "reflection",
    "investigate", "master", "file-code", "file-review", "subagent", "review-push",
  ]);

  private readonly _storage: Storage;
  private readonly _loader: Loader;
  private readonly _executor: Executor;
  // Snapshot: sessions keep the workflow version they started with
  private readonly _snapshots: Map<string, Map<string, WorkflowDefinition>> = new Map();

  constructor(storage: Storage, loader: Loader, executor: Executor) {
    this._storage = storage;
    this._loader = loader;
    this._executor = executor;
  }

  /** Find the most recently updated active session for the current Claude Code PID. */
  public resolveSessionId(sessionId?: string): string {
    if (sessionId) return sessionId;
    const pid = process.ppid;
    const active = this._storage.readAll().filter(
      s => s.context.claude_code_pid === pid && s.stack.length > 0
    );
    if (active.length === 0) throw new Error("No active session found. Call start first.");
    active.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
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
  public assertOwnership(sessionId: string, force?: boolean): string | undefined {
    const session = this._storage.read(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    const ownerPid = session.context.claude_code_pid;
    const currentPid = process.ppid;
    if (ownerPid !== undefined && ownerPid !== currentPid) {
      if (!force) {
        throw new Error(`Session "${sessionId}" belongs to PID ${ownerPid} (current: ${currentPid}). Use force: true to override.`);
      }
      if (Engine._isPidAlive(ownerPid as number)) {
        return `Warning: session "${sessionId}" belongs to PID ${ownerPid} which is still alive. Proceeding due to force: true.`;
      }
    }
  }

  public async start(workflowName: string, actor?: string, parentSessionId?: string): Promise<StatusResult> {
    // Guard: prevent duplicate top-level sessions from the same Claude Code process.
    // Sub-agent sessions (with parent_session_id) are exempt — they run alongside the parent.
    if (!parentSessionId) {
      const pid = process.ppid;
      const active = this._storage.readAll().filter(
        s => s.context.claude_code_pid === pid && !s.parent_session_id && s.stack.length > 0
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
          prompt: `Session already active: ${existing.session_id} (${frame.workflow} @ ${frame.current_state}). `
            + `If you are a sub-agent, pass parent_session_id to start your own session. `
            + `If you lost context, call status() to re-read the full prompt.`,
        };
      }
    }

    let sessionId: string;
    do {
      sessionId = randomBytes(4).toString("hex");
    } while (this._storage.read(sessionId));
    const wf = this._loader.get(workflowName);
    if (!wf) throw new Error(`Workflow "${workflowName}" not found`);

    // Snapshot all workflows for this session
    this._snapshots.set(sessionId, this._loader.getAll());

    const now = new Date().toISOString();
    const frame: StackFrame = {
      workflow: workflowName,
      current_state: wf.initial,
      state_visits: { [wf.initial]: 1 },
      total_transitions: 0,
    };

    const globalKey = `${workflowName}:${wf.initial}`;
    const session: SessionState = {
      session_id: sessionId,
      ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
      stack: [frame],
      active_frame: 0,
      started_at: now,
      updated_at: now,
      history: [{ frame: 0, event: "start", workflow: workflowName, at: now, actor }],
      overrides: {},
      context: { claude_code_pid: process.ppid, cwd: process.cwd() },
      global_state_visits: { [globalKey]: 1 },
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

  public async transition(sessionId: string, transitionName: string, actor?: string): Promise<StatusResult> {
    const session = this._storage.read(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    if (session.stack.length === 0) throw new Error(`Session "${sessionId}" has no active workflow`);

    // Session is waiting for children to complete — try to resolve
    if (session.pending_pop) {
      const result = await this.retryPendingPop(sessionId);
      if (result) return result;
      throw new Error(this._formatChildrenBlockError(sessionId));
    }

    const frame = session.stack[session.active_frame];
    const wf = this._getWorkflow(sessionId, frame.workflow);
    const state = this._resolveState(session, frame.workflow, frame.current_state);

    if (!state) throw new Error(`State "${frame.current_state}" not found in workflow "${frame.workflow}"`);
    // terminal states without transitions are truly final; with transitions they allow re-entry
    if (state.terminal && (!state.transitions || Object.keys(state.transitions).length === 0)) {
      throw new Error(`Cannot transition from terminal state "${frame.current_state}"`);
    }

    const transitions = state.transitions ?? {};
    const targetStateName = transitions[transitionName];
    if (!targetStateName) {
      const available = Object.keys(transitions).join(", ");
      throw new Error(`Transition "${transitionName}" not available. Available: ${available}`);
    }

    // Check max_transitions
    const maxTransitions = wf.max_transitions ?? DEFAULT_MAX_TRANSITIONS;
    if (frame.total_transitions >= maxTransitions) {
      throw new Error(`Max transitions (${maxTransitions}) reached for workflow "${frame.workflow}"`);
    }

    const now = new Date().toISOString();

    // Update frame
    const targetVisits = (frame.state_visits[targetStateName] ?? 0) + 1;
    const targetState = this._resolveState(session, frame.workflow, targetStateName);

    // Check max_visits
    if (targetState?.max_visits && targetVisits > targetState.max_visits) {
      throw new Error(
        `State "${targetStateName}" max_visits (${targetState.max_visits}) exceeded`
      );
    }

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
    };

    const globalKey = `${frame.workflow}:${targetStateName}`;
    const prevGlobal = session.global_state_visits ?? {};

    // Mark skill gate skills as loaded when transitioning from a skill gate state
    const skillUpdate = state?.skills?.length
      ? {
          loaded_skills: {
            ...(session.loaded_skills ?? {}),
            ...Object.fromEntries(state.skills.map(s => [stripOptionalPrefix(s), session.skill_epoch ?? 0])),
          },
        }
      : {};

    let updated: SessionState = {
      ...session,
      ...skillUpdate,
      stack: session.stack.map((f, i) => i === session.active_frame ? updatedFrame : f),
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
      const hasTransitions = targetState.transitions && Object.keys(targetState.transitions).length > 0;
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

  public async abort(sessionId: string): Promise<void> {
    const session = this._storage.read(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);

    // Kill background processes
    if (session.background_pids) {
      for (const [, pid] of Object.entries(session.background_pids)) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
      }
    }

    const now = new Date().toISOString();
    const updated: SessionState = {
      ...session,
      stack: [],
      active_frame: -1,
      updated_at: now,
      history: [...session.history, { frame: session.active_frame, event: "abort", at: now }],
      outcome: "abandoned",
    };

    await this._storage.write(sessionId, updated);
    this._snapshots.delete(sessionId);
    await this._cascadeAbandonChildren(sessionId);

    // If this was a child session, try to unblock the parent's pending completion
    if (session.parent_session_id) await this.retryPendingPop(session.parent_session_id);
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

  /** Abandon active sessions whose owner PID is no longer alive. */
  public async reapOrphanedSessions(): Promise<string[]> {
    const reaped: string[] = [];
    const active = this._storage.readAll().filter(s => s.stack.length > 0);
    for (const session of active) {
      const pid = session.context.claude_code_pid;
      if (pid === undefined || typeof pid !== "number") continue;
      if (!Engine._isPidAlive(pid)) {
        await this.abort(session.session_id);
        reaped.push(session.session_id);
      }
    }
    return reaped;
  }

  public async setContext(sessionId: string, key: string, value: unknown, actor?: string): Promise<void> {
    const session = this._storage.read(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);

    const now = new Date().toISOString();
    const updated: SessionState = {
      ...session,
      context: { ...session.context, [key]: value },
      updated_at: now,
      history: [...session.history, { frame: session.active_frame, event: "context_set", at: now, actor }],
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
    actionPrompt?: string
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
        if (s.startsWith('?')) optional.push(stripOptionalPrefix(s));
        else required.push(s);
      }

      const lines: string[] = [];
      if (required.length > 0) {
        lines.push(`Load the following skills before proceeding:\n${required.map(s => `  - Skill("${s}")`).join("\n")}`);
      }
      if (optional.length > 0) {
        lines.push(`Load these skills if available (skip if not found):\n${optional.map(s => `  - Skill("${s}")`).join("\n")}`);
      }
      lines.push('After loading all skills, transition to continue.');

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
    const targetStateName = transitions[transitionName];

    const frame = session.stack[session.active_frame];
    const wf = this._getWorkflow(session.session_id, frame.workflow);
    const maxTransitions = wf.max_transitions ?? DEFAULT_MAX_TRANSITIONS;
    if (frame.total_transitions >= maxTransitions) {
      throw new Error(`Max transitions (${maxTransitions}) reached for workflow "${frame.workflow}"`);
    }

    const targetVisits = (frame.state_visits[targetStateName] ?? 0) + 1;
    const resolvedTarget = this._resolveState(session, frame.workflow, targetStateName);
    if (resolvedTarget?.max_visits && targetVisits > resolvedTarget.max_visits) {
      throw new Error(`State "${targetStateName}" max_visits (${resolvedTarget.max_visits}) exceeded`);
    }

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
    };

    const globalKey = `${frame.workflow}:${targetStateName}`;
    const prevGlobal = session.global_state_visits ?? {};

    let updated: SessionState = {
      ...session,
      stack: session.stack.map((f, i) => i === session.active_frame ? updatedFrame : f),
      updated_at: now,
      history: [...session.history, historyEntry],
      global_state_visits: { ...prevGlobal, [globalKey]: (prevGlobal[globalKey] ?? 0) + 1 },
    };

    await this._storage.write(session.session_id, updated);

    if (resolvedTarget?.terminal) {
      const hasTransitions = resolvedTarget.transitions && Object.keys(resolvedTarget.transitions).length > 0;
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

  private _buildTemplateVars(session: SessionState): Record<string, unknown> {
    const vars: Record<string, unknown> = { context: session.context };
    const ar = session.last_action_result;
    if (ar) {
      if (ar.stdout !== undefined) vars.stdout = ar.stdout;
      if (ar.stderr !== undefined) vars.stderr = ar.stderr;
      if (ar.exit_code !== undefined) vars.exit_code = ar.exit_code;
      if (ar.status !== undefined) vars.status = ar.status;
      if (ar.body !== undefined) vars.body = ar.body;
      if (ar.error !== undefined) vars.error = ar.error;
      if (ar.pid !== undefined) vars.pid = ar.pid;
    }
    return vars;
  }

  private async _executeActionState(
    session: SessionState,
    state: StateDefinition,
    taskOps: TaskOp[],
    depth: number = 0
  ): Promise<StatusResult> {
    if (depth >= MAX_ACTION_CHAIN) {
      throw new Error(`Action chain exceeded max depth (${MAX_ACTION_CHAIN})`);
    }

    const vars = this._buildTemplateVars(session);
    const result = await this._executor.execute(state, vars);

    // Determine target state
    let targetStateName: string | undefined;
    let detail: string;

    if (state.cases) {
      const key = result.type === "exec" ? String(result.exit_code ?? 1) : String(result.status ?? 0);
      targetStateName = state.cases[key] ?? state.default;
      detail = result.type === "exec" ? `exit ${result.exit_code}` : `HTTP ${result.status ?? "err"}`;
    } else {
      targetStateName = result.success ? state.on_success : state.on_error;
      detail = result.type === "exec"
        ? `exit ${result.exit_code ?? "?"}`
        : result.success ? `HTTP ${result.status}` : (result.error ?? "error");
    }

    if (!targetStateName) {
      throw new Error(
        `Action state has no target for result: ${detail}. ` +
        `Configure cases/default or on_success/on_error.`
      );
    }

    // Determine prompt
    const promptTemplate = result.success ? state.success_prompt : state.error_prompt;
    const actionPrompt = promptTemplate ? render(promptTemplate, { ...vars, ...result }) : undefined;

    // Update frame
    const frame = session.stack[session.active_frame];
    const targetVisits = (frame.state_visits[targetStateName] ?? 0) + 1;
    const now = new Date().toISOString();

    // Check max_transitions
    const wf = this._getWorkflow(session.session_id, frame.workflow);
    const maxTransitions = wf.max_transitions ?? DEFAULT_MAX_TRANSITIONS;
    if (frame.total_transitions >= maxTransitions) {
      throw new Error(`Max transitions (${maxTransitions}) reached for workflow "${frame.workflow}"`);
    }

    // Check max_visits on target
    const resolvedTarget = this._resolveState(session, frame.workflow, targetStateName);
    if (resolvedTarget?.max_visits && targetVisits > resolvedTarget.max_visits) {
      throw new Error(`State "${targetStateName}" max_visits (${resolvedTarget.max_visits}) exceeded`);
    }

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
      detail,
      at: now,
    };

    const globalKey = `${frame.workflow}:${targetStateName}`;
    const prevGlobal = session.global_state_visits ?? {};

    // Save background PID if applicable
    let bgPids = session.background_pids;
    if (result.pid) {
      bgPids = { ...(bgPids ?? {}), [`${frame.current_state}:${Date.now()}`]: result.pid };
    }

    // Auto context_set from action state definition (rendered with action result vars)
    let ctx = session.context;
    if (result.success && state.context_set) {
      const renderVars = { ...vars, ...result };
      const entries = Object.entries(state.context_set).map(
        ([k, v]) => [k, render(v, renderVars)] as const
      );
      ctx = { ...ctx, ...Object.fromEntries(entries) };
    }

    let updated: SessionState = {
      ...session,
      context: ctx,
      stack: session.stack.map((f, i) => i === session.active_frame ? updatedFrame : f),
      updated_at: now,
      history: [...session.history, historyEntry],
      global_state_visits: { ...prevGlobal, [globalKey]: (prevGlobal[globalKey] ?? 0) + 1 },
      last_action_result: result,
      background_pids: bgPids,
    };

    await this._storage.write(session.session_id, updated);

    // Check target state
    const targetState = this._resolveState(updated, frame.workflow, targetStateName);

    if (targetState?.terminal) {
      const hasTransitions = targetState.transitions && Object.keys(targetState.transitions).length > 0;
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

  private async _pushSubWorkflow(session: SessionState, state: StateDefinition, taskOps?: TaskOp[]): Promise<StatusResult> {
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
      history: [...session.history, { frame: newStack.length - 1, event: "push", workflow: subName, at: now }],
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

  private async _popStack(session: SessionState, outcome: "complete" | "fail", taskOps?: TaskOp[]): Promise<StatusResult> {
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

      // Top-level workflow completed
      const updated: SessionState = {
        ...session,
        stack: [],
        active_frame: -1,
        updated_at: now,
        history: [...session.history, { frame: 0, event: "complete", at: now }],
        outcome: "completed",
      };
      await this._storage.write(session.session_id, updated);
      this._snapshots.delete(session.session_id);
      await this._cascadeAbandonChildren(session.session_id);
      return this._buildStatus(updated, taskOps);
    }

    // Pop current frame, return to parent
    const newStack = session.stack.slice(0, -1);
    const parentIdx = newStack.length - 1;
    const parentFrame = newStack[parentIdx];
    const parentWf = this._getWorkflow(session.session_id, parentFrame.workflow);
    const parentState = this._resolveState(session, parentFrame.workflow, parentFrame.current_state);

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
        { frame: parentIdx, from: parentFrame.current_state, to: nextStateName, via: `on_${outcome}`, at: now },
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

  private _formatChildrenBlockError(parentSessionId: string, activeChildren?: SessionState[]): string {
    const children = activeChildren ?? this._getActiveChildren(parentSessionId);
    const details = children.map(c => {
      const f = c.stack[c.active_frame];
      return `  - ${c.session_id}: ${f.workflow} @ ${f.current_state} (${f.total_transitions} transitions)`;
    }).join("\n");
    return (
      `Cannot complete: ${children.length} child session(s) still active:\n${details}\n` +
      `Abort them via abort or investigate why they didn't finish.`
    );
  }

  private _getActiveChildren(parentSessionId: string): SessionState[] {
    return this._storage.readAll().filter(
      s => s.parent_session_id === parentSessionId && s.stack.length > 0
    );
  }

  private async _cascadeAbandonChildren(parentSessionId: string): Promise<void> {
    const now = new Date().toISOString();
    const children = this._getActiveChildren(parentSessionId);
    for (const child of children) {
      const updated: SessionState = {
        ...child,
        stack: [],
        active_frame: -1,
        updated_at: now,
        history: [...child.history, { frame: child.active_frame, event: "cascade_abandon", at: now }],
        outcome: "abandoned",
      };
      await this._storage.write(child.session_id, updated);
      this._snapshots.delete(child.session_id);
      await this._cascadeAbandonChildren(child.session_id);
    }
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
    // Try snapshot first, fallback to loader
    const snapshot = this._snapshots.get(sessionId);
    const wf = snapshot?.get(name) ?? this._loader.get(name);
    if (!wf) throw new Error(`Workflow "${name}" not found`);
    return wf;
  }

  private _resolveState(
    session: SessionState,
    workflowName: string,
    stateName: string
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
    overrides: WorkflowOverrides
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

  private _buildStatus(session: SessionState, taskOps?: TaskOp[], actionPrompt?: string): StatusResult {
    if (session.stack.length === 0) {
      const isAbandoned = session.outcome === "abandoned";
      const msg = isAbandoned ? "Workflow abandoned." : "Workflow completed.";
      const stateName = isAbandoned ? "(abandoned)" : "(completed)";
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
    const rawPrompt = actionPrompt ?? state?.prompt ?? `[sub_workflow: ${state?.sub_workflow ?? "unknown"}]`;
    let prompt = render(rawPrompt, vars);

    if (state?.include_workflows) {
      const projectWorkflows = this._getProjectWorkflows(session.session_id);
      if (projectWorkflows.length > 0) {
        prompt += "\n\nAvailable workflows:\n" + projectWorkflows
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
      visitCount: session.global_state_visits?.[`${frame.workflow}:${frame.current_state}`]
        ?? frame.state_visits[frame.current_state] ?? 0,
      forcePrompt: actionPrompt !== undefined,
    };
  }
}
