// The curator's COUNTS: what each job's judge reads, computed by script, no model. Memory: the files, their
// indexes, orphans, dangling links, the index budget. Hygiene: the queue lines that break a check. Calibration: the
// ledger's rows since the last run and each model-table change's lands before and after. Lessons: unfiled triage
// rows and owed steps. Skills: tool-error shapes repeated across transcripts, skill usage, earlier edits' effect.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { calibrate, reviewRounds } from "./calibration.js";
import {
  type CuratorContext,
  INDEX_BUDGET_DEFAULT,
  type JobConfig,
  configPath,
  indexNameOf,
  isCuratorLineId,
  landsSince,
  memoryDirs,
  projectDirName,
  stateDir,
} from "./curator.js";
import { historyGitDir, historyLog } from "./curator-history.js";
import type { LedgerEntry } from "./ledger.js";
import { owedDueLines, type Queue } from "./queue.js";

const LINK_RE = /\]\(([^)\s]+\.md)\)/g;

// ---- memory ----

export interface MemoryFileFacts {
  readonly name: string;
  readonly bytes: number;
  /** The file has a frontmatter `description:` (what recall works off). */
  readonly description: boolean;
  /** The index files that link it. */
  readonly indexes: readonly string[];
}

export interface MemoryDirFacts {
  readonly dir: string;
  readonly indexes: readonly {
    readonly name: string;
    readonly bytes: number;
    readonly links: number;
  }[];
  readonly indexBudget: { readonly name: string; readonly bytes: number; readonly budget: number };
  readonly files: readonly MemoryFileFacts[];
  /** Topic files no index links. */
  readonly orphans: readonly string[];
  /** Index links to a file that does not exist. */
  readonly dangling: readonly { readonly index: string; readonly target: string }[];
  /** Topic files linked from more than one index (each belongs in exactly one). */
  readonly multiIndexed: readonly string[];
  readonly newSinceLastRun: readonly string[];
}

/** The index files of a memory dir: `indexes:` of the job, else its `index:` and every all-caps `*.md` (PARENT.md, ARCHIVE.md). */
function indexNames(job: JobConfig, names: readonly string[]): string[] {
  const listed = job.options.indexes;
  if (Array.isArray(listed)) return listed.map(String);
  const main = indexNameOf(job);
  return names.filter(n => n === main || /^[A-Z][A-Z0-9_-]*\.md$/.test(n));
}

export function memoryCounts(
  job: JobConfig,
  project: string,
  since: string | undefined,
): MemoryDirFacts[] {
  const from = since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(since);
  const budget =
    typeof job.options.index_budget_bytes === "number"
      ? job.options.index_budget_bytes
      : INDEX_BUDGET_DEFAULT;
  const out: MemoryDirFacts[] = [];
  for (const dir of memoryDirs(job, project)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter(n => n.endsWith(".md"));
    } catch {
      continue;
    }
    names.sort();
    const idx = indexNames(job, names);
    const linkedBy = new Map<string, string[]>();
    const dangling: { index: string; target: string }[] = [];
    const indexes = idx.map(name => {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      let links = 0;
      for (const m of text.matchAll(LINK_RE)) {
        const target = m[1];
        if (target.includes("/")) continue;
        links++;
        if (!names.includes(target)) dangling.push({ index: name, target });
        linkedBy.set(target, [...(linkedBy.get(target) ?? []), name]);
      }
      return { name, bytes: Buffer.byteLength(text), links };
    });
    const files: MemoryFileFacts[] = [];
    const fresh: string[] = [];
    for (const name of names) {
      if (idx.includes(name)) continue;
      const f = path.join(dir, name);
      const text = fs.readFileSync(f, "utf8");
      const st = fs.statSync(f);
      if ((st.birthtimeMs || st.mtimeMs) > from) fresh.push(name);
      const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
      files.push({
        name,
        bytes: Buffer.byteLength(text),
        description: /^description:\s*\S/m.test(front),
        indexes: [...new Set(linkedBy.get(name) ?? [])],
      });
    }
    const main = indexes.find(i => i.name === indexNameOf(job));
    out.push({
      dir,
      indexes,
      indexBudget: { name: indexNameOf(job), bytes: main?.bytes ?? 0, budget },
      files,
      orphans: files.filter(f => f.indexes.length === 0).map(f => f.name),
      dangling,
      multiIndexed: files.filter(f => f.indexes.length > 1).map(f => f.name),
      newSinceLastRun: fresh,
    });
  }
  return out;
}

