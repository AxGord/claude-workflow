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
  ModelTableObjectSchema,
  ModelRowObjectSchema,
  ModelChoiceObjectSchema,
} from "./types.js";
import { stationWarnings } from "./stations.js";
import { driverRefError } from "./driver.js";
import { POOL_GATE_FILE } from "./pool-gate.js";
import { modelTableErrors } from "./model-table.js";
import {
  TrustStore,
  actionStateNames,
  hashContent,
  projectOfWorkflowsDir,
  untrustedReason,
} from "./trust.js";

/** A parsed workflow file of one load tier (bundled, global, project). */
interface TierEntry {
  readonly def: WorkflowFile;
  readonly file: string;
}

type Tier = Map<string, TierEntry>;

/** A workflow file that did not load (or whose reload was refused), with the loader's reason. */
export interface BrokenFile {
  readonly name: string;
  readonly file: string;
  readonly reason: string;
  /** The bundled template's last good copy is still served: only the new text was refused. */
  readonly stale: boolean;
}

/** The bundled tier as a server read it: handed to a project loader so it never re-reads the live checkout. */
interface BundledTier {
  readonly tier: Tier;
  readonly broken: readonly BrokenFile[];
}

const OLDER_SERVER =
  "this server is older than the template (it does not know that key): restart Claude Code to load the engine that came with it";

/** A project workflow file left out of the load: it declares exec/fetch states and its project is not trusted. */
export interface UntrustedFile {
  readonly name: string;
  readonly file: string;
  readonly hash: string;
}

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

