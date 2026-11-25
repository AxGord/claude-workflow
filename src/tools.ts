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
  STATUS_ROUTES_KEY,
  type SessionState,
} from "./types.js";
import { Pool, formatStatus as formatPoolStatus, projectRoot, resolvePoolDir } from "./pool.js";
import { withProgress, type ProgressSink } from "./progress.js";
import { windowNudge } from "./window-nudge.js";
import { activeParents, staleNote } from "./stale.js";
import { scopeVerdict } from "./session-scope.js";
import {
  RESUME_TOOL,
  activeSubtree,
  dispatcherSplit,
  drivenByRootAgent,
  subAgentLines,
  where,
} from "./takeover.js";
import {
  MARK_TARGETS,
  QueueError,
  addQueueLine,
  editQueueLine,
  formatHeaderKey,
  formatMark,
  formatWindow,
  formatPickSummary,
  markQueue,
  pickQueue,
  planPick,
  readQueue,
  resolveQueueFile,
  setQueueHeaderKey,
  setQueueWindow,
  type HeaderResult,
  type MarkTarget,
  type PickResult,
} from "./queue.js";

/**
 * The sessions of `sessionId`'s active sub-tree (itself included) whose exec
 * waits for a pool lease past the pool's `starve_after`: what a parent sees at
 * its next `status` / `transition`, while the starved child's own call is blocked.
 */
export function starvationLines(storage: Storage, sessionId: string): string[] {
  const lines: string[] = [];
  try {
    for (const id of activeSubtree(storage, sessionId)) {
      const s = storage.read(id);
      if (!s?.pool_starved || s.stack.length === 0) continue;
      lines.push(
        `POOL STARVED: session ${id} (${where(s)}) waits for a pool lease since ${s.pool_starved.since} — ${s.pool_starved.note}. pool_status shows the pool.`,
      );
    }
  } catch {
    // a notice never fails the call it rides on
  }
  return lines;
}

/**
 * The STALE sessions below `sessionId` (`Engine.staleLines`), with what to do about them once: what a
 * parent sees at its next `status` / `transition`. The session itself is its parent's to see, and `sessions`'.
 */
export function staleNotice(engine: Engine, sessionId: string): string[] {
  try {
    const lines = engine.staleLines(sessionId, true);
    if (lines.length === 0) return [];
    return [
      ...lines,
      "A STALE session's agent may be dead or stuck: SendMessage it; no answer → abort its session, or have a new agent continue it from status (the session holds the step).",
    ];
  } catch {
    // a notice never fails the call it rides on
    return [];
  }
}

/**
 * The driver questions below `sessionId` that no move has answered for `ASK_UNANSWERED_AFTER_S`
 * (`Engine.unansweredAskLines`): what a parent sees at its next `status` / `transition`, so an answer
 * that never reached its driver does not leave the task idle unseen. No clock, no polling: it rides on
 * an event the session has anyway.
 */
export function unansweredNotice(engine: Engine, sessionId: string): string[] {
  try {
    return engine.unansweredAskLines(sessionId);
  } catch {
    // a notice never fails the call it rides on
    return [];
  }
}

/**
 * The `PARENT-ANSWER:` lines a dispatching session still holds, unless `body` already shows them (a revisit's
 * short reply does not render `{{parent_answers}}`): a lost wake leaves the held answer in view on the next reply.
 */
function unshownParentAnswers(engine: Engine, sessionId: string, body: string): string[] {
  try {
    return engine.parentAnswerLines(sessionId).filter(line => !body.includes(line));
  } catch {
    // a notice never fails the call it rides on
    return [];
  }
}

/** The `OWED-DUE:` lines a dispatching session holds, unless `body` already shows them: an owed step stays in view until handed to the parent. */
function unshownOwed(engine: Engine, sessionId: string, body: string): string[] {
  try {
    return engine.owedLines(sessionId).filter(line => !body.includes(line));
  } catch {
    // a notice never fails the call it rides on
    return [];
  }
}

/**
 * `staleNotice` unless `body` already shows every line of it — a prompt that renders
 * `{{stale_sessions}}` (a revisit's digest does not render it, so the notice comes back there).
 */
function unshownStale(engine: Engine, sessionId: string, body: string): string[] {
  const notice = staleNotice(engine, sessionId);
  return notice.slice(0, -1).every(line => body.includes(line)) ? [] : notice;
}

interface FormatOptions {
  readonly showSessionId: boolean;
  readonly forceFullPrompt: boolean;
  /** The caller just took a transition of a state that offers exactly these routes: a short-form reply need not list them again. */
  readonly sameRoutesAsBefore: boolean;
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
  const entries = contextEntries(context);
  return entries.length === 0 ? [] : ["CONTEXT:", ...entries.map(e => e.line)];
}

/** The lines of `formatContext` after its header, each with the key it shows (`…` for the folded rest). */
function contextEntries(context: Record<string, unknown>): { key: string; line: string }[] {
  const keys = Object.keys(context);
  const entries: { key: string; line: string }[] = [];
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
    entries.push({ key, line: `  ${key}: ${cut}` });
  }
  const rest = keys.slice(CONTEXT_KEY_LIMIT);
  if (rest.length > 0)
    entries.push({ key: "…", line: `  … ${rest.length} more: ${rest.join(", ")}` });
  return entries;
}

/** What a session's earlier `status` reply showed the caller: the context lines and how much of the history. */
interface StatusSeen {
  readonly lines: ReadonlyMap<string, string>;
  readonly historyLength: number;
}

