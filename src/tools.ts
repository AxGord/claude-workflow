import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Engine, StatusResult } from "./engine.js";
import type { Modifier } from "./modifier.js";
import type { Loader } from "./loader.js";
import type { Storage } from "./storage.js";
import { StateDefinitionSchema, type SessionState } from "./types.js";

interface FormatOptions {
  readonly showSessionId: boolean;
  readonly forceFullPrompt: boolean;
}

function formatStateHeader(status: StatusResult): string {
  if (status.stack.length === 0)
    return status.currentStateName === "(abandoned)" ? "(abandoned)" : "(completed)";

  const frame = status.stack[status.activeFrame];
  const visits = frame.state_visits[frame.current_state] ?? 0;
  const visitStr = visits > 1 ? ` (visit ${visits})` : "";

  if (status.stack.length === 1)
    return `${frame.workflow} @ ${frame.current_state}${visitStr}`;

  // Multi-frame: show full stack
  return status.stack
    .map((f, i) => {
      const active = i === status.activeFrame ? " ← ACTIVE" : "";
      const v = f.state_visits[f.current_state] ?? 0;
      const vs = v > 1 ? ` (visit ${v})` : "";
      const waiting = i < status.activeFrame ? " (waiting)" : "";
      return `  [${i}] ${f.workflow} @ ${f.current_state}${vs}${waiting}${active}`;
    })
    .join("\n");
}

function formatStatus(status: StatusResult, opts: Partial<FormatOptions> = {}): string {
  const { showSessionId = false, forceFullPrompt = false } = opts;
  const parts: string[] = [];

  if (showSessionId)
    parts.push(`SESSION: ${status.sessionId}`);

  parts.push(formatStateHeader(status));
  parts.push("");

  if (!forceFullPrompt && !status.forcePrompt && status.visitCount > 1) {
    parts.push(`Revisit #${status.visitCount} — follow the instructions from your first visit to this state.`);
    parts.push(`If you don't remember them, call status() to re-read.`);
  } else {
    parts.push(status.prompt);
  }

  const transitionNames = Object.keys(status.availableTransitions);
  if (transitionNames.length > 0) {
    parts.push("");
    parts.push("TRANSITIONS: " + transitionNames.join(", "));
  }

  if (status.taskOps.length > 0) {
    parts.push("");
    parts.push("TASKS:");
    for (const op of status.taskOps) {
      parts.push(`  ${op.action}: "${op.subject}"`);
    }
  }

  return parts.join("\n");
}

