import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { WorkflowDefinitionSchema } from "./types.js";
import { actionStateNames, actionStateRefusal } from "./trust.js";
export class Modifier {
    _storage;
    _loader;
    _engine;
    constructor(storage, loader) {
        this._storage = storage;
        this._loader = loader;
    }
    /** Late-bind engine to break circular dependency (Engine ↔ Modifier). */
    setEngine(engine) {
        this._engine = engine;
    }
    async modify(sessionId, changes) {
        const session = this._storage.read(sessionId);
        if (!session)
            throw new Error(`Session "${sessionId}" not found`);
        if (session.stack.length === 0)
            throw new Error("No active workflow to modify");
        // When pending_pop is active, overlays target the parent frame's workflow
        // (the child completed but couldn't pop because parent lacks on_complete/on_fail)
        let frame = session.stack[session.active_frame];
        if (session.pending_pop && session.active_frame > 0)
            frame = session.stack[session.active_frame - 1];
        const wfName = frame.workflow;
        const messages = [];
        const existing = session.overrides[wfName] ?? {};
        const updated = { ...existing };
        if (changes.add_state) {
            const { name, ...stateDef } = changes.add_state;
            if (stateDef.type === "exec" || stateDef.type === "fetch")
                throw new Error(actionStateRefusal(`State "${name}"`));
            const addStates = { ...(updated.add_states ?? {}), [name]: stateDef };
            updated.add_states = addStates;
            messages.push(`Added state "${name}"`);
        }
        if (changes.add_transition) {
            const addTransitions = [...(updated.add_transitions ?? []), changes.add_transition];
            updated.add_transitions = addTransitions;
            messages.push(`Added transition "${changes.add_transition.from}" --${changes.add_transition.name}--> "${changes.add_transition.to}"`);
        }
        if (changes.remove_transition) {
            const removeTransitions = [...(updated.remove_transitions ?? []), changes.remove_transition];
            updated.remove_transitions = removeTransitions;
            messages.push(`Removed transition "${changes.remove_transition.name}" from "${changes.remove_transition.from}"`);
        }
        const updatedSession = {
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
    async create(name, definition, scope) {
        const full = { name, ...definition };
        // Validate
        const validated = WorkflowDefinitionSchema.parse(full);
        const actions = actionStateNames(validated.states);
        if (actions.length > 0)
            throw new Error(actionStateRefusal(`Workflow "${name}" (state ${actions.join(", ")})`));
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