/**
 * `formatContext` against what the same session's earlier `status` reply already showed: a key whose
 * line is unchanged is named, not repeated; a changed or new key is listed whole.
 */
export function formatContextDelta(
  context: Record<string, unknown>,
  seen: ReadonlyMap<string, string> | undefined,
): string[] {
  const entries = contextEntries(context);
  if (entries.length === 0) return [];
  if (seen === undefined) return ["CONTEXT:", ...entries.map(e => e.line)];
  const changed = entries.filter(e => seen.get(e.key) !== e.line);
  const same = entries.filter(e => seen.get(e.key) === e.line).map(e => e.key);
  if (same.length === 0) return ["CONTEXT:", ...changed.map(e => e.line)];
  const note = `unchanged since your last status: ${same.join(", ")}; status({ full: true }) lists them`;
  return changed.length === 0
    ? [`CONTEXT: ${note}`]
    : ["CONTEXT:", ...changed.map(e => e.line), `  (${note})`];
}

// Memory of digest_on_repeat states whose FULL prompt already went out once
// in the agent's CURRENT context. Keyed per workflow+state. The server outlives
// /clear, /compact and an in-REPL /resume, so the SessionStart hook rewrites a
// per-process context-epoch marker on every start; a changed marker forgets
// every delivery.
const deliveredFullPrompts = new Set<string>();
// What `status` already showed per session, and whether `start` already printed the rules in full:
// kept for the same context epoch, forgotten with the delivered prompts.
const statusSeen = new Map<string, StatusSeen>();
let rulesDelivered = false;
let contextEpochFile: string | null = null;
let seenContextEpoch = "";

/** Test seam: forget which digest_on_repeat prompts were already delivered. */
export function resetDeliveredPrompts(): void {
  deliveredFullPrompts.clear();
  statusSeen.clear();
  rulesDelivered = false;
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
  resetDeliveredPrompts();
}

const START_FORCE_DESCRIPTION =
  "A reason, to start a SECOND root session (no parent_session_id) in a process that already has an active root; without it that start is refused. A sub-agent never needs it: it passes parent_session_id";
const FORCE_DESCRIPTION =
  "Skip the PID ownership check (for cross-process operations); with `reason`, also overrides the session-scope refusal (a session outside the caller's own subtree)";
const REASON_DESCRIPTION =
  "Why a session outside the caller's own subtree must be touched (needs force: true); logged";
const CALLER_DESCRIPTION =
  "Your own session id. Only that session and the sessions it started may be touched; any other target is refused unless force: true with a reason. Without it, aborting a root or a session with active descendants is refused";

const START_REPLY_DESCRIPTION =
  "Reply shape. \"id\": answer `SESSION: <id> @ <state>` only (plus the DRIVER block of a `driver:` workflow, or of a `dispatcher:` one whose opt-in is set), without the state's prompt and the rules; the session's own agent reads the prompt with status. For a parent that starts a child only to pass the id on.";

const FULL_DESCRIPTION =
  "true: the whole text, as a first reply gives it, even where this context already received a part of it (the rules, the unchanged context keys and history of an earlier status)";

const RULES_FULL =
  "WORKFLOW RULES:\n" +
  "- Transitions in real-time only — never batch multiple transitions in one step.\n" +
  "- Complete each state fully before transitioning to the next.\n" +
  "- On tool errors: stop and investigate before continuing.\n" +
  '- To advance: transition({ transition: "<name>" })';

const RULES_SHORT =
  'WORKFLOW RULES (as in your first start reply): one transition at a time, in real time; finish each state first; on a tool error stop and investigate; advance with transition({ transition: "<name>" }). start({ full: true }) prints them whole.';