export function registerTools(
  server: McpServer,
  engine: Engine,
  modifier: Modifier,
  loader: Loader,
  storage: Storage
): void {
  // 1. list
  server.registerTool("list", {
    description: "List all available workflow definitions in the project",
    inputSchema: z.object({}).strict(),
  }, async () => {
    const workflows = loader.getAll();
    if (workflows.size === 0) {
      return { content: [{ type: "text", text: "No workflows found. Add YAML files to .claude/workflows/" }] };
    }

    const lines = Array.from(workflows.entries()).map(([name, wf]) => {
      const stateCount = Object.keys(wf.states).length;
      const desc = wf.description ? ` — ${wf.description}` : "";
      return `  ${name} (${stateCount} states)${desc}`;
    });

    return {
      content: [{
        type: "text",
        text: `=== AVAILABLE WORKFLOWS ===\n${lines.join("\n")}`,
      }],
    };
  });

  // 2. start
  server.registerTool("start", {
    description: "Start a workflow. Returns the first prompt, session ID, and available transitions.",
    inputSchema: z.object({
      workflow: z.string().optional().describe("Name of the workflow to start. Defaults to \"master\""),
      actor: z.string().optional().describe("Identity of the agent performing this action"),
      parent_session_id: z.string().optional().describe("Parent session ID for sub-agent tracking"),
    }).strict(),
  }, async (args) => {
    try {
      const status = await engine.start(args.workflow ?? "master", args.actor, args.parent_session_id);
      const text = formatStatus(status, { showSessionId: true, forceFullPrompt: true })
        + "\n\n---\nWORKFLOW RULES:\n"
        + "- Transitions in real-time only — never batch multiple transitions in one step.\n"
        + "- Complete each state fully before transitioning to the next.\n"
        + "- On tool errors: stop and investigate before continuing.\n"
        + "- To advance: transition({ transition: \"<name>\" })\n"
        + "---";
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }], isError: true };
    }
  });

  // 3. status
  server.registerTool("status", {
    description: "Get current state, full stack, available transitions, and history for a session.",
    inputSchema: z.object({
      session_id: z.string().optional().describe("Session identifier"),
    }).strict(),
  }, async (args) => {
    try {
      const sid = engine.resolveSessionId(args.session_id);
      const status = engine.getStatus(sid);
      const historyLines = status.history.slice(-10).map(h => {
        const actorStr = h.actor ? ` [${h.actor}]` : "";
        const detailStr = h.detail ? ` (${h.detail})` : "";
        if (h.event === "action") return `  [${h.frame}] [auto] ${h.from} --${detailStr}--> ${h.to} at ${h.at}`;
        if (h.event === "skill_gate") return `  [${h.frame}] [auto] ${h.from} --skills--> ${h.to} at ${h.at}`;
        if (h.event) return `  [${h.frame}] ${h.event}${h.workflow ? ` (${h.workflow})` : ""}${actorStr} at ${h.at}`;
        return `  [${h.frame}] ${h.from} --${h.via}--> ${h.to}${actorStr} at ${h.at}`;
      });

      const text = [
        formatStatus(status, { showSessionId: true, forceFullPrompt: true }),
        "",
        "RECENT HISTORY:",
        ...historyLines,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }], isError: true };
    }
  });

  // 4. transition
  server.registerTool("transition", {
    description: "Transition to the next state in the active workflow. If the new state has a sub_workflow, it auto-pushes. If terminal, it auto-pops to parent.",
    inputSchema: z.object({
      session_id: z.string().optional().describe("Session identifier"),
      transition: z.string().describe("Name of the transition to take"),
      actor: z.string().optional().describe("Identity of the agent performing this action"),
      force: z.boolean().optional().describe("Skip PID ownership check (for cross-process operations)"),
    }).strict(),
  }, async (args) => {
    try {
      const sid = engine.resolveSessionId(args.session_id);
      const warning = engine.assertOwnership(sid, args.force);
      const status = await engine.transition(sid, args.transition, args.actor);
      const text = (warning ? warning + "\n\n" : "") + formatStatus(status);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }], isError: true };
    }
  });

  // 5. context_set
  server.registerTool("context_set", {
    description: "Save key-value data in the session context for later use.",
    inputSchema: z.object({
      session_id: z.string().optional().describe("Session identifier"),
      key: z.string().describe("Context key"),
      value: z.unknown().describe("Context value"),
      actor: z.string().optional().describe("Identity of the agent performing this action"),
      force: z.boolean().optional().describe("Skip PID ownership check (for cross-process operations)"),
    }).strict(),
  }, async (args) => {
    try {
      const sid = engine.resolveSessionId(args.session_id);
      const warning = engine.assertOwnership(sid, args.force);
      await engine.setContext(sid, args.key, args.value, args.actor);
      const text = (warning ? warning + "\n" : "") + `Context "${args.key}" set successfully.`;
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }], isError: true };
    }
  });

  // 6. modify
  server.registerTool("modify", {
    description: "Add/change/remove states and transitions in the current session's workflow (overlay, does not modify YAML).",
    inputSchema: z.object({
      session_id: z.string().optional().describe("Session identifier"),
      add_state: StateDefinitionSchema.extend({ name: z.string() }).optional().describe("Add a new state"),
      add_transition: z.object({
        from: z.string(),
        name: z.string(),
        to: z.string(),
      }).optional().describe("Add a transition"),
      remove_transition: z.object({
        from: z.string(),
        name: z.string(),
      }).optional().describe("Remove a transition"),
      force: z.boolean().optional().describe("Skip PID ownership check (for cross-process operations)"),
    }).strict(),
  }, async (args) => {
    try {
      const sid = engine.resolveSessionId(args.session_id);
      const warning = engine.assertOwnership(sid, args.force);
      const messages = await modifier.modify(sid, {
        add_state: args.add_state,
        add_transition: args.add_transition,
        remove_transition: args.remove_transition,
      });
      const text = (warning ? warning + "\n" : "") + `Modifications applied:\n${messages.join("\n")}`;
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }], isError: true };
    }
  });

  // 7. create
  server.registerTool("create", {
    description: "Create a new workflow definition (saves as YAML for reuse).",
    inputSchema: z.object({
      name: z.string().min(1).describe("Workflow name"),
      definition: z.object({
        description: z.string().optional(),
        initial: z.string().min(1),
        max_transitions: z.number().int().positive().optional(),
        states: z.record(StateDefinitionSchema),
      }).describe("Full workflow definition"),
      scope: z.enum(["project", "global"]).optional().describe("Where to save: project (.claude/workflows/) or global (~/.claude/workflows/). Default: project if available, else global."),
    }).strict(),
  }, async (args) => {
    try {
      const filePath = await modifier.create(args.name, args.definition, args.scope);
      return { content: [{ type: "text", text: `Workflow "${args.name}" created at ${filePath}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }], isError: true };
    }
  });

  // 8. delete
  server.registerTool("delete", {
    description: "Delete a workflow definition (removes YAML file).",
    inputSchema: z.object({
      name: z.string().min(1).describe("Workflow name to delete"),
      scope: z.enum(["project", "global"]).optional().describe("Where to look: project, global, or both (default). Project checked first when unspecified."),
    }).strict(),
  }, async (args) => {
    try {
      const activeSessions = storage.readAll().filter(s =>
        s.stack.length > 0 && s.stack.some(f => f.workflow === args.name)
      );
      if (activeSessions.length > 0) {
        const ids = activeSessions.map(s => s.session_id).join(", ");
        throw new Error(
          `Cannot delete workflow "${args.name}": ${activeSessions.length} active session(s) (${ids}). Abort or complete them first.`
        );
      }

      const filePath = loader.delete(args.name, args.scope);
      return { content: [{ type: "text", text: `Workflow "${args.name}" deleted: ${filePath}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }], isError: true };
    }
  });

  // 9. abort
  server.registerTool("abort", {
    description: "Abort the workflow (pop all stack frames, end session).",
    inputSchema: z.object({
      session_id: z.string().optional().describe("Session identifier"),
      force: z.boolean().optional().describe("Skip PID ownership check (for cross-process operations, e.g. aborting stale sessions from dead processes)"),
    }).strict(),
  }, async (args) => {
    try {
      const sid = engine.resolveSessionId(args.session_id);
      const warning = engine.assertOwnership(sid, args.force);
      await engine.abort(sid);
      const text = (warning ? warning + "\n" : "") + `Session "${sid}" aborted.`;
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }], isError: true };
    }
  });

  // 10. sessions
  server.registerTool("sessions", {
    description: "List all workflow sessions (active shown first, recent inactive limited to 3).",
    inputSchema: z.object({
      all: z.boolean().optional().describe("Show sessions from all processes. Default: only current process."),
    }).strict(),
  }, async (args) => {
    const pid = process.ppid;
    const allSessions = storage.readAll();
    const sessions = args.all ? allSessions : allSessions.filter(s => s.context.claude_code_pid === pid);
    if (sessions.length === 0) {
      const hint = args.all ? "" : " Use sessions({ all: true }) to see all processes.";
      return { content: [{ type: "text", text: `No sessions found.${hint}` }] };
    }

    const formatSession = (s: SessionState): string => {
      const isActive = s.stack.length > 0;
      const frame = isActive ? s.stack[s.active_frame] : null;
      const stateInfo = frame
        ? `${frame.workflow} @ ${frame.current_state}`
        : s.outcome === "abandoned" ? "(abandoned)" : "(completed)";
      const depth = s.stack.length > 1 ? ` [depth: ${s.stack.length}]` : "";
      const parent = s.parent_session_id ? ` [child of ${s.parent_session_id}]` : "";
      const pidInfo = args.all && s.context.claude_code_pid !== undefined
        ? ` [pid: ${s.context.claude_code_pid}${s.context.claude_code_pid === pid ? " ★" : ""}]`
        : "";
      return `  ${s.session_id}: ${stateInfo}${depth}${parent}${pidInfo} (updated: ${s.updated_at})`;
    };

    const active = sessions.filter(s => s.stack.length > 0);
    const inactive = sessions.filter(s => s.stack.length === 0);
    inactive.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const abandoned = inactive.filter(s => s.outcome === "abandoned");
    const completed = inactive.filter(s => s.outcome !== "abandoned");
    const recentAbandoned = abandoned.slice(0, 3);
    const recentCompleted = completed.slice(0, 3);

    const parts: string[] = [];

    parts.push("=== ACTIVE SESSIONS ===");
    if (active.length > 0)
      parts.push(active.map(formatSession).join("\n"));
    else
      parts.push("  (none)");

    if (recentAbandoned.length > 0) {
      const countLabel = abandoned.length > recentAbandoned.length
        ? ` (${recentAbandoned.length} of ${abandoned.length})`
        : "";
      parts.push("");
      parts.push(`=== ABANDONED${countLabel} ===`);
      parts.push(recentAbandoned.map(formatSession).join("\n"));
    }

    if (recentCompleted.length > 0) {
      const countLabel = completed.length > recentCompleted.length
        ? ` (${recentCompleted.length} of ${completed.length})`
        : "";
      parts.push("");
      parts.push(`=== RECENT COMPLETED${countLabel} ===`);
      parts.push(recentCompleted.map(formatSession).join("\n"));
    }

    return {
      content: [{ type: "text", text: parts.join("\n") }],
    };
  });
}
