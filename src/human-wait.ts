// A human wait state (`human:`): the task stops for its owner's answer without holding a window slot. The engine
// records the wait on the session (`human_wait`) and on its queue line (`awaiting`, `human_wait:`); the answer comes
// from the main conversation (`answer`) or the dashboard and is held on both until the pick resumes the line, ahead of
// every pending one, and a fresh driver takes the answer's route. Shared by the engine, the tool and the dashboard.
import { spawnSync } from "node:child_process";
import { markAnswered, QueueError } from "./queue.js";
import type { Storage } from "./storage.js";
import { dispatcherHolds } from "./takeover.js";
import type { HumanAnswer, HumanHold, HumanWait, SessionState } from "./types.js";
import { HUMAN_ANSWER_KEY } from "./types.js";
import { dispatcherSessionsOf } from "./window-nudge.js";

/** How long a hold's `stop` command may run when its session ends. */
export const HUMAN_STOP_TIMEOUT_MS = 30_000;

/** The longest answer text kept: the owner's words go to the worker whole, but a session file is no document store. */
export const HUMAN_ANSWER_MAX = 20_000;

/** HEAD of the repo at `cwd`, or undefined outside git. */
export function repoHead(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const sha = r.status === 0 ? r.stdout.trim() : "";
  return /^[0-9a-f]{7,64}$/.test(sha) ? sha : undefined;
}

/** The wait `session` stands at now: its record when the active frame is still at the recorded state. */
export function liveHumanWait(session: SessionState): HumanWait | undefined {
  const w = session.human_wait;
  if (w === undefined || session.stack.length === 0) return undefined;
  const f = session.stack[session.active_frame];
  return w.frame === session.active_frame && f?.current_state === w.state ? w : undefined;
}

/** A line of the show list: a value of several lines is one entry per line, blank ones dropped. */
export function showEntries(rendered: readonly string[]): string[] {
  return rendered
    .flatMap(v => v.split("\n"))
    .map(v => v.trim())
    .filter(v => v !== "");
}

/**
 * The block `status` / `transition` append at a human wait: the question, what to show, the answers; then either
 * what the driver does while no answer stands (hand back one AWAITING line and stop) or the answer to take.
 */
export function humanWaitBlock(
  session: SessionState,
  wait: HumanWait,
  answerKey: string,
  movedTo?: string,
): string {
  const task = typeof session.context.task === "string" ? session.context.task : undefined;
  const id = session.session_id;
  const lines = [
    `HUMAN WAIT${task ? ` task=${task}` : ""} session=${id} since ${wait.since}: ${wait.question}`,
    ...wait.show.map(s => `  show: ${s}`),
    `  answers: ${wait.routes.join(" | ")}`,
  ];
  const a = wait.answer;
  if (a === undefined) {
    lines.push(
      task
        ? `No answer yet. The queue line is \`awaiting\`: its window slot is free. A driver: end with ONE line \`AWAITING task=${task} session=${id} question=${firstLine(wait.question)}\` and stop; the dispatcher resumes the task on a fresh driver once the answer is recorded. Without a dispatcher: ask the user, then \`answer({session_id: "${id}", route, text})\`.`
        : `No answer yet: ask the user, then \`answer({session_id: "${id}", route, text})\`; the move out of this state is refused until then.`,
    );
    return lines.join("\n");
  }
  lines.push(
    `HUMAN-ANSWER route=${a.route} at=${a.at} by=${a.by}: ${a.text === "" ? "(no text)" : a.text}`,
  );
  lines.push(
    `→ transition \`${a.route}\` now (session ${id}), no \`set\`: the engine writes the answer's text into context \`${answerKey}\`.` +
      (movedTo !== undefined
        ? ` The repo's HEAD moved during the wait: the move enters \`${movedTo}\` (the rebase route) first.`
        : ""),
  );
  return lines.join("\n");
}

const firstLine = (s: string): string => {
  const l = s.trim().split("\n")[0] ?? "";
  return l.length > 120 ? `${l.slice(0, 119)}…` : l;
};

/** The context key a wait state writes its answer's text to. */
export const answerKeyOf = (spec: { readonly answer_key?: string } | undefined): string =>
  spec?.answer_key ?? HUMAN_ANSWER_KEY;

