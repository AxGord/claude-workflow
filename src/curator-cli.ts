#!/usr/bin/env node
// wf-curator: the curator service's script steps (src/curator*.ts), for the bundled `curator` workflow's execs and
// for a dry run by hand. The project: `--queue FILE` (its git root; the queue's header may name the config), else
// `--project DIR`, else the cwd's git root.
//   wf-curator due [--queue F|--project D] [--json]   the dry run: each enabled job's interval, count and why it is
//                                                     due; exit 0 some job is due, 10 none (or no config), 2 error
//   wf-curator plan [--queue F|--project D] [--run ID] a run directory for the due jobs (none due: every enabled one);
//                                                     stdout its path; exit 10 when no job is enabled
//   wf-curator counts --run-dir D                     counts/<job>.json per job, by script (no model)
//   wf-curator check-plan --run-dir D                 plan.json checked: exit 0 it has text edits (verify them),
//                                                     20 none, 1 bad shape, 30 missing
//   wf-curator check-verify --run-dir D               verify.json checked against the plan: exit 0, 1 bad, 30 missing
//   wf-curator apply --run-dir D                      the ops the consent allows, one shadow commit each → applied.json
//   wf-curator record --run-dir D                     each job's yield → its next interval (the state); present.md
//   wf-curator history log|diff|revert --target DIR [--rev REV]   the shadow history of a target directory
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CuratorContext,
  CuratorError,
  curatorContext,
  curatorDir,
  curatorStandings,
  memoryDirs,
  memoryFacts,
  parseLedgerText,
  readLedgerFile,
  recordYield,
  stateDir,
  writeCuratorState,
} from "./curator.js";
import { type Plan, applyPlan, needsVerify, parsePlan, parseVerify } from "./curator-apply.js";
import { countJob, skillsDirs } from "./curator-counts.js";
import { historyDiff, historyLog, historyRevert } from "./curator-history.js";
import { projectRoot } from "./pool.js";
import { readQueue, type Queue } from "./queue.js";
import { Storage } from "./storage.js";

const USAGE =
  "usage: wf-curator due|plan [--queue FILE|--project DIR] [--json] [--run ID] | counts|check-plan|check-verify|apply|record --run-dir DIR | history log|diff|revert --target DIR [--rev REV]";

interface Meta {
  readonly run: string;
  readonly project: string;
  readonly queue?: string;
  readonly config: string;
  readonly jobs: readonly string[];
  readonly due: readonly { readonly job: string; readonly reason: string }[];
  readonly started_at: string;
}

function flags(
  args: readonly string[],
  allowed: readonly string[],
  bools: readonly string[] = [],
): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (bools.includes(a)) m.set(a, "1");
    else if (allowed.includes(a)) {
      const v = args[++i];
      if (v === undefined) throw new CuratorError(`${a} needs a value`);
      m.set(a, v);
    } else throw new CuratorError(`unknown argument ${a}\n${USAGE}`);
  }
  return m;
}

function where(f: Map<string, string>): { project: string; queue?: Queue } {
  const q = f.get("--queue");
  if (q !== undefined && q !== "" && !q.startsWith("{{")) {
    const queue = readQueue(path.resolve(q));
    return { project: projectRoot(path.dirname(queue.file)), queue };
  }
  const p = f.get("--project");
  return { project: projectRoot(p !== undefined && p !== "" ? path.resolve(p) : process.cwd()) };
}

function contextOf(w: { project: string; queue?: Queue }): CuratorContext | null {
  return curatorContext({ project: w.project, ...(w.queue ? { queue: w.queue } : {}) });
}

const readMeta = (dir: string): Meta =>
  JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as Meta;

/** The context of a run directory, re-read: the config and state as they are now. */
function runContext(dir: string): { meta: Meta; ctx: CuratorContext; queue?: Queue } {
  const meta = readMeta(dir);
  const queue = meta.queue ? readQueue(meta.queue) : undefined;
  const ctx = contextOf({ project: meta.project, ...(queue ? { queue } : {}) });
  if (ctx === null) throw new CuratorError(`${meta.project}: the curator config is gone`);
  return { meta, ctx, ...(queue ? { queue } : {}) };
}

function liveTasks(): Set<string> {
  const ids = new Set<string>();
  for (const s of new Storage(stateDir(), { eventLog: false }).readAll()) {
    if (!(s.stack?.length > 0)) continue;
    const t = s.context.slice ?? s.context.task;
    if (typeof t === "string") ids.add(t);
  }
  return ids;
}

function targetsOf(ctx: CuratorContext): { memory: string[]; skills: string[] } {
  const memory = ctx.config.jobs.find(j => j.name === "memory");
  const skills = ctx.config.jobs.find(j => j.name === "skills");
  return {
    memory: memory ? memoryDirs(memory, ctx.config.project) : [],
    skills: skills ? skillsDirs(skills, ctx.config.project) : [],
  };
}

