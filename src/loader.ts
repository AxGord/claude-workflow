import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { ZodError } from "zod";
import { resetDeliveredPrompts } from "./tools.js";
import type { WorkflowDefinition, WorkflowFile } from "./types.js";
import {
  WorkflowDefinitionSchema,
  WorkflowFileSchema,
  WorkflowFileObjectSchema,
  StateDefinitionSchema,
  ResourceObjectSchema,
  FanoutObjectSchema,
} from "./types.js";

/** A parsed workflow file of one load tier (bundled, global, project). */
interface TierEntry {
  readonly def: WorkflowFile;
  readonly file: string;
}

type Tier = Map<string, TierEntry>;

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

function nearest(key: string, known: readonly string[]): string {
  let best = known[0];
  for (const k of known) if (editDistance(key, k) < editDistance(key, best)) best = k;
  return best;
}

/** The keys a schema object at `issuePath` accepts (workflow, state, or a state's retry). */
function knownKeysAt(issuePath: readonly (string | number)[]): readonly string[] {
  if (issuePath.length === 0) return Object.keys(WorkflowFileObjectSchema.shape);
  if (issuePath[2] === "retry") return ["max", "interval"];
  if (issuePath[2] === "resource") return Object.keys(ResourceObjectSchema.shape);
  if (issuePath[2] === "fanout") return Object.keys(FanoutObjectSchema.shape);
  return Object.keys(StateDefinitionSchema.shape);
}

/**
 * Turn a schema failure into one line per problem; an unknown key names the
 * file, the state, the key and the nearest known key (a typo is the usual cause).
 */
export function describeSchemaError(file: string, err: ZodError): string {
  return err.issues
    .map(issue => {
      if (issue.code !== "unrecognized_keys") {
        return `${file}: ${issue.path.join(".") || "(root)"}: ${issue.message}`;
      }
      const where =
        issue.path[0] === "states" && issue.path[1] !== undefined
          ? `state "${issue.path[1]}"${issue.path.length > 2 ? ` (${issue.path.slice(2).join(".")})` : ""}`
          : "workflow";
      const known = knownKeysAt(issue.path);
      return issue.keys
        .map(k => `${file}: ${where}: unknown key "${k}" — did you mean "${nearest(k, known)}"?`)
        .join("\n");
    })
    .join("\n");
}

export class Loader {
  private readonly _bundledDir: string | null;
  private readonly _globalDir: string;
  private readonly _projectDir: string | null;
  private _workflows: Map<string, WorkflowDefinition> = new Map();
  private _globalWatcher: fs.FSWatcher | null = null;
  private _projectWatcher: fs.FSWatcher | null = null;

  constructor(bundledDir: string | null, globalDir: string, projectDir: string | null) {
    this._bundledDir = bundledDir;
    this._globalDir = globalDir;
    this._projectDir = projectDir;
    fs.mkdirSync(this._globalDir, { recursive: true });
    if (this._projectDir) fs.mkdirSync(this._projectDir, { recursive: true });
    this._loadAll();
  }

  public get(name: string): WorkflowDefinition | undefined {
    return this._workflows.get(name);
  }

  public getAll(): Map<string, WorkflowDefinition> {
    return new Map(this._workflows);
  }

  public names(): string[] {
    return Array.from(this._workflows.keys());
  }

  /** Directory where create saves new YAML files */
  public getWriteDir(scope?: "project" | "global"): string {
    if (scope === "global") return this._globalDir;
    if (scope === "project") {
      if (!this._projectDir) throw new Error("No project directory available");
      return this._projectDir;
    }
    // Default: project if available, else global
    return this._projectDir ?? this._globalDir;
  }

  /** @deprecated Use getWriteDir() */
  public get writeDir(): string {
    return this.getWriteDir();
  }

  public startWatching(): void {
    this._globalWatcher = this._watchDir(this._globalDir);
    if (this._projectDir) this._projectWatcher = this._watchDir(this._projectDir);
  }

  public stopWatching(): void {
    this._globalWatcher?.close();
    this._globalWatcher = null;
    this._projectWatcher?.close();
    this._projectWatcher = null;
  }

  public reload(): void {
    this._loadAll();
  }

  /** Delete a workflow YAML file. */
  public delete(name: string, scope?: "project" | "global"): string {
    const dirs: string[] = [];
    if (scope !== "global" && this._projectDir) dirs.push(this._projectDir);
    if (scope !== "project") dirs.push(this._globalDir);

    for (const dir of dirs) {
      const fp = this._findFile(dir, name);
      if (fp) {
        fs.unlinkSync(fp);
        return fp;
      }
    }

    const where = scope ?? "project or global";
    throw new Error(`Workflow "${name}" not found in ${where} dir`);
  }

  private _findFile(dir: string, name: string): string | null {
    for (const ext of [".yaml", ".yml"]) {
      const fp = path.join(dir, name + ext);
      if (fs.existsSync(fp)) return fp;
    }
    return null;
  }

