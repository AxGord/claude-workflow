import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { SessionState, StateDefinition, WorkflowOverrides } from "./types.js";
import { WorkflowDefinitionSchema } from "./types.js";
import type { Storage } from "./storage.js";
import type { Loader } from "./loader.js";
import type { Engine } from "./engine.js";

export interface ModifyInput {
  readonly add_state?: { readonly name: string } & Partial<StateDefinition>;
  readonly add_transition?: {
    readonly from: string;
    readonly name: string;
    readonly to: string;
  };
  readonly remove_transition?: {
    readonly from: string;
    readonly name: string;
  };
}

export class Modifier {
  private readonly _storage: Storage;
  private readonly _loader: Loader;
  private _engine?: Engine;

  constructor(storage: Storage, loader: Loader) {
    this._storage = storage;
    this._loader = loader;
  }

  /** Late-bind engine to break circular dependency (Engine ↔ Modifier). */
  public setEngine(engine: Engine): void {
    this._engine = engine;
  }

  public async modify(sessionId: string, changes: ModifyInput): Promise<string[]> {
    const session = this._storage.read(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    if (session.stack.length === 0) throw new Error("No active workflow to modify");

    // When pending_pop is active, overlays target the parent frame's workflow
    // (the child completed but couldn't pop because parent lacks on_complete/on_fail)
    let frame = session.stack[session.active_frame];
    if (session.pending_pop && session.active_frame > 0)
      frame = session.stack[session.active_frame - 1];
    const wfName = frame.workflow;
    const messages: string[] = [];

    const existing = session.overrides[wfName] ?? {};
    const updated: WorkflowOverrides = { ...existing };

    if (changes.add_state) {
      const { name, ...stateDef } = changes.add_state;
      const isAction = stateDef.type === "exec" || stateDef.type === "fetch";
      if (isAction && stateDef.sub_workflow) {
        throw new Error(`State "${name}": action state cannot have sub_workflow`);
      }
      const addStates = { ...(updated.add_states ?? {}), [name]: stateDef as StateDefinition };
      (updated as Record<string, unknown>).add_states = addStates;
      messages.push(`Added state "${name}"`);
    }

    if (changes.add_transition) {
      const addTransitions = [...(updated.add_transitions ?? []), changes.add_transition];
      (updated as Record<string, unknown>).add_transitions = addTransitions;
      messages.push(`Added transition "${changes.add_transition.from}" --${changes.add_transition.name}--> "${changes.add_transition.to}"`);
    }

    if (changes.remove_transition) {
      const removeTransitions = [...(updated.remove_transitions ?? []), changes.remove_transition];
      (updated as Record<string, unknown>).remove_transitions = removeTransitions;
      messages.push(`Removed transition "${changes.remove_transition.name}" from "${changes.remove_transition.from}"`);
    }

    const updatedSession: SessionState = {
      ...session,
      overrides: { ...session.overrides, [wfName]: updated },
      updated_at: new Date().toISOString(),
    };

    await this._storage.write(sessionId, updatedSession);

    // If there's a pending pop, retry it now — the overlay may have added the missing on_complete/on_fail
    if (this._engine && updatedSession.pending_pop) {
      const result = await this._engine.retryPendingPop(sessionId);
      if (result) {
        messages.push(`Pending pop resolved → ${result.currentWorkflow} @ ${result.currentStateName}`);
      }
    }

    return messages;
  }

  public async create(
    name: string,
    definition: {
      readonly description?: string;
      readonly initial: string;
      readonly max_transitions?: number;
      readonly states: Record<string, StateDefinition>;
    },
    scope?: "project" | "global"
  ): Promise<string> {
    const full = { name, ...definition };

    // Validate
    const validated = WorkflowDefinitionSchema.parse(full);

    // Check states consistency
    const stateNames = new Set(Object.keys(validated.states));
    if (!stateNames.has(validated.initial)) {
      throw new Error(`Initial state "${validated.initial}" not found in states`);
    }

    const hasTerminal = Object.values(validated.states).some(s => s.terminal);
    if (!hasTerminal) {
      throw new Error("Workflow must have at least one terminal state");
    }

    for (const [sn, state] of Object.entries(validated.states)) {
      if (state.transitions) {
        for (const [tn, target] of Object.entries(state.transitions)) {
          if (!stateNames.has(target)) {
            throw new Error(`State "${sn}" transition "${tn}" → unknown state "${target}"`);
          }
        }
      }
    }

    // Write YAML
    const writeDir = this._loader.getWriteDir(scope);
    const yamlContent = YAML.stringify(full);
    const filePath = path.join(writeDir, `${name}.yaml`);
    fs.mkdirSync(writeDir, { recursive: true });
    fs.writeFileSync(filePath, yamlContent);

    // Reload to pick up the new workflow
    this._loader.reload();

    return filePath;
  }
}
