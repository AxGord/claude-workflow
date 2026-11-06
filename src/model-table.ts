// A task workflow's `model_table:` — difficulty → model/effort per named stage, its escalation and
// the reviewer's choice by the diff's class — as pure functions over a session's context and the
// visits of the frame that declares the table. The engine applies it on every write that sets one of
// its input keys or enters a state; this module holds no state.
import type { ModelTable } from "./types.js";
import { DIFFICULTY_MAX, DIFFICULTY_MIN } from "./types.js";

/** The context keys the table reads (`difficulty`, `review_class`) and writes (the rest). */
export const MODEL_KEYS = {
  difficulty: "difficulty",
  model: "model",
  effort: "effort",
  step: "model_step",
  reached: "model_reached",
  escalations: "escalations",
  reviewClass: "review_class",
  reviewModel: "review_model",
  reviewEffort: "review_effort",
  claimDifficulty: "claim_difficulty",
  stagesFirst: "stages_first",
} as const;

/** A stage name, any that matches: each stage writes `model_<stage>` / `effort_<stage>`; the bundled workflows give plan, execute, review, review_verify and fix a meaning. */
export const STAGE_NAME = /^[a-z][a-z_]*$/;

/** Names whose `model_<x>` / `effort_<x>` keys the table writes for itself (`model_step`, `model_reached`) or whose bare key it owns. */
const RESERVED_STAGES: ReadonlySet<string> = new Set(["model", "effort", "step", "reached"]);

/** The stage a context key `model_<x>` / `effort_<x>` belongs to, if `x` can be a stage name. */
export function stageOfKey(key: string, prefix: "model" | "effort"): string | undefined {
  if (!key.startsWith(`${prefix}_`)) return undefined;
  const name = key.slice(prefix.length + 1);
  return STAGE_NAME.test(name) && !RESERVED_STAGES.has(name) ? name : undefined;
}

/** The stage names a state's text reads as `context.model_<x>` / `context.effort_<x>`. */
export function stagesRead(state: unknown): string[] {
  const names = new Set<string>();
  for (const m of JSON.stringify(state ?? null).matchAll(
    /context\.(?:model|effort)_([a-z][a-z_]*)/g,
  )) {
    if (!RESERVED_STAGES.has(m[1])) names.add(m[1]);
  }
  return [...names];
}

/** `context` with the as-run row of each stage `names` not yet recorded (first value wins); null when none is new. */
export function recordStagesUsed(
  context: Readonly<Record<string, unknown>>,
  names: readonly string[],
): Record<string, unknown> | null {
  const was = (context[MODEL_KEYS.stagesFirst] ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...was };
  for (const name of names) {
    const k = stageKeys(name);
    const model = context[k.model];
    const effort = context[k.effort];
    if (name in next || typeof model !== "string" || typeof effort !== "string") continue;
    next[name] = { model, effort };
  }
  return Object.keys(next).length === Object.keys(was).length
    ? null
    : { ...context, [MODEL_KEYS.stagesFirst]: next };
}

/** The stages `escalate` moves; the others keep the difficulty's own row. */
const ESCALATING: ReadonlySet<string> = new Set(["execute", "fix"]);

/** The context keys of one stage. */
export function stageKeys(stage: string): { model: string; effort: string } {
  return { model: `model_${stage}`, effort: `effort_${stage}` };
}

/** `v` as a difficulty: a whole number in 1..10, given as a number or its decimal string; else null. */
export function parseDifficulty(v: unknown): number | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= DIFFICULTY_MIN && n <= DIFFICULTY_MAX ? n : null;
}

/** Why `v` is not a difficulty, for a refusal. */
export function difficultyError(v: unknown): string {
  return `difficulty "${String(v)}" is not a whole number ${DIFFICULTY_MIN}..${DIFFICULTY_MAX}`;
}

type Rows = readonly NonNullable<ModelTable["rows"]>[number][];

