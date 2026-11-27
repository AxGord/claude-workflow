// The curator service: a project's config of tidying jobs (memory, calibration, queue hygiene, lessons, skills,
// and its own), the cadence the ENGINE decides for each (lands since the job's last run against its interval, plus
// event triggers), the yield each run reports (found / changed per job) and the interval that yield tunes. The run
// itself is the bundled `curator` workflow; under a dispatcher the pick admits it as a queue line (`pickQueue`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { LedgerEntry } from "./ledger.js";
import { projectRoot } from "./pool.js";
import { PRIORITIES, type Priority } from "./priority.js";

export const CURATOR_WORKFLOW = "curator";
/** The id prefix of the queue lines the pick adds for a curator run. */
export const CURATOR_ID_PREFIX = "CURATOR-";
/** The exact shape of the ids the pick gives curator lines: a user's own `CURATOR-…` line is an ordinary line. */
const CURATOR_ID_RE = /^CURATOR-\d{4}-\d{2}-\d{2}-\d+$/;
export const isCuratorLineId = (id: string): boolean => CURATOR_ID_RE.test(id);
/** The project config, relative to the project root, when the queue header names none. */
export const CURATOR_CONFIG = path.join(".claude", "curator.yaml");
export const BUNDLED_JOBS = ["memory", "calibration", "hygiene", "lessons", "skills"] as const;
export type BundledJob = (typeof BUNDLED_JOBS)[number];
/** Each job's starting interval: lands since its last run (calibration: new lands on one model row). */
export const DEFAULT_EVERY: Readonly<Record<BundledJob, number>> = {
  hygiene: 10,
  memory: 20,
  calibration: 5,
  lessons: 10,
  skills: 20,
};
export const INTERVAL_FLOOR = 5;
export const INTERVAL_CAP = 40;
/** Findings of one run at or above which the job's interval halves. */
export const HIGH_YIELD_DEFAULT = 5;
/** New memory files since the memory job's last run that make it due at once. */
export const NEW_MEMORY_FILES_DEFAULT = 5;
export const INDEX_BUDGET_DEFAULT = 4096;
const JOB_RE = /^[a-z][a-z0-9_-]*$/;

export class CuratorError extends Error {}

/** One enabled job of a project's config. `options` is the job's mapping as written (its own keys). */
export interface JobConfig {
  readonly name: string;
  readonly bundled: boolean;
  /** The starting interval (`every:`), before any yield tuning. */
  readonly every: number;
  readonly options: Readonly<Record<string, unknown>>;
}

export type EditConsent = "propose" | "direct";

export interface CuratorConfig {
  readonly file: string;
  readonly project: string;
  readonly jobs: readonly JobConfig[];
  /** `propose` (default): the run edits nothing outside its run directory; `direct`: it applies what its rules allow. */
  readonly edits: EditConsent;
  readonly highYield: number;
  /** The difficulty the admitted line carries (the curator workflow's `model_table` maps it). */
  readonly difficulty: number;
  /** The priority the admitted line carries: housekeeping, so `high` unless the project says otherwise. */
  readonly priority: Priority;
}

/** The priority of an admitted curator line when the config names none: below `urgent`, so it never outranks a user's urgent line. */
export const CURATOR_PRIORITY_DEFAULT: Priority = "high";

const expandHome = (p: string): string =>
  p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;

/** A config path value: `~` expanded, relative = the project root. */
export function configPath(project: string, p: string): string {
  const e = expandHome(p);
  return path.isAbsolute(e) ? e : path.resolve(project, e);
}

const whole = (v: unknown, at: string, min: number): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min)
    throw new CuratorError(`${at}: a whole number of ${min} or more, not ${JSON.stringify(v)}`);
  return v;
};

/** The project a queue file belongs to: the git root of its directory. */
export function queueProject(queueFile: string): string {
  return projectRoot(path.dirname(path.resolve(queueFile)));
}