function readText(f: string): string | undefined {
  try {
    const t = fs.readFileSync(f, "utf8");
    return t.trim() === "" ? undefined : t;
  } catch {
    return undefined;
  }
}

function present(
  meta: Meta,
  dir: string,
  plan: Plan,
  applied: ReturnType<typeof applyPlan>,
  rows: string[],
): string {
  const lines = [
    `# Curator run ${meta.run}: what the parent does`,
    "",
    `Project ${meta.project}; config ${meta.config}; run directory ${dir} (counts/, plan.json, verify.json, applied.json).`,
    "",
    "## Yield and next interval",
    "",
    "| job | found | changed | interval |",
    "|---|---|---|---|",
    ...rows,
    "",
    "## Done",
    "",
    ...(applied.applied.length === 0
      ? ["nothing applied"]
      : applied.applied.map(
          a =>
            `- ${a.id} (${a.job}) in ${a.target}: commit ${a.commit ?? "none"}; undo: \`wf-curator history revert --target ${a.target} --rev ${a.commit ?? ""}\``,
        )),
    "",
    "## Proposed",
    "",
    ...applied.proposed.map(
      p =>
        `- ${p.id} (${p.job}) ${p.op.op} ${p.op.file ?? p.op.target ?? ""}: ${p.op.reason} [${p.why}]`,
    ),
    ...plan.proposals.map(p => `- ${p}`),
    ...(applied.proposed.length === 0 && plan.proposals.length === 0 ? ["none"] : []),
    "",
    "## User decisions needed",
    "",
    ...(plan.decisions.length === 0 ? ["none"] : plan.decisions.map(d => `- ${d}`)),
    "",
    "Relay Done, Proposed and the decisions to the user. Nothing proposed is applied or queued before the user answers.",
  ];
  return `${lines.join("\n")}\n`;
}

