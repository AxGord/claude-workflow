import { isClosingMove } from "./stations.js";
import { spawnSync } from "node:child_process";
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
  Dispatcher,
  Driver,
  AgentStep,
  AgentLink,
  Delivery,
  DispatcherRefreshSpec,
  Resume,
  ResumeChoice,
  ResumeStep,
} from "./types.js";
import {
  MAX_STACK_DEPTH,
  DEFAULT_MAX_TRANSITIONS,
  KEEP_TERMINAL_SESSIONS,
  DEFAULT_PRIORITY_LEVEL,
  DEFAULT_SUSPENDED_TTL_DAYS,
  DRIVER_ROLE,
  ROLE_NAME,
  PriorityLevelSchema,
} from "./types.js";
import { decideResume, resumeInstruction } from "./resume.js";
import {
  REBOUND_KEY,
  REFRESH_HANDED_KEY,
  WAKE_GAP_MS,
  decideRefresh,
  rebindLines,
  refreshDueLines,
  type RefreshDecision,
} from "./refresh.js";
import { projectNameOf, projectRoot } from "./pool.js";
import { projectDefaultPriority } from "./project-settings.js";
import {
  isCuratorLineId,
  curatorContext,
  curatorDueNotice,
  dueFor,
  readLedgerFile,
} from "./curator.js";
import { LEDGER_FILE, type Storage } from "./storage.js";
import { Estimates } from "./estimate.js";
import type { Loader } from "./loader.js";
import type { ExecContext } from "./executor.js";
import type { ExecPhase } from "./progress.js";
import { EXIT_CODE_TIMEOUT, Executor } from "./executor.js";
import { killProcessGroup } from "./process.js";
import { ledgerEntry, rootSessionIdOf, type LedgerEntry, type LedgerSpend } from "./ledger.js";
import {
  agentContextOf,
  agentReadingOf,
  isAgentId,
  measureParentSpend,
  measureSpend,
  subtreeOf,
} from "./spend.js";
import {
  MODEL_KEYS,
  applyModelTable,
  difficultyError,
  parseDifficulty,
  recordStagesUsed,
  stagesSpawned,
} from "./model-table.js";
import { render } from "./template.js";
import {
  answerKeyOf,
  humanWaitBlock,
  liveHumanWait,
  recordHumanAnswer,
  repoHead,
  showEntries,
  stopHumanHolds,
  type RecordedAnswer,
} from "./human-wait.js";
import {
  failAwaiting,
  markAwaiting,
  markHumanPassed,
  markOwedHanded,
  takeAwaiting,
  markQueue,
  owedDueLines,
  readQueue,
  resolveRepo,
  staleTaskAfter,
  STALE_TASK_AFTER_DEFAULT_MIN,
} from "./queue.js";
import {
  HOLD_CMD_TIMEOUT_MS,
  HOLD_KEY,
  HOLD_STATE,
  holdOf,
  holdVerdict,
  isHoldAnswer,
  parseHold,
  type HoldVerdict,
  type ParentHold,
} from "./parent-hold.js";
import {
  DISPATCHER_AFTER_KEY,
  DISPATCHER_AGENT_KEY,
  DISPATCHER_CALL_KEY,
  DRIVER_CALL_KEY,
  SPAWN_DEPTH_ENV,
  dispatcherOn,
  renderDispatcherCall,
  renderDriverCall,
  resolveDriverRef,
} from "./driver.js";
import { currentStep, linkedAgentLines, type IsRoute } from "./agent-link.js";
import { deliveryLine, liveDelivery, waiterWarning, withDelivery } from "./delivery.js";
import { currentProgress, startHeartbeat } from "./progress.js";
import { activeSubtree, dispatcherHolds, takeOver, taskEntries, where } from "./takeover.js";
import { secondRootRefusal } from "./session-scope.js";
import { actionStateRefusal, runsCommand } from "./trust.js";
import {
  ANSWER_ACK_KEY,
  activeParents,
  askStanding,
  askStandingNote,
  formatSeconds,
  staleNote,
  staleness,
  unansweredAskLine,
  type Staleness,
} from "./stale.js";
import { ASK_KEY, openAsk } from "./event-fold.js";

/**
 * The moves out of `collect` taken once a task has ended or the window has run dry (the pick then refills or ends
 * the run), refused while an answer is unrelayed. `refill` and `stop` stay free: `refill` ends no task and
 * re-enters `collect`, `stop` is the main conversation's own word; either way the answer stays held on its session.
 */
const PARENT_ANSWER_GUARDED: ReadonlySet<string> = new Set(["slot_free", "stalled"]);

/** Template vars with an action's result laid over them; the lazy getters (`stale_sessions`) carried along. */
function withResult(vars: Record<string, unknown>, result: ActionResult): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...vars, ...result };
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(vars)))
    if (!d.enumerable) Object.defineProperty(merged, key, d);
  return merged;
}

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
  /** Set when the active frame is within 5% of its workflow's `max_transitions`. */
  readonly capWarning?: string;
  /** `revisit_prompt` of the state, rendered with the same variables as `prompt`. */
  readonly revisitPrompt?: string;
  /** One line per non-empty var the state's `signal_vars` names: what a short-form reply must still carry. */
  readonly signalNotices?: readonly SignalNotice[];
  /**
   * `start` of a workflow with a `driver:` — the Agent call that spawns it (src/driver.ts); under a
   * `dispatcher:` in force, the dispatcher's call: at `start`, and on the reply that leaves its `after` state.
   */
  readonly driverCall?: string;
}

/** Where a move actually lands once `on_exhausted` routes are followed. */
interface EnteredTarget {
  readonly name: string;
  readonly state: StateDefinition | undefined;
  readonly visits: number;
  /** History detail when the move was rerouted past an exhausted state. */
  readonly exhausted?: string;
}

export interface SignalNotice {
  readonly line: string;
  /** The var's value as the prompt renders it: a reply that already shows it needs no line. */
  readonly value: string;
}

/** Longest value a signal notice quotes; the rest is cut, and the line says so. */
const SIGNAL_NOTICE_MAX = 300;
const SIGNAL_NOTICE_CUT = "… (cut; status() shows it whole)";

/**
 * `SIGNAL <var>: <value on one line>` for each of `names` whose value in `vars` is neither empty nor `none`
 * (the word a lazy list var renders for nothing).
 */
export function signalNoticeLines(
  names: readonly string[] | undefined,
  vars: Record<string, unknown>,
): SignalNotice[] | undefined {
  if (names === undefined || names.length === 0) return undefined;
  const lines: SignalNotice[] = [];
  for (const name of names) {
    const raw = vars[name];
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") continue;
    const value = String(raw).trim();
    if (value === "" || value === "none") continue;
    const flat = value.replace(/\s*\n\s*/gu, " | ");
    const shown =
      flat.length > SIGNAL_NOTICE_MAX
        ? `${flat.slice(0, SIGNAL_NOTICE_MAX)}${SIGNAL_NOTICE_CUT}`
        : flat;
    lines.push({ line: `SIGNAL ${name}: ${shown}`, value });
  }
  return lines.length > 0 ? lines : undefined;
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
  /** The resumed session as stored once its status is built: the parent its children's links are read against. */
  readonly session: SessionState;
  /** The routing-step test (exec / fetch / `station: false` states) of a session's own workflow: each parent is judged by its own. */
  readonly routeOf: (parent: SessionState) => IsRoute;
}

/** The `resume:` step a session is in: its spec, step, and where (frame, workflow, state, visit) it was entered. */
interface ResumeFound {
  readonly spec: Resume;
  readonly step: ResumeStep;
  readonly frame: number;
  readonly workflow: string;
  readonly state: string;
  readonly visit: number;
}

/** A recorded choice belongs to the step entered now: the same frame, workflow, state and visit. */
const sameStep = (rec: ResumeChoice, found: ResumeFound): boolean =>
  rec.frame === found.frame &&
  rec.workflow === found.workflow &&
  rec.state === found.state &&
  rec.visit === found.visit;

/**
 * A task driver ends its turn on WAITING while its worker runs, and Claude Code never delivers that turn to
 * the dispatcher: the session's linked non-driver agent is the only trace. Names it, so a quiet driver is
 * not pinged or re-spawned before the worker is looked at.
 */
function driverWaitNote(s: SessionState): string {
  const driver = s.agent_id;
  if (!driver) return "";
  const now = currentStep(s);
  const links = (s.agent_links ?? []).filter(
    l =>
      l.agent_id !== driver &&
      l.role !== undefined &&
      l.role !== DRIVER_ROLE &&
      !!l.step &&
      !!now &&
      l.step.workflow === now.workflow &&
      l.step.state === now.state &&
      l.step.visit === now.visit,
  );
  const last = links[links.length - 1];
  const delivered = liveDelivery(s);
  const deliveredNote = delivered
    ? `; the agent already delivered \`${delivered.key}\` at ${delivered.at} (its turn has not ended): SendMessage the driver once to take the state's transition from status, no notification needed`
    : "";
  if (!last) return deliveredNote === "" ? "" : ` —${deliveredNote.slice(1)}`;
  return ` — the driver may be waiting on its ${last.role} ${last.agent_id}, linked at this step: wait, not gone; check that agent (status, SendMessage to the driver) before any ping; never spawn a driver while it lives${deliveredNote}`;
}

