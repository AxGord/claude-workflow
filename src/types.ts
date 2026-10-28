import { z } from "zod";

// --- Workflow Definition (parsed from YAML) ---

/** `threads: "budget"` asks for the pool's whole budget as configured when the request is made; a later raise of `budget` does not grow a waiting or held lease. */
export const RESOURCE_THREADS_BUDGET = "budget";

/** A named lock: one word, no whitespace (`port:3000`, `ios-simulator`). */
export const LOCK_NAME_PATTERN = /^\S+$/;

/**
 * A session's priority level and the pool priority it stands for. A lease's
 * priority is its session's level plus the step's own `priority`, so a step
 * fine-tunes within its level as long as it stays under the level spacing.
 */
export const PRIORITY_LEVELS = { low: -100, normal: 0, high: 100, urgent: 200 } as const;
export type PriorityLevel = keyof typeof PRIORITY_LEVELS;
export const DEFAULT_PRIORITY_LEVEL: PriorityLevel = "normal";
export const PriorityLevelSchema = z.enum(["low", "normal", "high", "urgent"]);

const ThreadCountSchema = z.union([
  z.number().int().positive(),
  z.literal(RESOURCE_THREADS_BUDGET),
]);

/** `threads: { min, max }`: take what is free, at least `min`, at most `max`. */
export const FlexibleThreadsSchema = z
  .object({
    min: z.number().int().positive(),
    max: ThreadCountSchema,
  })
  .strict()
  .refine(t => t.max === RESOURCE_THREADS_BUDGET || t.min <= t.max, {
    message: "threads.min must not exceed threads.max",
  });

/** The keys of `resource:` (the loader names the nearest one for a typo). */
export const ResourceObjectSchema = z
  .object({
    threads: z.union([ThreadCountSchema, FlexibleThreadsSchema]).optional(),
    // flexible threads only: wait this long for the full max before taking what is free
    wait_full: z.number().nonnegative().optional(),
    // machine-wide mutual exclusion by name, granted atomically with the threads
    locks: z
      .array(z.string().regex(LOCK_NAME_PATTERN, "a lock name is one word without whitespace"))
      .nonempty()
      .optional(),
    priority: z.number().int().optional(),
    wait_timeout: z.number().nonnegative().optional(),
  })
  .strict();

export const ResourceSchema = ResourceObjectSchema.refine(
  r => r.threads !== undefined || r.locks !== undefined,
  { message: "resource needs threads, locks, or both" },
).refine(r => r.wait_full === undefined || typeof r.threads === "object", {
  message: "wait_full needs threads: { min, max }",
});

/**
 * The keys of `fanout:` (the loader names the nearest one for a typo): run the
 * exec's command `count` times (`WF_SHARD=i/N`, 1-based) or once per line
 * `items_command` prints (`WF_ITEM=<line>`), each instance under its own
 * pool lease of `threads_each` threads, at most `max_parallel` at once.
 */
export const FanoutObjectSchema = z
  .object({
    count: z.number().int().positive().optional(),
    items_command: z.string().min(1).optional(),
    threads_each: z.number().int().positive(),
    max_parallel: z.number().int().positive().optional(),
  })
  .strict();

export const FanoutSchema = FanoutObjectSchema.refine(
  f => (f.count === undefined) !== (f.items_command === undefined),
  { message: "fanout needs exactly one of count, items_command" },
);

// Single source of truth for state fields. Tool schemas derive from this.
// To hide internal fields from tools: StateDefinitionSchema.omit({ _field: true })
export const StateDefinitionSchema = z
  .object({
    prompt: z.string().optional(),
    transitions: z.record(z.string()).optional(),
    terminal: z.boolean().optional(),
    outcome: z.enum(["complete", "fail"]).optional(),
    max_visits: z.number().int().positive().optional(),
    // a move past max_visits enters this state instead of being refused
    on_exhausted: z.string().optional(),
    sub_workflow: z.string().optional(),
    on_complete: z.string().optional(),
    on_fail: z.string().optional(),
    task: z.string().optional(),

    // Skill gate: require skills to be loaded before proceeding
    skills: z.array(z.string()).optional(),

    // Include project-specific workflow list in prompt
    include_workflows: z.boolean().optional(),

    // Deliver a short digest instead of the full prompt when this state's
    // full prompt was already delivered once in this server process (the
    // agent's context already holds it; status() always returns the full text)
    digest_on_repeat: z.boolean().optional(),

    // Action state fields
    type: z.enum(["prompt", "exec", "fetch"]).optional(),

    // exec
    command: z.string().optional(),
    cwd: z.string().optional(),
    timeout: z.number().positive().optional(),
    env: z.record(z.string()).optional(),
    background: z.boolean().optional(),
    max_output: z.number().int().positive().optional(), // stdout/stderr truncation limit in bytes (default 10KB)
    // heavy work: lease `threads` and/or named `locks` from the machine-wide
    // pool before running (wait_timeout seconds, then exit 75); foreground exec only
    resource: ResourceSchema.optional(),
    // run the command as N shards, each under its own pool lease; exit 0 only if every shard exits 0
    fanout: FanoutSchema.optional(),
    // exec killed by its `timeout` (exit 124) routes here instead of on_error/cases
    on_timeout: z.string().optional(),

    // fetch
    url: z.string().optional(),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"]).optional(),
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),

    // shared action routing
    on_success: z.string().optional(),
    on_error: z.string().optional(),
    cases: z.record(z.string()).optional(),
    default: z.string().optional(),
    success_prompt: z.string().optional(),
    error_prompt: z.string().optional(),
    retry: z
      .object({ max: z.number().int().positive(), interval: z.number().int().positive() })
      .strict()
      .optional(),
    context_set: z.record(z.string()).optional(), // auto-set context keys after action succeeds; values are templates (e.g. "{{stdout}}")
  })
  .strict(); // an unknown key is a typo, never a silently ignored field