// ---- hygiene ----

export interface HygieneFinding {
  readonly id: string;
  readonly check: string;
  readonly detail: string;
}

const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);

function matches(value: string | undefined, pattern: unknown): boolean {
  if (typeof pattern !== "string") return false;
  try {
    return new RegExp(pattern).test(value ?? "");
  } catch {
    return false;
  }
}

/**
 * The queue's lines that break a check: a pending line without a required key (`require:`, default workflow and
 * touches), a research line whose workflow is no research workflow, a running line no live session runs, a
 * duplicate text, a project rule (`rules: [{match: {key: regex}, require: [key] | {key: regex}}]`), a forbidden word.
 */
export function hygieneFindings(
  queue: Queue,
  job: JobConfig,
  project: string,
  liveTasks: ReadonlySet<string>,
): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  const require = Array.isArray(job.options.require)
    ? job.options.require.map(String)
    : ["workflow", "touches"];
  const rules = Array.isArray(job.options.rules) ? job.options.rules : [];
  const words = Array.isArray(job.options.forbid_words) ? job.options.forbid_words.map(String) : [];
  const research = ["yaml", "yml"].some(x =>
    fs.existsSync(path.join(project, ".claude", "workflows", `research-task.${x}`)),
  );
  const texts = new Map<string, string>();
  const field = (l: Queue["lines"][number], k: string): string | undefined =>
    k === "id" ? l.id : k === "status" ? l.status : k === "text" ? l.text : l.meta[k];
  for (const l of queue.lines) {
    if (isCuratorLineId(l.id)) continue;
    const open =
      l.status === "pending" ||
      l.status === "backlog" ||
      l.status === "running" ||
      l.status === "awaiting";
    if (l.status === "pending")
      for (const k of require)
        if (field(l, k) === undefined) out.push({ id: l.id, check: "require", detail: `no ${k}:` });
    if (open && l.meta.kind === "research") {
      const wf = l.meta.workflow;
      if (wf !== undefined ? !wf.includes("research") : !research)
        out.push({
          id: l.id,
          check: "research",
          detail:
            wf !== undefined
              ? `workflow ${wf} is not a research workflow`
              : "no research-task in the project",
        });
    }
    if (l.status === "running" && !liveTasks.has(l.id))
      out.push({ id: l.id, check: "stuck", detail: "running, and no live session runs it" });
    if (l.status === "awaiting" && !liveTasks.has(l.id))
      out.push({ id: l.id, check: "stuck", detail: "awaiting, and no live session waits for it" });
    if (open && l.text !== "") {
      const key = norm(l.text);
      const first = texts.get(key);
      if (first !== undefined)
        out.push({ id: l.id, check: "duplicate", detail: `same text as ${first}` });
      else texts.set(key, l.id);
    }
    if (open)
      for (const r of rules) {
        if (typeof r !== "object" || r === null) continue;
        const rule = r as { match?: Record<string, unknown>; require?: unknown };
        const when = Object.entries(rule.match ?? {});
        if (when.length === 0 || !when.every(([k, p]) => matches(field(l, k), p))) continue;
        const req = rule.require;
        if (Array.isArray(req)) {
          for (const k of req.map(String))
            if (field(l, k) === undefined)
              out.push({
                id: l.id,
                check: "rule",
                detail: `matches ${JSON.stringify(rule.match)}: no ${k}:`,
              });
        } else if (typeof req === "object" && req !== null) {
          for (const [k, p] of Object.entries(req))
            if (!matches(field(l, k), p))
              out.push({
                id: l.id,
                check: "rule",
                detail: `matches ${JSON.stringify(rule.match)}: ${k} is ${JSON.stringify(field(l, k) ?? null)}, wants /${String(p)}/`,
              });
        }
      }
    const all = [l.id, l.text, ...l.notes.map(n => n.text)].join("\n").toLowerCase();
    for (const w of words)
      if (w !== "" && all.includes(w.toLowerCase()))
        out.push({ id: l.id, check: "forbidden-word", detail: `holds "${w}"` });
  }
  return out;
}

