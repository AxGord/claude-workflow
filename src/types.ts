import { z } from "zod";

// --- Workflow Definition (parsed from YAML) ---

// Single source of truth for state fields. Tool schemas derive from this.
// To hide internal fields from tools: StateDefinitionSchema.omit({ _field: true })
export const StateDefinitionSchema = z.object({
  prompt: z.string().optional(),
  transitions: z.record(z.string()).optional(),
  terminal: z.boolean().optional(),
  outcome: z.enum(["complete", "fail", "needs_action"]).optional(),
  max_visits: z.number().int().positive().optional(),
  sub_workflow: z.string().optional(),
  on_complete: z.string().optional(),
  on_fail: z.string().optional(),
  task: z.string().optional(),

  // Skill gate: require skills to be loaded before proceeding
  skills: z.array(z.string()).optional(),

  // Include project-specific workflow list in prompt
  include_workflows: z.boolean().optional(),

  // Action state fields
  type: z.enum(["prompt", "exec", "fetch"]).optional(),

  // exec
  command: z.string().optional(),
  cwd: z.string().optional(),
  timeout: z.number().positive().optional(),
  env: z.record(z.string()).optional(),
  background: z.boolean().optional(),
  max_output: z.number().int().positive().optional(), // stdout/stderr truncation limit in bytes (default 10KB)

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
  retry: z.object({ max: z.number().int().positive(), interval: z.number().int().positive() }).optional(),
  context_set: z.record(z.string()).optional(), // auto-set context keys after action succeeds; values are templates (e.g. "{{stdout}}")
});

export type StateDefinition = z.infer<typeof StateDefinitionSchema>;

export const WorkflowDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  initial: z.string().min(1),
  max_transitions: z.number().int().positive().optional().default(50),
  states: z.record(StateDefinitionSchema),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

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
}

export interface SessionState {
  readonly session_id: string;
  readonly parent_session_id?: string;
  readonly stack: StackFrame[];
  readonly active_frame: number;
  readonly started_at: string;
  readonly updated_at: string;
  readonly history: HistoryEntry[];
  readonly overrides: Record<string, WorkflowOverrides>;
  readonly context: Record<string, unknown>;
  readonly outcome?: "completed" | "abandoned";
  readonly soft_terminal?: boolean;
  readonly last_action_result?: ActionResult;
  readonly background_pids?: Record<string, number>;
  readonly pending_pop?: { readonly outcome: "complete" | "fail" };
  readonly global_state_visits?: Record<string, number>;
  readonly skill_epoch?: number;
  readonly loaded_skills?: Record<string, number>;
}

export interface WorkflowOverrides {
  readonly add_states?: Record<string, StateDefinition>;
  readonly modify_states?: Record<string, Partial<StateDefinition>>;
  readonly add_transitions?: Array<{ from: string; name: string; to: string }>;
  readonly remove_transitions?: Array<{ from: string; name: string }>;
}

// --- Tool input schemas ---

export const WorkflowStartInputSchema = z.object({
  workflow: z.string().optional().describe("Name of the workflow to start. Defaults to \"master\""),
  actor: z.string().optional().describe("Identity of the agent performing this action"),
  parent_session_id: z.string().optional().describe("Parent session ID for sub-agent tracking"),
});

export const WorkflowTransitionInputSchema = z.object({
  session_id: z.string().describe("Session identifier"),
  transition: z.string().describe("Name of the transition to take"),
  actor: z.string().optional().describe("Identity of the agent performing this action"),
});

export const WorkflowStatusInputSchema = z.object({
  session_id: z.string().describe("Session identifier"),
});

export const WorkflowContextSetInputSchema = z.object({
  session_id: z.string().describe("Session identifier"),
  key: z.string().describe("Context key"),
  value: z.unknown().describe("Context value"),
  actor: z.string().optional().describe("Identity of the agent performing this action"),
});

export const WorkflowModifyInputSchema = z.object({
  session_id: z.string().describe("Session identifier"),
  add_state: StateDefinitionSchema.extend({ name: z.string() }).optional().describe("Add a new state to the current workflow"),
  add_transition: z.object({
    from: z.string(),
    name: z.string(),
    to: z.string(),
  }).optional().describe("Add a transition between states"),
  remove_transition: z.object({
    from: z.string(),
    name: z.string(),
  }).optional().describe("Remove a transition"),
});

export const WorkflowCreateInputSchema = z.object({
  name: z.string().min(1).describe("Workflow name (used as filename)"),
  definition: z.object({
    description: z.string().optional(),
    initial: z.string().min(1),
    max_transitions: z.number().int().positive().optional(),
    states: z.record(StateDefinitionSchema),
  }).describe("Full workflow definition"),
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
