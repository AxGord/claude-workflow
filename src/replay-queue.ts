// The queue of a replay's window, as the engine's own pick sees it (`captureReplayQueue`, run by scripts/export-replay.mjs):
// the same `planPick` / `describeQueue` the dispatcher and the plan pane read, over the queue file rolled back to the
// window's start, cut to ids and enums of the allowlisted projects' lines. The pure half the site plays back is in
// replay.ts (`ReplayQueue`, `snapshotAt`); this half reads the queue module, so it stays out of the browser bundle.
import path from "node:path";
import {
  describeQueue,
  planPick,
  type PickBlock,
  type Queue,
  type QueueLine,
  resolveRepo,
} from "./queue.js";
import { REPLAY_QUEUE_NOTE, type ReplayQueue, type ReplayQueueLine } from "./replay.js";

/**
 * The queue's pending lines at the start of a window, in the order the pick visits them. `ranSince` is the task ids of every
 * session of the kept projects that started at or after the window's start (not only the window's own: a line that ran and
 * landed after the window was pending at its start). The queue is the file as it is now with those lines (and any still running) set back to pending, the
 * window size lifted (the replay's own pipelines bound what runs at once); a line of a project outside `projects` (the
 * basename of its resolved repo) is left out, and a wait on one is the fixed text "manual condition" or "overlaps a line
 * outside the replay". Only ids, difficulty, priority, kind and one of a fixed set of reasons are written: never a line's
 * text, a note or a path. A line added after the window cannot be rebuilt (`REPLAY_QUEUE_NOTE`).
 */
export function captureReplayQueue(
  queue: Queue,
  ranSince: ReadonlySet<string>,
  projects: readonly string[],
): ReplayQueue {
  const rolled: Queue = {
    ...queue,
    batchSize: queue.lines.length + 1,
    lines: queue.lines.map(l =>
      ranSince.has(l.id) || l.status === "running" ? { ...l, status: "pending" } : l,
    ),
  };
  const blocks = new Map<string, PickBlock>();
  const plan = planPick(rolled, { ignoreWindow: true, blocks });
  const why = new Map(plan.reasons.map(r => [r.id, r.why]));
  const admitted = new Set(plan.admitted.map(a => a.id));
  const view = new Map(describeQueue(rolled).lines.map(l => [l.id, l]));
  const allowed = new Set(projects);
  const byId = new Map(rolled.lines.map(l => [l.id, l]));
  const mine = (l: QueueLine): boolean => {
    const repo = resolveRepo(rolled, l);
    return repo !== null && allowed.has(path.basename(repo));
  };
  const holdOf = (id: string): string | undefined => {
    const w = why.get(id) ?? "";
    return w === "parked"
      ? "parked"
      : w.startsWith("parent-run")
        ? "parent-run (model —)"
        : undefined;
  };
  const exported = rolled.lines.filter(
    l =>
      l.status === "pending" &&
      mine(l) &&
      (admitted.has(l.id) || holdOf(l.id) !== undefined || blocks.has(l.id)),
  );
  const listed = new Set(exported.map(l => l.id));
  const waitOn = (id: string): string => {
    const l = byId.get(id);
    return l !== undefined && mine(l) && l.status !== "done"
      ? `${id} (${l.status})`
      : "manual condition";
  };
  const lines: ReplayQueueLine[] = exported
    .sort((a, b) => (view.get(a.id)?.admitOrder ?? 0) - (view.get(b.id)?.admitOrder ?? 0))
    .map(l => {
      const v = view.get(l.id);
      const block = blocks.get(l.id);
      const hold = holdOf(l.id);
      const after = (block?.after ?? []).filter(id => listed.has(id));
      const fixed = [
        ...new Set([
          ...(block?.after ?? []).filter(id => !listed.has(id)).map(waitOn),
          ...(block?.stuck === true ? ["manual condition"] : []),
        ]),
      ];
      const against = block?.against;
      const outside = against !== undefined && !listed.has(against.id);
      const difficulty = /^\d{1,2}$/.test(v?.difficulty ?? "") ? (v?.difficulty as string) : "";
      return {
        id: l.id,
        difficulty,
        priority: v?.priority ?? "",
        kind: v?.kind ?? "feature",
        ...(hold !== undefined || outside
          ? { hold: hold ?? "overlaps a line outside the replay" }
          : {}),
        ...(after.length > 0 ? { after } : {}),
        ...(fixed.length > 0 ? { fixed } : {}),
        ...(against !== undefined && !outside
          ? { against: [against.how, against.id] as const }
          : {}),
      };
    });
  return { note: REPLAY_QUEUE_NOTE, lines };
}
