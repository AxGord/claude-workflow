// What the other scenes of the site's use-case page draw (docs/use-case-anyparse.md): a queue line's fields and who
// reads them, the project's difficulty anchors, a small queue with the pick over it, the lane of review rounds, and
// where a lesson goes. Free of any import, so the page runs it in the browser. Two of these answer what the engine
// answers elsewhere, and a test holds each equal to the engine's: `toyPick` to `planPick` (src/queue.ts) over every
// state the scene can reach, `LINE_FIELDS` to the queue's own task keys.
import type { PathFacts, StageRow } from "./use-case-path.js";
import { stageRow } from "./use-case-path.js";

// ---- a line enters the queue

/** The parts of the pipeline that read a queue line, in the order a line meets them. */
export const READERS = ["pick", "table", "recon", "worker", "review", "land"] as const;
export type Reader = (typeof READERS)[number];
export const READER_NAMES: Readonly<Record<Reader, string>> = {
  pick: "the pick",
  table: "the model table",
  recon: "the recon",
  worker: "the worker",
  review: "the review",
  land: "the land",
};

export interface LineField {
  /** The task key, as the queue file writes it. */
  readonly key: string;
  readonly readers: readonly Reader[];
  readonly says: string;
}

/** The fields of a queue line the page shows, in the queue's own key order. */
export const LINE_FIELDS: readonly LineField[] = [
  {
    key: "id",
    readers: ["pick", "worker", "land"],
    says: "The line's name everywhere: its worktree and branch, the trailer of the commit that lands it, its row in the ledger.",
  },
  {
    key: "status",
    readers: ["pick"],
    says: "pending, running, done or failed. The pick sets running, the land sets done. A backlog line is never picked until someone promotes it.",
  },
  {
    key: "difficulty",
    readers: ["table", "recon"],
    says: "1 to 10, scored by the project's anchors. The model table turns it into every stage's model and effort, and from the recon's threshold a scout reads the line first. A pending line without it is refused.",
  },
  {
    key: "kind",
    readers: ["pick", "worker"],
    says: "bug, feature or research. A bug is reproduced before anyone fixes it; research ends in a report, not a commit.",
  },
  {
    key: "priority",
    readers: ["pick"],
    says: "urgent, high, normal or low: the order the pick walks the queue in, file order within one priority.",
  },
  {
    key: "after",
    readers: ["pick"],
    says: "The lines that must be done first. Until they are, the pick passes this one by.",
  },
  {
    key: "touches",
    readers: ["pick", "recon"],
    says: "The files the line will edit. Two lines that name the same file never run at once, so their branches cannot collide; the recon checks that each path exists.",
  },
  {
    key: "owner",
    readers: ["pick", "recon", "worker"],
    says: "The component that already answers the line's question. Lines with one owner do not run together, and the worker extends that owner instead of writing a second one.",
  },
  {
    key: "exclusive",
    readers: ["pick"],
    says: "The line runs alone in its repository: a whole-tree reformat, a mass rename. It starts when nothing else of that repository runs. By the engine's default the lines behind it are held back while it waits, so that moment comes; a key of the queue's header turns the hold off.",
  },
  {
    key: "text",
    readers: ["recon", "worker", "review"],
    says: "The brief, self-contained: the worker reads this line and no other. The recon checks its premises, the reviewer judges the change against it.",
  },
];

export interface Anchor {
  readonly from: number;
  readonly to: number;
  readonly says: string;
  /** Which example line stands for it. */
  readonly example: number;
}

/** The project's difficulty anchors, shortened: score the work, take the highest that applies. */
export const ANCHORS: readonly Anchor[] = [
  { from: 2, to: 2, says: "one function and its test; the owner is named and exists", example: 0 },
  { from: 3, to: 3, says: "one file, or a small change at one known owner", example: 0 },
  {
    from: 4,
    to: 4,
    says: "a few files around one known owner; a flag following an existing pattern",
    example: 1,
  },
  { from: 5, to: 5, says: "a new lint rule or command on existing components", example: 1 },
  {
    from: 6,
    to: 6,
    says: "a new shared component or config key; a change several callers move onto",
    example: 1,
  },
  {
    from: 7,
    to: 7,
    says: "writer layout or macro lowering with blast across the corpus; a cause not yet known",
    example: 2,
  },
  {
    from: 8,
    to: 8,
    says: "several owners change together; a contract moves across packages",
    example: 2,
  },
  {
    from: 9,
    to: 10,
    says: "a whole-tree sweep or a redesign: cut into lines, never run as one",
    example: 3,
  },
];

