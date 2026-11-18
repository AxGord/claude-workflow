// A task workflow's `driver:` — where its instructions live and the exact Agent call that spawns it.
// Pure but for `fs.existsSync` in `driverRefError`; the engine renders the call into `start`'s answer,
// so a dispatcher copies one block instead of composing the driver's prompt.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Dispatcher, Driver } from "./types.js";

/** The shipped drivers: `templates/drivers/<name>.md` of this plugin. */
export const SHIPPED_DRIVERS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
  "drivers",
);

/** The Agent call's `subagent_type` when `driver.agent_type` is not set: the plugin's own driver agent. */
export const DEFAULT_DRIVER_AGENT_TYPE = "workflow:driver";

/** The context key `start` keeps the rendered call in: `status({session_id, key: "driver_call"})` re-reads it whole. */
export const DRIVER_CALL_KEY = "driver_call";

const BARE_NAME = /^[A-Za-z0-9._-]+$/;

/** A `prompt_ref` → the absolute path of the instructions: a bare name is a shipped driver, else a path (`~/`, or relative to `cwd`). */
export function resolveDriverRef(
  ref: string,
  cwd: string,
  shippedDir = SHIPPED_DRIVERS_DIR,
): string {
  if (BARE_NAME.test(ref) && !ref.endsWith(".md")) return path.join(shippedDir, `${ref}.md`);
  if (ref === "~" || ref.startsWith("~/")) return path.join(os.homedir(), ref.slice(1));
  return path.resolve(cwd, ref);
}

/** The loader's check: a bare name must be a shipped driver (a path is the project's, checked when rendered). */
export function driverRefError(
  driver: Pick<Driver, "prompt_ref">,
  shippedDir = SHIPPED_DRIVERS_DIR,
): string | null {
  const ref = driver.prompt_ref;
  if (!BARE_NAME.test(ref) || ref.endsWith(".md")) return null;
  return fs.existsSync(path.join(shippedDir, `${ref}.md`))
    ? null
    : `driver.prompt_ref "${ref}": no shipped driver of that name (a path needs "/", "~" or ".md")`;
}

export interface DriverCallInput {
  readonly driver: Driver;
  /** The task session the driver takes over. */
  readonly sessionId: string;
  readonly task: string | undefined;
  readonly queueFile: string | undefined;
  /** The resolved instructions file. */
  readonly instructions: string;
  readonly instructionsExist: boolean;
}

/** The driver's prompt, exactly as the Agent call takes it. */
export function driverPrompt(i: DriverCallInput): string {
  const task = i.task ?? "(see the session's context)";
  return [
    `You are the driver of task ${task}${i.queueFile ? ` of the queue ${i.queueFile}` : ""}. Your task session is P = ${i.sessionId}`,
    "(it holds the step — never call start() for it). First read your instructions whole:",
    `${i.instructions} — then \`status({session_id: "${i.sessionId}"})\` and follow its prompts to the end; after that`,
    "every `transition` reply IS the next prompt — never call `status` after it. Re-spawned on a running session:",
    "that status lists P's LINKED AGENTS of its current state — the engine marks each `current` (linked at this",
    "visit) or not; only a `current` one is this visit's agent. A current agent → start no new session or agent —",
    "SendMessage it first; gone → check the tree for the work its step leaves behind and, when the step's own",
    "instructions say how to verify it, follow them; else a fresh agent on the session it is linked to, then",
    "link_agent it. None current → the prompt from its first step, as for a new visit; its own steps still apply",
    "(any SendMessage to an earlier agent and its link_agent included) — but never ask an earlier visit's",
    "agent where it stands, nor take it as this visit's. At a `_spawn` state an agent the status lists as `live` counts",
    "as current: message it, spawn no second one. A harness `[handback-send-enforce]` prompt while P has not ended is",
    "answered with the WAITING line only, never a hand-back.",
    "The workflow tools may be deferred:",
    'load them first with ToolSearch query "+plugin_workflow_wf" (max_results 20). Reply with exactly one line at',
    "the end, as the instructions say.",
  ].join("\n");
}

/** The block `start` appends: the Agent call to copy, then the link. */
export function renderDriverCall(i: DriverCallInput): string {
  const prompt = driverPrompt(i)
    .split("\n")
    .map(l => `    ${l}`)
    .join("\n");
  const lines = [
    "---",
    `DRIVER — this workflow is driven by an agent, not by you. Spawn exactly this (Agent), then`,
    `\`link_agent({session_id: "${i.sessionId}", agent_id: <its id>})\` and do not drive ${i.sessionId} yourself:`,
    `  model: ${i.driver.model}, effort: ${i.driver.effort}, run_in_background: true, subagent_type: ${JSON.stringify(i.driver.agent_type ?? DEFAULT_DRIVER_AGENT_TYPE)}, description: "drive ${i.task ?? i.sessionId}", prompt:`,
    prompt,
  ];
  if (!i.instructionsExist)
    lines.push(
      `WARNING: the driver's instructions ${i.instructions} do not exist — fix driver.prompt_ref first.`,
    );
  return lines.join("\n");
}

