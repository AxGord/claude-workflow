import { z } from "zod";

// --- Workflow Definition (parsed from YAML) ---

/** `threads: "budget"` asks for the pool's whole budget as configured when the request is made; a later raise of `budget` does not grow a waiting or held lease. */
export const RESOURCE_THREADS_BUDGET = "budget";

/** An exec's deadline stretches by its command's pool wait, up to this many times its `timeout`. */
export const POOL_WAIT_CEILING_FACTOR = 4;

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

/** A task's difficulty as a queue line's `difficulty:` and a session's `context.difficulty` carry it. */
export const DIFFICULTY_MIN = 1;
export const DIFFICULTY_MAX = 10;

/** The Agent tool's effort levels: a row naming another is a typo. */
export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

/** One model choice: what an Agent call of that step takes. */
export const ModelChoiceObjectSchema = z
  .object({ model: z.string().min(1), effort: EffortSchema })
  .strict();

/** A `model_table` row: the difficulties up to `upto` (after the previous row's) take this model and effort. */
export const ModelRowObjectSchema = z
  .object({
    upto: z.number().int().min(DIFFICULTY_MIN).max(DIFFICULTY_MAX),
    model: z.string().min(1),
    effort: EffortSchema,
  })
  .strict();

/**
 * A task workflow's `model_table:` (the loader names the nearest key for a typo): `rows` map
 * `context.difficulty` to `model` / `effort` (ascending `upto`, the last row's 10); each `escalate`
 * entry (`state: N`) moves one row up once that state's visits reach N; `review` maps the
 * `context.review_class` an exec measured from the diff to the reviewer's model and effort. `stages`
 * (named agent steps — any lowercase name; the bundled workflows use plan, execute, review, review_verify, fix) each map the difficulty by their own
 * rows; `stages.execute` replaces `rows` (the model / effort every workflow already reads), and
 * `escalate` moves the execute and fix stages only.
 */
export const ModelTableObjectSchema = z
  .object({
    rows: z.array(ModelRowObjectSchema).nonempty().optional(),
    stages: z.record(z.array(ModelRowObjectSchema).nonempty()).optional(),
    escalate: z.record(z.number().int().positive()).optional(),
    review: z.record(ModelChoiceObjectSchema).optional(),
  })
  .strict();

export type ModelTable = z.infer<typeof ModelTableObjectSchema>;

/**
 * A task workflow's `driver:` — the cheap agent that drives one task session for the dispatcher.
 * `prompt_ref` = the driver's instructions: a bare name (`task-driver`) is a shipped one
 * (`templates/drivers/<name>.md`), anything else a path (absolute, `~/…`, or relative to the session's cwd).
 * `agent_type` = the Agent call's `subagent_type` (default `workflow:driver`, the plugin's agents/driver.md:
 * workflow tools plus Agent / SendMessage / Read only, so the driver cannot edit code).
 * `start` of a session of such a workflow answers with the exact Agent call (src/driver.ts).
 */
export const DriverObjectSchema = z
  .object({
    model: z.string().min(1),
    effort: EffortSchema,
    prompt_ref: z.string().min(1),
    agent_type: z.string().min(1).optional(),
  })
  .strict();

/**
 * A dispatcher's `refresh:` — when the engine hands a long-lived dispatcher over to a fresh one (the
 * block's `refresh: false` = never): the same two thresholds as a task workflow's `resume:`,
 * `idle_minutes` (default 60, the prompt cache's life) and `context_tokens` (default 200000).
 */
export const DispatcherRefreshSchema = z
  .object({
    idle_minutes: z.number().positive().optional(),
    context_tokens: z.number().int().positive().optional(),
  })
  .strict();

/**
 * A dispatching workflow's `dispatcher:` — the cheap agent that drives the DISPATCHER session itself
 * (admission, task starts, driver spawns, slot bookkeeping) for the main conversation. Opt-in:
 * `env` = the environment variable that turns it on (absent = always on); off, the workflow is as if
 * it declared none. `after` = the state the main conversation still drives itself (building the
 * queue); the reply that leaves it repeats the block. `prompt_ref` / `agent_type` as in `driver:`
 * (default type `workflow:dispatcher`). Unlike `driver:` it changes nothing but `start`'s answer:
 * no `agent_step`, no one-agent-per-visit reading of the session's children.
 * `refresh` = see `DispatcherRefreshSchema`.
 */