// ---- calibration ----

interface Aggregate {
  readonly tasks: number;
  readonly review_rounds_mean: number;
  readonly usd_mean: number | null;
  readonly escalations: number;
}

function aggregate(lands: readonly LedgerEntry[]): Aggregate {
  const usd = lands.filter(e => e.spend?.usd !== undefined).map(e => e.spend?.usd ?? 0);
  const mean = (xs: readonly number[]): number =>
    xs.length === 0 ? 0 : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;
  return {
    tasks: lands.length,
    review_rounds_mean: mean(lands.map(e => reviewRounds(e.visits))),
    usd_mean: usd.length === 0 ? null : mean(usd),
    escalations: lands.reduce((a, e) => a + (e.escalations ?? 0), 0),
  };
}

export interface TuningChange {
  readonly file: string;
  readonly workflow: string;
  readonly commit: string;
  readonly at: string;
  readonly subject: string;
  /** The workflow's lands in the same span of time before and after the change. */
  readonly before: Aggregate;
  readonly after: Aggregate;
}

/** The project workflow files that carry a `model_table:`: `workflows:` dirs of the job, else `.claude/workflows`. */
function tunedWorkflows(job: JobConfig, project: string): { file: string; name: string }[] {
  const dirs = Array.isArray(job.options.workflows)
    ? job.options.workflows.map(d => configPath(project, String(d)))
    : [path.join(project, ".claude", "workflows")];
  const out: { file: string; name: string }[] = [];
  for (const d of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(d).filter(n => /\.ya?ml$/.test(n));
    } catch {
      continue;
    }
    for (const n of names.sort()) {
      const file = path.join(d, n);
      try {
        const doc = YAML.parse(fs.readFileSync(file, "utf8")) as {
          name?: unknown;
          model_table?: unknown;
        };
        if (doc && doc.model_table !== undefined)
          out.push({
            file,
            name: typeof doc.name === "string" ? doc.name : n.replace(/\.ya?ml$/, ""),
          });
      } catch {
        // a damaged file is the loader's to report
      }
    }
  }
  return out;
}

