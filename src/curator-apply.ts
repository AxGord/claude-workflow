// The curator's plan (what the judge decided: per-job yield, edit ops, proposals, decisions for the user), its
// check, and the APPLY step: under the default consent (`edits: propose`) nothing is applied and every op is a
// proposal; under `edits: direct` the mechanical moves are applied, a text edit only once the verifier passed it and
// never to memory when it changes a rule's meaning, to a `preferences-*` skill, nor to a skill that has a bundled
// copy. Each applied op is one commit of the target's shadow history (curator-history.ts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CuratorConfig } from "./curator.js";
import { historyEdit, historyFiles, historyRevert } from "./curator-history.js";

export const OPS = ["move-index", "move-file", "replace", "revert"] as const;
export type OpName = (typeof OPS)[number];

export interface PlanOp {
  readonly id: string;
  readonly job: string;
  readonly op: OpName;
  /** The file the op edits (absolute). */
  readonly file?: string;
  /** move-index: the index file the link line leaves / joins (names in the file's directory, or absolute). */
  readonly from?: string;
  readonly to?: string;
  /** move-file: the directory the file moves to, and that directory's index file that gets its line. */
  readonly to_dir?: string;
  /** replace: the exact text (once in the file) and its replacement. */
  readonly old?: string;
  readonly new?: string;
  /** revert: the target directory and its shadow commit. */
  readonly target?: string;
  readonly commit?: string;
  /** The op changes what a rule says (replace only): verified first, and never applied to memory. */
  readonly meaning?: boolean;
  readonly reason: string;
  /** What the edit should change, and how the next run measures it. */
  readonly expected?: string;
  /** The tool-error shape the edit should reduce (the skills job measures it next run). */
  readonly shape?: string;
  readonly shape_transcripts?: number;
}

export interface Plan {
  readonly jobs: Readonly<Record<string, { readonly found: number; readonly note?: string }>>;
  readonly ops: readonly PlanOp[];
  readonly proposals: readonly string[];
  readonly decisions: readonly string[];
}

