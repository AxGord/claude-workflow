// The path one queue line takes through anyparse's slice pipeline, as the site's use-case page draws it
// (docs/use-case-anyparse.md, docs/.vitepress/theme/UseCaseFlow.vue). Pure and free of any import, so the page
// runs it in the browser: the reader picks what the line says (its difficulty) and what the code turns out to be
// (the score a recon or the plan stage gives it, and whether the line's premise holds), `slicePath` answers which
// steps run, on which model and effort, and where the line ends. The thresholds and the rows are not typed here:
// they are `PathFacts`, read from the project's own workflow files by src/use-case.ts (`workflowFacts`).

/** One stage's model and effort. */
export interface StageRow {
  readonly model: string;
  readonly effort: string;
}

/** A row of a stage in the model table: the model and effort of every difficulty up to `upto`. */
export interface TableRow extends StageRow {
  readonly upto: number;
}

/** The project's `model_table.stages`, as its workflow file writes it. */
export type StageTable = Readonly<Record<string, readonly TableRow[]>>;

/**
 * A stage's row at a difficulty: the first row whose `upto` reaches it, else the last. The engine's own lookup is
 * `chooseStages` (src/model-table.ts); this is the same answer without its imports, and a test holds the two equal.
 */
export function stageRow(
  table: StageTable,
  stage: string,
  difficulty: number,
): StageRow | undefined {
  const rows = table[stage];
  if (!rows || rows.length === 0) return undefined;
  const { model, effort } = rows.find(r => difficulty <= r.upto) ?? rows[rows.length - 1];
  return { model, effort };
}

/** What the project's workflow files say about the path (the snapshot's `workflow`). */
export interface PathFacts {
  /** The pipeline's model table: difficulty to model and effort, per stage. */
  readonly table: StageTable;
  /** The agent that drives the task's session. */
  readonly driver: StageRow;
  /** The lowest difficulty a read-only recon reads before any worker. */
  readonly recon_from: number;
  /** The scores a separate executor runs: after a recon they need no plan stage, after a plan they are handed off. */
  readonly executor_scores: readonly number[];
  /** The lowest score that splits the line into smaller ones instead of running it. */
  readonly split_from: number;
}

export interface PathInput {
  /** The queue line's difficulty, 1..10. */
  readonly line: number;
  /** The score the code gets from whoever reads it first, 1..10. */
  readonly seen: number;
  /** False when a premise of the line does not hold. */
  readonly premise: boolean;
}

export type PathNode =
  | "claim"
  | "prepare"
  | "route"
  | "recon"
  | "verdict"
  | "plan"
  | "execute"
  | "closed"
  | "split"
  | "next";

export interface PathStep {
  readonly node: PathNode;
  /** Who acts: the driver, an engine script (no model), a stage's agent, or the parent conversation. */
  readonly actor: "driver" | "script" | "agent" | "parent";
  /** The model-table stage of an agent step. */
  readonly stage?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly text: string;
}

export interface SlicePath {
  /** Whether a recon reads the line before any worker. */
  readonly recon: boolean;
  /** Who gives the code its score: the recon when it runs, else the plan stage. */
  readonly scoredBy: "recon" | "plan";
  /** The difficulty the stages after the score run on (the line's own when nothing rewrote it). */
  readonly difficulty: number;
  /** How the stages' difficulty moved against the line's. */
  readonly rescored: "up" | "down" | "kept";
  /** The plan stage: run, skipped (a recon score that is the plan), or never reached. */
  readonly plan: "run" | "skipped" | "unreached";
  /** Who writes the code: the plan stage's own agent, a separate executor, or nobody. */
  readonly execute: "plan-agent" | "executor" | "unreached";
  readonly outcome: "review" | "split" | "closed";
  /** Who stopped a line that did not reach the review. */
  readonly stoppedBy?: "recon" | "plan";
  readonly steps: readonly PathStep[];
}

const clamp = (n: number): number => Math.min(10, Math.max(1, Math.round(n)));