  private _watchDir(dir: string): fs.FSWatcher | null {
    try {
      return fs.watch(dir, (_event, filename) => {
        if (filename && (filename.endsWith(".yaml") || filename.endsWith(".yml"))) this._loadAll();
      });
    } catch {
      return null;
    }
  }

  private _loadAll(): void {
    // Template text may have changed — digest_on_repeat states must deliver
    // their (possibly new) full prompt once more before digesting again.
    resetDeliveredPrompts();

    // Bundled (read-only defaults) → global → project: a later tier overrides by name.
    const tiers: Tier[] = [];
    if (this._bundledDir) tiers.push(this._loadDir(this._bundledDir));
    tiers.push(this._loadDir(this._globalDir));
    if (this._projectDir) tiers.push(this._loadDir(this._projectDir));

    const next = new Map<string, WorkflowDefinition>();
    const names = new Set(tiers.flatMap(t => [...t.keys()]));
    for (const name of names) {
      // A file that fails falls back to the same name one tier down, like a
      // file that fails the schema: a half-saved project `testing` must not
      // take `sub_workflow: testing` away from every new session.
      for (
        let found = Loader._find(tiers, name, tiers.length - 1);
        found;
        found = Loader._find(tiers, name, found.tier - 1)
      ) {
        try {
          const merged = WorkflowDefinitionSchema.parse(
            Loader._resolve(tiers, name, found.tier, []),
          );
          const errors = this._validate(merged);
          if (errors.length === 0) {
            next.set(name, merged);
            break;
          }
          console.error(`Validation errors in ${found.entry.file}: ${errors.join("; ")}`);
        } catch (err) {
          console.error(`Failed to load workflow ${found.entry.file}: ${(err as Error).message}`);
        }
      }
    }
    this._workflows = next;
  }

  /** The highest tier at or below `maxTier` that defines `name`. */
  private static _find(
    tiers: readonly Tier[],
    name: string,
    maxTier: number,
  ): { entry: TierEntry; tier: number } | undefined {
    for (let tier = maxTier; tier >= 0; tier--) {
      const entry = tiers[tier].get(name);
      if (entry) return { entry, tier };
    }
    return undefined;
  }

  /**
   * `name` as seen from `maxTier` down, its `extends` chain merged in. A heir
   * extending its own name inherits that name from the tiers below it (a
   * project `coding` over the global/bundled one); another name resolves from
   * the top tier. `chain` holds the `name@tier` links walked so far: a repeat is a cycle.
   */
  private static _resolve(
    tiers: readonly Tier[],
    name: string,
    maxTier: number,
    chain: readonly string[],
  ): object {
    const found = Loader._find(tiers, name, maxTier);
    if (!found) {
      const from =
        chain.length > 0 ? ` (extended by ${chain[chain.length - 1].split("@")[0]})` : "";
      throw new Error(
        `extends "${name}": no such workflow${maxTier < tiers.length - 1 ? " below this tier" : ""}${from}`,
      );
    }
    const link = `${name}@${found.tier}`;
    if (chain.includes(link))
      throw new Error(`extends cycle: ${[...chain, link].map(l => l.split("@")[0]).join(" → ")}`);
    const { extends: baseName, ...own } = found.entry.def;
    if (baseName === undefined) return own;
    const base = Loader._resolve(
      tiers,
      baseName,
      baseName === name ? found.tier - 1 : tiers.length - 1,
      [...chain, link],
    ) as WorkflowFile;
    return {
      name: own.name,
      description: own.description ?? base.description,
      initial: own.initial ?? base.initial,
      max_transitions: own.max_transitions ?? base.max_transitions,
      states: { ...base.states, ...own.states },
    };
  }

  private _loadDir(dir: string): Tier {
    const tier: Tier = new Map();
    if (!fs.existsSync(dir)) return tier;

    const files = fs.readdirSync(dir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));