export interface ExampleLine {
  readonly id: string;
  readonly kind: string;
  readonly priority: string;
  readonly after?: readonly string[];
  readonly touches: readonly string[];
  readonly owner?: string;
  readonly exclusive?: boolean;
  readonly text: string;
}

/** Example lines in the queue's shape (the names are made up; the fields are the engine's). */
export const EXAMPLE_LINES: readonly ExampleLine[] = [
  {
    id: "LINT-MESSAGE-NAMES-RULE",
    kind: "bug",
    priority: "normal",
    touches: ["src/check/Report.hx"],
    owner: "check.Report",
    text: "A lint finding's message does not name its rule. Print the rule's id after the message; one test pins it.",
  },
  {
    id: "LINT-UNUSED-LOCAL",
    kind: "feature",
    priority: "low",
    touches: ["src/check/rules/UnusedLocal.hx (new)", "test/check/rules/UnusedLocalTest.hx (new)"],
    owner: "check.rules",
    text: "A new lint rule: a local that is written and never read. Reuse the scope walker; no autofix yet.",
  },
  {
    id: "WRITER-CHAIN-BREAK",
    kind: "bug",
    priority: "high",
    after: ["WRITER-WRAP-RULES"],
    touches: ["src/format/wrap/Chain.hx", "src/macro/Lower.hx"],
    owner: "format.wrap",
    text: "A method chain breaks after its first call instead of before it. The cause is not known: reproduce it on the corpus first.",
  },
  {
    id: "FMT-TRAILING-COMMA-FLIP",
    kind: "feature",
    priority: "normal",
    touches: ["src", "test"],
    exclusive: true,
    text: "Flip the trailing-comma default and reformat the whole tree. Too big to run as one line: the plan cuts it by behaviour, each piece landing green alone.",
  },
];

// ---- the pick

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface ToyLine {
  readonly id: string;
  readonly status: "pending" | "running" | "done" | "backlog";
  readonly priority: Priority;
  readonly difficulty: number;
  readonly touches: readonly string[];
  readonly after?: readonly string[];
  readonly exclusive?: boolean;
}

/** The small queue the scene starts from, in file order. */
export const TOY_QUEUE: readonly ToyLine[] = [
  {
    id: "LINT-UNUSED-LOCAL",
    status: "pending",
    priority: "normal",
    difficulty: 5,
    touches: ["src/check/UnusedLocal.hx"],
  },
  {
    id: "LINT-UNUSED-LOCAL-FIX",
    status: "pending",
    priority: "normal",
    difficulty: 4,
    touches: ["src/check/UnusedLocal.hx"],
    after: ["LINT-UNUSED-LOCAL"],
  },
  {
    id: "WRITER-CHAIN-TESTS",
    status: "pending",
    priority: "normal",
    difficulty: 3,
    touches: ["src/format/Chain.hx", "test/format/ChainTest.hx"],
  },
  {
    id: "WRITER-CHAIN-BREAK",
    status: "pending",
    priority: "high",
    difficulty: 7,
    touches: ["src/format/Chain.hx"],
  },
  {
    id: "CLI-HELP-FLAG",
    status: "pending",
    priority: "normal",
    difficulty: 2,
    touches: ["src/cli/Help.hx"],
  },
  {
    id: "FMT-SWEEP",
    status: "pending",
    priority: "normal",
    difficulty: 6,
    touches: ["src", "test"],
    exclusive: true,
  },
  {
    id: "DOC-GUIDE-PAGE",
    status: "pending",
    priority: "low",
    difficulty: 2,
    touches: ["docs/guide/lint.md"],
  },
  {
    id: "IDEA-PARSE-CACHE",
    status: "backlog",
    priority: "low",
    difficulty: 6,
    touches: ["src/runtime/Cache.hx"],
  },
];

