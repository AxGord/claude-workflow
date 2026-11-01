// A task workflow's `driver:` — where its instructions live and the exact Agent call that spawns it.
// Pure but for `fs.existsSync` in `driverRefError`; the engine renders the call into `start`'s answer,
// so a dispatcher copies one block instead of composing the driver's prompt.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Driver } from "./types.js";

/** The shipped drivers: `templates/drivers/<name>.md` of this plugin. */
export const SHIPPED_DRIVERS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
  "drivers",
);

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
export function driverRefError(driver: Driver, shippedDir = SHIPPED_DRIVERS_DIR): string | null {
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
    "SendMessage it first; gone → at work, check the tree (its commit on the task's branch and a clean worktree →",
    "the prompt's verify step); at review, a <wt>.log/review.md newer than the branch's last commit holding a",
    "VERDICT line → route by that verdict; else a fresh agent on the session it is linked to, then link_agent it.",
    "None current → the prompt from its first step, as for a new visit; its own steps still apply (a fix round's",
    "SendMessage of the cause to worker_agent, then its link_agent, included) — but never ask an earlier visit's",
    "agent where it stands, nor take it as this visit's.",
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
    `  model: ${i.driver.model}, effort: ${i.driver.effort}, run_in_background: true, description: "drive ${i.task ?? i.sessionId}", prompt:`,
    prompt,
  ];
  if (!i.instructionsExist)
    lines.push(
      `WARNING: the driver's instructions ${i.instructions} do not exist — fix driver.prompt_ref first.`,
    );
  return lines.join("\n");
}