/** The keys a schema object at `issuePath` accepts (workflow, state, a state's retry, the model table). */
function knownKeysAt(issuePath: readonly (string | number)[]): readonly string[] {
  if (issuePath.length === 0) return Object.keys(WorkflowFileObjectSchema.shape);
  if (issuePath[0] === "model_table") {
    if (issuePath[1] === "rows" || issuePath[1] === "stages")
      return Object.keys(ModelRowObjectSchema.shape);
    if (issuePath[1] === "review") return Object.keys(ModelChoiceObjectSchema.shape);
    return Object.keys(ModelTableObjectSchema.shape);
  }
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
          : issue.path.length > 0
            ? issue.path.join(".")
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
  /** The names whose loaded definition is the project tier's own file. */
  private _projectNames: ReadonlySet<string> = new Set();
  /** The files of the project tier that parsed and passed the schema (a later merge or validation can still refuse them: `broken()`). */
  private _projectFiles: readonly TierEntry[] = [];
  private _untrusted: readonly UntrustedFile[] = [];
  private _broken: readonly BrokenFile[] = [];
  /** The bundled tier of the last load; a file that fails the next read keeps its entry here. */
  private _bundled: BundledTier = { tier: new Map(), broken: [] };
  private readonly _inherited: BundledTier | null;
  private readonly _trust: TrustStore;
  private _trustStamp = "none";
  private _claudeStamp = "none";
  private _globalWatcher: fs.FSWatcher | null = null;
  private _projectWatcher: fs.FSWatcher | null = null;

  /** `trust`: what gates the project tier's exec/fetch states (approvals, Claude Code's folder trust); none given, nothing is approved. */
  constructor(
    bundledDir: string | null,
    globalDir: string,
    projectDir: string | null,
    trust: TrustStore = new TrustStore(null),
    inherited: BundledTier | null = null,
  ) {
    this._inherited = inherited;
    this._bundledDir = bundledDir;
    this._globalDir = globalDir;
    this._projectDir = projectDir;
    this._trust = trust;
    fs.mkdirSync(this._globalDir, { recursive: true });
    if (this._projectDir) fs.mkdirSync(this._projectDir, { recursive: true });
    this._loadAll();
  }

  public get(name: string): WorkflowDefinition | undefined {
    this._syncTrust();
    return this._workflows.get(name);
  }

  public getAll(): Map<string, WorkflowDefinition> {
    this._syncTrust();
    return new Map(this._workflows);
  }

  public names(): string[] {
    this._syncTrust();
    return Array.from(this._workflows.keys());
  }

  /** The project files the last load left out for want of the user's approval of their exec/fetch states. */
  public untrusted(): readonly UntrustedFile[] {
    this._syncTrust();
    return this._untrusted;
  }

  /** The files the last load could not read (or refused to reload), each with the loader's reason. */
  public broken(): readonly BrokenFile[] {
    this._syncTrust();
    return this._broken;
  }

  /** What to tell the agent about the files that failed to load (empty when none, or none named by `only`). */
  public brokenNote(only?: string): string {
    return this.broken()
      .filter(b => only === undefined || b.name === only)
      .map(b => `${b.file}: ${b.reason}${b.stale ? " (the last good copy keeps serving)" : ""}`)
      .join("\n");
  }

  /** What to tell the agent about the project files left out (empty when none, or none named by `only`). */
  public untrustedNote(only?: string): string {
    const left = this.untrusted().filter(u => only === undefined || u.name === only);
    if (left.length === 0 || !this._projectDir) return "";
    return (
      `Not loaded: ${left.map(u => `"${u.name}" (${path.basename(u.file)})`).join(", ")} declare${left.length === 1 ? "s" : ""} exec/fetch states, and ` +
      untrustedReason(projectOfWorkflowsDir(this._projectDir), this._trust)
    );
  }

  /** An approval written by `wf-trust` (or a revoked one) takes effect on the next read, without a restart; so does a trust answer given in Claude Code. */
  private _syncTrust(): void {
    if (this._trust.stamp() !== this._trustStamp) {
      this._loadAll();
      return;
    }
    // Claude Code rewrites its config constantly: reload only when it now trusts what was left out.
    const claude = this._trust.claudeStamp();
    if (this._untrusted.length === 0 || claude === this._claudeStamp || !this._projectDir) return;
    this._claudeStamp = claude;
    const root = projectOfWorkflowsDir(this._projectDir);
    if (this._untrusted.some(u => this._trust.allows(root, u.hash))) this._loadAll();
  }

  /** The project tier's directory (`<project>/.claude/workflows`), null when there is none. */
  public get projectDir(): string | null {
    return this._projectDir;
  }

  public get globalDir(): string {
    return this._globalDir;
  }

  /** The name and file of every project-tier file that passed the schema, one per name; a file in `broken()` failed later (its merge or validation). */
  public projectFiles(): readonly { name: string; file: string }[] {
    this._syncTrust();
    return this._projectFiles.map(({ file, def }) => ({ name: def.name, file }));
  }

  /** The workflows the project tier defines itself (not those it only inherits from below). */
  public projectWorkflows(): Map<string, WorkflowDefinition> {
    const own = new Map<string, WorkflowDefinition>();
    for (const name of this._projectNames) {
      const wf = this._workflows.get(name);
      if (wf) own.set(name, wf);
    }
    return own;
  }

  /**
   * The same bundled and global tiers under another project's existing workflow directory: what a
   * session started in that project sees. Loaded once, not watched; the bundled tier is this
   * loader's own, not a second read of a checkout that may have moved under a running server.
   */
  public forProject(projectDir: string): Loader {
    return new Loader(this._bundledDir, this._globalDir, projectDir, this._trust, this._bundled);
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
    this._trustStamp = this._trust.stamp();
    this._claudeStamp = this._trust.claudeStamp();
    const untrusted: UntrustedFile[] = [];
    const failures: BrokenFile[] = [];

    // Bundled (read-only defaults) → global → project: a later tier overrides by name.
    // The bundled files ship with the engine's checkout, so a failing one is the checkout moving
    // under this server: its last good copy stays and a session never loses its template.
    const tiers: Tier[] = [];
    if (this._inherited) {
      this._bundled = this._inherited;
      tiers.push(this._inherited.tier);
      failures.push(...this._inherited.broken);
    } else if (this._bundledDir) {
      this._bundled = this._loadBundled(this._bundledDir, this._bundled);
      tiers.push(this._bundled.tier);
      failures.push(...this._bundled.broken);
    }
    tiers.push(this._loadDir(this._globalDir, failures));
    if (this._projectDir) tiers.push(this._loadDir(this._projectDir, failures, untrusted));

    const next = new Map<string, WorkflowDefinition>();
    const own = new Set<string>();
    const projectTier = this._projectDir ? tiers.length - 1 : -1;
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
            for (const w of stationWarnings(merged)) console.error(w);
            next.set(name, merged);
            if (found.tier === projectTier) own.add(name);
            break;
          }
          console.error(`Validation errors in ${found.entry.file}: ${errors.join("; ")}`);
          if (!failures.some(f => f.file === found.entry.file))
            failures.push({
              name,
              file: found.entry.file,
              reason: errors.join("; "),
              stale: false,
            });
        } catch (err) {
          const message = (err as Error).message;
          console.error(`Failed to load workflow ${found.entry.file}: ${message}`);
          // an heir whose parent failed to load says so, not only that the parent is missing
          const base = /^extends "([^"]+)"/.exec(message)?.[1];
          const baseFailure = failures.find(f => f.name === base && !f.stale);
          if (!failures.some(f => f.file === found.entry.file))
            failures.push({
              name,
              file: found.entry.file,
              reason: baseFailure
                ? `${message}; "${base}" failed to load: ${baseFailure.file}: ${baseFailure.reason}`
                : message,
              stale: false,
            });
        }
      }
    }
    this._workflows = next;
    this._projectNames = own;
    this._projectFiles = projectTier < 0 ? [] : [...tiers[projectTier].values()];
    this._untrusted = untrusted;
    this._broken = failures;
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
      model_table: own.model_table ?? base.model_table,
      driver: own.driver ?? base.driver,
      dispatcher: own.dispatcher ?? base.dispatcher,
      map: own.map ?? base.map,
      states: { ...base.states, ...own.states },
    };
  }

  /**
   * The bundled files are read as one set: they ship together with the checkout, so a file that
   * fails to load or to merge (its own schema, an `extends` chain, validation) means the checkout
   * moved under this server. The whole previous set then keeps serving, marked stale, and a heir
   * re-read from the moved checkout is never paired with a parent of the other version.
   */
  private _loadBundled(dir: string, last: BundledTier): BundledTier {
    const broken: BrokenFile[] = [];
    const tier = this._loadDir(dir, broken, undefined, true);
    for (const [name, entry] of tier) {
      try {
        const errors = this._validate(
          WorkflowDefinitionSchema.parse(Loader._resolve([tier], name, 0, [])),
        );
        if (errors.length > 0)
          broken.push({ name, file: entry.file, reason: errors.join("; "), stale: false });
      } catch (err) {
        broken.push({ name, file: entry.file, reason: (err as Error).message, stale: false });
      }
    }
    if (broken.length === 0 || last.tier.size === 0) return { tier, broken };
    return { tier: last.tier, broken: broken.map(b => ({ ...b, stale: true })) };
  }

  /**
   * `failures` collects the files that did not load. `untrusted` given: the project tier, whose
   * files may run exec/fetch states only once approved. `bundled`: the bundled tier, whose
   * unknown key means the server is older than the template.
   */
  private _loadDir(
    dir: string,
    failures: BrokenFile[],
    untrusted?: UntrustedFile[],
    bundled = false,
  ): Tier {
    const tier: Tier = new Map();
    if (!fs.existsSync(dir)) return tier;
    const fail = (fp: string, name: string, reason: string): void => {
      failures.push({ name, file: fp, reason, stale: false });
    };

    // pool-gate.yaml shares the directory but is the pool gate's config, not a workflow.
    const files = fs
      .readdirSync(dir)
      .filter(f => (f.endsWith(".yaml") || f.endsWith(".yml")) && f !== POOL_GATE_FILE);

    for (const file of files) {
      const fp = path.join(dir, file);
      try {
        const raw = fs.readFileSync(fp, "utf-8");
        const parsed = YAML.parse(raw);
        const declared = (parsed as { name?: unknown } | null)?.name;
        const fallbackName = typeof declared === "string" ? declared : file.replace(/\.ya?ml$/, "");
        const checked = WorkflowFileSchema.safeParse(parsed);
        if (!checked.success) {
          const described = describeSchemaError(fp, checked.error);
          console.error(`Failed to load workflow:\n${described}`);
          const newer = bundled && checked.error.issues.some(i => i.code === "unrecognized_keys");
          fail(
            fp,
            fallbackName,
            described.replaceAll(`${fp}: `, "") + (newer ? `; ${OLDER_SERVER}` : ""),
          );
          continue;
        }
        if (untrusted && actionStateNames(checked.data.states).length > 0) {
          const hash = hashContent(raw);
          const root = projectOfWorkflowsDir(dir);
          if (!this._trust.allows(root, hash)) {
            untrusted.push({ name: checked.data.name, file: fp, hash });
            console.error(
              `Not loaded: ${fp} declares exec/fetch states, and ${untrustedReason(root, this._trust)}`,
            );
            continue;
          }
        }
        tier.set(checked.data.name, { def: checked.data, file: fp });
      } catch (err) {
        console.error(`Failed to load workflow ${fp}:`, err);
        fail(fp, file.replace(/\.ya?ml$/, ""), (err as Error).message);
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
    if (wf.model_table) errors.push(...modelTableErrors(wf.model_table, stateNames, wf.states));
    if (wf.driver) {
      const refError = driverRefError(wf.driver);
      if (refError) errors.push(refError);
      const first = wf.states[wf.initial];
      if (
        first &&
        (first.type === "exec" || first.type === "fetch" || first.sub_workflow || first.skills)
      )
        errors.push(
          `driver: the initial state "${wf.initial}" must be a prompt state (start answers with the driver's call there)`,
        );
    }

    if (wf.dispatcher) {
      const refError = driverRefError(wf.dispatcher);
      if (refError) errors.push(refError.replace(/^driver\./, "dispatcher."));
      if (wf.driver)
        errors.push("dispatcher: a workflow declares `driver:` or `dispatcher:`, not both");
      const after = wf.dispatcher.after;
      if (after !== undefined && !stateNames.has(after))
        errors.push(`dispatcher.after: state "${after}" does not exist`);
    }

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

      if (state.stale_after !== undefined && (state.terminal || state.sub_workflow))
        errors.push(
          `state "${name}" stale_after is never read on a ${state.terminal ? "terminal" : "sub_workflow"} state`,
        );

      if (
        state.queue_mark !== undefined &&
        (!state.terminal || Object.keys(state.transitions ?? {}).length > 0)
      )
        errors.push(
          `state "${name}" queue_mark is read only on a terminal state with no transitions (the one that ends the session)`,
        );

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