/**
 * The config file of a project: the queue header's `curator:` (relative = the queue's directory; `off` = none),
 * else `<project>/.claude/curator.yaml` when it exists; null when the project has none.
 */
export function curatorConfigFile(opts: {
  readonly project: string;
  readonly queueFile?: string;
  readonly header?: Readonly<Record<string, string>>;
}): string | null {
  const head = opts.header?.curator?.trim();
  if (head !== undefined && head !== "") {
    if (/^(off|no|false|none)$/i.test(head)) return null;
    const base = opts.queueFile ? path.dirname(path.resolve(opts.queueFile)) : opts.project;
    const e = expandHome(head);
    return path.isAbsolute(e) ? e : path.resolve(base, e);
  }
  const f = path.join(opts.project, CURATOR_CONFIG);
  return fs.existsSync(f) ? f : null;
}

const priorityOf = (v: unknown, file: string): Priority => {
  if (v === undefined) return CURATOR_PRIORITY_DEFAULT;
  if (typeof v === "string" && (PRIORITIES as readonly string[]).includes(v)) return v as Priority;
  throw new CuratorError(
    `${file}: priority: one of ${PRIORITIES.join(", ")}, not ${JSON.stringify(v)}`,
  );
};

/** Parse a config's text. Jobs are off unless listed; `enabled: false` turns a listed one off. */
export function parseCuratorConfig(text: string, file: string, project: string): CuratorConfig {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new CuratorError(`${file}: not YAML: ${(err as Error).message}`);
  }
  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new CuratorError(
      `${file}: a mapping (jobs:, edits:, high_yield:, difficulty:, priority:)`,
    );
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!["jobs", "edits", "high_yield", "difficulty", "priority"].includes(k))
      throw new CuratorError(
        `${file}: unknown key ${k} (jobs, edits, high_yield, difficulty, priority)`,
      );
  const jobsRaw = o.jobs ?? {};
  if (typeof jobsRaw !== "object" || jobsRaw === null || Array.isArray(jobsRaw))
    throw new CuratorError(`${file}: jobs: a mapping of job name → its options`);
  const jobs: JobConfig[] = [];
  for (const [name, v] of Object.entries(jobsRaw as Record<string, unknown>)) {
    if (!JOB_RE.test(name)) throw new CuratorError(`${file}: job "${name}" is not a job name`);
    const opts = v === null || v === true ? {} : v;
    if (opts === false) continue;
    if (typeof opts !== "object" || Array.isArray(opts))
      throw new CuratorError(`${file}: jobs.${name}: a mapping of its options`);
    const m = opts as Record<string, unknown>;
    if (m.enabled === false) continue;
    const bundled = (BUNDLED_JOBS as readonly string[]).includes(name);
    if (!bundled && typeof m.prompt !== "string")
      throw new CuratorError(
        `${file}: jobs.${name}: a project job needs prompt: (what the judge does with its command's output)`,
      );
    if (m.command !== undefined && typeof m.command !== "string")
      throw new CuratorError(`${file}: jobs.${name}.command: a shell command`);
    const every =
      m.every === undefined
        ? bundled
          ? DEFAULT_EVERY[name as BundledJob]
          : 20
        : whole(m.every, `${file}: jobs.${name}.every`, 1);
    jobs.push({ name, bundled, every, options: m });
  }
  const edits = o.edits ?? "propose";
  if (edits !== "propose" && edits !== "direct")
    throw new CuratorError(`${file}: edits: propose or direct, not ${JSON.stringify(edits)}`);
  return {
    file,
    project,
    jobs,
    edits,
    highYield:
      o.high_yield === undefined
        ? HIGH_YIELD_DEFAULT
        : whole(o.high_yield, `${file}: high_yield`, 1),
    difficulty: o.difficulty === undefined ? 5 : whole(o.difficulty, `${file}: difficulty`, 1),
    priority: priorityOf(o.priority, file),
  };
}