/** The rules block of a `start` reply: whole the first time in a context (or on request), one line after. */
function workflowRules(full: boolean): string {
  syncContextEpoch();
  const whole = full || !rulesDelivered;
  rulesDelivered = true;
  return whole ? RULES_FULL : RULES_SHORT;
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

/** `status({ key: "routes" })`: the session's transitions at this state, `a|b|c` (`(none)` at a state with none). */
export function formatRoutes(available: Readonly<Record<string, unknown>>): string {
  const names = Object.keys(available);
  return names.length > 0 ? names.join("|") : "(none)";
}

export function formatStatus(status: StatusResult, opts: Partial<FormatOptions> = {}): string {
  const { showSessionId = false, forceFullPrompt = false, sameRoutesAsBefore = false } = opts;
  const parts: string[] = [];
  let shortForm = false;

  if (showSessionId) parts.push(`SESSION: ${status.sessionId}`);

  parts.push(formatStateHeader(status));
  parts.push("");

  syncContextEpoch();
  const digestKey = `${status.currentWorkflow}:${status.currentStateName}`;
  const digestable = status.currentState.digest_on_repeat === true;
  if (
    !forceFullPrompt &&
    !status.forcePrompt &&
    status.visitCount > 1 &&
    status.currentState.full_on_revisit !== true
  ) {
    shortForm = true;
    if (status.revisitPrompt === undefined) {
      parts.push(
        `Revisit #${status.visitCount} — follow the instructions from your first visit to this state.`,
      );
      parts.push(`If you don't remember them, call status() to re-read.`);
    } else {
      parts.push(status.revisitPrompt);
    }
  } else if (
    !forceFullPrompt &&
    !status.forcePrompt &&
    digestable &&
    deliveredFullPrompts.has(digestKey)
  ) {
    shortForm = true;
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

  if (status.capWarning) {
    parts.push("");
    parts.push(`WARNING: ${status.capWarning}`);
  }

  const transitionNames = Object.keys(status.availableTransitions);
  if (transitionNames.length > 0) {
    parts.push("");
    parts.push(
      shortForm && sameRoutesAsBefore && status.revisitPrompt === undefined
        ? "TRANSITIONS: unchanged — the routes of the state you just left"
        : "TRANSITIONS: " + transitionNames.join(", "),
    );
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
  const parents = new Map([...byId, [result.session.session_id, result.session]]);
  // under a dispatcher agent only it is woken: the task sessions of its `tasks` key are its to wake
  const { lines: dispatcher, mine } = dispatcherSplit(result.session, children, parents, "");
  if (dispatcher.length > 0) parts.push("", ...dispatcher);
  if (mine.length > 0) {
    parts.push(
      "",
      "SUSPENDED SUB-AGENT SESSIONS — wake each agent (agent → session → state), with the message below it; one no agent drives is yours; an earlier visit's agent of a `driver:` workflow's state is not woken:",
      ...subAgentLines(
        mine,
        RESUME_TOOL,
        "  ",
        s => drivenByRootAgent(s, result.status.sessionId, byId),
        s => (s.parent_session_id ? parents.get(s.parent_session_id) : undefined),
        result.routeOf,
      ),
      "",
      "A session whose agent cannot be woken: abort({ session_id, caller_session_id: <your own session id> }); a session of another agent's subtree needs force: true with a reason instead.",
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
// command/request, so a user's or an approved project workflow's exec states run
// unprompted under plan mode too (a project file's exec states load only in a project
// the user trusted (Claude Code's folder trust, or `wf-trust`); modify and create refuse exec/fetch states outright). modify/create/delete/abort stay unannotated so they
// keep their confirmation.
const ENGINE_STATE_ONLY = { readOnlyHint: true } as const;

/** queue_next's answer: the summary, then one block per admitted line with its free text. */
export function formatQueueNext(r: PickResult, explain: boolean | "all"): string {
  const lines = [formatPickSummary(r, explain)];
  for (const a of r.admitted)
    lines.push(
      "",
      `${r.dryRun ? "WOULD ADMIT" : "ADMITTED (running)"} ${a.id} | model: ${a.model} | effort: ${a.effort} | repo: ${a.repo}` +
        (a.workflow ? ` | workflow: ${a.workflow}` : "") +
        (a.difficulty !== undefined ? ` | difficulty: ${a.difficulty}` : "") +
        ` | kind: ${a.kind}` +
        (a.priority !== undefined ? ` | priority: ${a.priority}` : "") +
        (a.sweep !== undefined ? ` | sweep: ${a.sweep}` : ""),
      a.text,
    );
  return lines.join("\n");
}

/** The slice of the SDK's request extra a progress heartbeat needs. */
interface ToolExtra {
  readonly _meta?: { readonly progressToken?: string | number };
  readonly sendNotification: (n: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
}

/**
 * After a queue write: the lines a pick would admit into the free slots right now. A running batch session
 * admits only on a land's `slot_free`, so the caller is told to send the dispatcher a `refill`.
 */
function refillHint(file: string): string {
  try {
    const n = planPick(readQueue(file)).admitted.length;
    return n > 0
      ? `\nnote: a pick would admit ${n} line(s) now; a running batch session picks only on a land; tell its dispatcher "lines added" (transition \`refill\` at \`collect\`).`
      : "";
  } catch {
    return "";
  }
}

/** The dispatcher nudge of a window change (`windowNudge`): what a pick would admit now, read after the write. */
function windowNudgeLines(storage: Storage, file: string, r: HeaderResult): string[] {
  try {
    if (r.to <= r.from) return [];
    return windowNudge(storage.readAll(), file, r, planPick(readQueue(file)).admitted.length);
  } catch {
    return [];
  }
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
      const broken = loader.broken();
      const untrusted = [
        loader.untrustedNote(),
        broken.length > 0
          ? `BROKEN (did not load):\n${broken
              .map(
                b =>
                  `  ${b.name}: ${b.file}: ${b.reason}${b.stale ? " (the last good copy keeps serving)" : ""}`,
              )
              .join("\n")}`
          : "",
      ]
        .filter(n => n !== "")
        .join("\n\n");
      if (workflows.size === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "No workflows found. Add YAML files to .claude/workflows/" +
                (untrusted ? `\n${untrusted}` : ""),
            },
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
            text: `=== AVAILABLE WORKFLOWS ===\n${lines.join("\n")}${untrusted ? `\n\n${untrusted}` : ""}`,
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
        "Start a workflow. Returns the first prompt, session ID, and available transitions (the rules block is one line after the first start in a context; `full: true` prints it whole). A start without parent_session_id while this process already has an active root session is refused (a sub-agent never gets a root: pass parent_session_id).",
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
          context: z
            .record(z.string())
            .optional()
            .describe(
              "Context keys the session starts with (e.g. a dispatched task's `task`, `queue_file`, `difficulty`); not `cwd`",
            ),
          reply: z.literal("id").optional().describe(START_REPLY_DESCRIPTION),
          full: z.boolean().optional().describe(FULL_DESCRIPTION),
          force: z.string().min(1).optional().describe(START_FORCE_DESCRIPTION),
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
              args.context,
              args.force,
            ),
          );
          // No forceFullPrompt here: a digest_on_repeat initial state (master
          // route) digests on repeat start() calls in the same process — the
          // main ceremony saving. status() still always returns the full text.
          // a project file of the SAME name was left out (the bundled one runs instead): say so
          const shadowed = engine.untrustedNote(args.workflow ?? "master", args.cwd);
          const text =
            (shadowed ? `NOTE: ${shadowed}\n\n` : "") +
            (args.reply === "id"
              ? `SESSION: ${status.sessionId} @ ${status.currentStateName}` +
                (status.driverCall ? `\n\n${status.driverCall}` : "")
              : formatStatus(status, { showSessionId: true, forceFullPrompt: args.full === true }) +
                "\n\n---\n" +
                workflowRules(args.full === true) +
                "\n---" +
                (status.driverCall ? `\n\n${status.driverCall}` : ""));
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
        "Get current state, full stack, available transitions, and history for a session. With `key`: only that context value, in full. A repeat status of a session in the same context names the context keys that did not change and lists only the history entries since the last one; `full: true` gives everything.",
      annotations: ENGINE_STATE_ONLY,
      inputSchema: z
        .object({
          session_id: z.string().optional().describe("Session identifier"),
          key: z.string().optional().describe(STATUS_KEY_DESCRIPTION),
          full: z.boolean().optional().describe(FULL_DESCRIPTION),
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
        if (args.key === STATUS_ROUTES_KEY && !Object.hasOwn(status.context, args.key))
          return {
            content: [{ type: "text", text: formatRoutes(status.availableTransitions) }],
          };
        if (args.key !== undefined)
          return {
            content: [{ type: "text", text: formatContextValue(status.context, args.key) }],
          };
        syncContextEpoch();
        const seen = args.full === true ? undefined : statusSeen.get(sid);
        const entries =
          seen !== undefined && status.history.length >= seen.historyLength
            ? status.history.slice(Math.max(seen.historyLength, status.history.length - 10))
            : status.history.slice(-10);
        const historyLines = entries.map(h => {
          const actorStr = h.actor ? ` [${h.actor}]` : "";
          const detailStr = h.detail ? ` (${h.detail})` : "";
          if (h.event === "action")
            return `  [${h.frame}] [auto] ${h.from} --${detailStr}--> ${h.to} at ${h.at}`;
          if (h.event === "skill_gate")
            return `  [${h.frame}] [auto] ${h.from} --skills--> ${h.to} at ${h.at}`;
          if (h.event === "model") return `  [${h.frame}] model_table: ${h.detail} at ${h.at}`;
          if (h.event)
            return `  [${h.frame}] ${h.event}${h.workflow ? ` (${h.workflow})` : ""}${actorStr} at ${h.at}`;
          return `  [${h.frame}] ${h.from} --${h.via}--> ${h.to}${detailStr}${actorStr} at ${h.at}`;
        });
        const historyBlock =
          seen !== undefined && status.history.length >= seen.historyLength
            ? entries.length === 0
              ? [
                  "RECENT HISTORY: nothing new since your last status; status({ full: true }) lists the last 10",
                ]
              : ["RECENT HISTORY (since your last status):", ...historyLines]
            : ["RECENT HISTORY:", ...historyLines];

        const contextLines = formatContextDelta(status.context, seen?.lines);
        statusSeen.set(sid, {
          lines: new Map(contextEntries(status.context).map(e => [e.key, e.line])),
          historyLength: status.history.length,
        });
        const linked = engine.linkedAgentLines(sid);
        const suspendedAt = storage.read(sid)?.suspended_at;
        const starved = starvationLines(storage, sid);
        const body = formatStatus(status, { showSessionId: true, forceFullPrompt: true });
        const stale = unshownStale(engine, sid, body);
        const unanswered = [
          ...unansweredNotice(engine, sid),
          ...unshownParentAnswers(engine, sid, body),
          ...unshownOwed(engine, sid, body),
        ];
        const text = [
          ...(starved.length > 0 ? [...starved, ""] : []),
          ...(stale.length > 0 ? [...stale, ""] : []),
          ...(unanswered.length > 0 ? [...unanswered, ""] : []),
          ...(suspendedAt
            ? [
                `SUSPENDED since ${suspendedAt} — call resume({ session_id: "${sid}" }) to continue it.`,
                "",
              ]
            : []),
          body,
          ...(linked.length > 0 ? ["", ...linked] : []),
          ...(contextLines.length > 0 ? ["", ...contextLines] : []),
          "",
          ...historyBlock,
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
        "Transition to the next state in the active workflow. If the new state has a sub_workflow, it auto-pushes. If terminal, it auto-pops to parent. `set` = {key: value, ...} written to the context FIRST, in order, then the transition is taken, in one call (a key this transition or the state it leads to reads: pass it here, not in a context_set sent in the same parallel batch, which has no ordering guarantee). All or nothing: a refused key or a refused transition writes none of them. A context_set that is not in `set` must have RETURNED first.",
      annotations: ENGINE_STATE_ONLY,
      inputSchema: z
        .object({
          session_id: z.string().optional().describe("Session identifier"),
          transition: z.string().describe("Name of the transition to take"),
          set: z
            .record(z.unknown())
            .optional()
            .describe(
              "Context keys to write before the transition, in the given order, each as context_set would; all or nothing with the transition",
            ),
          actor: z.string().optional().describe("Identity of the agent performing this action"),
          force: z.boolean().optional().describe(FORCE_DESCRIPTION),
          reason: z.string().optional().describe(REASON_DESCRIPTION),
          caller_session_id: z.string().optional().describe(CALLER_DESCRIPTION),
        })
        .strict(),
    },
    (args, extra) =>
      serialized(sessionKey(args.session_id), async () => {
        try {
          const progress = progressOf(extra);
          const sid = engine.resolveSessionId(args.session_id);
          engine.assertNotSuspended(sid);
          const scope = scopeVerdict(storage, {
            tool: "transition",
            target: sid,
            caller: args.caller_session_id,
            force: args.force,
            reason: args.reason,
          });
          if (scope.refusal) throw new Error(scope.refusal);
          const warning = engine.assertOwnership(sid, args.force);
          const how = engine.orphanedStep(sid);
          const adopted = how
            ? await withProgress(progress, () => engine.adoptOrphanedExec(sid))
            : null;
          const setKeys = Object.keys(args.set ?? {});
          if (adopted) {
            const text = `${warning ? warning + "\n\n" : ""}${formatAdopted(adopted, how)}\n\nTransition "${args.transition}" was NOT taken${setKeys.length > 0 ? ` and its \`set\` keys were NOT written` : ""} — the session moved on; choose from the state above.`;
            return { content: [{ type: "text", text }], isError: true };
          }
          const leaving = Object.keys(engine.getStatus(sid).availableTransitions);
          const status = await withProgress(progress, () =>
            engine.transition(sid, args.transition, args.actor, args.set),
          );
          const setLine = setKeys.length > 0 ? `Context set: ${setKeys.join(", ")}.\n\n` : "";
          const arriving = Object.keys(status.availableTransitions);
          const body =
            setLine +
            formatStatus(status, {
              sameRoutesAsBefore:
                leaving.length > 0 &&
                leaving.length === arriving.length &&
                leaving.every((n, i) => n === arriving[i]),
            });
          const notices = [
            ...starvationLines(storage, sid),
            ...unshownStale(engine, sid, body),
            ...unansweredNotice(engine, sid),
            ...unshownParentAnswers(engine, sid, body),
            ...unshownOwed(engine, sid, body),
          ];
          const text =
            (warning ? warning + "\n\n" : "") +
            body +
            (notices.length > 0 ? `\n\n${notices.join("\n")}` : "") +
            (status.driverCall ? `\n\n${status.driverCall}` : "");
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
        "Save key-value data in the session context for later use. When a following transition reads the key, put it in that transition's `set` (one call), or wait for this call to return before calling transition (separate message, not the same parallel batch).",
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
          const derived = await engine.setContext(sid, args.key, args.value, args.actor);
          const answerNote =
            args.key === "parent_answer" ? engine.parentAnswerNote(sid) : undefined;
          const text =
            (warning ? warning + "\n" : "") +
            `Context "${args.key}" set successfully.` +
            (derived ? `\nmodel_table: ${derived}` : "") +
            (answerNote ? `\n${answerNote}` : "");
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
        "Add/change/remove states and transitions in the current session's workflow (overlay, does not modify YAML). An exec or fetch state is refused: those come only from a workflow file of a project the user trusted (Claude Code's folder trust, or `wf-trust`).",
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
      description:
        "Create a new workflow definition (saves as YAML for reuse). A definition with an exec or fetch state is refused: write that file yourself in a project the user trusted (Claude Code's folder trust, or `wf-trust`).",
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
      description:
        "Abort the workflow (pop all stack frames, end session; its active descendants end with it). Refused for a root or a session with active descendants unless caller_session_id names the target or an ancestor of it, or force: true with a reason.",
      inputSchema: z
        .object({
          session_id: z.string().optional().describe("Session identifier"),
          force: z.boolean().optional().describe(FORCE_DESCRIPTION),
          reason: z.string().optional().describe(REASON_DESCRIPTION),
          caller_session_id: z.string().optional().describe(CALLER_DESCRIPTION),
        })
        .strict(),
    },
    args => {
      const scopeOf = (sid: string) =>
        scopeVerdict(storage, {
          tool: "abort",
          target: sid,
          caller: args.caller_session_id,
          force: args.force,
          reason: args.reason,
        });
      // Kill first, outside the queue: the session's own running transition
      // holds the queue for as long as its foreground exec runs. An unresolved
      // id, a refused ownership or a refused scope kills nothing; the queued
      // run reports it.
      try {
        const sid = engine.resolveSessionId(args.session_id);
        engine.assertOwnership(sid, args.force);
        if (scopeOf(sid).refusal === undefined) engine.killSessionTree(sid);
      } catch {
        /* reported below */
      }
      return serialized(sessionKey(args.session_id), async () => {
        try {
          const sid = engine.resolveSessionId(args.session_id);
          const warning = engine.assertOwnership(sid, args.force);
          const scope = scopeOf(sid);
          if (scope.refusal) throw new Error(scope.refusal);
          const count = activeSubtree(storage, sid).length;
          console.error(
            `abort: session ${sid} by ${args.caller_session_id ?? "an unnamed caller"} ends ${count} session(s)` +
              (scope.overridden ? `; forced: ${scope.overridden}` : ""),
          );
          await engine.abort(sid);
          const text =
            (warning ? warning + "\n" : "") +
            `Session "${sid}" aborted${count > 1 ? ` (${count} sessions ended with it)` : ""}.`;
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
      description:
        "List all workflow sessions (active shown first, recent inactive limited to 3). [STALE] marks an active session whose state saw no engine call for longer than its stale_after (its agent may be dead or stuck).",
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

      const now = Date.now();
      const parents = activeParents(allSessions);
      const formatSession = (s: SessionState): string => {
        const isActive = s.stack.length > 0;
        const frame = isActive ? s.stack[s.active_frame] : null;
        const stateInfo = frame
          ? `${frame.workflow} @ ${frame.current_state}`
          : `(${s.outcome ?? "completed"})`;
        const depth = s.stack.length > 1 ? ` [depth: ${s.stack.length}]` : "";
        const parent = s.parent_session_id ? ` [child of ${s.parent_session_id}]` : "";
        const suspended = isActive && s.suspended_at ? ` [suspended since ${s.suspended_at}]` : "";
        const starved =
          isActive && s.pool_starved
            ? ` [POOL STARVED since ${s.pool_starved.since}: ${s.pool_starved.note}]`
            : "";
        const st = isActive ? engine.staleness(s, parents, now) : undefined;
        const stale = st ? ` [STALE: ${staleNote(st)}]` : "";
        const pidInfo =
          args.all && s.context.claude_code_pid !== undefined
            ? ` [pid: ${s.context.claude_code_pid}${s.context.claude_code_pid === pid ? " ★" : ""}]`
            : "";
        return `  ${s.session_id}: ${stateInfo}${depth}${parent}${suspended}${starved}${stale}${pidInfo} (updated: ${s.updated_at})`;
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
        "Shows what each measured lease runs against what it holds (`runs ~N`) and flags one whose processes run well above its threads (`OVERRUN`) or well below them for 30 s (`UNDERUSE`), a waiter queued past `starve_after` (`STARVED`) and a pool that granted nothing that long. " +
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
        "Record which sub-agent (the Agent tool's agent id: 'a' and hex, never a placeholder: anything else is refused) drives a child session, so that after a restart resume() " +
        "of the parent names the agent to wake with SendMessage. Call it once the child session id is known (sessions() lists children). " +
        "It also records the parent's state and visit: status() of the parent marks the agent current at that visit, " +
        "stale at a later visit of the state; linking again re-records it. Every agent linked stays on the session, so " +
        "the ledger's spend sums a respawned worker's earlier agents too. Each call is also recorded with its time, the parent's state and the stage that state spawns on, " +
        "so the ledger splits the spend per agent and stage (a worker linked again for a fix round splits at the call).",
      annotations: ENGINE_STATE_ONLY,
      inputSchema: z
        .object({
          session_id: z.string().describe("The sub-agent's session"),
          agent_id: z
            .string()
            .min(1)
            .describe(
              "The Agent tool's id of that sub-agent ('a' and hex, e.g. a15bb6b2a76ef441c)",
            ),
        })
        .strict(),
    },
    async args => {
      try {
        const step = await engine.linkAgent(args.session_id, args.agent_id);
        const at = step ? ` at its parent's ${step.state} visit ${step.visit}` : "";
        return {
          content: [
            {
              type: "text",
              text: `Session "${args.session_id}" linked to agent ${args.agent_id}${at}.`,
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

  // 16. queue_next
  server.registerTool(
    "queue_next",
    {
      description:
        "Admit the next tasks of a YAML task queue (header `batch_size:`, `tasks:` of `{id, status, difficulty, kind, priority, model, effort, repo, workflow, after, touches, owner, sweep, on_end_tell_parent, exclusive, breaking, parked, ended, restored, base, text_hash, text, notes}`): " +
        "fills the window (batch_size minus the running tasks) in `priority:` order (urgent, high, normal, low; file order within one) with pending tasks whose `after:` ids are all done, " +
        "that are not `parked`, and whose `touches:` / `owner:` overlap no running or just-admitted task (`touches:` within " +
        "one repo only, where no `touches:` = overlaps every task; `exclusive: true` = overlaps every task of its own repo (another repo is unaffected), and while it waits only for running lines of its repo, no later line of that repo is admitted (`held for exclusive <ID>`; header `exclusive_hold: no` turns that off); `breaking: true` = admitted only into an empty window, nothing else admitted while it runs; " +
        "header `overlap: files` = only file entries conflict, a directory or glob is a hint); sets each admitted task running under the queue's lock, so two calls never admit one task. `backlog` tasks are never admitted. Returns id, " +
        "model, effort, repo (absolute), workflow (when set), difficulty (1..10, when set: " +
        "the task workflow's model_table maps it to model/effort), kind (bug|feature|research; feature when the task has none), sweep (when set: the line's command, data for the project's workflow, no pick rule reads it) and text per admitted task. `batch_size: 0` = paused: nothing is admitted. " +
        "The exec form is `$WF_PLUGIN_ROOT/scripts/wf-queue`.",
      inputSchema: z
        .object({
          ...QUEUE_SEL,
          dry_run: z.boolean().optional().describe("Show what would be admitted; mark nothing"),
          explain: z
            .union([z.boolean(), z.literal("all")])
            .optional()
            .describe(
              "Why pending lines wait: substantive reasons by name, `window full` folded into one line; " +
                '"all" = one line per pending line',
            ),
        })
        .strict(),
    },
    async args => {
      try {
        const r = await pickQueue(resolveQueueFile(args), { dryRun: args.dry_run === true });
        return {
          content: [
            {
              type: "text",
              text: formatQueueNext(r, args.explain === "all" ? "all" : args.explain === true),
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

  // 17. queue_mark
  server.registerTool(
    "queue_mark",
    {
      description:
        "Change one task's status in a YAML task queue under its lock: running pending→running (with `retry: true`: " +
        "failed→running, a failed task run again; its `difficulty: N` becomes N+1, at most 10, so the new session starts a row up), done running→done, failed running→failed, released running→pending " +
        "(nothing of the task was made), promoted backlog→pending (refused for a line with no `difficulty:`), shelved pending→backlog. Refuses any other current status. " +
        '`running` also refuses a pending line the picker would not admit (overlap, after, exclusive, breaking, parked) and names why; `force: "<reason>"` marks it anyway and notes the reason. ' +
        "`note` is appended to the task's `notes:` as `{from, date, text}` (`from` defaults to `mark`).",
      inputSchema: z
        .object({
          ...QUEUE_SEL,
          id: z.string().min(1).describe("The task id"),
          to: z
            .enum(Object.keys(MARK_TARGETS) as [MarkTarget, ...MarkTarget[]])
            .describe("running | done | failed | released | promoted | shelved"),
          note: z.string().optional().describe("A note appended to the task's notes:"),
          from: z.string().min(1).optional().describe("Who writes the note (default `mark`)"),
          retry: z
            .boolean()
            .optional()
            .describe(
              "With `to: running`: restart a failed task (failed→running); its `difficulty:` is raised by one (≤10)",
            ),
          force: z
            .string()
            .min(1)
            .optional()
            .describe(
              "With `to: running` (pending→running): the reason to mark a line the picker would not admit (overlap, after, exclusive, breaking, parked); written into its notes",
            ),
        })
        .strict(),
    },
    async args => {
      try {
        const r = await markQueue(resolveQueueFile(args), args.id, args.to, args.note, {
          retry: args.retry === true,
          ...(args.force !== undefined ? { force: args.force } : {}),
          ...(args.from !== undefined ? { from: args.from } : {}),
        });
        return {
          content: [
            {
              type: "text",
              text:
                formatMark(r) + (args.to === "promoted" ? refillHint(resolveQueueFile(args)) : ""),
            },
          ],
        };
      } catch (err) {
        return queueError(err);
      }
    },
  );

  // 18. queue_add
  server.registerTool(
    "queue_add",
    {
      description:
        "Add a task to a YAML task queue under its lock (the lock queue_next / queue_mark take, so no status " +
        "is lost to a concurrent write): `task` is `{id, status?: pending|backlog, difficulty, kind: bug|feature|research (absent = feature; any other value is refused), priority: urgent|high|normal|low (the pick admits higher first, then file order; any other value is refused), model, effort, repo, workflow, after: [ids], touches: [paths], owner, sweep, on_end_tell_parent (one line: the step the parent owes when the line ends; the dispatcher hands it back once as `OWED task=<ID> status=<done|failed> sha=<sha>: <text>`), exclusive, breaking, parked, text, notes: [{from, date, text}]}`; `ended` (the day a line reached done or failed) is queue_mark's: a new task cannot set it. " +
        "The line records where it was written: `base` (HEAD of the line's repo — `repo:` or the queue's project; left out when that is not a git repo) and `text_hash` (short sha256 of text + touches + owner (+ sweep when set)), both set by queue_add / queue_edit only; `ended` (queue_mark's) and `restored` (the archive restore's) are never set on a new line. " +
        "Refused unless it reads as a pick reads it: a new id, known keys only, every id in `after:` a task of the queue " +
        "(no cycle), a one-word `workflow:`, a `repo:` that resolves, a `difficulty:` of 1..10 (REQUIRED on a pending line: `difficulty: <1-10> is required on a pending line`; backlog, `parked` and `model: —` lines need none), a `kind:` of bug|feature|research. Goes after `after_id`, before `before_id`, " +
        "else last. A queue addressed by `queue` or by default that does not exist yet is CREATED (`batch_size: 1`, `tasks: []`) and the answer says so (a full `file` path that does not exist is an error, never created).",
      inputSchema: z
        .object({
          ...QUEUE_SEL,
          task: z
            .record(z.unknown())
            .describe("The new task: `id` and its fields by key (`text` the brief)"),
          after_id: z.string().min(1).optional().describe("Insert right after this line"),
          before_id: z.string().min(1).optional().describe("Insert right before this line"),
        })
        .strict(),
    },
    async args => {
      try {
        const file = resolveQueueFile(args);
        const r = await addQueueLine(
          file,
          args.task,
          {
            after: args.after_id,
            before: args.before_id,
          },
          { create: args.file === undefined },
        );
        const made = r.created ? `; the queue did not exist — created ${file}` : "";
        return {
          content: [
            {
              type: "text",
              text: `${r.id}: added at line ${r.lineNo}${made}${(r.warnings ?? []).map(w => `\nwarning: ${w}`).join("")}${refillHint(file)}`,
            },
          ],
        };
      } catch (err) {
        return queueError(err);
      }
    },
  );

  // 19. queue_edit
  server.registerTool(
    "queue_edit",
    {
      description:
        "Change one task's fields in a YAML task queue under the queue's lock: `set: { field: value }` " +
        '(difficulty, kind: bug|feature|research — anything else is refused, priority: urgent|high|normal|low — anything else is refused, model, effort, repo, workflow, after, touches, owner, sweep (one non-empty line: a command for the workflow of the project, no pick rule), on_end_tell_parent (one non-empty line: the step the parent owes when the line ends; the dispatcher hands it back once as `OWED …`), exclusive, breaking, parked, text (`ended` is set by queue_mark only, read-only here; so is `restored` (written by the archive restore); so are `base` / `text_hash`: an edit that changes text, touches, owner, sweep or repo rewrites both — base = HEAD of its repo now — and any other edit leaves them); `""` or null removes the field; `after`/`touches` a list or a comma-separated string) and/or `append_note` ' +
        "(appended to `notes:` as `{from, date, text}`, `from` default `parent`). The status is queue_mark's. " +
        "A set field keeps its place; values are checked as queue_add checks them, so an edit that leaves a pending line (not parked, not `model: —`) with no `difficulty:` is refused (a line already without one stays editable). Returns the task as written (YAML).",
      inputSchema: z
        .object({
          ...QUEUE_SEL,
          id: z.string().min(1).describe("The task id"),
          set: z
            .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]))
            .optional()
            .describe("Fields to set; an empty value removes one"),
          append_note: z.string().optional().describe("A note appended to the task's notes:"),
          from: z.string().min(1).optional().describe("Who writes the note (default `parent`)"),
        })
        .strict(),
    },
    async args => {
      try {
        const r = await editQueueLine(
          resolveQueueFile(args),
          args.id,
          args.set ?? {},
          args.append_note,
          args.from,
        );
        return {
          content: [
            {
              type: "text",
              text:
                r.task +
                (r.warnings ?? []).map(w => `\nwarning: ${w}`).join("") +
                refillHint(resolveQueueFile(args)),
            },
          ],
        };
      } catch (err) {
        return queueError(err);
      }
    },
  );

  // 20. queue_header
  server.registerTool(
    "queue_header",
    {
      description:
        "Set a task queue's header under its lock. The window: `batch_size: N` with `reason: <reason>` (both required together; " +
        "`0` is the pause: running tasks finish, nothing new is admitted). And/or `archive_after_days: N` (a whole number ≥ 1; " +
        "`null` removes the key = no automatic archiving; a pick archives the done / failed lines that ended over N days ago). " +
        "And/or `exclusive_hold: yes|no` (`no` turns off the hold of a waiting exclusive line: while a pending `exclusive: true` line waits only for running " +
        "lines of its repo, no later line of that repo is admitted; `null` removes the key = on). " +
        '`until: "<TASK-ID> done"` with the window makes it temporary: the engine restores the window and reason it replaced at the mark of that line that leaves running (done, failed or released), so a raised window is never left raised; a plain window set meanwhile drops the pending revert. ' +
        "One call sets the window, either key or all; the other header keys are untouched. " +
        "When the window grows and a live dispatcher session holds the queue, the answer adds one line naming that session, its state and the call that makes it use the new window (`lines added` to its agent at `collect`, `retry` at `paused`; `transition` `refill` / `retry` when main drives it); a hand edit of the file is not noticed.",
      inputSchema: z
        .object({
          ...QUEUE_SEL,
          batch_size: z.number().int().min(0).optional().describe("The window; 0 = paused"),
          reason: z
            .string()
            .min(1)
            .optional()
            .describe("Why — written as the header's `reason:`; required with batch_size"),
          archive_after_days: z
            .number()
            .int()
            .min(1)
            .nullable()
            .optional()
            .describe(
              "Days after which a pick archives a done / failed line; null removes the key",
            ),
          exclusive_hold: z
            .enum(["yes", "no"])
            .nullable()
            .optional()
            .describe(
              "no = a waiting exclusive line does not hold its repo; yes = it does (the default); null removes the key",
            ),
          until: z
            .string()
            .min(1)
            .optional()
            .describe(
              "`<TASK-ID> done`: with batch_size + reason, a temporary window. The engine puts the window and reason it replaced back at the mark of that line that leaves running (done, failed or released), and says so in that mark's answer",
            ),
        })
        .strict(),
    },
    async args => {
      try {
        const window = args.batch_size !== undefined || args.reason !== undefined;
        if (!window && args.archive_after_days === undefined && args.exclusive_hold === undefined)
          throw new QueueError(
            "queue_header needs batch_size + reason, archive_after_days, exclusive_hold, or several",
          );
        if (window && (args.batch_size === undefined || args.reason === undefined))
          throw new QueueError("batch_size and reason go together");
        if (args.until !== undefined && !window)
          throw new QueueError("until goes with batch_size + reason: it ends a temporary window");
        const file = resolveQueueFile(args);
        const lines: string[] = [];
        if (args.batch_size !== undefined && args.reason !== undefined) {
          const r = await setQueueWindow(file, args.batch_size, args.reason, args.until);
          lines.push(formatWindow(r), ...windowNudgeLines(storage, file, r));
        }
        if (args.archive_after_days !== undefined)
          lines.push(
            formatHeaderKey(
              await setQueueHeaderKey(file, "archive_after_days", args.archive_after_days),
            ),
          );
        if (args.exclusive_hold !== undefined)
          lines.push(
            formatHeaderKey(await setQueueHeaderKey(file, "exclusive_hold", args.exclusive_hold)),
          );
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return queueError(err);
      }
    },
  );
}

/** The queue a call means: `file` (a full path), else `queue` (a name), else the project's default. */
const QUEUE_SEL = {
  file: z
    .string()
    .min(1)
    .optional()
    .describe(
      "A queue file by full path (a queue of another repo); omit it to use `queue` or the default",
    ),
  queue: z
    .string()
    .min(1)
    .optional()
    .describe(
      "A queue by name: `.claude/batch/<queue>.yaml` of the project (the git root of the server's cwd; a worktree resolves to its main checkout). " +
        "Neither `file` nor `queue` = `.claude/batch/queue.yaml`",
    ),
};

function queueError(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  return {
    content: [{ type: "text", text: `ERROR: ${(err as Error).message}` }],
    isError: true,
  };
}