/** The last changes of each tuned workflow file (git log), with its lands before and after each. */
export function tuningChanges(
  job: JobConfig,
  project: string,
  entries: readonly LedgerEntry[],
): TuningChange[] {
  const out: TuningChange[] = [];
  for (const w of tunedWorkflows(job, project)) {
    let log = "";
    try {
      log = execFileSync("git", ["log", "-3", "--format=%H%x09%cI%x09%s", "--", w.file], {
        cwd: path.dirname(w.file),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      continue; // not under git: no history to judge
    }
    const lands = entries.filter(e => e.workflow === w.name);
    for (const line of log.split("\n").filter(Boolean)) {
      const [commit, at, subject] = line.split("\t");
      const t = Date.parse(at);
      const after = lands.filter(e => Date.parse(e.ended_at) > t);
      const span = after.length === 0 ? 0 : Math.max(...after.map(e => Date.parse(e.ended_at))) - t;
      const before = lands.filter(e => {
        const x = Date.parse(e.ended_at);
        return x <= t && x > t - Math.max(span, 7 * 86_400_000);
      });
      out.push({
        file: w.file,
        workflow: w.name,
        commit,
        at,
        subject: subject ?? "",
        before: aggregate(before),
        after: aggregate(after),
      });
    }
  }
  return out;
}

// ---- lessons ----

/** The triage file of a queue: the header's `lessons_triage:` (relative = beside the queue), else the default beside it. */
export function triageFileOf(queue: Queue): string {
  const dir = path.dirname(queue.file);
  const head = queue.header.lessons_triage?.trim();
  return head
    ? path.resolve(dir, head)
    : path.resolve(dir, "..", "backups", "slice-logs", "lessons-triage.txt");
}

// ---- skills ----

export interface ErrorShape {
  readonly shape: string;
  /** Distinct transcripts it appears in. */
  readonly transcripts: number;
  readonly count: number;
  readonly example: string;
}

/** A tool error's shape: its first line with paths, numbers, quoted text and ids written as placeholders. */
export function errorShape(text: string): string {
  const first = text.split("\n").find(l => l.trim() !== "") ?? "";
  return first
    .replace(/<\/?tool_use_error>/g, "")
    .replace(/(["'`])(?:(?!\1).){0,200}\1/g, "<q>")
    .replace(/(?:~|\.{0,2})\/[^\s:,)]+/g, "<path>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    .replace(/\d+(?:\.\d+)?/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function resultText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map(x =>
        typeof x === "object" && x !== null && typeof (x as { text?: unknown }).text === "string"
          ? (x as { text: string }).text
          : "",
      )
      .join("\n");
  return "";
}

export interface TranscriptFacts {
  readonly files: number;
  readonly shapes: readonly ErrorShape[];
  /** Skill name → times it was loaded (the Skill tool) or one of its files read. */
  readonly usage: Readonly<Record<string, number>>;
}

/** All `.jsonl` files under `dir` changed after `since`, newest first, at most `max`. */
export function transcriptFiles(dir: string, since: string | undefined, max = 400): string[] {
  const from = since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(since);
  const found: { f: string; t: number }[] = [];
  const walk = (d: string, depth: number): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < 3 && e.name !== "memory") walk(f, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        const t = fs.statSync(f).mtimeMs;
        if (t > from) found.push({ f, t });
      }
    }
  };
  walk(dir, 0);
  return found
    .sort((a, b) => b.t - a.t)
    .slice(0, max)
    .map(x => x.f);
}

/** The error shapes seen in `min` or more transcripts, and the skills' usage, over `files`. */
export function transcriptFacts(
  files: readonly string[],
  skillsDirs: readonly string[],
  min = 3,
): TranscriptFacts {
  const shapes = new Map<string, { files: Set<string>; count: number; example: string }>();
  const usage: Record<string, number> = {};
  const skillOf = (p: string): string | undefined => {
    for (const d of skillsDirs) {
      const rel = path.relative(d, p);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep)[0];
    }
    return undefined;
  };
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"tool_result"') && !line.includes('"tool_use"')) continue;
      let j: { message?: { content?: unknown } };
      try {
        j = JSON.parse(line) as typeof j;
      } catch {
        continue;
      }
      const content = Array.isArray(j.message?.content) ? (j.message?.content as unknown[]) : [];
      for (const c of content) {
        if (typeof c !== "object" || c === null) continue;
        const b = c as {
          type?: string;
          is_error?: boolean;
          content?: unknown;
          name?: string;
          input?: Record<string, unknown>;
        };
        if (b.type === "tool_result" && b.is_error === true) {
          const raw = resultText(b.content);
          const shape = errorShape(raw);
          if (shape === "") continue;
          const s = shapes.get(shape) ?? {
            files: new Set<string>(),
            count: 0,
            example: raw.slice(0, 300),
          };
          s.files.add(f);
          s.count++;
          shapes.set(shape, s);
        } else if (b.type === "tool_use") {
          const name =
            b.name === "Skill" && typeof b.input?.skill === "string"
              ? b.input.skill
              : b.name === "Read" && typeof b.input?.file_path === "string"
                ? skillOf(b.input.file_path)
                : undefined;
          if (name !== undefined) usage[name] = (usage[name] ?? 0) + 1;
        }
      }
    }
  }
  return {
    files: files.length,
    shapes: [...shapes]
      .filter(([, s]) => s.files.size >= min)
      .map(([shape, s]) => ({
        shape,
        transcripts: s.files.size,
        count: s.count,
        example: s.example,
      }))
      .sort((a, b) => b.transcripts - a.transcripts || b.count - a.count),
    usage,
  };
}