export function readCuratorConfig(file: string, project: string): CuratorConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new CuratorError(`${file}: unreadable: ${(err as Error).message}`);
  }
  const c = parseCuratorConfig(text, file, project);
  if (c.difficulty > 10) throw new CuratorError(`${file}: difficulty: 1..10`);
  return c;
}

/** One run of one job, as the record step reports it. */
export interface JobRun {
  readonly at: string;
  readonly run: string;
  readonly found: number;
  readonly changed: number;
  /** The interval after this run's tuning. */
  readonly interval: number;
}

export interface JobState {
  readonly interval: number;
  readonly last_run_at?: string;
  /** The memory index's bytes the last run saw: an over-budget index fires again only once it grew. */
  readonly last_index_bytes?: number;
  readonly runs: readonly JobRun[];
}

export interface CuratorState {
  readonly project: string;
  readonly jobs: Readonly<Record<string, JobState>>;
}

/**
 * The engine's state dir (`STATE_DIR`, else `~/.claude/workflow-state`), read here rather than through
 * workflow-dirs.ts: that module loads the workflow loader, and the queue module imports this one.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.STATE_DIR;
  return v ? path.resolve(v) : path.join(os.homedir(), ".claude", "workflow-state");
}

/** A path as Claude Code names its project directory: every character but a letter, digit or `-` written as `-`. */
export const projectDirName = (p: string): string => p.replace(/[^A-Za-z0-9-]/g, "-");

/** The curator's directory of one project under the state dir: its state file and run directories. */
export function curatorDir(project: string, dir: string = stateDir()): string {
  return path.join(dir, "curator", projectDirName(project));
}

export function curatorStateFile(project: string, dir: string = stateDir()): string {
  return path.join(curatorDir(project, dir), "state.json");
}

export function readCuratorState(project: string, dir: string = stateDir()): CuratorState {
  try {
    const j = JSON.parse(fs.readFileSync(curatorStateFile(project, dir), "utf8")) as CuratorState;
    if (j && typeof j.jobs === "object" && j.jobs !== null) return { project, jobs: j.jobs };
  } catch {
    // absent or damaged: no run recorded yet
  }
  return { project, jobs: {} };
}

export function writeCuratorState(state: CuratorState, dir: string = stateDir()): void {
  const f = curatorStateFile(state.project, dir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(`${f}.tmp`, f);
}

/** A job's interval now: the tuned one when a run recorded it, else the config's `every:`. */
export function intervalOf(job: JobConfig, state: CuratorState): number {
  return state.jobs[job.name]?.interval ?? job.every;
}

/** Self-tuning by yield: nothing found doubles the interval (cap 40), `high` or more halves it (floor 5). */
export function nextInterval(interval: number, found: number, high: number): number {
  if (found === 0) return Math.min(INTERVAL_CAP, Math.max(interval, 1) * 2);
  if (found >= high) return Math.max(INTERVAL_FLOOR, Math.floor(interval / 2));
  return interval;
}

/** Which ledger lines are this project's lands: the queue's own line ids, else the project's git root. */
export interface LandScope {
  readonly ids?: ReadonlySet<string>;
  readonly project?: string;
}

const isCuratorRun = (e: LedgerEntry): boolean =>
  e.workflow === CURATOR_WORKFLOW || isCuratorLineId(e.task ?? "");

/** The task lines (one per task id) that ended with outcome completed after `since` within the scope, curator runs aside. */
export function landsSince(
  entries: readonly LedgerEntry[],
  scope: LandScope,
  since: string | undefined,
): LedgerEntry[] {
  const from = since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(since);
  const seen = new Map<string, LedgerEntry>();
  for (const e of entries) {
    if (e.task === undefined || e.outcome !== "completed" || isCuratorRun(e)) continue;
    if (!(Date.parse(e.ended_at) > from)) continue;
    if (scope.ids !== undefined ? !scope.ids.has(e.task) : e.project !== scope.project) continue;
    seen.set(e.task, e);
  }
  return [...seen.values()];
}

/** The model rows of a set of lands: `<workflow> <stage> <model>/<effort>` → lands that ran a stage on it. */
export function modelRowCounts(lands: readonly LedgerEntry[]): Map<string, number> {
  const rows = new Map<string, number>();
  for (const e of lands) {
    const stages =
      e.stages ??
      (e.model ? { execute: { model: e.model, effort: e.effort ?? "-" } } : undefined) ??
      {};
    for (const [stage, r] of Object.entries(stages)) {
      const key = `${e.workflow ?? "-"} ${stage} ${r.model}/${r.effort}`;
      rows.set(key, (rows.get(key) ?? 0) + 1);
    }
  }
  return rows;
}

/** What the memory job's event triggers read: the largest index file's bytes, and memory files new since its last run. */
export interface MemoryFacts {
  readonly indexBytes: number;
  readonly newFiles: number;
}

/** The memory directories of a job: `dirs:` (`~`, relative = the project), else the project's Claude Code memory. */
export function memoryDirs(job: JobConfig, project: string): string[] {
  const dirs = job.options.dirs;
  if (Array.isArray(dirs) && dirs.length > 0) return dirs.map(d => configPath(project, String(d)));
  const home = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return [path.join(home, "projects", projectDirName(project), "memory")];
}

export const indexNameOf = (job: JobConfig): string =>
  typeof job.options.index === "string" ? job.options.index : "MEMORY.md";

export function memoryFacts(
  job: JobConfig,
  project: string,
  since: string | undefined,
): MemoryFacts {
  const from = since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(since);
  let indexBytes = 0;
  let newFiles = 0;
  for (const dir of memoryDirs(job, project)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".md")) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(path.join(dir, n));
      } catch {
        continue;
      }
      if (n === indexNameOf(job)) indexBytes = Math.max(indexBytes, st.size);
      else if (st.birthtimeMs > from || (st.birthtimeMs === 0 && st.mtimeMs > from)) newFiles++;
    }
  }
  return { indexBytes, newFiles };
}