    for (const file of files) {
      const fp = path.join(dir, file);
      try {
        const raw = fs.readFileSync(fp, "utf-8");
        const parsed = YAML.parse(raw);
        const checked = WorkflowFileSchema.safeParse(parsed);
        if (!checked.success) {
          console.error(`Failed to load workflow:\n${describeSchemaError(fp, checked.error)}`);
          continue;
        }
        tier.set(checked.data.name, { def: checked.data, file: fp });
      } catch (err) {
        console.error(`Failed to load workflow ${fp}:`, err);
      }
    }
    return tier;
  }

  private _validate(wf: WorkflowDefinition): string[] {
    const errors: string[] = [];
    const stateNames = new Set(Object.keys(wf.states));

    if (!stateNames.has(wf.initial)) errors.push(`initial state "${wf.initial}" does not exist`);

    const hasTerminal = Object.values(wf.states).some(s => s.terminal);
    if (!hasTerminal) errors.push("no terminal state defined");

    for (const [name, state] of Object.entries(wf.states)) {
      const isAction = state.type === "exec" || state.type === "fetch";

      if (state.transitions) {
        for (const [tName, tgt] of Object.entries(state.transitions)) {
          if (!stateNames.has(tgt))
            errors.push(`state "${name}" transition "${tName}" → unknown state "${tgt}"`);
        }
      }

      if (state.on_exhausted !== undefined) {
        if (!stateNames.has(state.on_exhausted))
          errors.push(`state "${name}" on_exhausted → unknown state "${state.on_exhausted}"`);
        if (!state.max_visits) errors.push(`state "${name}" on_exhausted needs max_visits`);
      }

      if (isAction) {
        // Action state validation
        if (state.type === "exec" && !state.command)
          errors.push(`state "${name}" type exec requires command`);
        if (state.type === "fetch" && !state.url)
          errors.push(`state "${name}" type fetch requires url`);

        if (state.cases) {
          if (!state.default) errors.push(`state "${name}" has cases but no default`);
          for (const [key, tgt] of Object.entries(state.cases)) {
            if (!stateNames.has(tgt))
              errors.push(`state "${name}" cases "${key}" → unknown state "${tgt}"`);
          }
          if (state.default && !stateNames.has(state.default))
            errors.push(`state "${name}" default → unknown state "${state.default}"`);
        } else {
          if (!state.on_success || !state.on_error)
            errors.push(`state "${name}" action requires on_success + on_error or cases + default`);
          if (state.on_success && !stateNames.has(state.on_success))
            errors.push(`state "${name}" on_success → unknown state "${state.on_success}"`);
          if (state.on_error && !stateNames.has(state.on_error))
            errors.push(`state "${name}" on_error → unknown state "${state.on_error}"`);
        }

        if (state.resource && state.type !== "exec")
          errors.push(`state "${name}" resource is for exec states`);
        if (state.resource && state.background)
          errors.push(`state "${name}" resource cannot hold a lease for a background exec`);
        if (state.fanout && state.type !== "exec")
          errors.push(`state "${name}" fanout is for exec states`);
        if (state.fanout && state.background)
          errors.push(`state "${name}" fanout cannot run as a background exec`);
        if (state.fanout && state.resource)
          errors.push(`state "${name}" fanout leases threads_each per shard; drop resource`);
        if (state.on_timeout !== undefined) {
          if (state.type !== "exec" || state.background)
            errors.push(`state "${name}" on_timeout is for foreground exec states`);
          if (!stateNames.has(state.on_timeout))
            errors.push(`state "${name}" on_timeout → unknown state "${state.on_timeout}"`);
          if (state.cases?.["124"] !== undefined)
            errors.push(`state "${name}" on_timeout and cases "124" both route a timeout`);
        }
        if (state.sub_workflow)
          errors.push(`state "${name}" action state cannot have sub_workflow`);
        if (state.transitions && Object.keys(state.transitions).length > 0)
          errors.push(`state "${name}" action state cannot have transitions`);
      } else {
        // Non-action state validation
        if (!state.prompt && !state.sub_workflow && !state.terminal && !state.skills?.length)
          errors.push(`state "${name}" has no prompt, sub_workflow, terminal, or skills`);

        if (state.sub_workflow && !state.on_complete)
          errors.push(`state "${name}" has sub_workflow but no on_complete`);

        if (state.resource || state.fanout || state.on_timeout !== undefined)
          errors.push(`state "${name}" resource, fanout and on_timeout are for exec states`);
      }

      // terminal + transitions is allowed: "soft terminal" — considered complete
      // but can be re-entered via transitions (useful for top-level confirmation loops)
    }

    return errors;
  }

  public validateReferences(): string[] {
    const errors: string[] = [];
    for (const [wfName, wf] of this._workflows) {
      for (const [stateName, state] of Object.entries(wf.states)) {
        if (state.sub_workflow && !this._workflows.has(state.sub_workflow))
          errors.push(`${wfName}/${stateName}: sub_workflow "${state.sub_workflow}" not found`);
      }
    }
    return errors;
  }

  /**
   * Validate that every required skill referenced in a state's `skills:` list exists
   * in at least one skill directory (plugin bundle, user, or project). Optional skills
   * (`?<name>` prefix) are skipped — they're allowed to be missing.
   *
   * Skill discovery order matches Claude Code's: plugin templates → user (~/.claude/skills/)
   * → project (<cwd>/.claude/skills/). Existence is checked by SKILL.md presence.
   *
   * Returns a flat list of error strings; non-empty result means the workflow set
   * references a non-existent required skill (typo or removed skill).
   */
  public validateSkillReferences(): string[] {
    const errors: string[] = [];

    const skillDirs: string[] = [];
    if (this._bundledDir) skillDirs.push(path.join(this._bundledDir, "skills"));
    skillDirs.push(path.join(os.homedir(), ".claude", "skills"));
    if (this._projectDir) skillDirs.push(path.resolve(this._projectDir, "..", "skills"));

    const exists = (name: string): boolean =>
      skillDirs.some(d => fs.existsSync(path.join(d, name, "SKILL.md")));

    for (const [wfName, wf] of this._workflows) {
      for (const [stateName, state] of Object.entries(wf.states)) {
        if (!state.skills) continue;
        for (const ref of state.skills) {
          if (ref.startsWith("?")) continue;
          if (!exists(ref))
            errors.push(`${wfName}/${stateName}: required skill "${ref}" not found`);
        }
      }
    }
    return errors;
  }
}
