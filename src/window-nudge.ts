// A raised window admits nothing by itself: a dispatcher at `collect` moves only on a land's
// `slot_free` or main's `refill`, and one at `paused` only on `retry`. `queue_header` and
// `wf-queue --batch-size` therefore name the live dispatcher session that holds the queue and the
// one call that makes it pick. A hand edit of the queue file is never seen.
import path from "node:path";
import type { HeaderResult } from "./queue.js";
import { dispatcherHolds, where } from "./takeover.js";
import type { SessionState } from "./types.js";

/**
 * The active dispatcher sessions of the queue `file`: a root session (no parent, not suspended) whose
 * context names that queue and a `task_workflow` (what the bundled `plan_queue` and a project heir's
 * set), and no `task` (a task session carries the queue file too).
 */
export function dispatcherSessionsOf(
  sessions: readonly SessionState[],
  file: string,
): SessionState[] {
  const want = path.resolve(file);
  return sessions.filter(s => {
    const queue = s.context?.queue_file;
    return (
      s.stack?.length > 0 &&
      s.suspended_at === undefined &&
      s.parent_session_id === undefined &&
      typeof queue === "string" &&
      queue !== "" &&
      path.resolve(queue) === want &&
      typeof s.context?.task_workflow === "string" &&
      s.context?.task_workflow !== "" &&
      s.context?.task === undefined
    );
  });
}

/**
 * The lines to add to a window change's answer: for each live dispatcher session of the queue, its state and
 * the exact call that makes it use the grown window. Empty when the window did not grow, or no session
 * holds the queue. `admitNow` = the lines a pick would admit now (a dispatcher at `collect` is told only when
 * it is above zero; one at `paused` always, since `retry` is its only way out of the pause).
 */
export function windowNudge(
  sessions: readonly SessionState[],
  file: string,
  r: Pick<HeaderResult, "from" | "to">,
  admitNow: number,
): string[] {
  if (r.to <= r.from) return [];
  const out: string[] = [];
  for (const s of dispatcherSessionsOf(sessions, file)) {
    const at = s.stack[s.active_frame].current_state;
    const id = s.session_id;
    const agent = dispatcherHolds(s) ? s.agent_id : undefined;
    const send = (message: string, transition: string): string =>
      agent !== undefined
        ? `SendMessage({ to: "${agent}", message: "${message}" })`
        : `transition({ session_id: "${id}", transition: "${transition}" })`;
    const head = `note: batch_size ${r.from} → ${r.to}; dispatcher session ${id} (${where(s)}) holds this queue`;
    if (at === "paused") {
      out.push(
        `${head} and leaves the pause only on \`retry\`: ${send("retry", "retry")} (the pick then admits ${admitNow} line(s)).`,
      );
    } else if (admitNow > 0 && (at === "collect" || at === "dispatch" || at === "pick")) {
      const when = at === "collect" ? "" : `, once it stands at collect (it is at ${at} now)`;
      out.push(
        `${head} and picks only on a land; a pick would admit ${admitNow} line(s) now${when}: ${send("lines added", "refill")} (\`refill\` at collect).`,
      );
    }
  }
  return out;
}