/** The skills directories of a job: `dirs:`, else `CLAUDE_SKILLS_DIR`, else `~/.claude/skills`. */
export function skillsDirs(job: JobConfig, project: string): string[] {
  if (Array.isArray(job.options.dirs) && job.options.dirs.length > 0)
    return job.options.dirs.map(d => configPath(project, String(d)));
  return [process.env.CLAUDE_SKILLS_DIR ?? path.join(os.homedir(), ".claude", "skills")];
}

/** The transcript directory of a job: `transcripts:`, else the project's Claude Code directory. */
export function transcriptsDir(job: JobConfig, project: string): string {
  if (typeof job.options.transcripts === "string")
    return configPath(project, job.options.transcripts);
  const home = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(home, "projects", projectDirName(project));
}

export interface SkillFacts {
  readonly dir: string;
  readonly skills: readonly {
    readonly name: string;
    readonly bytes: number;
    readonly references: boolean;
    /** `preferences-*`: the user's own taste, only ever proposed. */
    readonly preference: boolean;
    readonly learned: boolean;
    readonly uses: number;
  }[];
}

/** An earlier applied edit that named the error shape it should reduce, measured on the transcripts since. */
export interface EditEffect {
  readonly target: string;
  readonly commit: string;
  readonly subject: string;
  readonly shape: string;
  /** The shape's transcripts when the edit was made, and since. */
  readonly before: number;
  readonly since: number;
}

function skillInventory(dir: string, usage: Readonly<Record<string, number>>): SkillFacts {
  let ents: fs.Dirent[] = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // no such dir
  }
  const skills = ents
    .filter(e => e.isDirectory())
    .map(e => {
      const f = path.join(dir, e.name, "SKILL.md");
      let bytes = 0;
      try {
        bytes = fs.statSync(f).size;
      } catch {
        return null;
      }
      return {
        name: e.name,
        bytes,
        references: fs.existsSync(path.join(dir, e.name, "references")),
        preference: e.name.startsWith("preferences"),
        learned: e.name.startsWith("learned-"),
        uses: usage[e.name] ?? 0,
      };
    })
    .filter(<T>(x: T | null): x is T => x !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { dir, skills };
}

/** The applied edits of a target whose commit body names `shape: <shape>` and `shape_transcripts: <n>`. */
function editEffects(
  target: string,
  transcripts: string,
  skills: readonly string[],
  dir: string,
): EditEffect[] {
  const out: EditEffect[] = [];
  for (const line of historyLog(target, dir).split("\n").filter(Boolean)) {
    const commit = line.slice(0, 40);
    let body = "";
    let at = "";
    try {
      body = execFileSync(
        "git",
        [`--git-dir=${historyGitDir(target, dir)}`, "show", "-s", "--format=%cI%n%b", commit],
        {
          encoding: "utf8",
        },
      );
    } catch {
      continue;
    }
    [at = ""] = body.split("\n");
    const shape = /^shape: (.+)$/m.exec(body)?.[1];
    if (shape === undefined) continue;
    const before = Number(/^shape_transcripts: (\d+)$/m.exec(body)?.[1] ?? "0");
    const now = transcriptFacts(transcriptFiles(transcripts, at), skills, 1).shapes.find(
      s => s.shape === shape,
    );
    out.push({
      target,
      commit,
      subject: line.slice(41),
      shape,
      before,
      since: now?.transcripts ?? 0,
    });
  }
  return out;
}

// ---- one job ----

export interface CountInput {
  readonly ctx: CuratorContext;
  readonly job: JobConfig;
  readonly queue?: Queue;
  readonly ledger: readonly LedgerEntry[];
  readonly liveTasks: ReadonlySet<string>;
  readonly stateDir?: string;
}