export const DispatcherObjectSchema = z
  .object({
    model: z.string().min(1),
    effort: EffortSchema,
    prompt_ref: z.string().min(1),
    agent_type: z.string().min(1).optional(),
    env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an environment variable name")
      .optional(),
    after: z.string().min(1).optional(),
    refresh: z.union([z.literal(false), DispatcherRefreshSchema]).optional(),
  })
  .strict();

/** A context key name: what `{{context.<key>}}` reads. */
const CONTEXT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A task workflow's `resume:` — how the engine chooses, at a step that wakes an agent it already ran
 * (a fix round's worker), between `SendMessage` to that agent and a fresh spawn with a handoff brief.
 * `agent` = the context key holding the agent's id; `tokens` = the context key its tokens are kept in
 * (read only when its transcript has no readable turn). The agent was warm when its transcript changed
 * less than `idle_minutes` ago (default 60, the prompt cache's life): it is resumed. A cold one is
 * respawned when its context is above `context_tokens` (default 50000). `model` / `effort` are
 * templates for the spawn (empty = the step's usual); `after_respawn` is a template appended to the
 * spawn instruction (what to record of the new agent).
 */
export const ResumeObjectSchema = z
  .object({
    agent: z.string().regex(CONTEXT_KEY, "a context key name"),
    tokens: z.string().regex(CONTEXT_KEY, "a context key name").optional(),
    idle_minutes: z.number().positive().optional(),
    context_tokens: z.number().int().positive().optional(),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    after_respawn: z.string().min(1).optional(),
  })
  .strict();

/**
 * A state's `resume:` — the step the engine renders as `{{resume}}`: `message` is what goes to the
 * agent when it is resumed (a template), `brief` the prompt of a fresh one (a template; required
 * unless `never_respawn`). `never_respawn: true` marks a step whose agent is always resumed, however
 * cold (a fix round whose worker's own reasoning matters).
 */
export const ResumeStepSchema = z
  .object({
    message: z.string().min(1),
    brief: z.string().min(1).optional(),
    never_respawn: z.boolean().optional(),
  })
  .strict();

/**
 * A state's `delivers:` — the context key the agent the state waits on writes its deliverable to (a bare
 * string is the key alone). The `context_set` of that key while the session stands at the state is the
 * DELIVERY: the engine records it (`SessionState.delivery`), tells the driver and the dispatcher at their
 * next `status` / `transition`, and fills `tokens` (the context key an agent's tokens are kept in) from the
 * agent's transcript. `agent` = the context key holding the agent's id; absent, the latest non-driver agent
 * linked to the session at this visit of the state.
 */
export const DeliversObjectSchema = z
  .object({
    key: z.string().regex(CONTEXT_KEY, "a context key name"),
    tokens: z.string().regex(CONTEXT_KEY, "a context key name").optional(),
    agent: z.string().regex(CONTEXT_KEY, "a context key name").optional(),
  })
  .strict();

export const DeliversSchema = z.union([
  z.string().regex(CONTEXT_KEY, "a context key name"),
  DeliversObjectSchema,
]);

export type Delivers = z.infer<typeof DeliversObjectSchema>;

/** A state's `delivers:` in its one object form (the bare key is `{ key }`). */
export const deliversOf = (d: z.infer<typeof DeliversSchema> | undefined): Delivers | undefined =>
  d === undefined ? undefined : typeof d === "string" ? { key: d } : d;

export type Resume = z.infer<typeof ResumeObjectSchema>;
export type ResumeStep = z.infer<typeof ResumeStepSchema>;

/** The engine's choice at a `resume:` step, recorded when the state is entered: what `{{resume}}` shows and `status` lists. */
export interface ResumeChoice {
  /** The stack frame and its workflow the state was entered in: a sub-workflow's own state of the same name is another step. */
  readonly frame: number;
  readonly workflow: string;
  readonly state: string;
  /** The state's visit number the choice was made at. */
  readonly visit: number;
  readonly choice: "resume" | "respawn";
  /** The agent's id (empty when the context named none). */
  readonly agent: string;
  /** Whole minutes since the agent's transcript last changed; absent when it could not be found. */
  readonly idle_minutes?: number;
  /** The agent's context: its last turn's size, else the `tokens` key. */
  readonly context?: number;
  readonly context_source?: "transcript" | "tokens";
  readonly reason: string;
  readonly at: string;
  /** The text `{{resume}}` renders to. */
  readonly instruction: string;
}

export type DispatcherRefreshSpec = z.infer<typeof DispatcherRefreshSchema>;

/** The engine's decision to hand a dispatcher agent over, recorded when its session entered `collect` with the agent past its bounds. */
export interface DispatcherRefresh {
  /** The dispatcher agent that was due. */
  readonly agent: string;
  readonly reason: string;
  /** Its context: the last turn's size. */
  readonly context: number;
  /** Whole minutes since the session's previous engine call; absent when unknown. */
  readonly idle_minutes?: number;
  readonly at: string;
}

export type Driver = z.infer<typeof DriverObjectSchema>;
export type Dispatcher = z.infer<typeof DispatcherObjectSchema>;

// Single source of truth for state fields. Tool schemas derive from this.
// To hide internal fields from tools: StateDefinitionSchema.omit({ _field: true })
export const StateDefinitionSchema = z
  .object({
    prompt: z.string().optional(),
    // The resume-or-respawn step `{{resume}}` renders in this state's prompt (workflow-level `resume:` holds the thresholds)
    resume: ResumeStepSchema.optional(),
    // The context key the agent this state waits on delivers to: its `context_set` is the delivery (see `DeliversObjectSchema`)
    delivers: DeliversSchema.optional(),
    transitions: z.record(z.string()).optional(),
    terminal: z.boolean().optional(),
    outcome: z.enum(["complete", "fail"]).optional(),
    // On a terminal state: when the session enters it, its own queue line (context `queue_file` + `task`)
    // that is still `running` is marked `failed` or `released` by the engine, so no line stays running
    // with no pipeline behind it. A line already marked is left as it is.
    queue_mark: z.enum(["failed", "released"]).optional(),
    max_visits: z.number().int().positive().optional(),
    // a move past max_visits enters this state instead of being refused
    on_exhausted: z.string().optional(),
    sub_workflow: z.string().optional(),
    on_complete: z.string().optional(),
    on_fail: z.string().optional(),
    task: z.string().optional(),

    // The state asks its parent a question: entering it logs an `ask` event, leaving it an `answer`
    // (the live workflow map draws the pair)
    ask: z.literal("parent").optional(),

    // Live workflow map: `false` keeps the state out of the band's stations (an exec helper), `true`
    // makes it one off the shortest path, and on a terminal picks the success end (src/stations.ts)
    station: z.boolean().optional(),

    // Skill gate: require skills to be loaded before proceeding
    skills: z.array(z.string()).optional(),

    // Include project-specific workflow list in prompt
    include_workflows: z.boolean().optional(),

    // Deliver a short digest instead of the full prompt when this state's
    // full prompt was already delivered once in this server process (the
    // agent's context already holds it; status() always returns the full text)
    digest_on_repeat: z.boolean().optional(),

    // Always deliver the full prompt, also on a revisit: the state's text carries what the agent must do
    // THIS time (a fresh session to start, a value that changed), not a rule it can recall from the first visit.
    full_on_revisit: z.boolean().optional(),

    // Template (rendered like `prompt`) shown on a revisit instead of the generic
    // "Revisit #N" line, for per-visit data such as an exec's {{stdout}}
    revisit_prompt: z.string().optional(),

    // seconds the state may go with no engine call before `sessions` / `status` mark the session
    // STALE (0 = never); unset = the state type's default (`STALE_AFTER_DEFAULTS` in stale.ts)
    stale_after: z.number().int().nonnegative().optional(),

    // Action state fields
    type: z.enum(["prompt", "exec", "fetch"]).optional(),

    // exec
    command: z.string().optional(),
    cwd: z.string().optional(),
    // ms; counts the run, not a pool wait (its own lease's, or its session's `wf-run` waiter's, up to 4x)
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
    model_table: ModelTableObjectSchema.optional(),
    resume: ResumeObjectSchema.optional(),
    driver: DriverObjectSchema.optional(),
    dispatcher: DispatcherObjectSchema.optional(),
    // Live map: `false` keeps a root session of this workflow with no children (a conversation, not a task) off the map
    map: z.boolean().optional(),
    states: z.record(StateDefinitionSchema),
  })
  .strict();

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

/**
 * A workflow YAML file as written. With `extends: <workflow>` it is a heir:
 * the base's states plus its own (a state of the same name replaces the
 * base's whole), and `initial` / `max_transitions` / `description` / `model_table` / `resume` / `driver` / `dispatcher` from the
 * heir where it sets them. Without `extends`, `initial` and `states` are required.
 */
export const WorkflowFileObjectSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    extends: z.string().min(1).optional(),
    initial: z.string().min(1).optional(),
    max_transitions: z.number().int().positive().optional(),
    model_table: ModelTableObjectSchema.optional(),
    resume: ResumeObjectSchema.optional(),
    driver: DriverObjectSchema.optional(),
    dispatcher: DispatcherObjectSchema.optional(),
    map: z.boolean().optional(),
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

/**
 * Where a parent stood when an agent was linked to its child: the active frame's workflow, state and
 * that state's visit. A later visit of the same state makes the agent an earlier visit's.
 */
export interface AgentStep {
  readonly workflow: string;
  readonly state: string;
  readonly visit: number;
}

/**
 * One `link_agent` call as the ledger's per-agent spend reads it: when it ran and the parent's state (and
 * the stage that state spawns on) the agent was linked at. A same agent linked again adds a row, so its turns
 * split at each link's time (`measureSpend`). Unlike `agent_step` it is recorded under any parent.
 */
export interface AgentLink {
  readonly agent_id: string;
  /** ISO time of the call. */
  readonly at: string;
  /** The parent's active state at the call; absent when the session has no active parent. */
  readonly state?: string;
  /** The first stage that state spawns on (`stagesSpawned`); absent when it spawns none. */
  readonly stage?: string;
  /** What the agent is to the session: `driver` (the agent that drives it) or another role (`worker`, `decider`, ...). Absent on a link made before roles. */
  readonly role?: string;
  /** The linked session's OWN step at the call; recorded for a non-driver link, which `agent_step` never holds. */
  readonly step?: AgentStep;
}

/** The role of the agent that drives a session: the one `agent_id` names. */
export const DRIVER_ROLE = "driver";

/** What a role name may be: lower-case words joined by `-` or `_`. */
export const ROLE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * An agent's delivery at a state that declares `delivers:`: the `context_set` of the deliverable key at
 * this step. It stands only while the session is still at the step it was made at (a move off it ends it).
 */
export interface Delivery extends AgentStep {
  readonly key: string;
  readonly at: string;
  /** The agent the tokens were read from (its transcript), when one could be named. */
  readonly agent?: string;
  /** The tokens context key the engine filled, and what it wrote: the value the key held when the step's first delivery came, plus the agent's context. */
  readonly tokens?: { readonly key: string; readonly base: number; readonly value: number };
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
  /** The Agent-tool id of the sub-agent driving this session (`link_agent`, role `driver`): a later link of another role never replaces it. */
  readonly agent_id?: string;
  /** Every agent `link_agent` ever linked to this session, in order (`agent_id` is only the latest driver: a respawned driver replaces it): what the ledger's spend sums. */
  readonly linked_agents?: readonly string[];
  /** Every `link_agent` call on this session, in order: what the ledger attributes each agent's spend to a state and stage by. */
  readonly agent_links?: readonly AgentLink[];
  /** The parent's step the driver's `link_agent` ran at; absent unless the parent was an active session of a `driver:` workflow then. */
  readonly agent_step?: AgentStep;
  /** The engine's resume-or-respawn choice at the latest entered state that declares `resume:`. */
  readonly resume_choice?: ResumeChoice;
  /** The latest delivery of a state's `delivers:` key; live only while the session stands at the step it names. */
  readonly delivery?: Delivery;
  /** A dispatching session: the wake its latest write belongs to (`at`) and the idle before that wake's first write (`idle_ms`). */
  readonly wake?: { readonly at: string; readonly idle_ms: number };
  /** A dispatching session whose dispatcher agent is past its refresh bounds: the engine's decision (`refresh.ts`). */
  readonly dispatcher_refresh?: DispatcherRefresh;
  readonly running_exec?: RunningExec;
  /**
   * The action state a server began and has not routed yet, written before its
   * exec waits for a lease or spawns: left without a `running_exec` by a server
   * that is gone, the step never started, and its new owner runs it again.
   */
  readonly pending_action?: PendingAction;
  /** Set while the step's exec waits for a pool lease past the pool's `starve_after`: since when, and why. */
  readonly pool_starved?: { readonly since: string; readonly note: string };
}

/** Where a session's unrouted action step is: its frame and state. */
export interface PendingAction {
  readonly frame: number;
  readonly state: string;
  readonly at: string;
  /** When a `resource:` / `fanout:` exec's run began (its first lease granted): its stall clock starts there. */
  readonly run_at?: string;
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
  "Priority level of the session's pool leases: low | normal | high | urgent. Default: the parent session's level, else the project's `.claude/workflows/settings.json` priority, else normal";

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

/** The one `status` key that is not a context key: the session's current transitions (a context key of this name wins). */
export const STATUS_ROUTES_KEY = "routes";

export const STATUS_KEY_DESCRIPTION =
  "Return only this context key's FULL value (status cuts every value to 200 chars). `routes` (when the context has no such key): the session's transitions at its current state, `a|b|c`";

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