export interface DueJob {
  readonly job: string;
  readonly reason: string;
}

/** One enabled job's standing: its interval, its count since the last run, and the reason it is due (absent = not due). */
export interface JobStanding {
  readonly job: string;
  readonly interval: number;
  readonly count: number;
  readonly lastRunAt?: string;
  readonly due?: string;
}

export interface DueInput {
  readonly config: CuratorConfig;
  readonly state: CuratorState;
  readonly ledger: readonly LedgerEntry[];
  readonly scope: LandScope;
  /** The memory job's facts; read from disk when absent. */
  readonly memory?: (job: JobConfig, since: string | undefined) => MemoryFacts;
}

/** Each enabled job's standing and, when due, why: the engine's cadence, never an agent's. */
export function curatorStandings(input: DueInput): JobStanding[] {
  const out: JobStanding[] = [];
  for (const job of input.config.jobs) {
    const js = input.state.jobs[job.name];
    const since = js?.last_run_at;
    const interval = intervalOf(job, input.state);
    const lands = landsSince(input.ledger, input.scope, since);
    let count = lands.length;
    let due: string | undefined;
    if (job.name === "calibration") {
      let top = "";
      count = 0;
      for (const [row, n] of modelRowCounts(lands))
        if (n > count) {
          count = n;
          top = row;
        }
      if (count >= interval) due = `model row ${top} has ${count} new lands (interval ${interval})`;
    } else if (count >= interval) {
      due = `${count} lands since ${since ? "its last run" : "the start"} (interval ${interval})`;
    }
    if (job.name === "memory" && due === undefined) {
      const facts = (input.memory ?? ((j, s) => memoryFacts(j, input.config.project, s)))(
        job,
        since,
      );
      const budget =
        typeof job.options.index_budget_bytes === "number"
          ? job.options.index_budget_bytes
          : INDEX_BUDGET_DEFAULT;
      const newMax =
        typeof job.options.new_files === "number"
          ? job.options.new_files
          : NEW_MEMORY_FILES_DEFAULT;
      if (facts.indexBytes > budget && facts.indexBytes > (js?.last_index_bytes ?? 0))
        due = `${indexNameOf(job)} is ${facts.indexBytes} bytes, over its budget of ${budget}`;
      else if (facts.newFiles >= newMax)
        due = `${facts.newFiles} new memory files since ${since ? "its last run" : "the start"}`;
    }
    out.push({
      job: job.name,
      interval,
      count,
      ...(since !== undefined ? { lastRunAt: since } : {}),
      ...(due !== undefined ? { due } : {}),
    });
  }
  return out;
}