/** The window sizes the scene offers. */
export const TOY_WINDOWS = [1, 2, 3, 4, 5] as const;

export interface ToyPick {
  /** The lines the pick admits, in the order it admits them. */
  readonly admitted: readonly string[];
  /** Why each other pending line waits, in the pick's own words. */
  readonly reasons: Readonly<Record<string, string>>;
}

/** Under the queue's `overlap: files` only an entry naming a file conflicts: here, one whose last segment holds a dot. */
const isFile = (entry: string): boolean => (entry.split("/").at(-1) ?? "").includes(".");
const pathOverlap = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

function conflict(a: ToyLine, b: ToyLine): string | null {
  if (a.exclusive) return `exclusive ${a.id}`;
  if (b.exclusive) return `exclusive ${b.id}`;
  for (const x of a.touches.filter(isFile))
    for (const y of b.touches.filter(isFile)) if (pathOverlap(x, y)) return `touches ${x} ~ ${y}`;
  return null;
}

/**
 * One pick over the small queue: the window minus the running lines is filled in priority order, then file order,
 * with the pending lines whose `after:` is done and that overlap no running or just-admitted line. With `hold`
 * (the engine's default; the queue header's `exclusive_hold: no` turns it off) a pending exclusive line that only
 * running lines keep out holds every line behind it. `ignoreWindow` asks what else keeps a line out once the
 * window is left aside (the engine's `explain`). The engine's pick is `planPick` (src/queue.ts); this is its
 * answer for a queue of one repository, and a test holds the two equal with the hold on and off.
 */
export function toyPick(
  lines: readonly ToyLine[],
  window: number,
  opts: { readonly hold: boolean; readonly ignoreWindow?: boolean },
): ToyPick {
  const byId = new Map(lines.map(l => [l.id, l]));
  const taken = lines.filter(l => l.status === "running");
  const free = window - taken.length;
  const admitted: string[] = [];
  const reasons: Record<string, string> = {};
  let hold: string | undefined;
  const order = lines
    .map((line, index) => ({ line, index }))
    .sort(
      (a, b) =>
        PRIORITIES.indexOf(a.line.priority) - PRIORITIES.indexOf(b.line.priority) ||
        a.index - b.index,
    );
  for (const { line } of order) {
    if (line.status !== "pending") continue;
    if (opts.ignoreWindow !== true && free <= admitted.length) {
      reasons[line.id] = "window full";
      continue;
    }
    const waits = (line.after ?? [])
      .map(id => byId.get(id))
      .filter((dep): dep is ToyLine => dep !== undefined && dep.status !== "done");
    if (waits.length > 0) {
      reasons[line.id] = `after: ${waits.map(dep => `${dep.id} (${dep.status})`).join(", ")}`;
      continue;
    }
    if (hold !== undefined) {
      reasons[line.id] = `held for exclusive ${hold}`;
      continue;
    }
    let why: string | null = null;
    for (const other of taken) {
      const c = conflict(line, other);
      if (c === null) continue;
      why = `overlaps ${other.id} (${c})`;
      break;
    }
    if (why === null) {
      admitted.push(line.id);
      taken.push(line);
    } else {
      reasons[line.id] = why;
      if (line.exclusive && opts.hold) hold ??= line.id;
    }
  }
  return { admitted, reasons };
}

export interface ToyState {
  readonly lines: readonly ToyLine[];
  readonly window: number;
  /** Whether a waiting exclusive line holds the lines behind it: the queue header's `exclusive_hold`. */
  readonly hold: boolean;
  /** Why each pending line waits now: what keeps it out whatever the window, else `window full`. */
  readonly reasons: Readonly<Record<string, string>>;
  /** The lines the last pick admitted. */
  readonly admitted: readonly string[];
}

/** A pick applied: the admitted lines run, and every line still pending says why it waits now. */
function picked(lines: readonly ToyLine[], window: number, hold: boolean): ToyState {
  const pick = toyPick(lines, window, { hold });
  const next = lines.map(l =>
    pick.admitted.includes(l.id) ? { ...l, status: "running" as const } : l,
  );
  const why = toyPick(next, window, { hold, ignoreWindow: true }).reasons;
  return {
    lines: next,
    window,
    hold,
    reasons: Object.fromEntries(
      next.filter(l => l.status === "pending").map(l => [l.id, why[l.id] ?? "window full"]),
    ),
    admitted: pick.admitted,
  };
}