/** The Agent call's `subagent_type` when `dispatcher.agent_type` is not set: the plugin's agents/dispatcher.md. */
export const DEFAULT_DISPATCHER_AGENT_TYPE = "workflow:dispatcher";

/** The context key `start` keeps the dispatcher's rendered call in; its presence on a session = the opt-in was on at its start. */
export const DISPATCHER_CALL_KEY = "dispatcher_call";

/** The context key holding the workflow's `dispatcher.after` state, when it names one: the main conversation's last own state. */
export const DISPATCHER_AFTER_KEY = "dispatcher_after";

/** Claude Code's nesting limit: main → dispatcher → task driver → worker → the worker's helper needs 4. */
export const SPAWN_DEPTH_ENV = "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH";
export const SPAWN_DEPTH_NEEDED = 4;

const OFF_VALUES = new Set(["", "0", "false", "off", "no"]);

/** Whether a `dispatcher:` block is in force: no `env` = always; else that variable holds anything but an off value. */
export function dispatcherOn(d: Dispatcher, env: NodeJS.ProcessEnv = process.env): boolean {
  if (d.env === undefined) return true;
  return !OFF_VALUES.has((env[d.env] ?? "").trim().toLowerCase());
}

export interface DispatcherCallInput {
  readonly dispatcher: Dispatcher;
  /** The dispatching session the agent takes over. */
  readonly sessionId: string;
  /** The resolved instructions file. */
  readonly instructions: string;
  readonly instructionsExist: boolean;
  /** What this process sees in `SPAWN_DEPTH_ENV`. */
  readonly spawnDepth: string | undefined;
}

/** The dispatcher's prompt, exactly as the Agent call takes it. */
export function dispatcherPrompt(i: DispatcherCallInput): string {
  const d = i.sessionId;
  return [
    `You are the dispatcher of the batch session D = ${d} (it holds the step — never call start() for it;`,
    `every start() you make carries parent_session_id: "${d}"). First read your instructions whole:`,
    `${i.instructions} — then \`status({session_id: "${d}"})\` and drive its \`dispatch\` and \`collect\` states as`,
    "the instructions say; after that every `transition` reply IS the next prompt. Spawned on a running session",
    "(D is past its first dispatch): its context keys `tasks` and `lessons_pending` are the truth, not a memory —",
    "wake or re-spawn a task driver only when the main conversation's message says the run was restarted.",
    "The workflow tools may be deferred:",
    'load them first with ToolSearch query "+plugin_workflow_wf" (max_results 20).',
  ].join("\n");
}

/** The block `start` appends (and the reply that leaves `after` repeats): the Agent call to copy, the link, what comes back. */
export function renderDispatcherCall(i: DispatcherCallInput): string {
  const d = i.sessionId;
  const disp = i.dispatcher;
  const prompt = dispatcherPrompt(i)
    .split("\n")
    .map(l => `    ${l}`)
    .join("\n");
  const when = disp.after
    ? `once it has left \`${disp.after}\` (the states up to it are yours; the reply that leaves it repeats this block — act on none of the prompt above it)`
    : "from here on";
  const lines = [
    "---",
    `DRIVER — the dispatcher${disp.env ? ` (opt-in ${disp.env} is set)` : ""}: ${when} this session is driven by an agent, not by you. Spawn exactly this (Agent), then`,
    `\`link_agent({session_id: "${d}", agent_id: <its id>})\` and take no transition of ${d} while it drives:`,
    `  model: ${disp.model}, effort: ${disp.effort}, run_in_background: true, subagent_type: ${JSON.stringify(disp.agent_type ?? DEFAULT_DISPATCHER_AGENT_TYPE)}, description: "dispatch ${d}", prompt:`,
    prompt,
    "It hands back to you ONLY, each as one hand-back, and keeps running:",
    "- a task driver's `NEEDS-PARENT …` line, verbatim → SendMessage your decision to the DISPATCHER, starting `task=<ID>:` (it relays it to that driver);",
    `- \`LESSONS lands=<n> …\` + the drivers' last lines of those lands, copied, not judged → treat each as ${d}'s \`collect\` prompt says for a landed task (\`status\` shows it);`,
    "- `HANDOVER session=… state=<s> …` → a state it does not drive (a pause, a failed pick, the cross-check, the report): yours; back at `dispatch` or `collect`, SendMessage it `continue`.",
    "A worker's, reviewer's or driver's line that reaches you instead: SendMessage it verbatim to the dispatcher. After a restart wake only the dispatcher; it wakes the task drivers.",
    `Depth: you → dispatcher → task driver → worker → the worker's helper is ${SPAWN_DEPTH_NEEDED} levels below you, one more than Claude Code allows by default: set ${SPAWN_DEPTH_ENV}=${SPAWN_DEPTH_NEEDED} (this engine process sees: ${i.spawnDepth?.trim() || "unset"}).`,
  ];
  if (!i.instructionsExist)
    lines.push(
      `WARNING: the dispatcher's instructions ${i.instructions} do not exist — fix dispatcher.prompt_ref first.`,
    );
  return lines.join("\n");
}