/** The steps one line takes from its claim to the review, a split or a close. */
export function slicePath(facts: PathFacts, input: PathInput): SlicePath {
  const line = clamp(input.line);
  const seen = clamp(input.seen);
  const agent = (node: PathNode, stage: string, d: number, text: string): PathStep => ({
    node,
    actor: "agent",
    stage,
    ...(stageRow(facts.table, stage, d) ?? { model: "-", effort: "-" }),
    text,
  });
  const executor = facts.executor_scores.includes(seen);
  const scores = facts.executor_scores.join(" or ");
  const recon = line >= facts.recon_from;
  const steps: PathStep[] = [
    {
      node: "claim",
      actor: "driver",
      ...facts.driver,
      text: `A driver claims the line. Difficulty ${line} sets every stage's model and effort from the model table.`,
    },
    {
      node: "prepare",
      actor: "script",
      text: "The engine makes a worktree and a branch off main. No agent, no tokens.",
    },
  ];
  const closed = (by: "recon" | "plan"): SlicePath => {
    steps.push({
      node: "closed",
      actor: "parent",
      text:
        by === "recon"
          ? "A premise of the line does not hold: the work is already on main, the target is gone, or the claim it stands on is false. The parent closes the line. No worker ran."
          : "The plan stage finds that a premise of the line does not hold and stops before any code. The parent closes the line.",
    });
    return {
      recon,
      scoredBy: by,
      difficulty: line,
      rescored: "kept",
      plan: by === "plan" ? "run" : "unreached",
      execute: "unreached",
      outcome: "closed",
      stoppedBy: by,
      steps,
    };
  };
  const split = (by: "recon" | "plan"): SlicePath => {
    steps.push({
      node: "split",
      actor: "parent",
      text:
        by === "recon"
          ? `The recon scores ${seen}: too big for one line. It proposes the smaller lines, the parent queues them and this line closes. No worker ran.`
          : `The plan stage scores ${seen}: too big for one line. Its plan is the list of smaller lines, the parent queues them and this line closes. No code was written.`,
    });
    return {
      recon,
      scoredBy: by,
      difficulty: line,
      rescored: "kept",
      plan: by === "plan" ? "run" : "unreached",
      execute: "unreached",
      outcome: "split",
      stoppedBy: by,
      steps,
    };
  };
  const next: PathStep = {
    node: "next",
    actor: "script",
    text: "The gate, the review and the land follow.",
  };

  if (recon) {
    steps.push(
      {
        node: "route",
        actor: "script",
        text: `Difficulty ${line} is ${facts.recon_from} or more: a recon reads the line before any worker.`,
      },
      agent(
        "recon",
        "recon",
        line,
        "The recon reads the code and changes nothing. It checks the line's premises and scores the work by the project's anchors.",
      ),
    );
    if (!input.premise) return closed("recon");
    if (seen >= facts.split_from) return split("recon");
    const rescored = seen > line ? "up" : seen < line ? "down" : "kept";
    steps.push({
      node: "verdict",
      actor: "script",
      text:
        rescored === "kept"
          ? `The recon's score is ${seen}, as the line said. The stages keep their rows.`
          : `The recon's score is ${seen}, not ${line}. The engine rewrites every stage's row and the queue line's difficulty.`,
    });
    if (executor) {
      steps.push(
        {
          node: "plan",
          actor: "script",
          text: `A recon score of ${scores} is the plan: no plan stage runs.`,
        },
        agent(
          "execute",
          "execute",
          seen,
          "An executor on the execute row writes the code from the recon's findings.",
        ),
        next,
      );
      return {
        recon,
        scoredBy: "recon",
        difficulty: seen,
        rescored,
        plan: "skipped",
        execute: "executor",
        outcome: "review",
        steps,
      };
    }
    steps.push(
      agent(
        "plan",
        "plan",
        seen,
        "The plan stage reads the recon first, names the question the change answers and finds who already answers it.",
      ),
      {
        ...agent("execute", "plan", seen, "The same agent carries on and writes the code."),
      },
      next,
    );
    return {
      recon,
      scoredBy: "recon",
      difficulty: seen,
      rescored,
      plan: "run",
      execute: "plan-agent",
      outcome: "review",
      steps,
    };
  }

  steps.push(
    {
      node: "route",
      actor: "script",
      text: `Difficulty ${line} is below ${facts.recon_from}: no recon, straight to the plan stage.`,
    },
    agent(
      "plan",
      "plan",
      line,
      "The plan stage names the question the change answers, finds who already answers it, and scores the work itself: the line's number was a guess made without the code.",
    ),
  );
  if (!input.premise) return closed("plan");
  if (seen >= facts.split_from) return split("plan");
  if (executor) {
    steps.push(
      {
        node: "verdict",
        actor: "script",
        text: `Its score is ${seen}: it writes its plan and stops. The engine sets difficulty ${seen} on the session and on the queue line.`,
      },
      agent("execute", "execute", seen, "An executor on the execute row runs that plan."),
      next,
    );
    return {
      recon,
      scoredBy: "plan",
      difficulty: seen,
      rescored: seen > line ? "up" : "kept",
      plan: "run",
      execute: "executor",
      outcome: "review",
      steps,
    };
  }
  steps.push(
    agent(
      "execute",
      "plan",
      line,
      `Its score is ${seen}, below ${Math.min(...facts.executor_scores)}: the same agent carries on and writes the code.`,
    ),
    next,
  );
  return {
    recon,
    scoredBy: "plan",
    difficulty: line,
    rescored: "kept",
    plan: "run",
    execute: "plan-agent",
    outcome: "review",
    steps,
  };
}

/** A named pair of choices the page offers as one tap. */
export interface PathScenario extends PathInput {
  readonly id: string;
  readonly label: string;
}

/** The scenarios the page offers, in reading order: each takes a different way through the pipeline. */
export const PATH_SCENARIOS: readonly PathScenario[] = [
  { id: "small", label: "A small fix", line: 2, seen: 2, premise: true },
  { id: "as-scored", label: "As scored", line: 5, seen: 5, premise: true },
  { id: "harder", label: "Harder than it looked", line: 5, seen: 7, premise: true },
  { id: "easier", label: "Easier than it looked", line: 6, seen: 3, premise: true },
  { id: "hidden", label: "Small line, big work", line: 3, seen: 8, premise: true },
  { id: "split", label: "Too big for one line", line: 6, seen: 9, premise: true },
  { id: "refuted", label: "A refuted premise", line: 5, seen: 5, premise: false },
];