/** The rows behind `model` / `effort`: `stages.execute`, else `rows`. */
function executeRows(t: ModelTable): Rows {
  return t.stages?.execute ?? t.rows ?? [];
}

function rowErrors(rows: Rows, rowLabel: string, endLabel: string): string[] {
  const errors: string[] = [];
  rows.forEach((r, i) => {
    if (i > 0 && r.upto <= rows[i - 1].upto)
      errors.push(`${rowLabel} ${i + 1}: upto ${r.upto} is not above ${rows[i - 1].upto}`);
  });
  const last = rows[rows.length - 1].upto;
  if (last !== DIFFICULTY_MAX)
    errors.push(`${endLabel}: the last row's upto is ${last}, not ${DIFFICULTY_MAX}`);
  return errors;
}

/**
 * What the schema cannot check: `upto` strictly ascending and ending at 10 (in `rows` and in every
 * stage); the execute rows given once; stage names well-formed and not reserved; `escalate` naming states; and, with
 * `states` given, no `context.model_<x>` / `context.effort_<x>` read of a stage the table lacks.
 */
export function modelTableErrors(
  t: ModelTable,
  stateNames: ReadonlySet<string>,
  states?: unknown,
): string[] {
  const errors: string[] = [];
  if (t.rows) errors.push(...rowErrors(t.rows, "model_table row", "model_table"));
  if (t.rows && t.stages?.execute)
    errors.push("model_table: `rows` and `stages.execute` both set — give the execute rows once");
  if (!t.rows && !t.stages?.execute) errors.push("model_table: needs `rows` or `stages.execute`");
  for (const [name, rows] of Object.entries(t.stages ?? {})) {
    if (!STAGE_NAME.test(name))
      errors.push(`model_table stages: stage name "${name}" does not match ${STAGE_NAME.source}`);
    else if (RESERVED_STAGES.has(name))
      errors.push(
        `model_table stages: "${name}" is not a stage name (it collides with the table's own keys)`,
      );
    errors.push(
      ...rowErrors(rows, `model_table stage "${name}" row`, `model_table stage "${name}"`),
    );
  }
  for (const s of Object.keys(t.escalate ?? {}))
    if (!stateNames.has(s)) errors.push(`model_table escalate → unknown state "${s}"`);
  if (t.stages && states !== undefined) {
    const declared = new Set(Object.keys(t.stages));
    const bad = new Set<string>();
    for (const m of JSON.stringify(states).matchAll(/context\.(?:model|effort)_([a-z0-9_]+)/g)) {
      const name = m[1];
      if (name !== "step" && name !== "reached" && !declared.has(name)) bad.add(name);
    }
    for (const name of bad)
      errors.push(
        `model_table: a state reads the stage "${name}", which stages does not declare ` +
          `(declared: ${[...declared].join(", ")})`,
      );
  }
  return errors;
}

export interface ModelChoice {
  readonly model: string;
  readonly effort: string;
  /** The row taken, 0-based. */
  readonly step: number;
  /** Rows above the difficulty's own: the escalations that took effect (capped by the last row). */
  readonly escalations: number;
}

/** The `escalate` entries whose state's visits reached the number (not capped by any rows). */
export function reachedCount(t: ModelTable, visits: Readonly<Record<string, number>>): number {
  return Object.entries(t.escalate ?? {}).filter(([s, n]) => (visits[s] ?? 0) >= n).length;
}

function pickRow(rows: Rows, difficulty: number, up: number): ModelChoice {
  const at = rows.findIndex(r => difficulty <= r.upto);
  const base = at < 0 ? rows.length - 1 : at;
  const step = Math.min(base + up, rows.length - 1);
  const row = rows[step];
  return {
    model: row.model,
    effort: row.effort,
    step,
    escalations: step - base,
  };
}

/** The execute row of `difficulty` (valid), moved one row up per `escalate` entry its state's visits reached. */
export function chooseModel(
  t: ModelTable,
  difficulty: number,
  visits: Readonly<Record<string, number>>,
): ModelChoice {
  return pickRow(executeRows(t), difficulty, reachedCount(t, visits));
}