export type StateDefinition = z.infer<typeof StateDefinitionSchema>;

export const WorkflowDefinitionSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    initial: z.string().min(1),
    max_transitions: z.number().int().positive().optional().default(50),
    states: z.record(StateDefinitionSchema),
  })
  .strict();

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

/**
 * A workflow YAML file as written. With `extends: <workflow>` it is a heir:
 * the base's states plus its own (a state of the same name replaces the
 * base's whole), and `initial` / `max_transitions` / `description` from the
 * heir where it sets them. Without `extends`, `initial` and `states` are required.
 */
export const WorkflowFileObjectSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    extends: z.string().min(1).optional(),
    initial: z.string().min(1).optional(),
    max_transitions: z.number().int().positive().optional(),
    states: z.record(StateDefinitionSchema).optional(),
  })
  .strict();

export const WorkflowFileSchema = WorkflowFileObjectSchema.refine(
  f => f.extends !== undefined || (f.initial !== undefined && f.states !== undefined),
  { message: "a workflow without extends needs initial and states" },
);

export type WorkflowFile = z.infer<typeof WorkflowFileSchema>;

// --- Action Result (from exec/fetch states) ---

export interface ActionResult {
  readonly type: "exec" | "fetch";
  readonly success: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exit_code?: number;
  readonly status?: number;
  readonly body?: string;
  readonly error?: string;
  readonly pid?: number;
  readonly duration_ms?: number;
  /** Time spent waiting for a pool lease (`resource:` execs); not part of duration_ms. */
  readonly wait_ms?: number;
  /** Threads the pool granted a `resource:` exec (absent when it got no lease). */
  readonly threads_granted?: number;
  /** A `fanout:` exec's instances, in shard order. */
  readonly shards?: readonly ShardResult[];
}

/** One instance of a `fanout:` exec. */
export interface ShardResult {
  /** `i/N` (1-based) for `count`, the item line for `items_command`. */
  readonly shard: string;
  readonly exit_code: number;
  readonly duration_ms: number;
  readonly wait_ms: number;
  readonly threads_granted?: number;
}

// --- Session State (persisted as JSON) ---

export interface StackFrame {
  readonly workflow: string;
  readonly current_state: string;
  readonly state_visits: Record<string, number>;
  readonly total_transitions: number;
}

export interface HistoryEntry {
  readonly frame: number;
  readonly at: string;
  readonly from?: string;
  readonly to?: string;
  readonly via?: string;
  readonly event?: string;
  readonly workflow?: string;
  readonly actor?: string;
  readonly detail?: string;
  readonly exit_code?: number;
  readonly duration_ms?: number;
  readonly wait_ms?: number;
  readonly threads_granted?: number;
  /** A leased exec's step: `<project>|<workflow>|<state>` (project = the session cwd's git root). */
  readonly step_key?: string;
  readonly shards?: readonly ShardResult[];
}

export type SessionOutcome = "completed" | "failed" | "abandoned";

/**
 * The files of a foreground exec started detached in its own process group:
 * its output goes to `out` / `err` and its exit code to `rc`, so the run
 * outlives the server and a later one can take its result over.
 */
export interface DetachedRun {
  readonly pgid: number;
  readonly out: string;
  readonly err: string;
  readonly rc: string;
  readonly started_at: string;
  /** Machine boot time when it started: a different boot means the process is gone whatever its pgid shows. */
  readonly boot_ms: number;
}

/** A session's foreground exec in flight, recorded so a resume can take it over. */
export interface RunningExec extends DetachedRun {
  readonly frame: number;
  readonly state: string;
}