function main(args: string[]): number {
  const cmd = args.shift();
  if (cmd === "due") {
    const f = flags(args, ["--queue", "--project"], ["--json"]);
    const w = where(f);
    const ctx = contextOf(w);
    if (ctx === null) {
      process.stdout.write(
        `no curator config for ${w.project} (.claude/curator.yaml, or the queue header's curator:)\n`,
      );
      return 10;
    }
    const standings = curatorStandings({
      config: ctx.config,
      state: ctx.state,
      ledger: parseLedgerText(readLedgerFile()),
      scope: ctx.scope,
    });
    if (f.has("--json"))
      process.stdout.write(`${JSON.stringify({ config: ctx.config.file, standings }, null, 2)}\n`);
    else {
      process.stdout.write(`curator config ${ctx.config.file} (edits: ${ctx.config.edits})\n`);
      for (const s of standings)
        process.stdout.write(
          `${s.job}\tinterval ${s.interval}\tcount ${s.count}\tlast run ${s.lastRunAt ?? "never"}\t${s.due ? `DUE: ${s.due}` : "-"}\n`,
        );
      const due = standings.filter(s => s.due);
      process.stdout.write(
        due.length > 0 ? `would run now: ${due.map(s => s.job).join(", ")}\n` : "nothing due\n",
      );
    }
    return standings.some(s => s.due) ? 0 : 10;
  }
  if (cmd === "plan") {
    const f = flags(args, ["--queue", "--project", "--run"]);
    const w = where(f);
    const ctx = contextOf(w);
    if (ctx === null || ctx.config.jobs.length === 0) {
      process.stderr.write(`no curator job is enabled for ${w.project}\n`);
      return 10;
    }
    const standings = curatorStandings({
      config: ctx.config,
      state: ctx.state,
      ledger: parseLedgerText(readLedgerFile()),
      scope: ctx.scope,
    });
    const due = standings.filter(s => s.due).map(s => ({ job: s.job, reason: s.due as string }));
    const jobs = due.length > 0 ? due.map(d => d.job) : ctx.config.jobs.map(j => j.name);
    const raw = f.get("--run");
    const run =
      raw !== undefined && /^[A-Za-z0-9._-]+$/.test(raw)
        ? raw
        : `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const dir = path.join(curatorDir(ctx.config.project), "runs", run);
    fs.mkdirSync(path.join(dir, "counts"), { recursive: true });
    const meta: Meta = {
      run,
      project: ctx.config.project,
      ...(ctx.queueFile ? { queue: ctx.queueFile } : {}),
      config: ctx.config.file,
      jobs,
      due,
      started_at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    process.stderr.write(
      `jobs: ${jobs.join(", ")}${due.length > 0 ? ` (due: ${due.map(d => `${d.job}: ${d.reason}`).join("; ")})` : " (none due: every enabled job)"}\n`,
    );
    process.stdout.write(dir);
    return 0;
  }
  if (cmd === "history") {
    const sub = args.shift();
    const f = flags(args, ["--target", "--rev"]);
    const target = f.get("--target");
    if (target === undefined) throw new CuratorError("history needs --target DIR");
    const rev = f.get("--rev");
    const t = path.resolve(target);
    if (sub === "log") process.stdout.write(`${historyLog(t)}\n`);
    else if (sub === "diff" && rev !== undefined) process.stdout.write(`${historyDiff(t, rev)}\n`);
    else if (sub === "revert" && rev !== undefined)
      process.stdout.write(`reverted ${rev}: ${historyRevert(t, rev)}\n`);
    else throw new CuratorError(USAGE);
    return 0;
  }
  const f = flags(args, ["--run-dir"]);
  const dir = f.get("--run-dir");
  if (dir === undefined || cmd === undefined) throw new CuratorError(USAGE);
  const { meta, ctx, queue } = runContext(dir);
  if (cmd === "counts") {
    const ledger = parseLedgerText(readLedgerFile());
    const live = liveTasks();
    for (const name of meta.jobs) {
      const job = ctx.config.jobs.find(j => j.name === name);
      if (!job) continue;
      const r = countJob({ ctx, job, ...(queue ? { queue } : {}), ledger, liveTasks: live });
      fs.writeFileSync(
        path.join(dir, "counts", `${name}.json`),
        `${JSON.stringify(r.json, null, 2)}\n`,
      );
      process.stdout.write(`${r.summary}\n`);
    }
    return 0;
  }
  const planText = readText(path.join(dir, "plan.json"));
  if (cmd === "check-plan") {
    if (planText === undefined) {
      process.stdout.write(`NO PLAN: ${dir}/plan.json is missing or empty\n`);
      return 30;
    }
    const r = parsePlan(planText, meta.jobs);
    if (!r.plan) {
      process.stdout.write(`PLAN SHAPE:\n- ${r.errors.join("\n- ")}\n`);
      return 1;
    }
    const v = needsVerify(r.plan);
    process.stdout.write(
      `plan OK: ${r.plan.ops.length} op(s), ${v.length} text edit(s) to verify${v.length > 0 ? `: ${v.map(o => o.id).join(", ")}` : ""}\n`,
    );
    return v.length > 0 ? 0 : 20;
  }
  const parsed = planText === undefined ? undefined : parsePlan(planText, meta.jobs).plan;
  if (parsed === undefined)
    throw new CuratorError(`${dir}/plan.json: missing or not a valid plan (run check-plan)`);
  const verifyText = readText(path.join(dir, "verify.json"));
  if (cmd === "check-verify") {
    if (verifyText === undefined) {
      process.stdout.write(`NO VERDICTS: ${dir}/verify.json is missing or empty\n`);
      return 30;
    }
    const r = parseVerify(verifyText, parsed);
    if (!r.verdicts) {
      process.stdout.write(`VERIFY SHAPE:\n- ${r.errors.join("\n- ")}\n`);
      return 1;
    }
    const ok = needsVerify(parsed).filter(o => r.verdicts?.[o.id] === "ok").length;
    process.stdout.write(`verify OK: ${ok} of ${needsVerify(parsed).length} text edit(s) passed\n`);
    return 0;
  }
  const verdicts = verifyText === undefined ? {} : (parseVerify(verifyText, parsed).verdicts ?? {});
  if (cmd === "apply") {
    const r = applyPlan(parsed, verdicts, ctx.config, targetsOf(ctx), meta.run);
    fs.writeFileSync(path.join(dir, "applied.json"), `${JSON.stringify(r, null, 2)}\n`);
    process.stdout.write(
      `applied ${r.applied.length}, proposed ${r.proposed.length} (edits: ${ctx.config.edits})\n`,
    );
    return 0;
  }
  if (cmd === "record") {
    const appliedText = readText(path.join(dir, "applied.json"));
    const applied = appliedText
      ? (JSON.parse(appliedText) as ReturnType<typeof applyPlan>)
      : { applied: [], proposed: [] };
    const yields = meta.jobs.map(job => ({
      job,
      found: parsed.jobs[job]?.found ?? 0,
      changed: new Set(applied.applied.filter(a => a.job === job).map(a => a.id)).size,
    }));
    const memory = ctx.config.jobs.find(j => j.name === "memory");
    const bytes =
      memory && meta.jobs.includes("memory")
        ? memoryFacts(memory, ctx.config.project, undefined).indexBytes
        : undefined;
    const next = recordYield(ctx.state, ctx.config, yields, meta.run, new Date(), bytes);
    writeCuratorState(next);
    const rows = yields.map(y => {
      const before =
        ctx.state.jobs[y.job]?.interval ?? ctx.config.jobs.find(j => j.name === y.job)?.every ?? 0;
      return `| ${y.job} | ${y.found} | ${y.changed} | ${before} → ${next.jobs[y.job]?.interval ?? before} |`;
    });
    const file = path.join(dir, "present.md");
    fs.writeFileSync(file, present(meta, dir, parsed, applied, rows));
    process.stdout.write(file);
    return 0;
  }
  throw new CuratorError(USAGE);
}

if (
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`wf-curator: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }

export { main as curatorMain };
