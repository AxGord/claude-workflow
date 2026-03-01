import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { WorkflowDefinition } from "./types.js";
import { WorkflowDefinitionSchema } from "./types.js";

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
      if (fp) { fs.unlinkSync(fp); return fp; }
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
        if (filename && (filename.endsWith(".yaml") || filename.endsWith(".yml")))
          this._loadAll();
      });
    } catch {
      return null;
    }
  }

  private _loadAll(): void {
    const next = new Map<string, WorkflowDefinition>();

    // Load bundled first (read-only defaults)
    if (this._bundledDir) this._loadDir(this._bundledDir, next);

    // Global overrides bundled
    this._loadDir(this._globalDir, next);

    // Project overrides global
    if (this._projectDir) this._loadDir(this._projectDir, next);

    this._workflows = next;
  }

  private _loadDir(dir: string, target: Map<string, WorkflowDefinition>): void {
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));

    for (const file of files) {
      const fp = path.join(dir, file);
      try {
        const raw = fs.readFileSync(fp, "utf-8");
        const parsed = YAML.parse(raw);
        const validated = WorkflowDefinitionSchema.parse(parsed);
        const errors = this._validate(validated);
        if (errors.length > 0) {
          console.error(`Validation errors in ${fp}: ${errors.join("; ")}`);
          continue;
        }
        target.set(validated.name, validated);
      } catch (err) {
        console.error(`Failed to load workflow ${fp}:`, err);
      }
    }
  }

  private _validate(wf: WorkflowDefinition): string[] {
    const errors: string[] = [];
    const stateNames = new Set(Object.keys(wf.states));

    if (!stateNames.has(wf.initial))
      errors.push(`initial state "${wf.initial}" does not exist`);

    const hasTerminal = Object.values(wf.states).some(s => s.terminal);
    if (!hasTerminal)
      errors.push("no terminal state defined");

    for (const [name, state] of Object.entries(wf.states)) {
      if (state.transitions) {
        for (const [tName, tgt] of Object.entries(state.transitions)) {
          if (!stateNames.has(tgt))
            errors.push(`state "${name}" transition "${tName}" → unknown state "${tgt}"`);
        }
      }

      if (!state.prompt && !state.sub_workflow && !state.terminal)
        errors.push(`state "${name}" has no prompt, sub_workflow, or terminal flag`);

      if (state.sub_workflow && !state.on_complete)
        errors.push(`state "${name}" has sub_workflow but no on_complete`);

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
}