export interface SessionState {
  readonly session_id: string;
  readonly parent_session_id?: string;
  readonly root_session_id?: string;
  /** Inherited from the parent at start; `set_priority` changes it for the session and its descendants. Absent = normal. */
  readonly priority?: PriorityLevel;
  readonly stack: StackFrame[];
  readonly active_frame: number;
  readonly started_at: string;
  readonly updated_at: string;
  readonly history: HistoryEntry[];
  readonly overrides: Record<string, WorkflowOverrides>;
  readonly context: Record<string, unknown>;
  readonly outcome?: SessionOutcome;
  readonly soft_terminal?: boolean;
  readonly last_action_result?: ActionResult;
  readonly background_pids?: Record<string, number>;
  readonly pending_pop?: { readonly outcome: "complete" | "fail" };
  readonly global_state_visits?: Record<string, number>;
  readonly skill_epoch?: number;
  readonly loaded_skills?: Record<string, number>;
  /** Set while the Claude Code process that owned the session is gone; `resume` clears it. */
  readonly suspended_at?: string;
  /** The Claude Code conversation the session belongs to (`claude --resume` keeps it). */
  readonly claude_session_id?: string;
  /** The Agent-tool id of the sub-agent driving this session (`link_agent`). */
  readonly agent_id?: string;
  readonly running_exec?: RunningExec;
}

export interface WorkflowOverrides {
  readonly add_states?: Record<string, StateDefinition>;
  readonly modify_states?: Record<string, Partial<StateDefinition>>;
  readonly add_transitions?: Array<{ from: string; name: string; to: string }>;
  readonly remove_transitions?: Array<{ from: string; name: string }>;
}

// --- Tool input schemas ---

export const START_CWD_DESCRIPTION =
  "Absolute path of an existing directory the session works in (e.g. a sub-agent's git worktree); " +
  "exec states without their own cwd run there. Default: the server's cwd";

export const START_PRIORITY_DESCRIPTION =
  "Priority level of the session's pool leases: low | normal | high | urgent. Default: the parent session's level, else normal";

export const WorkflowStartInputSchema = z.object({
  workflow: z.string().optional().describe('Name of the workflow to start. Defaults to "master"'),
  actor: z.string().optional().describe("Identity of the agent performing this action"),
  parent_session_id: z.string().optional().describe("Parent session ID for sub-agent tracking"),
  cwd: z.string().optional().describe(START_CWD_DESCRIPTION),
  priority: PriorityLevelSchema.optional().describe(START_PRIORITY_DESCRIPTION),
});

export const WorkflowTransitionInputSchema = z.object({
  session_id: z.string().describe("Session identifier"),
  transition: z.string().describe("Name of the transition to take"),
  actor: z.string().optional().describe("Identity of the agent performing this action"),
});

export const STATUS_KEY_DESCRIPTION =
  "Return only this context key's FULL value (status cuts every value to 200 chars)";

export const WorkflowStatusInputSchema = z.object({
  session_id: z.string().describe("Session identifier"),
  key: z.string().optional().describe(STATUS_KEY_DESCRIPTION),
});

export const WorkflowContextSetInputSchema = z.object({
  session_id: z.string().describe("Session identifier"),
  key: z.string().describe("Context key"),
  value: z.unknown().describe("Context value"),
  actor: z.string().optional().describe("Identity of the agent performing this action"),
});

export const WorkflowModifyInputSchema = z.object({
  session_id: z.string().describe("Session identifier"),
  add_state: StateDefinitionSchema.extend({ name: z.string() })
    .optional()
    .describe("Add a new state to the current workflow"),
  add_transition: z
    .object({
      from: z.string(),
      name: z.string(),
      to: z.string(),
    })
    .optional()
    .describe("Add a transition between states"),
  remove_transition: z
    .object({
      from: z.string(),
      name: z.string(),
    })
    .optional()
    .describe("Remove a transition"),
});

export const WorkflowCreateInputSchema = z.object({
  name: z.string().min(1).describe("Workflow name (used as filename)"),
  definition: z
    .object({
      description: z.string().optional(),
      initial: z.string().min(1),
      max_transitions: z.number().int().positive().optional(),
      states: z.record(StateDefinitionSchema),
    })
    .describe("Full workflow definition"),
});

export const WorkflowAbortInputSchema = z.object({
  session_id: z.string().describe("Session identifier"),
});

export const WorkflowListInputSchema = z.object({}).optional();

export const WorkflowSessionsInputSchema = z.object({}).optional();

// --- Constants ---

export const MAX_STACK_DEPTH = 10;
export const DEFAULT_MAX_TRANSITIONS = 50;
export const LOCK_STALE_MS = 5000;
export const KEEP_TERMINAL_SESSIONS = 3;
/** A suspended session nobody resumed for this many days is abandoned (`WF_SUSPENDED_TTL_DAYS`). */
export const DEFAULT_SUSPENDED_TTL_DAYS = 7;