/** One job's counts, as the JSON the judge reads (`counts/<job>.json`), and a one-line summary. */
export function countJob(input: CountInput): { readonly json: unknown; readonly summary: string } {
  const { ctx, job } = input;
  const project = ctx.config.project;
  const since = ctx.state.jobs[job.name]?.last_run_at;
  const dir = input.stateDir ?? stateDir();
  switch (job.bundled ? job.name : "project") {
    case "memory": {
      const dirs = memoryCounts(job, project, since);
      const n = dirs.reduce(
        (a, d) =>
          a +
          d.orphans.length +
          d.dangling.length +
          d.multiIndexed.length +
          d.files.filter(f => !f.description).length +
          (d.indexBudget.bytes > d.indexBudget.budget ? 1 : 0),
        0,
      );
      return {
        json: { job: job.name, since: since ?? null, dirs },
        summary: `memory: ${dirs.length} dir(s), ${n} mechanical finding(s)`,
      };
    }
    case "hygiene": {
      if (!input.queue)
        return {
          json: { job: job.name, findings: [], note: "no queue" },
          summary: "hygiene: no queue",
        };
      const findings = hygieneFindings(input.queue, job, project, input.liveTasks);
      return {
        json: { job: job.name, queue: input.queue.file, findings },
        summary: `hygiene: ${findings.length} finding(s)`,
      };
    }
    case "calibration": {
      const lands = landsSince(input.ledger, ctx.scope, since);
      const all = landsSince(input.ledger, ctx.scope, undefined);
      const rows = calibrate(lands);
      const changes = tuningChanges(job, project, all);
      return {
        json: {
          job: job.name,
          since: since ?? null,
          lands: lands.length,
          rows,
          tuning_changes: changes,
        },
        summary: `calibration: ${lands.length} new land(s), ${rows.length} row(s), ${changes.length} tuning change(s)`,
      };
    }
    case "lessons": {
      if (!input.queue)
        return { json: { job: job.name, triage: [], owed: [] }, summary: "lessons: no queue" };
      const triage = triageFileOf(input.queue);
      let rows: string[] = [];
      try {
        rows = fs
          .readFileSync(triage, "utf8")
          .split("\n")
          .filter(l => l.trim() !== "");
      } catch {
        // no triage file: nothing unfiled
      }
      const owed = owedDueLines(input.queue);
      return {
        json: { job: job.name, triage_file: triage, triage: rows, owed },
        summary: `lessons: ${rows.length} triage row(s), ${owed.length} owed step(s)`,
      };
    }
    case "skills": {
      const skills = skillsDirs(job, project);
      const tdir = transcriptsDir(job, project);
      const min = typeof job.options.min_transcripts === "number" ? job.options.min_transcripts : 3;
      const facts = transcriptFacts(transcriptFiles(tdir, since), skills, min);
      const effects = skills.flatMap(s => editEffects(s, tdir, skills, dir));
      return {
        json: {
          job: job.name,
          since: since ?? null,
          transcripts_dir: tdir,
          transcripts: facts.files,
          error_shapes: facts.shapes,
          inventory: skills.map(s => skillInventory(s, facts.usage)),
          earlier_edits: effects,
        },
        summary: `skills: ${facts.files} transcript(s), ${facts.shapes.length} repeated error shape(s), ${effects.length} earlier edit(s) to judge`,
      };
    }
    default: {
      const command = typeof job.options.command === "string" ? job.options.command : undefined;
      if (command === undefined)
        return {
          json: { job: job.name, prompt: job.options.prompt },
          summary: `${job.name}: no command`,
        };
      const r = spawnSync("sh", ["-c", command], {
        cwd: project,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 1 << 20,
      });
      const stdout = (r.stdout ?? "").slice(0, 65_536);
      return {
        json: {
          job: job.name,
          prompt: job.options.prompt,
          command,
          exit: r.status,
          stdout,
          stderr: (r.stderr ?? "").slice(0, 4096),
        },
        summary: `${job.name}: command exit ${String(r.status)}, ${stdout.split("\n").filter(Boolean).length} line(s)`,
      };
    }
  }
}