export function dueJobs(input: DueInput): DueJob[] {
  return curatorStandings(input)
    .filter(s => s.due !== undefined)
    .map(s => ({ job: s.job, reason: s.due as string }));
}

/** One job's yield in a run. */
export interface JobYield {
  readonly job: string;
  readonly found: number;
  readonly changed: number;
}

/** The state after a run: each job it ran gets its run record, its tuned interval and the new last-run time. */
export function recordYield(
  state: CuratorState,
  config: CuratorConfig,
  yields: readonly JobYield[],
  run: string,
  now: Date,
  memoryIndexBytes?: number,
): CuratorState {
  const jobs: Record<string, JobState> = { ...state.jobs };
  for (const y of yields) {
    const job = config.jobs.find(j => j.name === y.job);
    if (!job) continue;
    const before = intervalOf(job, state);
    const interval = nextInterval(before, y.found, config.highYield);
    const prev = jobs[y.job];
    // a record step run again (a retry, a restart) tunes nothing twice
    if (prev?.runs.some(r => r.run === run)) continue;
    jobs[y.job] = {
      interval,
      last_run_at: now.toISOString(),
      ...(y.job === "memory" && memoryIndexBytes !== undefined
        ? { last_index_bytes: memoryIndexBytes }
        : prev?.last_index_bytes !== undefined
          ? { last_index_bytes: prev.last_index_bytes }
          : {}),
      runs: [
        ...(prev?.runs ?? []).slice(-19),
        { at: now.toISOString(), run, found: y.found, changed: y.changed, interval },
      ],
    };
  }
  return { project: state.project, jobs };
}

/** Everything the cadence needs for one project, read from disk: null when the project has no config or no job. */
export interface CuratorContext {
  readonly config: CuratorConfig;
  readonly state: CuratorState;
  readonly scope: LandScope;
  readonly queueFile?: string;
}

/** The ids of a queue file's lines and its archive: the lands the curator counts for that queue. */
export function queueIds(
  lines: readonly { readonly id: string }[],
  archived: Iterable<string>,
): Set<string> {
  return new Set([...lines.map(l => l.id), ...archived]);
}

/** The ledger of a state dir; none when it was never written. */
export function readLedgerFile(dir: string = stateDir()): string {
  try {
    return fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8");
  } catch {
    return "";
  }
}