/** What `recordHumanAnswer` answers: the stored session and the note for the caller (who resumes it, and how). */
export interface RecordedAnswer {
  readonly session: SessionState;
  readonly note: string;
}

/**
 * The owner's answer to the human wait session `sessionId` stands at: written on the session (the move out takes
 * it) and on its queue line (`answered:`, so the pick resumes the line first). A second answer before the resume
 * replaces the first. Refused when the session is at no wait, or `route` is not one of its answers.
 */
export async function recordHumanAnswer(
  storage: Pick<Storage, "read" | "update" | "readAll">,
  sessionId: string,
  route: string,
  text: string,
  by: string,
): Promise<RecordedAnswer> {
  if (text.length > HUMAN_ANSWER_MAX)
    throw new Error(
      `the answer is ${text.length} characters, more than ${HUMAN_ANSWER_MAX}: put it in a file and name the file`,
    );
  const at = new Date().toISOString();
  const answer: HumanAnswer = { route, text, at, by };
  let refusal: string | undefined;
  const stored = await storage.update(sessionId, cur => {
    refusal = undefined;
    if (cur === null) {
      refusal = `Session "${sessionId}" not found`;
      return null;
    }
    const wait = liveHumanWait(cur);
    if (wait === undefined) {
      refusal = `Session "${sessionId}" waits for no human answer (it stands at ${cur.stack[cur.active_frame]?.current_state ?? "its end"})`;
      return null;
    }
    if (!wait.routes.includes(route)) {
      refusal = `"${route}" is not an answer of ${wait.state}: one of ${wait.routes.join(", ")}`;
      return null;
    }
    return {
      ...cur,
      human_wait: { ...wait, answer },
      updated_at: at,
      history: [
        ...cur.history,
        { frame: cur.active_frame, event: "human_answer", at, actor: by, detail: route },
      ],
    };
  });
  if (stored === null) throw new Error(refusal ?? `Session "${sessionId}" not found`);
  const file = stored.context.queue_file;
  const task = stored.context.task;
  if (typeof file !== "string" || typeof task !== "string")
    return {
      session: stored,
      note: `Answer ${route} recorded on ${sessionId}: take it with transition \`${route}\` on that session (its driver: SendMessage it to continue from status).`,
    };
  try {
    await markAnswered(file, task, sessionId, route, at);
  } catch (err) {
    const why = err instanceof QueueError ? err.message : String(err);
    return {
      session: stored,
      note: `Answer ${route} recorded on ${sessionId}, but its queue line was not marked answered (${why}): take it with transition \`${route}\` on that session.`,
    };
  }
  const wake = answerNudge(storage.readAll(), file);
  return {
    session: stored,
    note:
      `Answer ${route} recorded on ${sessionId} (task ${task}): the line resumes on the next free slot, before any pending line.` +
      (wake.length > 0 ? `\n${wake.join("\n")}` : ""),
  };
}

/** For each live dispatcher of the queue: the one call that makes it pick now, so a free slot takes the answered line. */
export function answerNudge(sessions: readonly SessionState[], file: string): string[] {
  return dispatcherSessionsOf(sessions, file).map(s => {
    const at = s.stack[s.active_frame].current_state;
    const call =
      dispatcherHolds(s) && s.agent_id !== undefined
        ? `SendMessage({ to: "${s.agent_id}", message: "answered" })`
        : `transition({ session_id: "${s.session_id}", transition: "refill" })`;
    const when = at === "collect" ? "" : ` once it stands at collect (it is at ${at} now)`;
    return `note: dispatcher session ${s.session_id} holds this queue and picks only on a land or a refill: ${call}${when}.`;
  });
}

/** Runs each hold's `stop` command once, in its cwd; never throws (a session ends whatever its holds do). */
export function stopHumanHolds(holds: readonly HumanHold[] | undefined): string[] {
  const out: string[] = [];
  for (const h of holds ?? []) {
    const r = spawnSync("sh", ["-c", h.command], {
      cwd: h.cwd,
      encoding: "utf8",
      timeout: HUMAN_STOP_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    out.push(`${h.state}: stop exited ${r.status ?? r.signal ?? "?"}`);
  }
  return out;
}