/** The scene's first state: the dispatcher's first pick over the queue. */
export const toyStart = (window: number, hold: boolean): ToyState =>
  picked(TOY_QUEUE, window, hold);

/** A running line lands (its slot frees and the pick runs again), or the window changes (the pick runs again). */
export function toyStep(
  state: ToyState,
  action: { readonly land: string } | { readonly window: number } | { readonly promote: string },
): ToyState {
  if ("window" in action) return picked(state.lines, action.window, state.hold);
  if ("promote" in action)
    return picked(
      state.lines.map(l =>
        l.id === action.promote && l.status === "backlog" ? { ...l, status: "pending" } : l,
      ),
      state.window,
      state.hold,
    );
  return picked(
    state.lines.map(l =>
      l.id === action.land && l.status === "running" ? { ...l, status: "done" } : l,
    ),
    state.window,
    state.hold,
  );
}

// ---- worker, gate, review rounds, land

export interface LaneStep {
  readonly id: "work" | "gate" | "gate-fix" | "commit" | "review" | "fix" | "land" | "reject";
  readonly name: string;
  readonly actor: "agent" | "script" | "parent";
  /** The model-table stage of an agent step, with its row. */
  readonly stage?: string;
  readonly model?: string;
  readonly effort?: string;
  /** A review's verdict. */
  readonly verdict?: "MERGE" | "FIXES";
  readonly says: string;
}

export interface RoundsLane {
  /** One row per round: the first is the worker's own, each later one a fix round, the last the land or the reject. */
  readonly rows: readonly (readonly LaneStep[])[];
  /** Entries into the review: what the ledger counts as the line's review rounds. */
  readonly reviews: number;
  readonly outcome: "landed" | "rejected";
}

/** The most FIXES verdicts the scene offers: one more than the pipeline's fix rounds, the one that rejects. */
export const maxFixes = (facts: { readonly fix_rounds: number }): number => facts.fix_rounds + 1;

/**
 * The lane of one line from its code to main: the worker's gate (with its own fix loop when `gateFail`), the review,
 * `fixes` FIXES verdicts each answered by a fix round, then the land; a FIXES verdict past the pipeline's fix rounds
 * rejects the line instead.
 */