/** What a STALE line of a session whose driver acked the parent's answer adds: the answer arrived, so the silence is the worker's. */
function ackedNote(s: SessionState, now: number): string {
  const st = askStanding(s, now);
  return st?.kind === "acked"
    ? ` — the parent's answer reached the driver (acked ${st.acked_at}): this silence is the worker's, not the parent's`
    : "";
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
    "curator",
  ]);

  private readonly _storage: Storage;
  private readonly _loader: Loader;
  private readonly _executor: Executor;
  // Snapshot: sessions keep the workflow version they started with
  private readonly _snapshots: Map<string, Map<string, WorkflowDefinition>> = new Map();
  // Sessions whose processes the abort tool killed ahead of its queued abort:
  // their running action chain must stop, not route the killed exec's result.
  private readonly _aborting = new Set<string>();

  /** The ledger appends of ended sessions, one after the other (see `_finalize`). */
  private _ledgerTurn: Promise<void> = Promise.resolve();
  // Sessions whose action state this server is running: their `running_exec`
  // is this server's own, never one to take over.
  private readonly _inFlight = new Set<string>();
  private readonly _options: EngineOptions;
  /** `<session>|<hold since>` of the holds whose condition-met line this process handed: the persisted `met_handed` follows. */
  private readonly _holdHanded = new Set<string>();
  /** The last answer of a held condition, so one call that renders it three times runs a command once. */
  private readonly _holdChecked = new Map<string, { at: number; met: boolean }>();
  // The ledger's run times, re-read by its appended tail.
  private _estimates: Estimates | undefined;

  constructor(storage: Storage, loader: Loader, executor: Executor, options: EngineOptions = {}) {
    this._storage = storage;
    this._loader = loader;
    this._executor = executor;
    this._options = options;
    storage.events?.setDriverResolver(session => this._driverOf(session));
    storage.events?.setStateResolver((session, workflow, state) => {
      try {
        return this._resolveState(session, workflow, state);
      } catch {
        return undefined;
      }
    });
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
    initialContext?: Readonly<Record<string, string>>,
    forceReason?: string,
  ): Promise<StatusResult> {
    if (cwd !== undefined) Engine._assertSessionCwd(cwd);
    if (priority !== undefined) PriorityLevelSchema.parse(priority);
    const initial = initialContext ?? {};
    for (const key of Object.keys(initial))
      if (key === "cwd" || key === "claude_code_pid" || key === "project" || key === "project_root")
        throw new Error(`start context: "${key}" is the engine's (pass cwd as its own argument)`);

    // A parentless start while this process holds an active root is refused: the old idempotent
    // reply handed the root's id to whoever asked (a sub-agent that then aborted it).
    if (!parentSessionId) {
      const refusal = secondRootRefusal(this._storage, process.ppid, forceReason);
      if (refusal) throw new Error(refusal);
      if (forceReason?.trim())
        console.error(
          `start: a second root session on purpose in PID ${process.ppid}: ${forceReason.trim()}`,
        );
    }

    let sessionId: string;
    do {
      sessionId = randomBytes(4).toString("hex");
    } while (this._storage.read(sessionId));
    const workflows = this._workflowsAt(cwd);
    const wf = workflows.get(workflowName);
    if (!wf) {
      const note = this.untrustedNote(workflowName, cwd);
      const broken = this.brokenNote(workflowName, cwd);
      if (broken) throw new Error(`Workflow "${workflowName}" failed to load: ${broken}`);
      throw new Error(`Workflow "${workflowName}" not found${note ? `. ${note}` : ""}`);
    }

    // explicit > the parent's > the project's settings file > normal; read before anything is recorded
    const parent = parentSessionId ? this._storage.read(parentSessionId) : null;
    // Under a dispatcher agent a task is never started twice: its memory of a dispatch is not the truth.
    const task = initial.task;
    if (parent && task && typeof parent.context[DISPATCHER_CALL_KEY] === "string") {
      const twin = this._storage
        .readAll()
        .find(
          s =>
            s.parent_session_id === parentSessionId &&
            s.stack.length > 0 &&
            s.context.task === task,
        );
      if (twin) {
        const call =
          typeof twin.context[DRIVER_CALL_KEY] === "string"
            ? `its driver's call is status({ session_id: "${twin.session_id}", key: "${DRIVER_CALL_KEY}" })`
            : "its workflow declares no `driver:`, so it has no driver call: the main conversation drives it";
        throw new Error(
          `task "${task}" already runs under ${parentSessionId} as session ${twin.session_id} (${twin.agent_id ? `agent ${twin.agent_id}` : "no agent linked"}): start no second one — ${call}`,
        );
      }
    }
    const level =
      priority ??
      parent?.priority ??
      projectDefaultPriority(cwd ?? process.cwd()) ??
      DEFAULT_PRIORITY_LEVEL;

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
    const rootSessionId = parentSessionId
      ? rootSessionIdOf(parent ?? { session_id: parentSessionId })
      : sessionId;
    const claudeSessionId = this._claudeSessionId();
    const created: SessionState = {
      session_id: sessionId,
      ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
      root_session_id: rootSessionId,
      priority: level,
      stack: [frame],
      active_frame: 0,
      started_at: now,
      updated_at: now,
      history: [{ frame: 0, event: "start", workflow: workflowName, at: now, actor }],
      overrides: {},
      context: {
        ...initial,
        claude_code_pid: process.ppid,
        cwd: cwd ?? process.cwd(),
        // resolved while the worktree exists: a removed one can no longer be mapped to its checkout
        project: projectNameOf(cwd ?? process.cwd()),
        // `{{project_root}}` / WF_PROJECT_ROOT, fixed here for the same reason
        project_root: projectRoot(cwd ?? process.cwd()),
      },
      global_state_visits: { [globalKey]: 1 },
      ...(claudeSessionId ? { claude_session_id: claudeSessionId } : {}),
    };
    if (
      MODEL_KEYS.difficulty in initial &&
      wf.model_table &&
      parseDifficulty(initial[MODEL_KEYS.difficulty]) === null
    )
      throw new Error(
        `${difficultyError(initial[MODEL_KEYS.difficulty])} (the workflow's model_table maps it)`,
      );
    const modelled = this._withEntry(created, new Set(Object.keys(initial)));
    // Kept in the context: a dispatcher after a restart or compaction re-spawns the driver from it.
    // The opt-in is read once, here: the key's presence is what later calls go by.
    const dispatcherCall =
      wf.dispatcher && dispatcherOn(wf.dispatcher)
        ? this._dispatcherCall(modelled, wf.dispatcher)
        : undefined;
    // The dispatcher's agent id (when it is linked and the parent is a dispatcher session): a driver that lost it
    // to a compaction reads it here; linking a respawned dispatcher refreshes it (linkAgent).
    const dispatcherAgent =
      parent && typeof parent.context[DISPATCHER_CALL_KEY] === "string" && parent.agent_id
        ? { [DISPATCHER_AGENT_KEY]: parent.agent_id }
        : {};
    const withCalls = wf.driver
      ? {
          ...modelled,
          context: {
            ...modelled.context,
            [DRIVER_CALL_KEY]: this._driverCall(modelled, wf.driver, parent),
          },
        }
      : dispatcherCall !== undefined
        ? {
            ...modelled,
            context: {
              ...modelled.context,
              [DISPATCHER_CALL_KEY]: dispatcherCall,
              ...(wf.dispatcher?.after ? { [DISPATCHER_AFTER_KEY]: wf.dispatcher.after } : {}),
            },
          }
        : modelled;
    const session: SessionState = {
      ...withCalls,
      context: { ...withCalls.context, ...dispatcherAgent },
    };

    await this._storage.write(sessionId, session);

    const status = await this._enterInitial(session, workflowName, wf.initial);
    if (dispatcherCall !== undefined) return { ...status, driverCall: dispatcherCall };
    return wf.driver ? { ...status, driverCall: String(session.context[DRIVER_CALL_KEY]) } : status;
  }

  /** The first status of a new session: its initial state may be a skill gate, a sub-workflow or an action. */
  private async _enterInitial(
    session: SessionState,
    workflowName: string,
    initial: string,
  ): Promise<StatusResult> {
    const initialState = this._resolveState(session, workflowName, initial);
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

  /** The Agent call that spawns a `dispatcher:` workflow's dispatcher on this new session. */
  private _dispatcherCall(session: SessionState, dispatcher: Dispatcher): string {
    const instructions = resolveDriverRef(dispatcher.prompt_ref, String(session.context.cwd));
    return renderDispatcherCall({
      dispatcher,
      sessionId: session.session_id,
      instructions,
      instructionsExist: fs.existsSync(instructions),
      spawnDepth: process.env[SPAWN_DEPTH_ENV],
    });
  }

  /**
   * The dispatcher's call when this call's moves left the `after` state of the session's
   * `dispatcher:` (the main conversation's last own state): the reply repeats the block there.
   */
  private _dispatcherCallLeaving(sessionId: string, movesBefore: number): string | undefined {
    const s = this._storage.read(sessionId);
    const call = s?.context[DISPATCHER_CALL_KEY];
    if (!s || typeof call !== "string" || call === "" || s.stack.length === 0) return undefined;
    let after: string | undefined;
    try {
      after = this._getWorkflow(s.session_id, s.stack[0].workflow).dispatcher?.after;
    } catch {
      return undefined;
    }
    if (after === undefined) return undefined;
    const left = s.history.slice(movesBefore).some(h => h.frame === 0 && h.from === after);
    return left ? call : undefined;
  }

  /** The Agent call that spawns a `driver:` workflow's driver on this new session. */
  private _driverCall(session: SessionState, driver: Driver, parent: SessionState | null): string {
    const cwd = String(session.context.cwd);
    const instructions = resolveDriverRef(driver.prompt_ref, cwd);
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined;
    return renderDriverCall({
      driver,
      sessionId: session.session_id,
      task: str(session.context.task),
      queueFile: str(session.context.queue_file) ?? str(parent?.context.queue_file),
      instructions,
      instructionsExist: fs.existsSync(instructions),
    });
  }

  /**
   * Take a transition. `set` = context keys written first, in order, each as `setContext` would
   * (own history line, `model_table` derivation), in the SAME write as the move: the entered
   * state sees them, and a refused key or a refused move writes none of it.
   */
  public async transition(
    sessionId: string,
    transitionName: string,
    actor?: string,
    set?: Readonly<Record<string, unknown>>,
  ): Promise<StatusResult> {
    const movesBefore = this._storage.read(sessionId)?.history.length ?? 0;
    const status = await this._transition(sessionId, transitionName, actor, set);
    const call = this._dispatcherCallLeaving(sessionId, movesBefore);
    return call === undefined ? status : { ...status, driverCall: call };
  }

  private async _transition(
    sessionId: string,
    transitionName: string,
    actor?: string,
    set?: Readonly<Record<string, unknown>>,
  ): Promise<StatusResult> {
    let session = this._storage.read(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    if (session.stack.length === 0)
      throw new Error(`Session "${sessionId}" has no active workflow`);
    const keys = Object.entries(set ?? {});

    // Session is waiting for children to complete — try to resolve
    if (session.pending_pop) {
      if (keys.length > 0)
        throw new Error(
          "`set` cannot ride a transition of a session waiting for its children: nothing was written; use context_set",
        );
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
    let requested = transitions[transitionName];
    if (!requested) {
      const available = Object.keys(transitions).join(", ");
      throw new Error(`Transition "${transitionName}" not available. Available: ${available}`);
    }

    // a human wait is left only by the answer recorded for it, and that answer's route
    const leaving = state.human ? this._humanLeave(session, state, transitionName) : undefined;
    if (leaving !== undefined) {
      if (keys.length > 0)
        throw new Error(
          `\`set\` cannot ride the move out of a human wait: the engine writes the answer's text into \`${leaving.key}\`; nothing was written`,
        );
      if (leaving.movedTo !== undefined) requested = leaving.movedTo;
      session = {
        ...session,
        context: { ...session.context, [leaving.key]: leaving.text },
        human_wait: undefined,
      };
    }

    // a dispatching session's `collect` cannot end while a task holds a parent answer nobody relayed
    if (frame.current_state === "collect" && PARENT_ANSWER_GUARDED.has(transitionName)) {
      const held = this.parentAnswerLines(sessionId);
      if (held.length > 0)
        throw new Error(
          `Transition "${transitionName}" refused: a task holds a parent_answer not yet relayed (unrelayed). SendMessage each to its driver as \`MAIN DECISION (quoted, the main conversation's own word): task=<ID>: <text>\`, then context_set the task session's \`parent_answer\` to "":\n${held.join("\n")}`,
        );
    }

    // a dispatching session does not end its run while queue lines wait for their owner's answer
    if (frame.current_state === "collect" && transitionName === "stalled") {
      const waiting = this._awaitingLines(session);
      if (waiting.length > 0)
        throw new Error(
          `Transition "stalled" refused: ${waiting.length} line(s) of the queue await their owner's answer (${waiting.join(", ")}): end the turn; \`refill\` once an answer is recorded`,
        );
    }

    // Check max_transitions
    const maxTransitions = wf.max_transitions ?? DEFAULT_MAX_TRANSITIONS;
    if (frame.total_transitions >= maxTransitions && !isClosingMove(wf, requested)) {
      throw new Error(
        `Max transitions (${maxTransitions}) reached for workflow "${frame.workflow}"` +
          ` — only a move that closes the run is accepted now`,
      );
    }

    for (const [key, value] of keys) session = this._withKey(session, key, value, actor);

    const now = new Date().toISOString();

    // an answer starts the owner's round: the other states' max_visits count from here
    const roundFrame: StackFrame =
      leaving !== undefined ? { ...frame, round_base: { ...frame.state_visits } } : frame;
    const {
      name: targetStateName,
      state: targetState,
      visits: targetVisits,
      exhausted,
    } = this._enterTarget(session, roundFrame, requested);

    const updatedFrame: StackFrame = {
      ...roundFrame,
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

    let updated: SessionState = this._withEntry({
      ...session,
      ...skillUpdate,
      ...this._wakeStamp(session, now),
      stack: session.stack.map((f, i) => (i === session.active_frame ? updatedFrame : f)),
      updated_at: now,
      history: [...session.history, historyEntry],
      global_state_visits: { ...prevGlobal, [globalKey]: (prevGlobal[globalKey] ?? 0) + 1 },
    });

    await this._storage.write(sessionId, updated);
    if (leaving !== undefined) await this._takeHuman(updated, leaving.passes);

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

    if (targetState?.human) return this._enterHuman(updated, targetState, taskOps);

    return this._buildStatus(updated, taskOps);
  }

  /**
   * The move out of the human wait `state` by `route`: refused unless the recorded answer names that route.
   * Gives the context key and text to write, whether the answer passes the line's gate, and the `moved:` state
   * a passing answer enters instead when the repo's HEAD moved during the wait.
   */
  private _humanLeave(
    session: SessionState,
    state: StateDefinition,
    route: string,
  ): { key: string; text: string; passes: boolean; movedTo?: string } {
    const spec = state.human!;
    const wait = liveHumanWait(session);
    const answer = wait?.answer;
    if (!answer)
      throw new Error(
        `State "${session.stack[session.active_frame].current_state}" waits for a human answer: nothing moved. The owner answers with the \`answer\` tool (session ${session.session_id}, route one of ${Object.keys(state.transitions ?? {}).join(", ")}) or from the dashboard; a driver hands back its AWAITING line and stops`,
      );
    if (answer.route !== route)
      throw new Error(
        `Transition "${route}" refused: the owner's recorded answer is \`${answer.route}\` — take that one`,
      );
    const passes = spec.passes === undefined || spec.passes.includes(route);
    const movedTo = passes ? this._movedTo(session, spec.moved, wait) : undefined;
    return { key: answerKeyOf(spec), text: answer.text, passes, ...(movedTo ? { movedTo } : {}) };
  }

  /** The `moved:` state, when one is declared and the repo's HEAD is no longer the one the wait began at. */
  private _movedTo(
    session: SessionState,
    moved: string | undefined,
    wait: { readonly head?: string } | undefined,
  ): string | undefined {
    if (moved === undefined || wait?.head === undefined) return undefined;
    const now = repoHead(Engine._cwdOf(session));
    return now !== undefined && now !== wait.head ? moved : undefined;
  }

  /**
   * Enter the human wait `state`: record what it asks and shows on the session, keep its `stop` command for the
   * session's end, and — for a queue task — move its line to `awaiting`, which frees its window slot.
   */
  private async _enterHuman(
    session: SessionState,
    state: StateDefinition,
    taskOps: TaskOp[],
    actionPrompt?: string,
  ): Promise<StatusResult> {
    const spec = state.human!;
    const frame = session.stack[session.active_frame];
    const vars = this._buildTemplateVars(session, false);
    const now = new Date().toISOString();
    const cwd = Engine._cwdOf(session) ?? process.cwd();
    const question = render(spec.question, vars).trim();
    const show = showEntries((spec.show ?? []).map(v => render(v, vars)));
    const head = repoHead(cwd);
    const stop = spec.stop === undefined ? undefined : render(spec.stop, vars);
    const holds = session.human_holds ?? [];
    const hold = { state: frame.current_state, command: stop ?? "", cwd };
    const kept =
      stop === undefined || holds.some(h => h.command === hold.command && h.cwd === cwd)
        ? holds
        : [...holds, hold];
    const updated: SessionState = {
      ...session,
      human_wait: {
        frame: session.active_frame,
        state: frame.current_state,
        visit: frame.state_visits[frame.current_state] ?? 1,
        since: now,
        question,
        show,
        routes: Object.keys(state.transitions ?? {}),
        ...(head !== undefined ? { head } : {}),
      },
      ...(kept.length > 0 ? { human_holds: kept } : {}),
      updated_at: now,
    };
    await this._storage.write(session.session_id, updated);
    const file = updated.context.queue_file;
    const task = updated.context.task;
    let note: string | undefined;
    if (typeof file === "string" && typeof task === "string") {
      try {
        await markAwaiting(file, task, {
          since: now,
          session: updated.session_id,
          state: frame.current_state,
          question,
          show,
        });
      } catch (err) {
        note = `note: queue line ${task} was not marked awaiting (${(err as Error).message}): it keeps its window slot.`;
      }
    }
    const status = this._buildStatus(updated, taskOps, actionPrompt);
    return note === undefined ? status : { ...status, prompt: `${status.prompt}\n${note}` };
  }

  /**
   * The answer was taken: a line still `awaiting` (the move came before a pick resumed it) runs again, and a passing
   * answer is recorded on it (`human_passed:`) when it carries `human_gate:`. Never throws.
   */
  private async _takeHuman(session: SessionState, passes: boolean): Promise<void> {
    const file = session.context.queue_file;
    const task = session.context.task;
    if (typeof file !== "string" || typeof task !== "string") return;
    try {
      await takeAwaiting(file, task, session.session_id);
      if (passes) await markHumanPassed(file, task);
    } catch {
      // no queue, no line: the move stands; a land of a gated line is refused at its done mark
    }
  }

  /** The owner's answer to the human wait `sessionId` stands at (the `answer` tool). */
  public async answer(
    sessionId: string,
    route: string,
    text: string,
    by = "main",
  ): Promise<RecordedAnswer> {
    return recordHumanAnswer(this._storage, sessionId, route, text, by);
  }

  /**
   * A session that ends: its human waits' `stop` commands run once, and a queue line still `awaiting` its answer
   * (an abort at the wait) is failed, so no line stays awaiting with no session behind it. Never throws.
   */
  private async _endHuman(session: SessionState, why: string): Promise<void> {
    if (session.human_holds?.length) stopHumanHolds(session.human_holds);
    const wait = session.human_wait;
    const file = session.context.queue_file;
    const task = session.context.task;
    if (wait === undefined || typeof file !== "string" || typeof task !== "string") return;
    try {
      await failAwaiting(
        file,
        task,
        session.session_id,
        `ended at the human wait ${wait.state} without an answer taken (${why})`,
      );
    } catch {
      // no queue or line: the end stands
    }
  }

  /** Whether the queue line of a session at a human wait is still `awaiting` (the pick has not resumed it); false on any read error. */
  private _lineAwaiting(session: SessionState, state: StateDefinition | undefined): boolean {
    const file = session.context.queue_file;
    const task = session.context.task;
    if (state?.human === undefined || typeof file !== "string" || typeof task !== "string")
      return false;
    try {
      return readQueue(file).lines.some(l => l.id === task && l.status === "awaiting");
    } catch {
      return false;
    }
  }

  /** The `awaiting` lines of a dispatching session's queue (its context names `queue_file` and `task_workflow`); [] on any read error. */
  private _awaitingLines(session: SessionState): string[] {
    const file = session.context.queue_file;
    if (typeof file !== "string" || typeof session.context.task_workflow !== "string") return [];
    try {
      return readQueue(file)
        .lines.filter(l => l.status === "awaiting")
        .map(l => l.id);
    } catch {
      return [];
    }
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
    await this._endHuman(session, event);
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
   * Whether `session` is STALE at `now` (`stale.ts`), its state resolved as `status` resolves it — a
   * workflow no longer loadable counts as a prompt state. `parents`: `activeParents` of the sessions.
   */
  public staleness(
    session: SessionState,
    parents: ReadonlySet<string>,
    now: number = Date.now(),
  ): Staleness | undefined {
    if (session.stack.length === 0) return undefined;
    const frame = session.stack[session.active_frame];
    let state: StateDefinition | undefined;
    try {
      state = this._resolveState(session, frame.workflow, frame.current_state);
    } catch {
      state = undefined;
    }
    const pid = session.context.claude_code_pid;
    const alive = typeof pid === "number" && Engine._isPidAlive(pid);
    return staleness(session, state, parents, now, alive, this._lineAwaiting(session, state));
  }

  /**
   * One `STALE:` line per STALE session of `sessionId`'s active sub-tree, parents first — the
   * session itself too unless `descendantsOnly`.
   */
  public staleLines(
    sessionId: string,
    descendantsOnly = false,
    now: number = Date.now(),
  ): string[] {
    const tree = activeSubtree(this._storage, sessionId)
      .slice(descendantsOnly ? 1 : 0)
      .map(id => this._storage.read(id))
      .filter((s): s is SessionState => !!s && s.stack.length > 0);
    const parents = activeParents(tree);
    const lines: string[] = [];
    const limit = this._staleTaskLimit(sessionId);
    for (const s of tree) {
      const hold = descendantsOnly ? this._holdVerdict(s, now) : undefined;
      if (hold?.kind === "silent") continue;
      const st = this.staleness(s, parents, now);
      const of = s.parent_session_id ? `, child of ${s.parent_session_id}` : "";
      const agent = s.agent_id ? `, agent ${s.agent_id}` : "";
      const wait = driverWaitNote(s) + ackedNote(s, now);
      if (st)
        lines.push(
          `STALE: session ${s.session_id} (${where(s)}${of}${agent}) — ${staleNote(st)}${wait}`,
        );
      if (hold) lines.push(hold.line);
      else if (
        st &&
        descendantsOnly &&
        typeof s.context.task === "string" &&
        st.idle_s >= limit * 60
      ) {
        const state = s.stack[s.active_frame].current_state;
        lines.push(
          `NEEDS-PARENT task=${s.context.task} session=${s.session_id} reason=stale ${formatSeconds(st.idle_s)}, no engine call since ${st.since} state=${state} agent=${s.agent_id ?? "none"} see=state collect`,
        );
      }
    }
    return lines;
  }

  /**
   * What the parent's hold on task session `s` means at `now`: undefined without a hold, outside `blocked`, or
   * once its met condition was handed. Pure but for the command a held `until_cmd` runs (its answer kept 5 s).
   */
  private _holdVerdict(s: SessionState, now: number): HoldVerdict | undefined {
    const hold = holdOf(s.context);
    const task = s.context.task;
    if (!hold || typeof task !== "string" || s.stack.length === 0) return undefined;
    if (s.stack[s.active_frame]?.current_state !== HOLD_STATE) return undefined;
    const handed =
      hold.met_handed !== undefined || this._holdHanded.has(`${s.session_id}|${hold.since}`);
    return holdVerdict(hold, task, s.session_id, this._holdMet(s, hold, now), handed, now);
  }

  /** Whether the hold's condition holds now; any read or run failure is not met. */
  private _holdMet(s: SessionState, hold: ParentHold, now: number): boolean {
    const key = `${s.session_id}|${hold.since}`;
    const seen = this._holdChecked.get(key);
    if (seen && Math.abs(now - seen.at) < 5000) return seen.met;
    let met = false;
    try {
      // the task session's own `queue_file`, else its dispatcher's
      const file =
        s.context.queue_file ??
        (s.parent_session_id
          ? this._storage.read(s.parent_session_id)?.context.queue_file
          : undefined);
      const queue = typeof file === "string" ? readQueue(file) : undefined;
      if (hold.kind === "until_done") {
        const line = queue?.lines.find(l => l.id === hold.value);
        met = (line ? line.status : queue?.archived.get(hold.value)) === "done";
      } else {
        const own = queue?.lines.find(l => l.id === s.context.task);
        const cwd =
          (queue && own ? resolveRepo(queue, own) : null) ??
          (typeof s.context.project_root === "string" ? s.context.project_root : process.cwd());
        met =
          spawnSync("sh", ["-c", hold.value], {
            cwd,
            timeout: HOLD_CMD_TIMEOUT_MS,
            stdio: "ignore",
          }).status === 0;
      }
    } catch {
      met = false;
    }
    this._holdChecked.set(key, { at: now, met });
    return met;
  }

  /**
   * Count the condition-met lines of `sessionId`'s held tasks that stand in `text` as handed: `text` is the reply a
   * caller is about to receive, so a prompt rendered and thrown away (a `status` with a `key`, the read before a
   * `transition`) hands nothing, and the next reply that carries the line is the one that does.
   */
  public markHoldsHanded(sessionId: string, text: string, now: number = Date.now()): void {
    for (const id of activeSubtree(this._storage, sessionId).slice(1)) {
      const s = this._storage.read(id);
      const v = s ? this._holdVerdict(s, now) : undefined;
      if (s && v?.kind === "met" && text.includes(v.line)) this._handHold(s);
    }
  }

  /** Record that the condition-met line of `s`'s hold is handed: in memory at once, on the session after. */
  private _handHold(s: SessionState): void {
    const hold = holdOf(s.context);
    if (!hold) return;
    this._holdHanded.add(`${s.session_id}|${hold.since}`);
    void this._storage
      .update(s.session_id, cur => {
        const h = cur && holdOf(cur.context);
        return cur && h && h.since === hold.since
          ? {
              ...cur,
              context: {
                ...cur.context,
                [HOLD_KEY]: { ...h, met_handed: new Date().toISOString() },
              },
            }
          : null;
      })
      .catch(() => undefined);
  }

  /**
   * `session` with the hold a `parent_answer` records: the answer `hold ...` stores its condition as `parent_hold`
   * (refused without one, or outside `blocked`); any other answer ends a hold. The empty clear after a relay leaves it.
   */
  private _withHold(session: SessionState, key: string, value: unknown): SessionState {
    if (key !== "parent_answer" || typeof value !== "string" || value.trim() === "") return session;
    if (!isHoldAnswer(value)) {
      if (session.context[HOLD_KEY] === undefined) return session;
      const context = { ...session.context };
      delete context[HOLD_KEY];
      return { ...session, context };
    }
    const state = session.stack[session.active_frame]?.current_state;
    if (typeof session.context.task !== "string" || state !== HOLD_STATE)
      throw new Error(
        `hold refused: a hold applies to a task session standing at "${HOLD_STATE}" (this one stands at "${state ?? "none"}")`,
      );
    const parsed = parseHold(value, new Date());
    if ("error" in parsed) throw new Error(parsed.error);
    return { ...session, context: { ...session.context, [HOLD_KEY]: parsed.hold } };
  }

  /**
   * A task session of a dispatcher's `tasks` key that ended completed has nothing left to route, so its entry leaves the
   * key at its end: the dispatcher never waits on the parent for a slot an ended session holds. The driver's last line
   * still reaches the dispatcher, which frees the slot with `slot_free`. A failed or abandoned end keeps its entry.
   */
  private async _dropEndedTask(ended: SessionState): Promise<void> {
    const parentId = ended.parent_session_id;
    if (!parentId) return;
    const entry = new RegExp(`(?:^|\\s)[^\\s=]+=${ended.session_id}(?:\\s+driver=\\S+)?(?=\\s|$)`);
    await this._storage.update(parentId, cur => {
      const tasks = cur?.context.tasks;
      if (!cur || cur.stack.length === 0 || typeof tasks !== "string" || !entry.test(tasks))
        return null;
      const rest = tasks.replace(entry, "").trim();
      try {
        return this._withKey(cur, "tasks", rest, "engine");
      } catch {
        // another entry's driver is refused: the ended session's own entry is not worth failing its end
        return null;
      }
    });
  }

  /** Minutes a task session may stand STALE before it is raised: the dispatcher's queue header key, else the default. */
  private _staleTaskLimit(sessionId: string): number {
    const file = this._storage.read(sessionId)?.context.queue_file;
    if (typeof file !== "string") return STALE_TASK_AFTER_DEFAULT_MIN;
    try {
      return staleTaskAfter(readQueue(file)) ?? STALE_TASK_AFTER_DEFAULT_MIN;
    } catch {
      return STALE_TASK_AFTER_DEFAULT_MIN;
    }
  }

  /**
   * One `PARENT-ANSWER:` line per active task session below `sessionId` whose context holds a non-empty
   * `parent_answer` (what the parent recorded for its NEEDS-PARENT, `<route or decision>`): the task, its
   * session, the driver of the dispatcher's `tasks` key (else the linked agent) and the text. The dispatcher
   * relays it to that driver, then clears the key; until then the engine holds it.
   */
  public parentAnswerLines(sessionId: string): string[] {
    const root = this._storage.read(sessionId);
    const drivers = new Map<string, string>();
    for (const e of taskEntries(root?.context.tasks)) drivers.set(e.session, e.driver);
    const lines: string[] = [];
    for (const id of activeSubtree(this._storage, sessionId).slice(1)) {
      const s = this._storage.read(id);
      const text = s?.context.parent_answer;
      if (!s || typeof text !== "string" || text.trim() === "") continue;
      const task = typeof s.context.task === "string" ? s.context.task : "?";
      const driver = drivers.get(id) ?? s.agent_id ?? "none";
      lines.push(`PARENT-ANSWER: task=${task} session=${id} driver=${driver}: ${text.trim()}`);
    }
    return lines;
  }

  /**
   * One `OWED-DUE:` line per ended (done or failed) queue line of the session's `queue_file` that carries
   * `on_end_tell_parent:` and has no `owed_handed:` of its own: the record is on the queue line (written by
   * `setContext` of `owed_handed`), so it outlives this session and a later dispatcher on the same queue repeats nothing.
   */
  public owedLines(sessionId: string): string[] {
    const ctx = this._storage.read(sessionId)?.context;
    const file = ctx?.queue_file;
    // the dispatching session only (it names the task workflow); a task session carries `queue_file` too
    if (typeof file !== "string" || typeof ctx?.task_workflow !== "string") return [];
    try {
      return owedDueLines(readQueue(file));
    } catch {
      return [];
    }
  }

  /**
   * The `CURATOR-DUE:` line of a task session that has ended with no dispatching session above it (under a
   * dispatcher the pick admits the run itself): the project's due jobs and the exact `start`. None when no job is
   * due, the project has no config, or the session is a curator run.
   */
  public curatorDueLines(sessionId: string): string[] {
    const s = this._storage.read(sessionId);
    if (!s || s.stack.length > 0) return [];
    const task = s.context.slice ?? s.context.task;
    if (typeof task !== "string" || isCuratorLineId(task)) return [];
    for (let p = s.parent_session_id, n = 0; p && n < 10; n++) {
      const parent = this._storage.read(p);
      if (!parent) break;
      if (typeof parent.context.task_workflow === "string") return [];
      p = parent.parent_session_id;
    }
    try {
      const file = s.context.queue_file;
      const queue = typeof file === "string" && fs.existsSync(file) ? readQueue(file) : undefined;
      const project = queue
        ? projectRoot(path.dirname(queue.file))
        : projectRoot(typeof s.context.cwd === "string" ? s.context.cwd : process.cwd());
      const ctx = curatorContext({
        project,
        ...(queue ? { queue } : {}),
        ...(this._options.stateDir ? { stateDir: this._options.stateDir } : {}),
      });
      if (ctx === null) return [];
      const due = dueFor(ctx, readLedgerFile(this._options.stateDir));
      return due.length > 0 ? [curatorDueNotice(ctx.config, due, ctx.queueFile)] : [];
    } catch {
      // a notice never fails the call it rides on
      return [];
    }
  }

  /** The note a `context_set` of `parent_answer` on task session `sessionId` answers with: who relays it and how. */
  public parentAnswerNote(sessionId: string): string | undefined {
    const task = this._storage.read(sessionId);
    const dispatcher = task?.parent_session_id
      ? this._storage.read(task.parent_session_id)
      : undefined;
    if (!task || !dispatcher || dispatcher.stack.length === 0) return undefined;
    const held =
      "held by the engine until the dispatcher relays it to the task's driver and clears the key";
    if (dispatcherHolds(dispatcher) && dispatcher.agent_id)
      return `note: parent_answer ${held}; wake the dispatcher: SendMessage({ to: "${dispatcher.agent_id}", message: "answer" }) — no SendMessage to the driver.`;
    return `note: parent_answer ${held}; the dispatching session ${dispatcher.session_id} shows it in its \`collect\` prompt and cannot leave \`collect\` while it stands.`;
  }

  /**
   * The `PARENT ASK:` line of `sessionId`'s own open `ask_parent`: `unanswered <age>`, or `answered, acked <time>`
   * once its driver wrote `parent_answer_ack`. Undefined without an open question.
   */
  public askStandingLine(sessionId: string, now: number = Date.now()): string | undefined {
    const s = this._storage.read(sessionId);
    const st = s ? askStanding(s, now) : null;
    return s && st ? `PARENT ASK: asked ${st.asked_at}, ${askStandingNote(st)}` : undefined;
  }

  /**
   * One `UNANSWERED:` line per driver question in `sessionId`'s active sub-tree that has stood open past
   * `ASK_UNANSWERED_AFTER_S`: a decision that never reached its driver stays visible on the next pass.
   */
  public unansweredAskLines(sessionId: string, now: number = Date.now()): string[] {
    const lines: string[] = [];
    for (const id of activeSubtree(this._storage, sessionId).slice(1)) {
      const s = this._storage.read(id);
      const ask = s ? openAsk(s) : null;
      // an answer the engine holds is waiting for the dispatcher, not lost: no repeat of the question
      const answered =
        typeof s?.context.parent_answer === "string" && s.context.parent_answer.trim() !== "";
      // a held task waits for its condition, not for an answer: its hold speaks for it until the deadline
      const held = s ? this._holdVerdict(s, now)?.kind === "silent" : false;
      // an answer the driver acked reached it: the silence after that is the worker's, which the STALE mark measures
      const acked = s ? askStanding(s, now)?.kind === "acked" : false;
      const line =
        s && ask && !answered && !held && !acked ? unansweredAskLine(s, ask, now) : undefined;
      if (line) lines.push(line);
    }
    return lines;
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
    return {
      status,
      suspendedChildren,
      session: this._storage.read(sessionId) ?? resumed,
      routeOf: parent => this.routeTest(parent),
    };
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

  /**
   * Record the Agent-tool id of a sub-agent of a session, for a parent's resume. `role` says what it
   * is to the session: `driver` — the agent that drives it, the one `agent_id` names — or another
   * (`worker`, `decider`, ...), kept in `linked_agents` and `agent_links` (the per-agent spend) and
   * never in `agent_id`. A link without a role is the driver when none is linked yet, or when it is
   * the same agent, or when the session's workflow declares no `driver:` (a respawned agent replaces
   * the old one); on a session of a `driver:` workflow, a different agent without a role is a worker.
   * A driver link also records, under a parent of a `driver:` workflow (one agent per state visit),
   * the parent's step (`agent_step`), so a later visit of that state tells it from this visit's agent;
   * a non-driver link records the session's own step on its `agent_links` row instead. Returns the
   * parent's step, or undefined when none is recorded.
   */
  public async linkAgent(
    sessionId: string,
    agentId: string,
    role?: string,
  ): Promise<AgentStep | undefined> {
    if (!isAgentId(agentId))
      throw new Error(
        `"${agentId}" is not an agent id: link_agent takes the id the Agent tool returned for the spawned sub-agent ('a' and hex, e.g. a15bb6b2a76ef441c), never a placeholder`,
      );
    if (role !== undefined && !ROLE_NAME.test(role))
      throw new Error(
        `"${role}" is not a role: link_agent's role is lower-case words (driver, worker, decider, reviewer, ...)`,
      );
    const own = this._storage.read(sessionId);
    const parent = own?.parent_session_id ? this._storage.read(own.parent_session_id) : null;
    const ownDeclares = own !== null && own.stack.length > 0 && this._declaresDriver(own);
    const parentStep =
      parent && parent.stack.length > 0 && this._declaresDriver(parent)
        ? currentStep(parent)
        : undefined;
    let step: AgentStep | undefined;
    let drives = false;
    const set = await this._storage.update(sessionId, cur => {
      if (!cur) return null;
      drives =
        role === undefined
          ? !cur.agent_id || cur.agent_id === agentId || !ownDeclares
          : role === DRIVER_ROLE;
      step = drives ? parentStep : undefined;
      const link: AgentLink = {
        ...this._agentLink(parent, agentId),
        role: role ?? (drives ? DRIVER_ROLE : "worker"),
        ...(!drives && cur.stack.length > 0 ? { step: currentStep(cur) } : {}),
      };
      return {
        ...cur,
        ...(drives ? { agent_id: agentId, agent_step: step } : {}),
        linked_agents: cur.linked_agents?.includes(agentId)
          ? cur.linked_agents
          : [...(cur.linked_agents ?? []), agentId],
        agent_links: [...(cur.agent_links ?? []), link],
      };
    });
    if (!set) throw new Error(`Session "${sessionId}" not found`);
    // A dispatcher (re)linked: its live task sessions carry the new id.
    if (drives && typeof set.context[DISPATCHER_CALL_KEY] === "string") {
      for (const c of this._storage.readAll())
        if (c.parent_session_id === sessionId && c.stack.length > 0)
          await this._storage.update(c.session_id, cur =>
            cur ? { ...cur, context: { ...cur.context, [DISPATCHER_AGENT_KEY]: agentId } } : null,
          );
    }
    return step;
  }

  /** A `link_agent` call now: the parent's active state and the first stage it spawns on, none for a parent that is not active. */
  private _agentLink(parent: SessionState | null, agentId: string): AgentLink {
    const at = new Date().toISOString();
    const frame = parent && parent.stack.length > 0 ? parent.stack[parent.active_frame] : undefined;
    if (!parent || !frame) return { agent_id: agentId, at };
    let stage: string | undefined;
    try {
      const def = this._resolveState(parent, frame.workflow, frame.current_state);
      stage = def ? stagesSpawned(def)[0] : undefined;
    } catch {
      // a state that cannot be resolved names no stage
    }
    return {
      agent_id: agentId,
      at,
      state: frame.current_state,
      ...(stage !== undefined ? { stage } : {}),
    };
  }

  /** The `driver:` block of the workflow the session was started with (undefined: none, or the workflow is gone). */
  private _driverOf(s: SessionState): Driver | undefined {
    try {
      return this._getWorkflow(s.session_id, s.stack[0].workflow).driver;
    } catch {
      return undefined;
    }
  }

  /** The session runs a `driver:` workflow: the workflow it was started with declares one. */
  private _declaresDriver(s: SessionState): boolean {
    return this._driverOf(s) !== undefined;
  }

  /** Whether a state of the session's active frame is a routing step, by that session's own workflow. */
  public routeTest(s: SessionState): IsRoute {
    const frame = s.stack[s.active_frame];
    return state => {
      try {
        const def = frame ? this._resolveState(s, frame.workflow, state) : undefined;
        return def?.type === "exec" || def?.type === "fetch" || def?.station === false;
      } catch {
        return false;
      }
    };
  }

  /** status()'s LINKED AGENTS block of a session: its children's agents linked at its current state. */
  public linkedAgentLines(sessionId: string): string[] {
    const s = this._storage.read(sessionId);
    if (!s || s.stack.length === 0 || !this._declaresDriver(s)) return [];
    try {
      const children = this._storage.readAll().filter(c => c.parent_session_id === sessionId);
      return linkedAgentLines(s, children, this.routeTest(s));
    } catch {
      return [];
    }
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

  /**
   * Set one context key. Under a `model_table` a `difficulty` outside 1..10 is refused, and the
   * keys it derives are written with it; the answer is that derivation's note, if any.
   */
  public async setContext(
    sessionId: string,
    key: string,
    value: unknown,
    actor?: string,
  ): Promise<string | undefined> {
    return (await this.setContextDelivering(sessionId, key, value, actor)).derived;
  }

  /**
   * `setContext`, also answering the delivery the write made: the key was the `delivers:` key of the step the
   * session stands at (`delivery`, with the tokens key the engine filled). The reply to the agent that wrote it.
   */
  public async setContextDelivering(
    sessionId: string,
    key: string,
    value: unknown,
    actor?: string,
  ): Promise<{ derived: string | undefined; delivery?: Delivery; note?: string }> {
    const session = this._storage.read(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    const keyed = this._withHold(this._withKey(session, key, value, actor), key, value);
    const updated = this._withDelivered(keyed, key, value);
    const delivery = updated.delivery !== keyed.delivery ? updated.delivery : undefined;

    await this._storage.write(sessionId, updated);
    // the dispatcher's `owed_handed` (the ids it handed to the parent) is recorded on the queue lines themselves
    const queueFile = session.context.queue_file;
    if (key === "owed_handed" && typeof value === "string" && typeof queueFile === "string")
      for (const id of value.split(/\s+/).filter(Boolean))
        await markOwedHanded(queueFile, id).catch(() => false);
    const last = keyed.history[keyed.history.length - 1];
    return {
      derived: last.event === "model" ? last.detail : undefined,
      ...(delivery ? { delivery, note: this._deliveryNote(updated, delivery) } : {}),
    };
  }

  /** `session` with the delivery this write of `key` made, when it is the `delivers:` key of its step and not empty. */
  private _withDelivered(session: SessionState, key: string, value: unknown): SessionState {
    if (session.stack.length === 0 || value === undefined || value === null || value === "")
      return session;
    const frame = session.stack[session.active_frame];
    let state: StateDefinition | undefined;
    try {
      state = frame && this._resolveState(session, frame.workflow, frame.current_state);
    } catch {
      return session; // a frame whose workflow is gone has no state to deliver at
    }
    return withDelivery(
      session,
      state,
      key,
      new Date().toISOString(),
      agent => agentReadingOf(agent, session.claude_session_id).context,
    );
  }

  /**
   * What the agent that made `delivery` is told: it is recorded and the driver goes on without the end of its turn,
   * plus the warning when its session still owns a live pool waiter or lease.
   */
  private _deliveryNote(session: SessionState, delivery: Delivery): string {
    const tree = activeSubtree(this._storage, session.session_id)
      .map(id => this._storage.read(id))
      .filter((s): s is SessionState => !!s);
    const dirs = new Set<string>();
    for (const s of tree) {
      const wt = s.context.wt;
      if (typeof wt === "string" && path.isAbsolute(wt)) dirs.add(wt);
      const cwd = s.context.cwd;
      if (
        s.session_id !== session.session_id &&
        typeof cwd === "string" &&
        path.isAbsolute(cwd) &&
        cwd !== s.context.project_root
      )
        dirs.add(cwd);
    }
    let held: ReturnType<Executor["pool"]["heldBy"]> = [];
    try {
      held = this._executor.pool.heldBy({
        sessions: new Set(tree.map(s => s.session_id)),
        dirs: [...dirs],
      });
    } catch {
      held = []; // an unreadable pool names no waiter; the delivery stands
    }
    const head = `Delivery of "${delivery.key}" recorded: the driver takes the next step without waiting for your turn to end${
      delivery.tokens
        ? `; \`${delivery.tokens.key}\` = ${delivery.tokens.value} set from your transcript`
        : ""
    }.`;
    return [head, waiterWarning(delivery.key, held)].filter(Boolean).join("\n");
  }

  /**
   * One `DELIVERY:` line per session of `sessionId`'s active sub-tree (itself included) that stands at a step whose
   * agent has delivered: what the driver of the session and the dispatcher above it see at their next `status` /
   * `transition`, so a delivery needs no notification to be noticed.
   */
  public deliveryLines(sessionId: string): string[] {
    const lines: string[] = [];
    for (const id of activeSubtree(this._storage, sessionId)) {
      const s = this._storage.read(id);
      if (!s || s.stack.length === 0 || !liveDelivery(s)) continue;
      const frame = s.stack[s.active_frame];
      let routes: string[] = [];
      try {
        routes = Object.keys(
          this._resolveState(s, frame.workflow, frame.current_state)?.transitions ?? {},
        );
      } catch {
        routes = [];
      }
      const line = deliveryLine(s, routes);
      if (line) lines.push(line);
    }
    return lines;
  }

  /**
   * `session` with one context key written: its `context_set` history line, and what its
   * `model_table` derives from it. Pure — nothing is stored; a refused key throws.
   */
  private _withKey(
    session: SessionState,
    key: string,
    value: unknown,
    actor?: string,
  ): SessionState {
    if (key === "tasks") this._assertTaskDrivers(session, value);
    if (
      key === MODEL_KEYS.difficulty &&
      parseDifficulty(value) === null &&
      this._modelTableOf(session) !== null
    )
      throw new Error(`${difficultyError(value)} (the workflow's model_table maps it)`);

    const now = new Date().toISOString();
    const context = { ...session.context, [key]: value };
    // an ack answers the question open when it was written: a new question starts unanswered
    if (key === ASK_KEY && typeof value === "string" && value.trim() !== "")
      delete context[ANSWER_ACK_KEY];
    return this._withModel(
      {
        ...session,
        ...this._wakeStamp(session, now),
        context,
        updated_at: now,
        history: [
          ...session.history,
          { frame: session.active_frame, event: "context_set", at: now, actor, detail: key },
        ],
      },
      new Set([key]),
    );
  }

  /**
   * A dispatcher's `tasks` value names, per task session below it, the task's DRIVER: an entry whose `driver=` is another
   * agent (the worker, say) sends every later answer past the driver, so it is refused, with the linked driver named.
   * A session with no linked driver, one whose workflow declares none, and `driver=-` are not checked.
   */
  private _assertTaskDrivers(session: SessionState, value: unknown): void {
    const wrong: string[] = [];
    for (const e of taskEntries(value)) {
      if (e.driver === "-") continue;
      const task = this._storage.read(e.session);
      if (!task || task.parent_session_id !== session.session_id) continue;
      if (!task.agent_id || task.agent_id === e.driver || !this._declaresDriver(task)) continue;
      wrong.push(
        `${e.label}=${e.session} driver=${e.driver} is not the driver of ${e.session}: write driver=${task.agent_id}`,
      );
    }
    if (wrong.length > 0)
      throw new Error(
        `\`tasks\` refused, nothing written: ${wrong.join("; ")} (the agent linked with role "driver")`,
      );
  }

  /** The `model_table` the session runs under — the nearest frame's workflow down the stack that declares one — and that frame's visits. */
  private _modelTableOf(session: SessionState): {
    table: NonNullable<WorkflowDefinition["model_table"]>;
    visits: Record<string, number>;
  } | null {
    for (let i = Math.min(session.active_frame, session.stack.length - 1); i >= 0; i--) {
      const frame = session.stack[i];
      let table: WorkflowDefinition["model_table"];
      try {
        table = this._getWorkflow(session.session_id, frame.workflow).model_table;
      } catch {
        continue; // a frame whose workflow is gone has no table; the move itself reports it
      }
      if (table) return { table, visits: frame.state_visits };
    }
    return null;
  }

  /**
   * `session` with what its `model_table` derives from this write (`changed` = the context keys it
   * set; an entered state may move the row up), plus a `model` history line; the same object when
   * nothing changes.
   */
  private _withModel(
    session: SessionState,
    changed: ReadonlySet<string> = new Set(),
  ): SessionState {
    if (session.stack.length === 0) return session;
    const found = this._modelTableOf(session);
    if (!found) return session;
    const r = applyModelTable(session.context, found.table, found.visits, changed);
    const derived: SessionState = r
      ? {
          ...session,
          context: r.context,
          history: [
            ...session.history,
            { frame: session.active_frame, event: "model", detail: r.note, at: session.updated_at },
          ],
        }
      : session;
    // The state now entered fixes the rows of the stages it reads: those are the rows they run on.
    const frame = derived.stack[derived.active_frame];
    let state: StateDefinition | undefined;
    try {
      state = frame && this._resolveState(derived, frame.workflow, frame.current_state);
    } catch {
      state = undefined; // a frame whose workflow is gone has no state to read; the move itself reports it
    }
    const used = state ? recordStagesUsed(derived.context, stagesSpawned(state)) : null;
    return used ? { ...derived, context: used } : derived;
  }

  /** `_withModel`, then the choice of the `resume:` step the entered state declares: for every write that ENTERS a state. */
  private _withEntry(
    session: SessionState,
    changed: ReadonlySet<string> = new Set(),
  ): SessionState {
    return this._withRefresh(this._withResume(this._withModel(session, changed)));
  }

  /**
   * A dispatching session's wake stamp for a write at `now`: a write after `WAKE_GAP_MS` of silence starts a wake whose
   * idle is that silence (the first write of a wake is the only one that sees it: a `context_set` always precedes the
   * `transition`, so the transition alone would read about zero); a nearer one keeps the wake it belongs to.
   */
  private _wakeStamp(session: SessionState, now: string): { wake?: SessionState["wake"] } {
    if (typeof session.context[DISPATCHER_CALL_KEY] !== "string") return {};
    const gap = Date.parse(now) - Date.parse(session.updated_at);
    if (session.wake && !(gap >= WAKE_GAP_MS)) return {};
    return { wake: { at: now, idle_ms: Number.isNaN(gap) ? 0 : Math.max(0, gap) } };
  }

  /** The bounds of the dispatcher agent's refresh, when this session is a dispatching one with it on (a `dispatcher_call`, `refresh` not `false`). */
  private _refreshSpec(session: SessionState): DispatcherRefreshSpec | undefined {
    if (session.stack.length === 0 || typeof session.context[DISPATCHER_CALL_KEY] !== "string")
      return undefined;
    try {
      const refresh = this._getWorkflow(session.session_id, session.stack[0].workflow).dispatcher
        ?.refresh;
      return refresh === false ? undefined : (refresh ?? {});
    } catch {
      return undefined; // a workflow that is gone declares nothing to refresh
    }
  }

  /**
   * Whether the dispatcher agent of a session standing at `collect` is due now: its transcript's last turn against
   * the bound, the idle since the session's previous engine call against the cache's life. undefined: not at
   * `collect`, no refresh declared, or the agent's session is already being rebound.
   */
  private _refreshDecision(session: SessionState): RefreshDecision | undefined {
    const spec = this._refreshSpec(session);
    if (!spec || session.stack[session.active_frame].current_state !== "collect") return undefined;
    const agent = session.agent_id ?? "";
    const reading =
      agent !== "" && isAgentId(agent) ? agentReadingOf(agent, session.claude_session_id) : {};
    // a reading with no write yet in this wake (a `status` first) is the silence so far; else the wake's recorded idle
    const since = Date.now() - Date.parse(session.updated_at);
    const idleMs = Number.isNaN(since)
      ? undefined
      : since >= WAKE_GAP_MS || !session.wake
        ? Math.max(0, since)
        : session.wake.idle_ms;
    let safePoint = false;
    try {
      safePoint =
        this.parentAnswerLines(session.session_id).length === 0 &&
        this.owedLines(session.session_id).length === 0;
    } catch {
      safePoint = false;
    }
    return decideRefresh(spec, { agent, idleMs, context: reading.context, safePoint });
  }

  /**
   * The old agent's id while its replacement is not yet bound: the old one recorded `refresh_handed`, a different agent
   * is linked now, and that agent has not recorded `dispatcher_rebound`. Keyed on the context, not on a decision
   * recorded at `collect` entry, so a refresh first seen on a `status` reply is rebound the same way.
   */
  private static _rebinding(session: SessionState): string | undefined {
    const old = session.context[REFRESH_HANDED_KEY];
    const agent = session.agent_id;
    return typeof old === "string" &&
      old !== "" &&
      agent &&
      old !== agent &&
      session.context[REBOUND_KEY] !== agent
      ? old
      : undefined;
  }

  /** `session` with the decision to replace its dispatcher agent recorded, when the state just entered is `collect` and the agent is due; once per agent. */
  private _withRefresh(session: SessionState): SessionState {
    const rec = session.dispatcher_refresh;
    if (Engine._rebinding(session) || (rec && rec.agent === session.agent_id)) return session;
    const d = this._refreshDecision(session);
    if (!d?.due || !session.agent_id) return session;
    const reading = agentReadingOf(session.agent_id, session.claude_session_id);
    return {
      ...session,
      dispatcher_refresh: {
        agent: session.agent_id,
        reason: d.reason,
        context: reading.context ?? 0,
        ...(d.idle === undefined ? {} : { idle_minutes: d.idle }),
        at: new Date().toISOString(),
      },
    };
  }

  /**
   * The lines `{{refresh}}` renders and a reply appends: the old dispatcher's REFRESH-DUE (recorded at entry, else
   * read now) until it has handed the message to main; the fresh one's REBIND list until it records the rebind.
   */
  public refreshLines(sessionId: string): string[] {
    const s = this._storage.read(sessionId);
    if (!s || s.stack.length === 0 || this._refreshSpec(s) === undefined) return [];
    const agent = s.agent_id ?? "";
    const rebinding = Engine._rebinding(s);
    if (rebinding)
      return rebindLines({
        session: sessionId,
        old: rebinding,
        fresh: agent,
        drivers: taskEntries(s.context.tasks)
          .filter(e => isAgentId(e.driver))
          .map(e => ({ task: e.label, session: e.session, driver: e.driver })),
      });
    if (agent === "" || s.context[REFRESH_HANDED_KEY] === agent) return [];
    const rec = s.dispatcher_refresh?.agent === agent ? s.dispatcher_refresh : undefined;
    const decision = rec ? undefined : this._refreshDecision(s);
    if (!rec && !decision?.due) return [];
    return refreshDueLines({
      session: sessionId,
      agent,
      reason: rec?.reason ?? decision?.reason ?? "",
      running: taskEntries(s.context.tasks).length,
    });
  }

  /** The workflow and `resume:` step of the state `session` is in, when both are declared. */
  private _resumeStepOf(session: SessionState): ResumeFound | undefined {
    if (session.stack.length === 0) return undefined;
    const frame = session.stack[session.active_frame];
    let spec: Resume | undefined;
    let state: StateDefinition | undefined;
    try {
      spec = this._getWorkflow(session.session_id, frame.workflow).resume;
      state = this._resolveState(session, frame.workflow, frame.current_state);
    } catch {
      return undefined; // a frame whose workflow is gone has no step to read; the move itself reports it
    }
    if (!spec || !state?.resume) return undefined;
    return {
      spec,
      step: state.resume,
      frame: session.active_frame,
      workflow: frame.workflow,
      state: frame.current_state,
      visit: frame.state_visits[frame.current_state] ?? 0,
    };
  }

  /** The choice for the `resume:` step `session` is in, from the agent's transcript now (pure: nothing is stored). */
  private _resumeChoice(session: SessionState, found: ResumeFound): ResumeChoice {
    const { spec, step } = found;
    const now = Date.now();
    const vars = this._buildTemplateVars(session, false);
    const text = (key: string | undefined): string => {
      const v = key === undefined ? undefined : session.context[key];
      return typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
    };
    const agent = text(spec.agent);
    let reading: { activeAt?: number; context?: number } = {};
    if (agent !== "" && isAgentId(agent))
      reading = agentReadingOf(agent, session.claude_session_id);
    const keyed = text(spec.tokens);
    const context =
      reading.context ??
      (keyed !== "" && Number.isFinite(Number(keyed)) ? Number(keyed) : undefined);
    const idleMs = reading.activeAt === undefined ? undefined : Math.max(0, now - reading.activeAt);
    const decided = decideResume(spec, step, { agent, idleMs, context });
    const partial = { choice: decided.choice, agent, reason: decided.reason };
    return {
      frame: found.frame,
      workflow: found.workflow,
      state: found.state,
      visit: found.visit,
      ...partial,
      ...(idleMs === undefined ? {} : { idle_minutes: Math.floor(idleMs / 60_000) }),
      ...(context === undefined
        ? {}
        : { context, context_source: reading.context === undefined ? "tokens" : "transcript" }),
      at: new Date(now).toISOString(),
      instruction: resumeInstruction(partial, spec, {
        message: render(step.message, vars),
        brief: step.brief === undefined ? undefined : render(step.brief, vars),
        model: spec.model === undefined ? undefined : render(spec.model, vars).trim(),
        effort: spec.effort === undefined ? undefined : render(spec.effort, vars).trim(),
        after: spec.after_respawn === undefined ? undefined : render(spec.after_respawn, vars),
      }),
    };
  }

  /** `session` with the choice of the `resume:` step it just entered recorded; the same object when its state has none. */
  private _withResume(session: SessionState): SessionState {
    const found = this._resumeStepOf(session);
    return found ? { ...session, resume_choice: this._resumeChoice(session, found) } : session;
  }

  /** What `{{resume}}` renders to: the choice recorded at entry, else one made now (a session stored before the step was declared). */
  private _resumeInstruction(session: SessionState): string {
    const found = this._resumeStepOf(session);
    if (!found) return "";
    const rec = session.resume_choice;
    return rec && sameStep(rec, found)
      ? rec.instruction
      : this._resumeChoice(session, found).instruction;
  }

  /** The line `status` shows for the recorded choice of the state the session is in (empty when none). */
  public resumeChoiceLine(sessionId: string): string | undefined {
    const s = this._storage.read(sessionId);
    const rec = s?.resume_choice;
    if (!s || !rec) return undefined;
    const found = this._resumeStepOf(s);
    if (!found || !sameStep(rec, found)) return undefined;
    return `RESUME CHOICE at ${rec.state} (visit ${rec.visit}): ${rec.choice} agent ${rec.agent === "" ? "(none)" : rec.agent} — ${rec.reason}${rec.context_source ? ` [context from ${rec.context_source}]` : ""} at ${rec.at}`;
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
    if (
      frame.total_transitions >= maxTransitions &&
      !isClosingMove(wf, transitions[transitionName])
    ) {
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

    let updated: SessionState = this._withEntry({
      ...session,
      stack: session.stack.map((f, i) => (i === session.active_frame ? updatedFrame : f)),
      updated_at: now,
      history: [...session.history, historyEntry],
      global_state_visits: { ...prevGlobal, [globalKey]: (prevGlobal[globalKey] ?? 0) + 1 },
    });

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
    // a human wait's own cap counts every round; any other state's counts this round's visits
    const inRound = (n: string, s: StateDefinition | undefined, v: number): number =>
      s?.human ? v : v - (frame.round_base?.[n] ?? 0);
    while (state?.max_visits && inRound(name, state, visits) > state.max_visits) {
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

  private _buildTemplateVars(session: SessionState, withResume = true): Record<string, unknown> {
    // visits/root_workflow let action states route on engine-known facts
    // (fix loops taken, running as a spawned sub-agent) with no agent turn.
    const vars: Record<string, unknown> = {
      session_id: session.session_id,
      parent_session_id: session.parent_session_id ?? "",
      context: session.context,
      visits: session.stack[session.active_frame].state_visits,
      root_workflow: session.stack[0].workflow,
      // the main checkout of the session's cwd, as `start` resolved it; a session
      // stored before the key existed maps its cwd now (a removed worktree then falls back)
      project_root:
        typeof session.context.project_root === "string"
          ? session.context.project_root
          : projectRoot(
              typeof session.context.cwd === "string" ? session.context.cwd : process.cwd(),
            ),
    };
    // read only by a template that names it: it walks the session's sub-tree
    Object.defineProperty(vars, "stale_sessions", {
      get: () => this.staleLines(session.session_id, true).join("\n") || "none",
    });
    // the resume-or-respawn instruction of the state now entered (a `resume:` step): ONE of the two, never both
    if (withResume)
      Object.defineProperty(vars, "resume", {
        get: () => this._resumeInstruction(session),
      });
    // the parent's recorded answers the dispatcher has not relayed yet
    Object.defineProperty(vars, "parent_answers", {
      get: () => this.parentAnswerLines(session.session_id).join("\n") || "none",
    });
    // the engine's decision to replace the dispatcher agent (or to rebind its drivers to the fresh one)
    Object.defineProperty(vars, "refresh", {
      get: () => this.refreshLines(session.session_id).join("\n") || "none",
    });
    // the owed steps of lines that ended, not yet handed to the parent
    Object.defineProperty(vars, "owed_steps", {
      get: () => this.owedLines(session.session_id).join("\n") || "none",
    });
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
    const phaseSink: {
      set?: (phase: ExecPhase) => void;
      note?: (note: string | undefined) => void;
    } = {};
    // A starved pool wait is written on the session (its ancestors' status and transition
    // list it) until no wait of the step is starved any more, and cleared when the step
    // starts and ends — a mark a crashed server left behind never outlives the next step.
    let starvedWrite: Promise<unknown> | undefined;
    let runAtWrite: Promise<unknown> | undefined;
    const clearStarved = (): Promise<unknown> =>
      this._storage
        .update(session.session_id, cur =>
          cur?.pool_starved ? { ...cur, pool_starved: undefined } : null,
        )
        .catch(() => undefined);
    const marked = (): boolean => {
      try {
        return !!this._storage.read(session.session_id)?.pool_starved;
      } catch {
        return false;
      }
    };
    const execCtx: ExecContext = {
      ...this._execContext(session),
      ...this._estimate(session, state),
      onPhase: phase => {
        phaseSink.set?.(phase);
        // the first granted lease starts the step's run: its stall clock counts from here
        if (phase !== "run" || runAtWrite) return;
        const runAt = new Date().toISOString();
        runAtWrite = this._storage
          .update(session.session_id, cur =>
            cur?.pending_action?.frame === frameIndex &&
            cur.pending_action.state === stateName &&
            cur.pending_action.run_at === undefined
              ? { ...cur, pending_action: { ...cur.pending_action, run_at: runAt } }
              : null,
          )
          .catch(() => undefined);
      },
      onStarved: note => {
        phaseSink.note?.(note);
        const record = note !== undefined ? { since: new Date().toISOString(), note } : undefined;
        const write = (): Promise<unknown> =>
          record
            ? this._storage
                .update(session.session_id, cur =>
                  cur && cur.stack.length > 0 ? { ...cur, pool_starved: record } : null,
                )
                .catch(() => undefined)
            : clearStarved();
        // ast-grep-ignore: then-without-catch -- the write catches its own failure
        starvedWrite = starvedWrite ? starvedWrite.then(write) : write();
      },
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
    } else if (mark.run_at !== undefined && !own) {
      // a step run again waits for its own lease: its clock starts at that lease, not the old run's
      await this._storage.update(session.session_id, cur => {
        const p = cur?.pending_action;
        if (!cur || cur.stack.length === 0 || p?.frame !== frameIndex || p.state !== stateName)
          return null;
        return { ...cur, pending_action: { frame: p.frame, state: p.state, at: p.at } };
      });
    }
    let result: ActionResult | null;
    // tells the waiting tool call's client the exec is alive (only when it asked for progress)
    const beat = startHeartbeat(currentProgress(), stateName);
    phaseSink.set = beat.setPhase;
    phaseSink.note = beat.setNote;
    if (marked()) await clearStarved();
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
      if (runAtWrite) await runAtWrite;
      if (starvedWrite) await starvedWrite;
      if (starvedWrite || marked()) await clearStarved();
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
    if (frame.total_transitions >= maxTransitions && !isClosingMove(wf, routedName)) {
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
      ? render(promptTemplate, withResult(vars, result))
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
    const setKeys = new Set(result.success ? Object.keys(state.context_set ?? {}) : []);
    if (result.success && state.context_set) {
      const renderVars = withResult(vars, result);
      const entries = Object.entries(state.context_set).map(
        ([k, v]) => [k, render(v, renderVars)] as const,
      );
      ctx = { ...ctx, ...Object.fromEntries(entries) };
    }

    let updated: SessionState = this._withEntry(
      {
        ...session,
        context: ctx,
        // set_priority runs outside the session's queue: the level written during the exec wins.
        ...(current.priority ? { priority: current.priority } : {}),
        // so do link_agent and the conversation id a resume stamps
        agent_id: current.agent_id,
        agent_step: current.agent_step,
        linked_agents: current.linked_agents,
        agent_links: current.agent_links,
        claude_session_id: current.claude_session_id,
        stack: session.stack.map((f, i) => (i === session.active_frame ? updatedFrame : f)),
        updated_at: now,
        history: [...session.history, historyEntry],
        global_state_visits: { ...prevGlobal, [globalKey]: (prevGlobal[globalKey] ?? 0) + 1 },
        last_action_result: result,
        background_pids: bgPids,
        running_exec: undefined,
        pending_action: undefined,
      },
      setKeys,
    );

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

    if (targetState?.human) return this._enterHuman(updated, targetState, taskOps, actionPrompt);

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
        {
          frame: newStack.length - 1,
          event: "push",
          workflow: subName,
          to: wf.initial,
          at: now,
        },
      ],
      global_state_visits: { ...prevGlobal, [globalKey]: (prevGlobal[globalKey] ?? 0) + 1 },
    };
    const entered = this._withResume(updated);

    await this._storage.write(session.session_id, entered);

    // Check if the initial state of sub_workflow is itself a skill gate, sub_workflow, or action
    const initialState = this._resolveState(entered, subName, wf.initial);
    if (this._isSkillGate(initialState)) {
      return this._handleSkillGate(entered, initialState!, taskOps ?? []);
    }
    if (initialState?.sub_workflow) {
      return this._pushSubWorkflow(entered, initialState, taskOps);
    }
    if (this._isActionState(initialState)) {
      return this._executeActionState(entered, initialState!, taskOps ?? []);
    }

    return this._buildStatus(entered, taskOps);
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

    await this._markQueueLine(session, terminalState?.queue_mark, frame.current_state);
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

  /**
   * A terminal state with `queue_mark:`: the session's own queue line, when it is still `running`, goes to
   * `failed` / `released` (a mark that leaves `running` also ends a temporary window set until it). Never
   * throws: a missing queue or line must not keep the session from ending.
   */
  private async _markQueueLine(
    session: SessionState,
    mark: "failed" | "released" | undefined,
    ended: string,
  ): Promise<void> {
    const file = session.context.queue_file;
    const task = session.context.task;
    if (mark === undefined || typeof file !== "string" || typeof task !== "string") return;
    try {
      await markQueue(file, task, mark, `ended ${ended}: the pipeline made no mark`, {
        ifRunning: true,
        from: "engine",
      });
    } catch {
      // no queue file, no such line, a held lock: the end of the session stands
    }
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
      await this._endHuman(session, outcome);
      await this._finalize(updated);
      await this._cascadeAbandonChildren(session.session_id);
      if (outcome === "complete") await this._dropEndedTask(updated);
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
    const updated: SessionState = this._withEntry({
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
    });

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
      await this._endHuman(child, "cascade_abandon");
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
    // one line at a time: a task line's parent stretch starts where the line before it ended
    const before = this._ledgerTurn;
    const turn = (async () => {
      await before;
      try {
        const entry = ledgerEntry(session, this._spendOf(session));
        await this._storage.appendLedger(this._withParentSpend(session, entry));
      } catch (err) {
        console.error(`Ledger append failed for ${session.session_id}:`, err);
      }
    })();
    this._ledgerTurn = turn;
    await turn;
  }

  /** A task's line also records what the top-level conversation spent in its own turns since the ledger's latest line for it; never throws. */
  private _withParentSpend(session: SessionState, entry: LedgerEntry): LedgerEntry {
    const conversation = session.claude_session_id;
    if (entry.task === undefined || !conversation) return entry;
    try {
      const parent = measureParentSpend(
        conversation,
        session.started_at,
        session.updated_at,
        this._storage.readLedger(),
      );
      return parent ? { ...entry, parent_spend: parent } : entry;
    } catch (err) {
      console.error(`Parent spend of ${session.session_id} not measured:`, err);
      return entry;
    }
  }

  /** The real spend of an ended session's agents (itself and its descendants); never throws. */
  private _spendOf(session: SessionState): LedgerSpend | undefined {
    try {
      const tree = subtreeOf(session, this._storage.readAll());
      return measureSpend(tree, session.started_at, session.updated_at);
    } catch (err) {
      console.error(`Spend of ${session.session_id} not measured:`, err);
      return undefined;
    }
  }

  /** The ledger's estimate of a leased step's run, read by the requester (never under the pool lock). */
  private _estimate(
    session: SessionState,
    state: StateDefinition,
  ): Pick<ExecContext, "estimate" | "estimateCurve"> {
    const stateDir = this._options.stateDir;
    if (!stateDir || !state.resource || state.fanout) return {};
    const frame = session.stack[session.active_frame];
    const cwd = typeof session.context.cwd === "string" ? session.context.cwd : process.cwd();
    const key = `${projectRoot(cwd)}|${frame.workflow}|${frame.current_state}`;
    this._estimates ??= new Estimates(path.join(stateDir, LEDGER_FILE));
    const estimates = this._estimates;
    return {
      estimate: threads => estimates.lookup(key, threads),
      // a history that cannot cover the range still hands over the sizes it has: the pool takes the lease's end from them
      estimateCurve: (min, max) => estimates.curve(key, min, max) ?? estimates.known(key),
    };
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
      agentContext: () => agentContextOf(session),
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
    if (!wf) {
      const session = this._storage.read(sessionId);
      const broken = this.brokenNote(name, session ? Engine._cwdOf(session) : undefined);
      throw new Error(
        broken ? `Workflow "${name}" failed to load: ${broken}` : `Workflow "${name}" not found`,
      );
    }
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

  /**
   * Why the project's own file of `workflow` (or any project file, with no name) is not what a session
   * runs: it declares exec/fetch states and its project is not trusted. Empty when nothing was left out.
   */
  public untrustedNote(workflow: string | undefined, cwd: string | undefined): string {
    const own = this._projectLoaderAt(cwd);
    return [this._loader, ...(own ? [own] : [])]
      .map(l => l.untrustedNote(workflow))
      .filter(n => n !== "")
      .join(" ");
  }

  /** The load failures of the files that define `workflow` (every failed file with no name), the loader's own reason each. */
  public brokenNote(workflow: string | undefined, cwd: string | undefined): string {
    const own = this._projectLoaderAt(cwd);
    const lines = [this._loader, ...(own ? [own] : [])].flatMap(l =>
      l.brokenNote(workflow).split("\n"),
    );
    return [...new Set(lines.filter(n => n !== ""))].join("\n");
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
      return Engine._noActionFromOverlay(stateName, overrides.add_states[stateName]);
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

    const merged = Engine._noActionFromOverlay(stateName, { ...base, ...mods }, base);
    return this._applyTransitionOverrides(merged, workflowName, stateName, overrides);
  }

  /**
   * A session's overlay (`modify`) never brings an exec/fetch state or a human wait's `stop`, nor changes what one runs, whatever
   * its stored file says: the command would run with no one's approval. A state the workflow itself
   * defines as an action state (`base`) keeps what it runs; its routing may still be overlaid.
   */
  private static _noActionFromOverlay(
    stateName: string,
    state: StateDefinition,
    base?: StateDefinition,
  ): StateDefinition {
    if (!runsCommand(state)) return state;
    const runs = (d: StateDefinition | undefined): string =>
      JSON.stringify([
        d?.type,
        d?.human?.stop,
        d?.command,
        d?.cwd,
        d?.env,
        d?.fanout,
        d?.url,
        d?.method,
        d?.headers,
        d?.body,
      ]);
    if (base === undefined || runs(state) !== runs(base))
      throw new Error(actionStateRefusal(`State "${stateName}"`));
    return state;
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

  private _capWarning(session: SessionState, frame: StackFrame): string | undefined {
    const wf = this._getWorkflow(session.session_id, frame.workflow);
    const max = wf.max_transitions ?? DEFAULT_MAX_TRANSITIONS;
    const left = max - frame.total_transitions;
    if (left > max * 0.05) return undefined;
    if (this._resolveState(session, frame.workflow, frame.current_state)?.terminal)
      return undefined;
    return (
      `${frame.total_transitions} of ${max} transitions used in "${frame.workflow}"` +
      (left > 0 ? `, ${left} left` : `, none left`) +
      `. At the cap only a move that closes the run (into a terminal, or a state that leads on to one without a way back) is accepted: ` +
      `end the run cleanly now (a stop / report route), or raise max_transitions in the workflow file and start a new session.`
    );
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
    const wait = state?.human ? liveHumanWait(session) : undefined;
    if (wait !== undefined) {
      const a = wait.answer;
      const passes = a !== undefined && (state!.human!.passes ?? [a.route]).includes(a.route);
      const movedTo = passes ? this._movedTo(session, state!.human!.moved, wait) : undefined;
      prompt += `\n\n${humanWaitBlock(session, wait, answerKeyOf(state!.human), movedTo)}`;
    }

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
      // a human wait's block (the answer, or what to do without one) is new on every visit
      forcePrompt: actionPrompt !== undefined || wait !== undefined,
      capWarning: this._capWarning(session, frame),
      revisitPrompt:
        state?.revisit_prompt === undefined ? undefined : render(state.revisit_prompt, vars),
      signalNotices: signalNoticeLines(state?.signal_vars, vars),
    };
  }
}