/** `CURATOR-<date>-<n>`: the first id of the day no line or archived line holds. */
export function curatorLineId(taken: ReadonlySet<string>, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  for (let n = 1; ; n++) {
    const id = `${CURATOR_ID_PREFIX}${day}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** The text of the queue line a pick adds for a due run. */
export function curatorLineText(config: CuratorConfig, due: readonly DueJob[]): string {
  return `Curator run (admitted by the engine): ${due.map(d => `${d.job} (${d.reason})`).join("; ")}. Config ${config.file}. The bundled curator workflow runs the jobs; it edits nothing in a repo.`;
}

/** The one line a session with no dispatcher shows when the project's curator is due: what to start. */
export function curatorDueNotice(
  config: CuratorConfig,
  due: readonly DueJob[],
  queueFile?: string,
): string {
  const queue = queueFile ? `, queue_file: "${queueFile}"` : "";
  return `CURATOR-DUE: ${due.map(d => `${d.job} (${d.reason})`).join("; ")} — start it: start({workflow: "${CURATOR_WORKFLOW}", cwd: "${config.project}", context: {difficulty: "${config.difficulty}"${queue}}}) and spawn its DRIVER block`;
}

/** The queue as the admission reads it (a structural subset of `Queue`, so this module needs no import of it). */
export interface AdmitQueue {
  readonly file: string;
  readonly header: Readonly<Record<string, string>>;
  readonly batchSize: number;
  readonly lines: readonly {
    readonly id: string;
    readonly status: string;
    readonly meta?: Readonly<Record<string, string>>;
  }[];
  readonly archived: ReadonlyMap<string, unknown>;
}

/** The config, state and land scope of a project (and its queue, when there is one); null when it has no config. */
export function curatorContext(opts: {
  readonly project: string;
  readonly queue?: AdmitQueue;
  readonly stateDir?: string;
}): CuratorContext | null {
  const file = curatorConfigFile({
    project: opts.project,
    ...(opts.queue ? { queueFile: opts.queue.file, header: opts.queue.header } : {}),
  });
  if (file === null) return null;
  const config = readCuratorConfig(file, opts.project);
  return {
    config,
    state: readCuratorState(opts.project, opts.stateDir),
    scope: opts.queue
      ? { ids: queueIds(opts.queue.lines, opts.queue.archived.keys()) }
      : { project: opts.project },
    ...(opts.queue ? { queueFile: opts.queue.file } : {}),
  };
}

/** The jobs due now for a context, over the state dir's ledger. */
export function dueFor(ctx: CuratorContext, ledgerText: string): DueJob[] {
  return dueJobs({
    config: ctx.config,
    state: ctx.state,
    ledger: parseLedgerText(ledgerText),
    scope: ctx.scope,
  });
}

/** `parseLedger` without importing ledger.ts's runtime (it pulls the pool and the timeline). */
export function parseLedgerText(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // a damaged line is not a run
    }
  }
  return out;
}

/** The line a pick adds for a due curator run. */
export interface CuratorLine {
  readonly id: string;
  readonly text: string;
  readonly difficulty: number;
  readonly priority: Priority;
  readonly due: readonly DueJob[];
}

/**
 * Whether a pick adds a curator line now: a slot is free, no curator line is pending or running, the project's config
 * enables a job and one is due. `note` is what the pick summary says (a config error never fails the pick).
 */
export function curatorAdmission(
  q: AdmitQueue,
  opts: { readonly now?: Date; readonly stateDir?: string; readonly ledger?: string } = {},
): { readonly line?: CuratorLine; readonly note?: string } {
  if (q.batchSize <= 0) return {};
  const live = q.lines.filter(l => l.status === "running" || l.status === "pending");
  const running = q.lines.filter(l => l.status === "running").length;
  if (live.some(l => isCuratorLineId(l.id)) || running >= q.batchSize) return {};
  // a run the parent closed (failed) today is not re-added on every free slot: the next one waits for tomorrow
  const now = opts.now ?? new Date();
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const failed = q.lines.find(
    l => isCuratorLineId(l.id) && l.status === "failed" && (l.meta?.ended ?? "") >= day,
  );
  if (failed !== undefined)
    return { note: `curator: held, ${failed.id} failed today; the next run is admitted tomorrow` };
  let ctx: CuratorContext | null;
  try {
    ctx = curatorContext({ project: queueProject(q.file), queue: q, stateDir: opts.stateDir });
  } catch (err) {
    return { note: `curator: not admitted, ${(err as Error).message}` };
  }
  if (ctx === null || ctx.config.jobs.length === 0) return {};
  const due = dueFor(ctx, opts.ledger ?? readLedgerFile(opts.stateDir));
  if (due.length === 0) return {};
  const id = curatorLineId(new Set([...q.lines.map(l => l.id), ...q.archived.keys()]), now);
  return {
    line: {
      id,
      text: curatorLineText(ctx.config, due),
      difficulty: ctx.config.difficulty,
      priority: ctx.config.priority,
      due,
    },
    note: `curator: added ${id} (${due.map(d => d.job).join(", ")} due)`,
  };
}
