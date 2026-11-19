#!/usr/bin/env node
// wf-skills: the bundled skills the SessionStart hook copies into ~/.claude/skills (src/skills.ts).
//   wf-skills list [--json]         every bundled skill and each one's state: shipped / installed / current, outdated, edited, deleted, available;
//                                   your learned-* skills under their own heading (never shipped, updated or removed)
//   wf-skills add <name>… | --all-stack
//                                   install shipped skills by name; the stack pack (language, domain and tool skills) is
//                                   installed only this way, then kept current like the default set
//   wf-skills diff <name>           your copy against the version this release ships (diff -ru)
//   wf-skills split <name>          move the text you ADDED to an edited bundled copy into learned-<name> and restore the shipped
//                                   text, so the copy is updated again; refuses unless the diff is pure additions
//   wf-skills update <name>…        force the shipped version; an edited copy is saved to <state dir>/skill-backups first
//   wf-skills remove [--state] [--dry-run]
//                                   remove every UNEDITED engine copy, the manifest and the staging directories an interrupted
//                                   update left (.wf-*); an edited copy and a skill the
//                                   engine never shipped stay. --state also removes the engine's state and pool
//                                   directories (sessions, ledger, skill backups, pool log), named first
//   wf-skills sync [--quiet]        what the hook runs on every start (--quiet: only the note about edited copies)
// Run `remove` BEFORE uninstalling the plugin: its scripts go with it, and a session started in between copies the skills again.
// Exit: 0 done · 2 usage or error.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_FILE,
  addSkills,
  editedNote,
  engineVersion,
  learnedSkills,
  planRemove,
  planSkills,
  readManifest,
  removeSkills,
  shippedSkills,
  skillsDir,
  sourceDir,
  splitSkill,
  syncSkills,
  updateSkill,
  type SkillRow,
  type SkillsContext,
} from "./skills.js";
import { resolvePoolDir } from "./pool.js";
import { stateDir, workflowDirs } from "./workflow-dirs.js";

const USAGE =
  "usage: wf-skills list [--json] | add <name>… | add --all-stack | diff <name> | split <name> | update <name>… | remove [--state] [--dry-run] | sync [--quiet]";

class UsageError extends Error {}

function context(): SkillsContext {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return { root, skillsDir: skillsDir(), stateDir: stateDir(), version: engineVersion(root) };
}

const out = (line: string): void => console.log(line);

const LABEL: Record<SkillRow["state"], string> = {
  current: "current",
  outdated: "outdated (unedited: the next start updates it)",
  edited: "edited (kept as it is)",
  missing: "not installed (the next start installs it)",
  available: "stack skill, not installed (wf-skills add <name>)",
  deleted: "deleted by you (stays deleted)",
  retired: "no longer shipped (unedited)",
};

function list(ctx: SkillsContext, json: boolean): void {
  const rows = planSkills(ctx, readManifest(ctx.stateDir));
  if (json) {
    out(
      JSON.stringify(
        rows.map(({ name, shipped, pack, installed, state }) => ({
          name,
          shipped,
          pack,
          installed,
          state,
        })),
        null,
        2,
      ),
    );
    return;
  }
  const width = Math.max(...rows.map(r => r.name.length));
  for (const r of rows) {
    const label =
      r.state === "outdated" && r.action === "none"
        ? "outdated (unedited, but written by another plugin root of this or a newer version: kept)"
        : LABEL[r.state];
    out(
      `${r.name.padEnd(width)}  ${r.shipped ? "shipped" : "       "}  ${r.installed ? "installed" : "         "}  ${label}`,
    );
  }
  const count = (s: SkillRow["state"]): number => rows.filter(r => r.state === s).length;
  out(
    `${rows.length} skill(s) in ${ctx.skillsDir}: ${count("current")} current, ${count("outdated")} outdated, ${count("edited")} edited, ${count("deleted")} deleted, ${count("missing")} not installed, ${count("available")} stack skill(s) available`,
  );
  const learned = learnedSkills(ctx);
  if (learned.length > 0) {
    out("learned (yours: never shipped, updated or removed):");
    for (const name of learned) out(`  ${name}`);
  }
  out(
    readManifest(ctx.stateDir)
      ? `manifest: ${path.join(ctx.stateDir, MANIFEST_FILE)}`
      : `no manifest yet in ${ctx.stateDir}: the next session start adopts the copies above by the history of shipped versions`,
  );
}

function diff(ctx: SkillsContext, name: string): void {
  if (!shippedSkills(ctx.root).has(name)) throw new UsageError(`no bundled skill named ${name}`);
  const mine = path.join(ctx.skillsDir, name);
  if (!fs.existsSync(mine)) {
    out(`${name} is not installed in ${ctx.skillsDir}`);
    return;
  }
  const r = spawnSync("diff", ["-ru", "-x", ".DS_Store", mine, sourceDir(ctx.root, name)], {
    encoding: "utf8",
  });
  out(r.stdout.length > 0 ? r.stdout.trimEnd() : `${name}: your copy equals the shipped version`);
}

