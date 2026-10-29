import fs from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Engine, ResumeResult, StatusResult } from "./engine.js";
import type { Modifier } from "./modifier.js";
import type { Loader } from "./loader.js";
import type { Storage } from "./storage.js";
import {
  PriorityLevelSchema,
  PRIORITY_LEVELS,
  StateDefinitionSchema,
  START_CWD_DESCRIPTION,
  START_PRIORITY_DESCRIPTION,
  STATUS_KEY_DESCRIPTION,
  type SessionState,
} from "./types.js";
import { Pool, formatStatus as formatPoolStatus, projectRoot, resolvePoolDir } from "./pool.js";
import { withProgress, type ProgressSink } from "./progress.js";
import { RESUME_TOOL, drivenByRootAgent, subAgentLines, where } from "./takeover.js";

interface FormatOptions {
  readonly showSessionId: boolean;
  readonly forceFullPrompt: boolean;
}

function formatStateHeader(status: StatusResult): string {
  if (status.stack.length === 0) return status.currentStateName;

  const frame = status.stack[status.activeFrame];
  const visits = frame.state_visits[frame.current_state] ?? 0;
  const visitStr = visits > 1 ? ` (visit ${visits})` : "";

  if (status.stack.length === 1) return `${frame.workflow} @ ${frame.current_state}${visitStr}`;

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

const CONTEXT_VALUE_LIMIT = 200;
const CONTEXT_KEY_LIMIT = 40;

/**
 * The session context as status() shows it, so a parent can read a child's
 * results: one line per key, each value cut to a fixed length (status with
 * `key` returns one value whole); past the key limit the remaining keys are
 * listed by name only.
 */
export function formatContext(context: Record<string, unknown>): string[] {
  const keys = Object.keys(context);
  if (keys.length === 0) return [];
  const lines = ["CONTEXT:"];
  for (const key of keys.slice(0, CONTEXT_KEY_LIMIT)) {
    const raw = context[key];
    const text = (typeof raw === "string" ? raw : (JSON.stringify(raw) ?? String(raw))).replace(
      /\n/g,
      "\\n",
    );
    const cut =
      text.length > CONTEXT_VALUE_LIMIT
        ? `${text.slice(0, CONTEXT_VALUE_LIMIT)}… [${text.length} chars; status key="${key}" for all]`
        : text;
    lines.push(`  ${key}: ${cut}`);
  }
  const rest = keys.slice(CONTEXT_KEY_LIMIT);
  if (rest.length > 0) lines.push(`  … ${rest.length} more: ${rest.join(", ")}`);
  return lines;
}

// Memory of digest_on_repeat states whose FULL prompt already went out once
// in the agent's CURRENT context. Keyed per workflow+state. The server outlives
// /clear, /compact and an in-REPL /resume, so the SessionStart hook rewrites a
// per-process context-epoch marker on every start; a changed marker forgets
// every delivery.
const deliveredFullPrompts = new Set<string>();
let contextEpochFile: string | null = null;
let seenContextEpoch = "";

/** Test seam: forget which digest_on_repeat prompts were already delivered. */
export function resetDeliveredPrompts(): void {
  deliveredFullPrompts.clear();
}

/** The context-epoch marker the SessionStart hook rewrites on /clear and /compact; null = none. */
export function setContextEpochFile(file: string | null): void {
  contextEpochFile = file;
  seenContextEpoch = "";
}

function syncContextEpoch(): void {
  if (contextEpochFile === null) return;
  let epoch = "";
  try {
    epoch = fs.readFileSync(contextEpochFile, "utf8");
  } catch (err) {
    // ENOENT = no SessionStart has written one yet. Anything else still falls
    // back to "" (an extra clear at worst) — a throw would fail every tool call.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      console.error(`context-epoch marker unreadable (${contextEpochFile}):`, err);
  }
  if (epoch === seenContextEpoch) return;
  seenContextEpoch = epoch;
  deliveredFullPrompts.clear();
}

/** One context value whole, as status({ key }) returns it: a string as is, anything else as JSON. */
export function formatContextValue(context: Record<string, unknown>, key: string): string {
  if (!Object.hasOwn(context, key)) {
    const keys = Object.keys(context);
    throw new Error(
      `Context key "${key}" is not set. Keys: ${keys.length > 0 ? keys.join(", ") : "(none)"}`,
    );
  }
  const raw = context[key];
  return typeof raw === "string" ? raw : (JSON.stringify(raw, null, 2) ?? String(raw));
}

export function formatStatus(status: StatusResult, opts: Partial<FormatOptions> = {}): string {
  const { showSessionId = false, forceFullPrompt = false } = opts;
  const parts: string[] = [];

  if (showSessionId) parts.push(`SESSION: ${status.sessionId}`);

  parts.push(formatStateHeader(status));
  parts.push("");

  syncContextEpoch();
  const digestKey = `${status.currentWorkflow}:${status.currentStateName}`;
  const digestable = status.currentState.digest_on_repeat === true;
  if (!forceFullPrompt && !status.forcePrompt && status.visitCount > 1) {
    parts.push(
      `Revisit #${status.visitCount} — follow the instructions from your first visit to this state.`,
    );
    parts.push(`If you don't remember them, call status() to re-read.`);
  } else if (
    !forceFullPrompt &&
    !status.forcePrompt &&
    digestable &&
    deliveredFullPrompts.has(digestKey)
  ) {
    parts.push(
      `This state's full prompt was already delivered earlier in this context — follow those instructions.`,
    );
    parts.push(
      `If THIS context has not seen them (or templates may have changed), call status() for the current full text.`,
    );
  } else {
    parts.push(status.prompt);
    if (digestable) deliveredFullPrompts.add(digestKey);
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

/**
 * What `resume` prints: the session's status, then the suspended sub-agent
 * sessions below it — agent → session → state — and the message that wakes
 * each agent to resume its OWN session.
 */
export function formatResume(result: ResumeResult): string {
  const parts = [
    `RESUMED: ${result.status.sessionId}`,
    formatStatus(result.status, { showSessionId: true, forceFullPrompt: true }),
  ];
  const children = result.suspendedChildren;
  const byId = new Map(children.map(s => [s.session_id, s]));
  if (children.length > 0) {
    parts.push(
      "",
      "SUSPENDED SUB-AGENT SESSIONS — wake each agent (agent → session → state), with the message below it; one no agent drives is yours:",
      ...subAgentLines(children, RESUME_TOOL, "  ", s =>
        drivenByRootAgent(s, result.status.sessionId, byId),
      ),
      "",
      "A session whose agent cannot be woken: abort({ session_id, force: true }).",
    );
  }
  return parts.join("\n");
}

/** A step a previous server began and never routed, finished on this process's first call to its session. */
function formatAdopted(status: StatusResult, how: "exec" | "rerun" | undefined): string {
  return [
    how === "rerun"
      ? "INTERRUPTED STEP RUN AGAIN — a previous server began this action state and is gone, its exec never started or left no result (e.g. it waited for a pool lease); it ran now and is routed:"
      : "EXEC IN FLIGHT TAKEN OVER — the step a previous server left running is finished and routed:",
    formatStatus(status, { showSessionId: true, forceFullPrompt: true }),
  ].join("\n");
}

// Claude Code treats an MCP tool as read-only only via readOnlyHint; without
// it, plan mode (and every subagent spawned under it) prompts on each call and
// ignores allow rules. These tools write only the engine's own session files —
// EXCEPT that start/transition entering an exec/fetch state runs that state's
// command/request, so a user or project workflow's exec states run unprompted
// under plan mode too. modify/create/delete/abort stay unannotated so they
// keep their confirmation.
const ENGINE_STATE_ONLY = { readOnlyHint: true } as const;

/** The slice of the SDK's request extra a progress heartbeat needs. */
interface ToolExtra {
  readonly _meta?: { readonly progressToken?: string | number };
  readonly sendNotification: (n: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
}

export function registerTools(
  server: McpServer,
  engine: Engine,
  modifier: Modifier,
  loader: Loader,
  storage: Storage,
  pool: Pool = new Pool(resolvePoolDir()),
): void {
  // ENGINE_STATE_ONLY also makes Claude Code treat these tools as
  // concurrency-safe, so a context_set + transition from one message may
  // arrive in parallel. Engine mutations read the session, then await the
  // write — run them one at a time in arrival order, or the later write
  // silently drops the earlier one's change. One queue PER SESSION: a
  // sibling agent's call is not held behind another session's exec/fetch
  // chain (a lint run, a retrying fetch). Cross-session writes (abort's
  // and root completion's child cascade, a child abort's retryPendingPop on
  // its parent) run outside the target's queue; the engine re-reads a
  // session after an exec, which narrows that race to one write's latency.
  const queues = new Map<string, Promise<unknown>>();
  const serialized = <T>(key: string | null, fn: () => Promise<T>): Promise<T> => {
    if (key === null) return fn();
    // ast-grep-ignore: then-without-catch -- `run` goes back to the caller, who gets its rejection
    const run = (queues.get(key) ?? Promise.resolve()).then(fn);
    // Settles either way, so a failed task never stalls the ones queued behind it.
    const release = (): void => {
      if (queues.get(key) === tail) queues.delete(key);
    };
    const tail: Promise<void> = run.then(release, release);
    queues.set(key, tail);
    return run;
  };
  // An id that does not resolve yet — the session a parallel top-level start
  // is creating — queues behind that start (once the session is written,
  // later calls key by its id); otherwise the handler reports the error itself.
  const sessionKey = (sessionId?: string): string => {
    try {
      return engine.resolveSessionId(sessionId);
    } catch {
      return "start";
    }
  };

  // The progress sink of a call whose client sent a progressToken: heartbeats of
  // a long exec reach it as notifications/progress, so the client's no-response
  // timeout does not cut a call that is only waiting.
  const progressOf = (extra: ToolExtra | undefined): ProgressSink | undefined => {
    // a direct handler call (tests) has no request extra
    if (!extra) return undefined;
    const token = extra._meta?.progressToken;
    if (token === undefined) return undefined;
    let n = 0;
    return message => {
      n += 1;
      extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: n, message },
        })
        .catch(() => undefined);
    };
  };

  // 1. list
  server.registerTool(
    "list",
    {
      description: "List all available workflow definitions in the project",
      annotations: ENGINE_STATE_ONLY,
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const workflows = loader.getAll();
      if (workflows.size === 0) {
        return {
          content: [
            { type: "text", text: "No workflows found. Add YAML files to .claude/workflows/" },
          ],
        };
      }

      const lines = Array.from(workflows.entries()).map(([name, wf]) => {
        const stateCount = Object.keys(wf.states).length;
        const desc = wf.description ? ` — ${wf.description}` : "";
        return `  ${name} (${stateCount} states)${desc}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `=== AVAILABLE WORKFLOWS ===\n${lines.join("\n")}`,
          },
        ],
      };
    },
  );

  // 2. start
  // Only top-level starts race each other (duplicate-session check, then
  // write); a child start creates its own session and must not wait behind
  // a sibling's initial exec.
  server.registerTool(
    "start",
    {
      description:
        "Start a workflow. Returns the first prompt, session ID, and available transitions.",
      annotations: ENGINE_STATE_ONLY,
      inputSchema: z
        .object({
          workflow: z
            .string()
            .optional()
            .describe('Name of the workflow to start. Defaults to "master"'),
          actor: z.string().optional().describe("Identity of the agent performing this action"),
          parent_session_id: z
            .string()
            .optional()
            .describe("Parent session ID for sub-agent tracking"),
          cwd: z.string().optional().describe(START_CWD_DESCRIPTION),
          priority: PriorityLevelSchema.optional().describe(START_PRIORITY_DESCRIPTION),
        })
        .strict(),
    },
    (args, extra) =>
      serialized(args.parent_session_id ? null : "start", async () => {
        try {
          const status = await withProgress(progressOf(extra), () =>
            engine.start(
              args.workflow ?? "master",
              args.actor,
              args.parent_session_id,
              args.cwd,
              args.priority,
            ),
          );
          // No forceFullPrompt here: a digest_on_repeat initial state (master
          // route) digests on repeat start() calls in the same process — the
          // main ceremony saving. status() still always returns the full text.
          const text =
            formatStatus(status, { showSessionId: true }) +
            "\n\n---\nWORKFLOW RULES:\n" +
            "- Transitions in real-time only — never batch multiple transitions in one step.\n" +
            "- Complete each state fully before transitioning to the next.\n" +
            "- On tool errors: stop and investigate before continuing.\n" +
            '- To advance: transition({ transition: "<name>" })\n' +
            "---";
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return {
            content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }],
            isError: true,
          };
        }
      }),
  );

  // 3. status
  server.registerTool(
    "status",
    {
      description:
        "Get current state, full stack, available transitions, and history for a session. With `key`: only that context value, in full.",
      annotations: ENGINE_STATE_ONLY,
      inputSchema: z
        .object({
          session_id: z.string().optional().describe("Session identifier"),
          key: z.string().optional().describe(STATUS_KEY_DESCRIPTION),
        })
        .strict(),
    },
    async (args, extra) => {
      try {
        const sid = engine.resolveSessionId(args.session_id);
        // checked outside the queue first: status must not wait behind this server's own exec
        const how = args.key === undefined ? engine.orphanedStep(sid) : undefined;
        if (how) {
          const adopted = await serialized(sid, () =>
            withProgress(progressOf(extra), () => engine.adoptOrphanedExec(sid)),
          );
          if (adopted) return { content: [{ type: "text", text: formatAdopted(adopted, how) }] };
        }
        const status = engine.getStatus(sid);
        if (args.key !== undefined)
          return {
            content: [{ type: "text", text: formatContextValue(status.context, args.key) }],
          };
        const historyLines = status.history.slice(-10).map(h => {
          const actorStr = h.actor ? ` [${h.actor}]` : "";
          const detailStr = h.detail ? ` (${h.detail})` : "";
          if (h.event === "action")
            return `  [${h.frame}] [auto] ${h.from} --${detailStr}--> ${h.to} at ${h.at}`;
          if (h.event === "skill_gate")
            return `  [${h.frame}] [auto] ${h.from} --skills--> ${h.to} at ${h.at}`;
          if (h.event)
            return `  [${h.frame}] ${h.event}${h.workflow ? ` (${h.workflow})` : ""}${actorStr} at ${h.at}`;
          return `  [${h.frame}] ${h.from} --${h.via}--> ${h.to}${detailStr}${actorStr} at ${h.at}`;
        });

        const contextLines = formatContext(status.context);
        const suspendedAt = storage.read(sid)?.suspended_at;
        const text = [
          ...(suspendedAt
            ? [
                `SUSPENDED since ${suspendedAt} — call resume({ session_id: "${sid}" }) to continue it.`,
                "",
              ]
            : []),
          formatStatus(status, { showSessionId: true, forceFullPrompt: true }),
          ...(contextLines.length > 0 ? ["", ...contextLines] : []),
          "",
          "RECENT HISTORY:",
          ...historyLines,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // 4. transition
  server.registerTool(
    "transition",
    {
      description:
        "Transition to the next state in the active workflow. If the new state has a sub_workflow, it auto-pushes. If terminal, it auto-pops to parent. A context_set this transition (or the state it leads to) depends on must have RETURNED first: never send them in the same parallel tool batch, which has no ordering guarantee.",
      annotations: ENGINE_STATE_ONLY,
      inputSchema: z
        .object({
          session_id: z.string().optional().describe("Session identifier"),
          transition: z.string().describe("Name of the transition to take"),
          actor: z.string().optional().describe("Identity of the agent performing this action"),
          force: z
            .boolean()
            .optional()
            .describe("Skip PID ownership check (for cross-process operations)"),
        })
        .strict(),
    },
    (args, extra) =>
      serialized(sessionKey(args.session_id), async () => {
        try {
          const progress = progressOf(extra);
          const sid = engine.resolveSessionId(args.session_id);
          engine.assertNotSuspended(sid);
          const warning = engine.assertOwnership(sid, args.force);
          const how = engine.orphanedStep(sid);
          const adopted = how
            ? await withProgress(progress, () => engine.adoptOrphanedExec(sid))
            : null;
          if (adopted) {
            const text = `${warning ? warning + "\n\n" : ""}${formatAdopted(adopted, how)}\n\nTransition "${args.transition}" was NOT taken — the session moved on; choose from the state above.`;
            return { content: [{ type: "text", text }], isError: true };
          }
          const status = await withProgress(progress, () =>
            engine.transition(sid, args.transition, args.actor),
          );
          const text = (warning ? warning + "\n\n" : "") + formatStatus(status);
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return {
            content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }],
            isError: true,
          };
        }
      }),
  );

  // 5. context_set
  server.registerTool(
    "context_set",
    {
      description:
        "Save key-value data in the session context for later use. When a following transition reads the key, wait for this call to return before calling transition (separate message, not the same parallel batch).",
      annotations: ENGINE_STATE_ONLY,
      inputSchema: z
        .object({
          session_id: z.string().optional().describe("Session identifier"),
          key: z.string().describe("Context key"),
          value: z.unknown().describe("Context value"),
          actor: z.string().optional().describe("Identity of the agent performing this action"),
          force: z
            .boolean()
            .optional()
            .describe("Skip PID ownership check (for cross-process operations)"),
        })
        .strict(),
    },
    args =>
      serialized(sessionKey(args.session_id), async () => {
        try {
          const sid = engine.resolveSessionId(args.session_id);
          engine.assertNotSuspended(sid);
          const warning = engine.assertOwnership(sid, args.force);
          await engine.setContext(sid, args.key, args.value, args.actor);
          const text = (warning ? warning + "\n" : "") + `Context "${args.key}" set successfully.`;
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return {
            content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }],
            isError: true,
          };
        }
      }),
  );

  // 6. modify
  server.registerTool(
    "modify",
    {
      description:
        "Add/change/remove states and transitions in the current session's workflow (overlay, does not modify YAML).",
      inputSchema: z
        .object({
          session_id: z.string().optional().describe("Session identifier"),
          add_state: StateDefinitionSchema.extend({ name: z.string() })
            .optional()
            .describe("Add a new state"),
          add_transition: z
            .object({
              from: z.string(),
              name: z.string(),
              to: z.string(),
            })
            .optional()
            .describe("Add a transition"),
          remove_transition: z
            .object({
              from: z.string(),
              name: z.string(),
            })
            .optional()
            .describe("Remove a transition"),
          force: z
            .boolean()
            .optional()
            .describe("Skip PID ownership check (for cross-process operations)"),
        })
        .strict(),
    },
    args =>
      serialized(sessionKey(args.session_id), async () => {
        try {
          const sid = engine.resolveSessionId(args.session_id);
          engine.assertNotSuspended(sid);
          const warning = engine.assertOwnership(sid, args.force);
          const messages = await modifier.modify(sid, {
            add_state: args.add_state,
            add_transition: args.add_transition,
            remove_transition: args.remove_transition,
          });
          const text =
            (warning ? warning + "\n" : "") + `Modifications applied:\n${messages.join("\n")}`;
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return {
            content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }],
            isError: true,
          };
        }
      }),
  );

  // 7. create
  server.registerTool(
    "create",
    {
      description: "Create a new workflow definition (saves as YAML for reuse).",
      inputSchema: z
        .object({
          name: z.string().min(1).describe("Workflow name"),
          definition: z
            .object({
              description: z.string().optional(),
              initial: z.string().min(1),
              max_transitions: z.number().int().positive().optional(),
              states: z.record(StateDefinitionSchema),
            })
            .describe("Full workflow definition"),
          scope: z
            .enum(["project", "global"])
            .optional()
            .describe(
              "Where to save: project (.claude/workflows/) or global (~/.claude/workflows/). Default: project if available, else global.",
            ),
        })
        .strict(),
    },
    async args => {
      try {
        const filePath = await modifier.create(args.name, args.definition, args.scope);
        return {
          content: [{ type: "text", text: `Workflow "${args.name}" created at ${filePath}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // 8. delete
  server.registerTool(
    "delete",
    {
      description: "Delete a workflow definition (removes YAML file).",
      inputSchema: z
        .object({
          name: z.string().min(1).describe("Workflow name to delete"),
          scope: z
            .enum(["project", "global"])
            .optional()
            .describe(
              "Where to look: project, global, or both (default). Project checked first when unspecified.",
            ),
        })
        .strict(),
    },
    async args => {
      try {
        const activeSessions = storage
          .readAll()
          .filter(s => s.stack.length > 0 && s.stack.some(f => f.workflow === args.name));
        if (activeSessions.length > 0) {
          const ids = activeSessions.map(s => s.session_id).join(", ");
          throw new Error(
            `Cannot delete workflow "${args.name}": ${activeSessions.length} active session(s) (${ids}). Abort or complete them first.`,
          );
        }

        const filePath = loader.delete(args.name, args.scope);
        return {
          content: [{ type: "text", text: `Workflow "${args.name}" deleted: ${filePath}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // 9. abort
  server.registerTool(
    "abort",
    {
      description: "Abort the workflow (pop all stack frames, end session).",
      inputSchema: z
        .object({
          session_id: z.string().optional().describe("Session identifier"),
          force: z
            .boolean()
            .optional()
            .describe(
              "Skip PID ownership check (for cross-process operations, e.g. aborting stale sessions from dead processes)",
            ),
        })
        .strict(),
    },
    args => {
      // Kill first, outside the queue: the session's own running transition
      // holds the queue for as long as its foreground exec runs. An unresolved
      // id or a refused ownership kills nothing; the queued run reports it.
      try {
        const sid = engine.resolveSessionId(args.session_id);
        engine.assertOwnership(sid, args.force);
        engine.killSessionTree(sid);
      } catch {
        /* reported below */
      }
      return serialized(sessionKey(args.session_id), async () => {
        try {
          const sid = engine.resolveSessionId(args.session_id);
          const warning = engine.assertOwnership(sid, args.force);
          await engine.abort(sid);
          const text = (warning ? warning + "\n" : "") + `Session "${sid}" aborted.`;
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return {
            content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }],
            isError: true,
          };
        }
      });
    },
  );

  // 10. sessions
  server.registerTool(
    "sessions",
    {
      description: "List all workflow sessions (active shown first, recent inactive limited to 3).",
      annotations: ENGINE_STATE_ONLY,
      inputSchema: z
        .object({
          all: z
            .boolean()
            .optional()
            .describe("Show sessions from all processes. Default: only current process."),
        })
        .strict(),
    },
    async args => {
      const pid = process.ppid;
      const allSessions = storage.readAll();
      const sessions = args.all
        ? allSessions
        : allSessions.filter(s => s.context.claude_code_pid === pid);
      if (sessions.length === 0) {
        const hint = args.all ? "" : " Use sessions({ all: true }) to see all processes.";
        return { content: [{ type: "text", text: `No sessions found.${hint}` }] };
      }

      const formatSession = (s: SessionState): string => {
        const isActive = s.stack.length > 0;
        const frame = isActive ? s.stack[s.active_frame] : null;
        const stateInfo = frame
          ? `${frame.workflow} @ ${frame.current_state}`
          : `(${s.outcome ?? "completed"})`;
        const depth = s.stack.length > 1 ? ` [depth: ${s.stack.length}]` : "";
        const parent = s.parent_session_id ? ` [child of ${s.parent_session_id}]` : "";
        const suspended = isActive && s.suspended_at ? ` [suspended since ${s.suspended_at}]` : "";
        const pidInfo =
          args.all && s.context.claude_code_pid !== undefined
            ? ` [pid: ${s.context.claude_code_pid}${s.context.claude_code_pid === pid ? " ★" : ""}]`
            : "";
        return `  ${s.session_id}: ${stateInfo}${depth}${parent}${suspended}${pidInfo} (updated: ${s.updated_at})`;
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
      if (active.length > 0) parts.push(active.map(formatSession).join("\n"));
      else parts.push("  (none)");

      if (recentAbandoned.length > 0) {
        const countLabel =
          abandoned.length > recentAbandoned.length
            ? ` (${recentAbandoned.length} of ${abandoned.length})`
            : "";
        parts.push("");
        parts.push(`=== ABANDONED${countLabel} ===`);
        parts.push(recentAbandoned.map(formatSession).join("\n"));
      }

      if (recentCompleted.length > 0) {
        const countLabel =
          completed.length > recentCompleted.length
            ? ` (${recentCompleted.length} of ${completed.length})`
            : "";
        parts.push("");
        parts.push(`=== RECENT COMPLETED${countLabel} ===`);
        parts.push(recentCompleted.map(formatSession).join("\n"));
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
      };
    },
  );

  // 11. set_priority
  // Outside the session queue: the session may be inside an exec that waits
  // for the very lease this re-ranks.
  const levels = Object.entries(PRIORITY_LEVELS)
    .map(([l, v]) => `${l} ${v}`)
    .join(", ");
  server.registerTool(
    "set_priority",
    {
      description:
        "Call only on the user's request; never raise your own session or change another project's. " +
        "Set the priority level of a session and its active descendants (later children inherit it). " +
        `Their WAITING pool entries are re-ranked at once; running leases keep theirs (no preemption). Levels: ${levels}; ` +
        "a lease's priority = its session level + the step's own priority.",
      inputSchema: z
        .object({
          session_id: z
            .string()
            .describe("Session identifier (any session, also another process's)"),
          level: PriorityLevelSchema.describe("low | normal | high | urgent"),
        })
        .strict(),
    },
    async args => {
      try {
        const { sessions, moved } = await engine.setPriority(args.session_id, args.level);
        return {
          content: [
            {
              type: "text",
              text: `Priority ${args.level} (${PRIORITY_LEVELS[args.level]}) set on ${sessions.join(", ")}; ${moved} waiting pool entr${moved === 1 ? "y" : "ies"} re-ranked.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // 12. pool_status
  server.registerTool(
    "pool_status",
    {
      description:
        "The machine-wide thread pool, as `wf-run --status` shows it: budget and load, then one line per lease " +
        "and per waiter (in admission order) — pid, threads/locks held or wanted, priority and level, since when, project, session, step, label. " +
        "Runs one admission pass (reaps dead entries, may grant a waiting lease).",
      annotations: ENGINE_STATE_ONLY,
      inputSchema: z.object({}).strict(),
    },
    async () => {
      try {
        return {
          content: [
            { type: "text", text: formatPoolStatus(await pool.measuredStatus(), pool.dir) },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // 13. resume
  server.registerTool(
    "resume",
    {
      description:
        "Continue a SUSPENDED session (its Claude Code process exited; `claude --resume` or another account picks it up): " +
        "the session and its sub-tree become owned by this process, and the session's status is returned. A session stopped inside " +
        "an exec state finishes it first (waits for the exec still running, takes the result it left, or runs it again). " +
        "Lists its suspended sub-agent sessions with the message that wakes each agent. A sub-agent continues ITS OWN session with resume, not start.",
      annotations: ENGINE_STATE_ONLY,
      inputSchema: z
        .object({
          session_id: z.string().describe("The suspended session to continue"),
        })
        .strict(),
    },
    (args, extra) =>
      serialized(args.session_id, async () => {
        try {
          const resumed = await withProgress(progressOf(extra), () =>
            engine.resume(args.session_id),
          );
          return { content: [{ type: "text", text: formatResume(resumed) }] };
        } catch (err) {
          return {
            content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }],
            isError: true,
          };
        }
      }),
  );

  // 14. suspended
  server.registerTool(
    "suspended",
    {
      description:
        "List suspended sessions of this project (the git root of this server's cwd) — e.g. after switching accounts, " +
        "when the conversation that owned them cannot be resumed. Continue one with resume({ session_id }).",
      annotations: ENGINE_STATE_ONLY,
      inputSchema: z
        .object({
          all: z
            .boolean()
            .optional()
            .describe("Every project's suspended sessions. Default: this project's only."),
        })
        .strict(),
    },
    async args => {
      const list = engine.listSuspended(args.all ? undefined : projectRoot(process.cwd()));
      if (list.length === 0) return { content: [{ type: "text", text: "No suspended sessions." }] };
      const ids = new Set(list.map(s => s.session_id));
      const lines = ["=== SUSPENDED SESSIONS ==="];
      for (const s of list) {
        const child = s.parent_session_id && ids.has(s.parent_session_id);
        const agent = s.agent_id ? ` [agent ${s.agent_id}]` : "";
        const exec = s.running_exec ? ` [exec in flight: ${s.running_exec.state}]` : "";
        const cwd = args.all && typeof s.context.cwd === "string" ? ` [${s.context.cwd}]` : "";
        lines.push(
          `  ${child ? "  ↳ " : ""}${s.session_id}: ${where(s)}${child ? ` [child of ${s.parent_session_id}]` : ""}${agent}${exec}${cwd} (since ${s.suspended_at})`,
        );
      }
      lines.push(
        "",
        "Resume a root with resume({ session_id }); its output names the sub-agents to wake.",
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // 15. link_agent
  server.registerTool(
    "link_agent",
    {
      description:
        "Record which sub-agent (the Agent tool's agent id) drives a child session, so that after a restart resume() " +
        "of the parent names the agent to wake with SendMessage. Call it once the child session id is known (sessions() lists children).",
      annotations: ENGINE_STATE_ONLY,
      inputSchema: z
        .object({
          session_id: z.string().describe("The sub-agent's session"),
          agent_id: z.string().min(1).describe("The Agent tool's id of that sub-agent"),
        })
        .strict(),
    },
    async args => {
      try {
        await engine.linkAgent(args.session_id, args.agent_id);
        return {
          content: [
            {
              type: "text",
              text: `Session "${args.session_id}" linked to agent ${args.agent_id}.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