/** A plan's text checked: the plan, or the list of what is wrong with it. */
export function parsePlan(
  text: string,
  jobs: readonly string[],
): { plan?: Plan; errors: string[] } {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { errors: [`not JSON: ${(err as Error).message}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { errors: ["a JSON object {jobs, ops, proposals, decisions}"] };
  const o = raw as Record<string, unknown>;
  const jobsRaw = (o.jobs ?? {}) as Record<string, unknown>;
  const out: Record<string, { found: number; note?: string }> = {};
  for (const j of jobs) {
    const v = jobsRaw[j] as { found?: unknown; note?: unknown } | undefined;
    if (v === undefined || typeof v.found !== "number" || !Number.isInteger(v.found) || v.found < 0)
      errors.push(`jobs.${j}.found: a whole number (the findings of this job; 0 = none)`);
    else out[j] = { found: v.found, ...(typeof v.note === "string" ? { note: v.note } : {}) };
  }
  const list = (k: string): string[] => {
    const v = o[k] ?? [];
    if (!Array.isArray(v) || v.some(x => typeof x !== "string")) {
      errors.push(`${k}: a list of strings`);
      return [];
    }
    return v as string[];
  };
  const proposals = list("proposals");
  const decisions = list("decisions");
  const ops: PlanOp[] = [];
  const ids = new Set<string>();
  const opsRaw = o.ops ?? [];
  if (!Array.isArray(opsRaw)) errors.push("ops: a list");
  for (const [i, v] of (Array.isArray(opsRaw) ? opsRaw : []).entries()) {
    const at = `ops[${i}]`;
    if (typeof v !== "object" || v === null) {
      errors.push(`${at}: an object`);
      continue;
    }
    const op = v as Record<string, unknown>;
    const str = (k: string): string | undefined => (typeof op[k] === "string" ? op[k] : undefined);
    const id = str("id");
    if (!id || ids.has(id)) errors.push(`${at}.id: a unique string`);
    else ids.add(id);
    if (!OPS.includes(op.op as OpName)) errors.push(`${at}.op: one of ${OPS.join(", ")}`);
    if (!jobs.includes(str("job") ?? ""))
      errors.push(`${at}.job: one of this run's jobs (${jobs.join(", ")})`);
    if (!str("reason")) errors.push(`${at}.reason: why, one line`);
    const need = (...ks: string[]): void => {
      for (const k of ks)
        if (str(k) === undefined) errors.push(`${at}.${k}: required for ${String(op.op)}`);
    };
    if (op.op === "move-index") need("file", "from", "to");
    if (op.op === "move-file") need("file", "to_dir");
    if (op.op === "replace") need("file", "old", "new");
    if (op.op === "revert") need("target", "commit");
    for (const k of ["file", "to_dir", "target"])
      if (str(k) !== undefined && !path.isAbsolute(str(k) as string))
        errors.push(`${at}.${k}: an absolute path`);
    ops.push(op as unknown as PlanOp);
  }
  if (errors.length > 0) return { errors };
  return { plan: { jobs: out, ops, proposals, decisions }, errors };
}

/** The ops a verifier must pass before they may be applied: every text edit. */
export const needsVerify = (plan: Plan): PlanOp[] => plan.ops.filter(o => o.op === "replace");

/** A verify verdict per op id (`ok`, or `reject: <why>`): the verifier's text checked against the plan. */
export function parseVerify(
  text: string,
  plan: Plan,
): { verdicts?: Record<string, string>; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { errors: [`not JSON: ${(err as Error).message}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { errors: ['a JSON object {"<op id>": "ok" | "reject: <why>"}'] };
  const v = raw as Record<string, unknown>;
  const errors: string[] = [];
  for (const op of needsVerify(plan)) {
    const x = v[op.id];
    if (typeof x !== "string" || !(x === "ok" || x.startsWith("reject:")))
      errors.push(`${op.id}: "ok" or "reject: <why>"`);
  }
  return errors.length > 0 ? { errors } : { verdicts: v as Record<string, string>, errors };
}

export interface Applied {
  readonly id: string;
  readonly job: string;
  readonly target: string;
  readonly commit: string | null;
}

export interface Proposed {
  readonly id: string;
  readonly job: string;
  readonly why: string;
  readonly op: PlanOp;
}

export interface ApplyResult {
  readonly applied: readonly Applied[];
  readonly proposed: readonly Proposed[];
}

const inside = (dir: string, f: string): boolean => {
  const rel = path.relative(path.resolve(dir), path.resolve(f));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** The link line of `name` in an index text, or undefined. */
function linkLine(text: string, name: string): string | undefined {
  return text.split("\n").find(l => l.includes(`](${name})`));
}

const indexPath = (dir: string, p: string): string => (path.isAbsolute(p) ? p : path.join(dir, p));

function appendLine(file: string, line: string): void {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.writeFileSync(file, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`);
}

function dropLine(file: string, line: string): void {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const i = lines.indexOf(line);
  if (i >= 0) lines.splice(i, 1);
  fs.writeFileSync(file, lines.join("\n"));
}

/** The engine checkout (or install) whose `templates/` hold the bundled skills; `src/` and `build/` sit beside it. */
const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The bundled copy of a skill (`templates/skills` or `templates/skills-stack`), or undefined when it has none. */
function bundledCopy(name: string): string | undefined {
  if (name === "" || name === "..") return undefined;
  return ["skills", "skills-stack"]
    .map(set => path.join(ENGINE_ROOT, "templates", set, name))
    .find(d => fs.existsSync(d));
}

/** The skill a file of a skills target belongs to (its first path segment under the target). */
const skillOf = (target: string, file: string): string =>
  path.relative(path.resolve(target), path.resolve(file)).split(path.sep)[0] ?? "";

/**
 * Why a change to a skill that has a bundled copy is not applied live: the live copy is the source of truth but the
 * bundled one is the shipped snapshot, and an edit of one side alone makes `check-skill-sync.sh` report drift and
 * refuse every engine commit. The curator edits nothing in a repo, so it proposes the edit for an engine-task line
 * that changes the bundled copy; the land syncs the live one.
 */
function bundledRefusal(
  op: PlanOp,
  targets: { readonly memory: readonly string[]; readonly skills: readonly string[] },
  dir?: string,
): string | null {
  const touched: Array<[string, string]> = [];
  const add = (file: string | undefined): void => {
    if (file === undefined) return;
    const t = targets.skills.find(s => inside(s, file));
    if (t !== undefined) touched.push([t, skillOf(t, file)]);
  };
  if (op.op === "revert") {
    const t = targets.skills.find(s => path.resolve(s) === path.resolve(op.target ?? ""));
    if (t !== undefined) {
      try {
        for (const f of historyFiles(t, op.commit as string, dir))
          touched.push([t, f.split("/")[0] ?? ""]);
      } catch {
        // an unknown commit fails in the apply step with its own reason
      }
    }
  } else {
    add(op.file);
    add(op.to_dir !== undefined ? path.join(op.to_dir, "x") : undefined);
  }
  const hit = touched.find(([, name]) => bundledCopy(name) !== undefined);
  if (hit === undefined) return null;
  const set = path.basename(path.dirname(bundledCopy(hit[1]) as string));
  return `skill ${hit[1]} has a bundled copy: proposed as an engine-task line that edits templates/${set}/${hit[1]}; the land syncs the live copy`;
}

/** Why an op may not be applied now, or null. */
function refusal(
  op: PlanOp,
  config: CuratorConfig,
  targets: { readonly memory: readonly string[]; readonly skills: readonly string[] },
  verdicts: Readonly<Record<string, string>>,
  dir?: string,
): string | null {
  if (config.edits !== "direct")
    return "consent: propose (the default; `edits: direct` in the config applies)";
  const all = [...targets.memory, ...targets.skills];
  const file = op.op === "revert" ? op.target : op.file;
  const target = all.find(
    t =>
      file !== undefined &&
      (op.op === "revert" ? path.resolve(t) === path.resolve(file) : inside(t, file)),
  );
  if (target === undefined) return `${file ?? "?"} is outside the curator's targets`;
  if (op.op === "move-file" && !all.some(t => path.resolve(t) === path.resolve(op.to_dir ?? "")))
    return `${op.to_dir ?? "?"} is not one of the curator's targets`;
  if (op.op === "replace") {
    const verdict = verdicts[op.id] ?? "not verified";
    if (verdict !== "ok") return `verifier: ${verdict}`;
    if (targets.memory.includes(target) && op.meaning !== false)
      return "changes a memory rule's meaning: proposed only";
    const skill = path.relative(target, file as string).split(path.sep)[0] ?? "";
    if (targets.skills.includes(target) && skill.startsWith("preferences"))
      return "a preferences skill: the user's own taste, proposed only";
  }
  return bundledRefusal(op, targets, dir);
}

function message(run: string, op: PlanOp): string {
  return [
    `curator ${run} ${op.job} ${op.id}: ${op.op} ${path.basename(op.file ?? op.target ?? "")}`,
    "",
    `reason: ${op.reason}`,
    ...(op.expected ? [`expected: ${op.expected}`] : []),
    ...(op.shape ? [`shape: ${op.shape}`, `shape_transcripts: ${op.shape_transcripts ?? 0}`] : []),
  ].join("\n");
}

/** Apply one allowed op: one shadow commit per target it touches. */
function applyOne(
  op: PlanOp,
  run: string,
  targetOf: (f: string) => string,
  dir?: string,
): Applied[] {
  const msg = message(run, op);
  const at = (target: string, files: string[], edit: () => void): Applied => ({
    id: op.id,
    job: op.job,
    target,
    commit: historyEdit(target, files, msg, edit, dir),
  });
  const file = op.file as string;
  if (op.op === "revert") {
    const target = op.target as string;
    return [
      { id: op.id, job: op.job, target, commit: historyRevert(target, op.commit as string, dir) },
    ];
  }
  if (op.op === "replace") {
    const text = fs.readFileSync(file, "utf8");
    const old = op.old as string;
    const n = text.split(old).length - 1;
    if (n !== 1) throw new Error(`${file}: the old text occurs ${n} times, not once`);
    return [
      at(targetOf(file), [file], () =>
        fs.writeFileSync(
          file,
          text.replace(old, () => op.new as string),
        ),
      ),
    ];
  }
  const name = path.basename(file);
  const dir0 = path.dirname(file);
  if (op.op === "move-index") {
    const from = indexPath(dir0, op.from as string);
    const to = indexPath(dir0, op.to as string);
    const line = linkLine(fs.readFileSync(from, "utf8"), name);
    if (line === undefined) throw new Error(`${from} has no line linking ${name}`);
    return [
      at(targetOf(from), [from, to], () => {
        dropLine(from, line);
        appendLine(to, line);
      }),
    ];
  }
  // move-file: the file and its index line leave one memory dir for another
  const toDir = op.to_dir as string;
  const dest = path.join(toDir, name);
  if (fs.existsSync(dest)) throw new Error(`${dest} exists`);
  const indexes = fs
    .readdirSync(dir0)
    .filter(n => n.endsWith(".md") && n !== name)
    .map(n => path.join(dir0, n))
    .filter(f => linkLine(fs.readFileSync(f, "utf8"), name) !== undefined);
  const lines = indexes.map(f => linkLine(fs.readFileSync(f, "utf8"), name) as string);
  const toIndex = indexPath(toDir, op.to ?? "MEMORY.md");
  const text = fs.readFileSync(file, "utf8");
  // the destination first: a failure past it leaves the file in both places, never in neither
  const arrived = at(targetOf(dest), [dest, toIndex], () => {
    fs.writeFileSync(dest, text);
    appendLine(toIndex, lines[0] ?? `- [${name}](${name})`);
  });
  const left = at(targetOf(file), [file, ...indexes], () => {
    fs.rmSync(file);
    indexes.forEach((f, i) => dropLine(f, lines[i]));
  });
  return [arrived, left];
}

/** Apply what the consent and the rules allow; everything else stays a proposal with its reason. */
export function applyPlan(
  plan: Plan,
  verdicts: Readonly<Record<string, string>>,
  config: CuratorConfig,
  targets: { readonly memory: readonly string[]; readonly skills: readonly string[] },
  run: string,
  dir?: string,
): ApplyResult {
  const applied: Applied[] = [];
  const proposed: Proposed[] = [];
  const all = [...targets.memory, ...targets.skills];
  const targetOf = (f: string): string => all.find(t => inside(t, f)) as string;
  for (const op of plan.ops) {
    const why = refusal(op, config, targets, verdicts, dir);
    if (why !== null) {
      proposed.push({ id: op.id, job: op.job, why, op });
      continue;
    }
    try {
      applied.push(...applyOne(op, run, targetOf, dir));
    } catch (err) {
      proposed.push({ id: op.id, job: op.job, why: `not applied: ${(err as Error).message}`, op });
    }
  }
  return { applied, proposed };
}
