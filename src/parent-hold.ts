// A parent's HOLD on a blocked task: the answer `hold` carries a condition the engine checks, so the engine, not the
// parent's memory, says when to resume. Pure: the engine reads the session, the queue and runs the command.
import { formatSeconds } from "./stale.js";

/** The context key of a task session that holds the parent's hold. */
export const HOLD_KEY = "parent_hold";
/** The state a hold applies to. */
export const HOLD_STATE = "blocked";
/** Seconds a hold silences the stale / unanswered reminders of its task when it names no deadline. */
export const HOLD_DEADLINE_DEFAULT_S = 3600;
/** The longest deadline a hold may name (seconds): a reminder is never silenced for longer. */
export const HOLD_DEADLINE_MAX_S = 4 * 3600;
/** Milliseconds a held `until_cmd` may run per check. */
export const HOLD_CMD_TIMEOUT_MS = 5000;

export type HoldKind = "until_done" | "until_cmd";

/** What `context.parent_hold` holds. `text` is the condition as the pane and the lines word it. */
export interface ParentHold {
  readonly kind: HoldKind;
  /** The queue id (`until_done`) or the command (`until_cmd`). */
  readonly value: string;
  readonly text: string;
  readonly since: string;
  readonly deadline_s: number;
  /** When the condition-met line was handed to the parent; absent = not yet. */
  readonly met_handed?: string;
}

const HOLD_SYNTAX =
  'a hold takes a condition: "hold until_done: <queue id>" (the line reached done) or "hold until_cmd: <command>" (run in the task\'s repo, exit 0 = met), optionally "hold deadline=<N>m|h until_…" (default 1h, at most 4h)';

/** The condition as a phrase: `ENG-X is done`, `` `cmd` exits 0 ``. */
export function conditionText(kind: HoldKind, value: string): string {
  return kind === "until_done" ? `${value} is done` : `\`${value}\` exits 0`;
}

/** Whether `answer` is the `hold` route: its first word is `hold`. */
export function isHoldAnswer(answer: string): boolean {
  return /^\s*hold(?=\s|$)/i.test(answer);
}

/**
 * The hold a `parent_answer` text records: `hold [deadline=<N>m|h] until_done: <id>` or `... until_cmd: <command>`.
 * A hold with no condition, an unknown condition or a deadline over the cap is an error naming the syntax.
 */
export function parseHold(answer: string, now: Date): { hold: ParentHold } | { error: string } {
  const m =
    /^\s*hold(?:\s+deadline=(\d+)([mh]))?\s+(until_done|until_cmd)\s*:\s*([\s\S]*?)\s*$/i.exec(
      answer,
    );
  if (!m) return { error: `hold refused: ${HOLD_SYNTAX}` };
  const kind = m[3].toLowerCase() as HoldKind;
  const value = m[4];
  if (value === "") return { error: `hold refused: ${kind} names nothing; ${HOLD_SYNTAX}` };
  if (kind === "until_done" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value))
    return { error: `hold refused: until_done takes one queue id, got "${value}"` };
  const deadline =
    m[1] === undefined
      ? HOLD_DEADLINE_DEFAULT_S
      : Number(m[1]) * (m[2].toLowerCase() === "h" ? 3600 : 60);
  if (deadline < 60 || deadline > HOLD_DEADLINE_MAX_S)
    return {
      error: `hold refused: deadline ${formatSeconds(deadline)} is outside 1m..${formatSeconds(HOLD_DEADLINE_MAX_S)}: a reminder is never silenced for longer`,
    };
  return {
    hold: {
      kind,
      value,
      text: conditionText(kind, value),
      since: now.toISOString(),
      deadline_s: deadline,
    },
  };
}

/** The hold a task session's context carries, or undefined when absent or malformed. */
export function holdOf(context: Readonly<Record<string, unknown>>): ParentHold | undefined {
  const h = context[HOLD_KEY] as Partial<ParentHold> | null | undefined;
  if (
    !h ||
    (h.kind !== "until_done" && h.kind !== "until_cmd") ||
    typeof h.value !== "string" ||
    typeof h.since !== "string" ||
    typeof h.deadline_s !== "number" ||
    Number.isNaN(Date.parse(h.since))
  )
    return undefined;
  return {
    kind: h.kind,
    value: h.value,
    text: typeof h.text === "string" ? h.text : conditionText(h.kind, h.value),
    since: h.since,
    deadline_s: h.deadline_s,
    ...(typeof h.met_handed === "string" ? { met_handed: h.met_handed } : {}),
  };
}

/** What a hold means for its task at `now`: silences the reminders, is met (hand it once), or is overdue. */
export type HoldVerdict =
  | { readonly kind: "silent" }
  | { readonly kind: "met"; readonly line: string }
  | { readonly kind: "overdue"; readonly line: string };

/**
 * The verdict of `hold` for task `task` of session `session`: `met` = the condition holds now. A met hold
 * already handed (`handed`) is `undefined`, the reminders are back to their own rules; an unmet one is `silent`
 * until `deadline_s` past `since`, then `overdue`.
 */
export function holdVerdict(
  hold: ParentHold,
  task: string,
  session: string,
  met: boolean,
  handed: boolean,
  now: number,
): HoldVerdict | undefined {
  const head = `NEEDS-PARENT task=${task} session=${session}`;
  if (met)
    return handed
      ? undefined
      : { kind: "met", line: `${head} reason=hold condition met: ${hold.text}` };
  const age = Math.floor((now - Date.parse(hold.since)) / 1000);
  if (age <= hold.deadline_s) return { kind: "silent" };
  return {
    kind: "overdue",
    line: `${head} reason=hold ${formatSeconds(age)}, condition not met: ${hold.text}; still hold?`,
  };
}
