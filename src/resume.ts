// A task workflow's `resume:` — whether a step that wakes an agent it already ran resumes it (SendMessage) or
// spawns a fresh one with a handoff brief. Pure: the engine reads the agent's transcript and renders the
// templates; this file decides and words the ONE instruction a prompt shows.
import type { Resume, ResumeChoice, ResumeStep } from "./types.js";

/** The prompt cache's life: an agent idle for less is warm, resuming it re-reads its context cheaply. */
export const DEFAULT_IDLE_MINUTES = 60;

/** A cold agent above this context is cheaper to replace than to resume (re-writing its context into the cache). */
export const DEFAULT_CONTEXT_TOKENS = 50_000;

const RESUME_VAR = "{{resume}}";

/** What the decision reads of the agent. */
export interface ResumeInputs {
  /** The agent's id; empty when the context named none. */
  readonly agent: string;
  /** Milliseconds since its transcript last changed; undefined when unknown. */
  readonly idleMs?: number;
  /** Its context in tokens; undefined when unknown. */
  readonly context?: number;
}

/** The choice and the reason that names the inputs it rests on. */
export function decideResume(
  spec: Resume,
  step: ResumeStep,
  inputs: ResumeInputs,
): { choice: "resume" | "respawn"; reason: string } {
  const idleLimit = spec.idle_minutes ?? DEFAULT_IDLE_MINUTES;
  const bound = spec.context_tokens ?? DEFAULT_CONTEXT_TOKENS;
  const idle = inputs.idleMs === undefined ? undefined : Math.floor(inputs.idleMs / 60_000);
  const facts =
    `idle ${idle === undefined ? "unknown" : `${idle} min`}, ` +
    `context ${inputs.context === undefined ? "unknown" : inputs.context}`;
  if (inputs.agent === "")
    return step.never_respawn
      ? {
          choice: "resume",
          reason: `no agent recorded in \`${spec.agent}\`; this step never respawns`,
        }
      : { choice: "respawn", reason: `no agent recorded in \`${spec.agent}\`` };
  if (step.never_respawn)
    return { choice: "resume", reason: `this step never respawns (${facts})` };
  if (idle === undefined) return { choice: "resume", reason: `idle unknown: resume (${facts})` };
  if (idle < idleLimit)
    return { choice: "resume", reason: `warm: idle ${idle} min < ${idleLimit} (${facts})` };
  if (inputs.context === undefined)
    return {
      choice: "resume",
      reason: `cold (idle ${idle} min >= ${idleLimit}) but context unknown`,
    };
  return inputs.context > bound
    ? {
        choice: "respawn",
        reason: `cold and large: idle ${idle} min >= ${idleLimit}, context ${inputs.context} > ${bound}`,
      }
    : {
        choice: "resume",
        reason: `cold but small: idle ${idle} min >= ${idleLimit}, context ${inputs.context} <= ${bound}`,
      };
}

/**
 * The single instruction a prompt shows for the choice: a resume names the agent and the message, a respawn
 * names the model and effort and the brief. `message` / `brief` / `after` / `model` / `effort` are already rendered.
 */
export function resumeInstruction(
  c: Pick<ResumeChoice, "choice" | "agent" | "reason">,
  spec: Resume,
  rendered: {
    message: string;
    brief?: string;
    model?: string;
    effort?: string;
    after?: string;
  },
): string {
  if (c.choice === "resume")
    return `RESUME (${c.reason}): SendMessage \`${c.agent}\` with:\n${rendered.message}`;
  const how = [
    rendered.model ? `model ${rendered.model}` : "",
    rendered.effort ? `effort ${rendered.effort}` : "",
  ].filter(Boolean);
  return [
    `RESPAWN (${c.reason}): do NOT SendMessage ${c.agent === "" ? "the old agent" : `\`${c.agent}\``}; spawn a fresh agent (${how.length > 0 ? how.join(", ") : "the step's usual model and effort"}) with this brief:`,
    rendered.brief ?? "",
    `Then \`context_set\` \`${spec.agent}\` to the new agent's id.${rendered.after ? ` ${rendered.after}` : ""}`,
  ].join("\n");
}

/** What the schema cannot check: a `resume:` step needs the workflow's `resume:`, a brief unless it never respawns. */
export function resumeErrors(wf: {
  readonly resume?: Resume;
  readonly states: Readonly<
    Record<
      string,
      | {
          readonly resume?: ResumeStep;
          readonly prompt?: string;
          readonly revisit_prompt?: string;
          readonly full_on_revisit?: boolean;
        }
      | undefined
    >
  >;
}): string[] {
  const errors: string[] = [];
  const stepStates = Object.entries(wf.states).filter(([, s]) => s?.resume !== undefined);
  if (wf.resume === undefined && stepStates.length > 0)
    errors.push(
      `resume: state "${stepStates[0][0]}" declares \`resume:\` but the workflow declares none (its thresholds and agent key)`,
    );
  if (wf.resume !== undefined && stepStates.length === 0)
    errors.push("resume: the workflow declares `resume:` but no state does");
  for (const [name, s] of stepStates) {
    const step = s?.resume;
    if (!s?.prompt?.includes(RESUME_VAR))
      errors.push(`resume: state "${name}" needs \`${RESUME_VAR}\` in its \`prompt\``);
    // a revisit shows only "Revisit #N" unless it carries the text: the new choice would never reach the driver
    if (!s?.revisit_prompt?.includes(RESUME_VAR) && s?.full_on_revisit !== true)
      errors.push(
        `resume: state "${name}" needs \`${RESUME_VAR}\` in its \`revisit_prompt\` (or \`full_on_revisit: true\`): a revisit would not show the engine's choice for that visit`,
      );
    if (step && !step.never_respawn && step.brief === undefined)
      errors.push(`resume: state "${name}" needs a \`brief\` (or \`never_respawn: true\`)`);
    if (step?.never_respawn && step.brief !== undefined)
      errors.push(
        `resume: state "${name}" has a \`brief\` and \`never_respawn: true\`: a step that never respawns needs no brief`,
      );
  }
  return errors;
}
