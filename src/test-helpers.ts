import type { SessionState, WorkflowDefinition } from "./types.js";
import type { Storage } from "./storage.js";
import { Loader } from "./loader.js";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";

export class InMemoryStorage implements Storage {
  private _data = new Map<string, SessionState>();

  read(sessionId: string): SessionState | null {
    return this._data.get(sessionId) ?? null;
  }

  async write(sessionId: string, state: SessionState): Promise<void> {
    this._data.set(sessionId, state);
  }

  list(): string[] {
    return Array.from(this._data.keys());
  }

  delete(sessionId: string): boolean {
    return this._data.delete(sessionId);
  }

  readAll(): SessionState[] {
    return Array.from(this._data.values());
  }
}

export function createFixtureDir(workflows: Record<string, object>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-test-"));
  for (const [name, def] of Object.entries(workflows)) {
    const full = { name, ...def };
    fs.writeFileSync(path.join(dir, `${name}.yaml`), YAML.stringify(full));
  }
  return dir;
}

export function createTestLoader(workflows: Record<string, object>): { loader: Loader; dir: string } {
  const dir = createFixtureDir(workflows);
  const loader = new Loader(null, dir, null);
  return { loader, dir };
}

export function createTestEngine(workflows: Record<string, object>): {
  engine: Engine;
  storage: InMemoryStorage;
  loader: Loader;
  executor: Executor;
} {
  const storage = new InMemoryStorage();
  const { loader } = createTestLoader(workflows);
  const executor = new Executor();
  const engine = new Engine(storage, loader, executor);
  return { engine, storage, loader, executor };
}

export function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Minimal valid workflow for tests. */
export const SIMPLE_WORKFLOW = {
  initial: "start",
  states: {
    start: {
      prompt: "Start state",
      transitions: { next: "end" },
    },
    end: {
      prompt: "Done",
      terminal: true,
      outcome: "complete",
    },
  },
} as const;

/** Workflow with multiple states for transition tests. */
export const MULTI_STATE_WORKFLOW = {
  initial: "a",
  states: {
    a: {
      prompt: "State A",
      transitions: { go_b: "b", go_c: "c" },
    },
    b: {
      prompt: "State B",
      transitions: { go_c: "c", back: "a" },
    },
    c: {
      prompt: "State C",
      terminal: true,
      outcome: "complete",
    },
  },
} as const;