/** The row of every declared stage; `escalate` moves execute and fix, the rest keep the difficulty's own. */
export function chooseStages(
  t: ModelTable,
  difficulty: number,
  visits: Readonly<Record<string, number>>,
): Record<string, ModelChoice> {
  const up = reachedCount(t, visits);
  return Object.fromEntries(
    Object.entries(t.stages ?? {}).map(([name, rows]) => [
      name,
      pickRow(rows, difficulty, ESCALATING.has(name) ? up : 0),
    ]),
  );
}

/**
 * The context after the table's derivations, with one line saying what changed; null = unchanged.
 * `changed` = the keys this write set. model/effort (the execute row) and, under `stages`, every
 * `model_<stage>` / `effort_<stage>` are (re)written when `difficulty` was set or an escalation moved
 * a row since the last write. review_model/review_effort follow the review stage, and the
 * `review` entry of a `review_class` overrides it (without a stage: the task's own model and effort,
 * written when `review_class` was set).
 */
export function applyModelTable(
  context: Readonly<Record<string, unknown>>,
  t: ModelTable,
  visits: Readonly<Record<string, number>>,
  changed: ReadonlySet<string>,
): { context: Record<string, unknown>; note: string } | null {
  const K = MODEL_KEYS;
  const out: Record<string, unknown> = { ...context };
  const notes: string[] = [];
  const d = parseDifficulty(context[K.difficulty]);
  const stages = d !== null && t.stages ? chooseStages(t, d, visits) : null;
  let refreshed = false;
  if (d !== null) {
    const c = chooseModel(t, d, visits);
    const reached = reachedCount(t, visits);
    if (
      changed.has(K.difficulty) ||
      context[K.step] !== c.step + 1 ||
      (stages !== null && context[K.reached] !== reached)
    ) {
      const was = context[K.step];
      out[K.claimDifficulty] ??= d;
      out[K.model] = c.model;
      out[K.effort] = c.effort;
      out[K.step] = c.step + 1;
      out[K.escalations] = c.escalations;
      const shown: string[] = [];
      if (stages) {
        out[K.reached] = reached;
        for (const [name, sc] of Object.entries(stages)) {
          const k = stageKeys(name);
          out[k.model] = sc.model;
          out[k.effort] = sc.effort;
          shown.push(`${name} ${sc.model}/${sc.effort}`);
        }
      }
      refreshed = true;
      const why = changed.has(K.difficulty)
        ? `difficulty ${d}`
        : `escalated from row ${typeof was === "number" ? was : "?"}`;
      notes.push(
        `${why} → ${c.model}/${c.effort} (row ${c.step + 1} of ${executeRows(t).length}` +
          `${c.escalations > 0 ? `, +${c.escalations}` : ""})` +
          `${shown.length > 0 ? ` [${shown.join(", ")}]` : ""}`,
      );
    }
  }
  const reviewStage = stages?.review;
  if (changed.has(K.reviewClass) || (refreshed && reviewStage)) {
    const raw = out[K.reviewClass];
    const cls = typeof raw === "string" ? raw.trim() : "";
    const own = t.review?.[cls];
    const model = own?.model ?? reviewStage?.model ?? out[K.model];
    const effort = own?.effort ?? reviewStage?.effort ?? out[K.effort];
    if (typeof model === "string" && typeof effort === "string") {
      out[K.reviewModel] = model;
      out[K.reviewEffort] = effort;
      if (reviewStage) {
        const k = stageKeys("review");
        out[k.model] = model;
        out[k.effort] = effort;
      }
      if (changed.has(K.reviewClass))
        notes.push(
          `review ${cls || "?"} → ${model}/${effort}${own ? "" : reviewStage ? " (the review stage)" : " (the task's own)"}`,
        );
    }
  }
  return notes.length > 0 ? { context: out, note: notes.join("; ") } : null;
}
