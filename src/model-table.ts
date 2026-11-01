// A task workflow's `model_table:` — difficulty → model/effort, its escalation and the reviewer's
// choice by the diff's class — as pure functions over a session's context and the visits of the
// frame that declares the table. The engine applies it on every write that sets one of its input
// keys or enters a state; this module holds no state.
import type { ModelTable } from "./types.js";
import { DIFFICULTY_MAX, DIFFICULTY_MIN } from "./types.js";

/** The context keys the table reads (`difficulty`, `review_class`) and writes (the rest). */
export const MODEL_KEYS = {
  difficulty: "difficulty",
  model: "model",
  effort: "effort",
  step: "model_step",
  escalations: "escalations",
  reviewClass: "review_class",
  reviewModel: "review_model",
  reviewEffort: "review_effort",
} as const;

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

/** What the schema cannot check: `upto` strictly ascending and ending at 10; `escalate` naming states. */
export function modelTableErrors(t: ModelTable, stateNames: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  t.rows.forEach((r, i) => {
    if (i > 0 && r.upto <= t.rows[i - 1].upto)
      errors.push(`model_table row ${i + 1}: upto ${r.upto} is not above ${t.rows[i - 1].upto}`);
  });
  const last = t.rows[t.rows.length - 1].upto;
  if (last !== DIFFICULTY_MAX)
    errors.push(`model_table: the last row's upto is ${last}, not ${DIFFICULTY_MAX}`);
  for (const s of Object.keys(t.escalate ?? {}))
    if (!stateNames.has(s)) errors.push(`model_table escalate → unknown state "${s}"`);
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

/** The row of `difficulty` (valid), moved one row up per `escalate` entry its state's visits reached. */
export function chooseModel(
  t: ModelTable,
  difficulty: number,
  visits: Readonly<Record<string, number>>,
): ModelChoice {
  const at = t.rows.findIndex(r => difficulty <= r.upto);
  const base = at < 0 ? t.rows.length - 1 : at;
  const reached = Object.entries(t.escalate ?? {}).filter(([s, n]) => (visits[s] ?? 0) >= n).length;
  const step = Math.min(base + reached, t.rows.length - 1);
  const row = t.rows[step];
  return { model: row.model, effort: row.effort, step, escalations: step - base };
}

/**
 * The context after the table's derivations, with one line saying what changed; null = unchanged.
 * `changed` = the keys this write set. model/effort are (re)written when `difficulty` was set or
 * the row moved since the last write (an escalation); review_model/review_effort when
 * `review_class` was set: its `review` entry, else the task's own model and effort.
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
  if (d !== null) {
    const c = chooseModel(t, d, visits);
    if (changed.has(K.difficulty) || context[K.step] !== c.step + 1) {
      const was = context[K.step];
      out[K.model] = c.model;
      out[K.effort] = c.effort;
      out[K.step] = c.step + 1;
      out[K.escalations] = c.escalations;
      const why = changed.has(K.difficulty)
        ? `difficulty ${d}`
        : `escalated from row ${typeof was === "number" ? was : "?"}`;
      notes.push(
        `${why} → ${c.model}/${c.effort} (row ${c.step + 1} of ${t.rows.length}` +
          `${c.escalations > 0 ? `, +${c.escalations}` : ""})`,
      );
    }
  }
  if (changed.has(K.reviewClass)) {
    const raw = context[K.reviewClass];
    const cls = typeof raw === "string" ? raw.trim() : "";
    const own = t.review?.[cls];
    const model = own?.model ?? out[K.model];
    const effort = own?.effort ?? out[K.effort];
    if (typeof model === "string" && typeof effort === "string") {
      out[K.reviewModel] = model;
      out[K.reviewEffort] = effort;
      notes.push(`review ${cls || "?"} → ${model}/${effort}${own ? "" : " (the task's own)"}`);
    }
  }
  return notes.length > 0 ? { context: out, note: notes.join("; ") } : null;
}