export function roundsLane(
  facts: PathFacts & {
    readonly fix_rounds: number;
    readonly gate_fix_rounds: number;
    readonly land_lock: string;
  },
  input: { readonly difficulty: number; readonly fixes: number; readonly gateFail: boolean },
): RoundsLane {
  const fixes = Math.min(Math.max(0, input.fixes), maxFixes(facts));
  const row = (stage: string): StageRow =>
    stageRow(facts.table, stage, input.difficulty) ?? { model: "-", effort: "-" };
  const executor = facts.executor_scores.includes(input.difficulty);
  const gate: LaneStep = {
    id: "gate",
    name: "gate",
    actor: "script",
    says: "The engine runs the project's gate on the committed tree, through the thread pool: the suite, the lints, the checks the change selects. One table, green or red.",
  };
  const commit: LaneStep = {
    id: "commit",
    name: "commit",
    actor: "script",
    says: "The engine formats, applies the safe autofixes and makes the line's one commit, amending it on a later round: what the gate judges next is that commit. The message is the agent's.",
  };
  const review = (n: number, verdict: "MERGE" | "FIXES"): LaneStep => ({
    id: "review",
    name: n === 1 ? "review" : `review ${n}`,
    actor: "agent",
    stage: n === 1 ? "review" : "review_verify",
    ...row(n === 1 ? "review" : "review_verify"),
    verdict,
    says:
      n === 1
        ? "A fresh reviewer, read-only, reads the diff and the worker's report against the line's brief and returns MERGE, FIXES or REJECT."
        : "The same reviewer re-checks its own fix list against the fix's diff only, not the whole change again.",
  });
  const first: LaneStep[] = [
    {
      id: "work",
      name: "code",
      actor: "agent",
      stage: executor ? "execute" : "plan",
      ...row(executor ? "execute" : "plan"),
      says: "The worker writes the change and its tests in the line's own worktree.",
    },
    commit,
    gate,
  ];
  if (input.gateFail)
    first.push(
      {
        id: "gate-fix",
        name: "fix",
        actor: "agent",
        stage: executor ? "execute" : "plan",
        ...row(executor ? "execute" : "plan"),
        says: `A red gate goes back to the worker with the failed row: its own loop, up to ${facts.gate_fix_rounds} times, with no reviewer and no review round.`,
      },
      commit,
      gate,
    );
  first.push(review(1, fixes === 0 ? "MERGE" : "FIXES"));
  const rows: LaneStep[][] = [first];
  const rounds = Math.min(fixes, facts.fix_rounds);
  for (let k = 1; k <= rounds; k++)
    rows.push([
      {
        id: "fix",
        name: `fix round ${k}`,
        actor: "agent",
        stage: "fix",
        ...row("fix"),
        says: "The reviewer's fix list goes to the worker that wrote the change; its fix amends the same commit.",
      },
      commit,
      gate,
      review(k + 1, k < fixes ? "FIXES" : "MERGE"),
    ]);
  const rejected = fixes > facts.fix_rounds;
  rows.push([
    rejected
      ? {
          id: "reject",
          name: "rejected",
          actor: "parent",
          says: `A FIXES verdict after ${facts.fix_rounds} fix rounds rejects the line: it is marked failed, its worktree is kept, and the parent decides what to queue instead.`,
        }
      : {
          id: "land",
          name: "land",
          actor: "script",
          says: `One land at a time, machine-wide, under the lock ${facts.land_lock}: the branch is merged into a candidate tree, rebuilt and judged by the full battery. Main moves only on green; then the queue line is marked done.`,
        },
  ]);
  return { rows, reviews: rounds + 1, outcome: rejected ? "rejected" : "landed" };
}

// ---- lessons become new queue lines

export const LESSON_PLACES = ["high", "normal", "low", "backlog", "tool", "none"] as const;
export type LessonPlace = (typeof LESSON_PLACES)[number];
export const LESSON_PLACE_NAMES: Readonly<Record<LessonPlace, string>> = {
  high: "queue · high",
  normal: "queue · normal",
  low: "queue · low",
  backlog: "backlog",
  tool: "queue · a check",
  none: "nothing",
};

export interface Lesson {
  /** What a landed line left behind: an open item of its worker or a non-blocking note of its reviewer. */
  readonly says: string;
  readonly from: "worker" | "reviewer";
  readonly to: LessonPlace;
  /** The rule that sends it there. */
  readonly rule: string;
}

/** Example rows of what a landed line leaves behind, one for each place the project's rule sends a lesson to. */
export const LESSONS: readonly Lesson[] = [
  {
    says: "Three rules each walk a call chain their own way. One walker would serve all of them.",
    from: "reviewer",
    to: "high",
    rule: "An enabler: it makes many later lines cheaper (one owner instead of copies). Enablers go first.",
  },
  {
    says: "The writer dropped a comment after a closing brace. Reproduced on the project's own tree.",
    from: "worker",
    to: "normal",
    rule: "A defect reproduced on a real tree, or a loss (wrong code, a dropped comment): normal priority.",
  },
  {
    says: "The new rule's message could name the variable it complains about.",
    from: "reviewer",
    to: "low",
    rule: "Everything else is low: the default for a review lesson.",
  },
  {
    says: "The fix may mishandle nested generics. Nobody ran it.",
    from: "reviewer",
    to: "backlog",
    rule: "Not reproduced on a real tree, not a loss, not the user's call: it waits in the backlog with its one-line repro, and is never picked until promoted.",
  },
  {
    says: "A narrow lint run missed a cross-file finding; the gate must lint the whole scope.",
    from: "worker",
    to: "tool",
    rule: "A check a tool or gate can hold is never a note for the next worker to remember: it becomes a queue line against the tool's owner.",
  },
  {
    says: "The test names read well.",
    from: "reviewer",
    to: "none",
    rule: "Nothing to do. Most rows end here, and saying so is part of the rule.",
  },
];