function remove(ctx: SkillsContext, flags: ReadonlySet<string>): void {
  const dry = flags.has("--dry-run");
  const poolDir = resolvePoolDir();
  const stateDirs = flags.has("--state") ? [ctx.stateDir, poolDir] : [];
  // the engine creates the global workflow directory at its first start; it goes only while still empty
  const workflows = workflowDirs().global;
  const emptyWorkflows =
    flags.has("--state") && fs.existsSync(workflows) && fs.readdirSync(workflows).length === 0;
  for (const dir of emptyWorkflows ? [...stateDirs, workflows] : stateDirs) {
    if (path.parse(dir).root === dir || dir === os.homedir()) {
      throw new UsageError(`refusing to remove ${dir}`);
    }
  }
  const manifest = path.join(ctx.stateDir, MANIFEST_FILE);
  const hadManifest = fs.existsSync(manifest);
  const plan = dry ? planRemove(ctx) : removeSkills(ctx);
  const pre = dry ? "would remove" : "removed";
  for (const name of plan.remove) out(`${pre} ${path.join(ctx.skillsDir, name)}`);
  for (const name of plan.keep) out(`kept (edited) ${path.join(ctx.skillsDir, name)}`);
  for (const name of plan.scratch)
    out(`${pre} ${path.join(ctx.skillsDir, name)} (interrupted update)`);
  if (hadManifest) out(`${pre} ${manifest}`);
  if (stateDirs.length === 0) {
    out(
      `left in place: ${ctx.stateDir} and ${poolDir} (the ledger and the pool log are yours; --state removes them)`,
    );
  }
  for (const dir of stateDirs) {
    if (!fs.existsSync(dir)) continue;
    out(
      `${pre} ${dir} (sessions, ledger, skill backups, pool log; end every Claude Code session first)`,
    );
    if (!dry) fs.rmSync(dir, { recursive: true, force: true });
  }
  if (emptyWorkflows) {
    out(`${pre} ${workflows} (empty)`);
    if (!dry) fs.rmdirSync(workflows);
  }
}

function sync(ctx: SkillsContext, quiet: boolean): void {
  const r = syncSkills(ctx);
  if (r === null) return;
  for (const e of r.errors) console.error(`wf-skills: ${e}`);
  if (r.errors.length > 0) process.exitCode = 2;
  if (!quiet) {
    out(
      `installed ${r.installed.length}, updated ${r.updated.length}, adopted ${r.adopted.length}, edited kept ${r.edited.length}, deleted by you ${r.deleted.length}`,
    );
  }
  const note = editedNote(r.named, path.join(ctx.root, "scripts", "wf-skills"));
  if (note) out(note);
}

function main(argv: readonly string[]): void {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter(a => a.startsWith("--")));
  const names = rest.filter(a => !a.startsWith("--"));
  const ctx = context();
  const only = (allowed: readonly string[], n: number | "some"): void => {
    const bad = [...flags].find(f => !allowed.includes(f));
    if (bad) throw new UsageError(`unknown flag ${bad}`);
    if (n === "some" ? names.length === 0 : names.length !== n) throw new UsageError(USAGE);
  };
  switch (cmd) {
    case "list":
      only(["--json"], 0);
      return list(ctx, flags.has("--json"));
    case "add": {
      only(["--all-stack"], flags.has("--all-stack") ? 0 : "some");
      const r = addSkills(ctx, names, flags.has("--all-stack"));
      for (const name of r.installed) out(`installed ${name}`);
      for (const name of r.present) {
        out(
          `${name} is already in ${ctx.skillsDir} (wf-skills update ${name} takes the shipped version)`,
        );
      }
      return;
    }
    case "diff":
      only([], 1);
      return diff(ctx, names[0]);
    case "split": {
      only([], 1);
      const r = splitSkill(ctx, names[0]);
      out(
        `moved ${r.sections} added block(s)${r.files.length > 0 ? ` and ${r.files.length} added file(s)` : ""} of ${names[0]} to ${r.learned}; ${names[0]} is the shipped text again`,
      );
      if (r.backup) out(`your edited copy was saved to ${r.backup}`);
      return;
    }
    case "update":
      only([], "some");
      for (const name of names) {
        const backup = updateSkill(ctx, name);
        out(`updated ${name}${backup ? ` (your edited copy saved to ${backup})` : ""}`);
      }
      return;
    case "remove":
      only(["--state", "--dry-run"], 0);
      return remove(ctx, flags);
    case "sync":
      only(["--quiet"], 0);
      return sync(ctx, flags.has("--quiet"));
    default:
      throw new UsageError(USAGE);
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(`wf-skills: ${(err as Error).message}`);
  process.exitCode = 2;
}
