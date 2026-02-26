import { z } from "zod";

// --- Workflow Definition (parsed from YAML) ---

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
  readonly pending_pop?: { readonly outcome: "complete" | "fail" };
  readonly global_state_visits?: Record<string, number>;
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
  add_state: z.object({
    name: z.string(),
    prompt: z.string().optional(),
    transitions: z.record(z.string()).optional(),
    terminal: z.boolean().optional(),
    outcome: z.enum(["complete", "fail", "needs_action"]).optional(),
    max_visits: z.number().int().positive().optional(),
    sub_workflow: z.string().optional(),
    on_complete: z.string().optional(),
    on_fail: z.string().optional(),
  }).optional().describe("Add a new state to the current workflow"),
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
