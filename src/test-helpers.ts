import type { SessionState, WorkflowDefinition } from "./types.js";
import type { LedgerEntry } from "./ledger.js";
import type { Storage } from "./storage.js";
import { prunePolicy } from "./storage.js";
import { EventLog } from "./event-log.js";
import { Loader } from "./loader.js";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export class InMemoryStorage implements Storage {
  private _data = new Map<string, SessionState>();

  read(sessionId: string): SessionState | null {
    return this._data.get(sessionId) ?? null;
  }

  /** Memory-only event log, fed like Storage feeds its own. */
  readonly events = new EventLog();

  #parent(s: SessionState): SessionState | null {
    return s.parent_session_id ? this.read(s.parent_session_id) : null;
  }

  async write(sessionId: string, state: SessionState): Promise<void> {
    this.events.observe(this.read(sessionId), state, this.#parent(state));
    this._data.set(sessionId, state);
  }

  async update(
    sessionId: string,
    change: (current: SessionState | null) => SessionState | null,
  ): Promise<SessionState | null> {
    const next = change(this.read(sessionId));
    if (next) {
      this.events.observe(this.read(sessionId), next, this.#parent(next));
      this._data.set(sessionId, next);
    }
    return next;
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

  pruneTerminal(keep: number): void {
    prunePolicy(this.readAll(), keep, id => this.delete(id));
  }

  /** Ledger lines appended so far, in order. */
  readonly ledger: object[] = [];

  async appendLedger(entry: object): Promise<void> {
    this.ledger.push(entry);
  }

  readLedger(): LedgerEntry[] {
    return this.ledger as LedgerEntry[];
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

export function createTestLoader(workflows: Record<string, object>): {
  loader: Loader;
  dir: string;
} {
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

/**
 * The dashboard's /graph.js (the workflow graph and its panel, shared with the documentation site) as an
 * expression for a `vm` context that runs the page's script: the module's `export`s are dropped and its
 * names become the value, which the test assigns to the page's `Graph`.
 */
export function graphModuleExpression(): string {
  const file = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "dashboard",
    "graph.js",
  );
  const source = fs.readFileSync(file, "utf8");
  const names = [...source.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return `(() => { ${source.replace(/^export /gm, "")}\n return { ${names.join(", ")} }; })()`;
}

/**
 * A test that writes into a worktree the engine under test prepared must write into its own temp
 * dir: when the setup failed (timed out under load) the path is empty and a write lands in the
 * repo cwd. Returns the path, or throws.
 */
export function assertUnderTmp(dir: string): string {
  const tmp = fs.realpathSync(os.tmpdir());
  const resolved = dir === "" ? "" : path.resolve(dir);
  if (resolved === "" || !resolved.startsWith(tmp + path.sep))
    throw new Error(`not under the temp dir ${tmp}: ${JSON.stringify(dir)}`);
  return dir;
}

/**
 * `spawnSync` of a child process with a `timeout`: a child that hangs or cannot start fails the test
 * at once, with the child's own output in the message, instead of hanging the suite until the test's
 * guard fires with no word on which child it was. The timeout must be below the test's own.
 */
export function spawnChild(
  cmd: string,
  args: string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> & {
    timeout: number;
  },
): { status: number | null; stdout: string; stderr: string } {
  // VITEST_MAX_WORKERS (the pool gate's lease share, set for the suite that runs this test) overrides
  // a child's own --maxWorkers flag: a child that names its worker count keeps it.
  const env = { ...(options.env ?? process.env) };
  if (args.some(a => a.startsWith("--maxWorkers"))) delete env.VITEST_MAX_WORKERS;
  const r = spawnSync(cmd, args, { ...options, env, encoding: "utf8" });
  if (r.error)
    throw new Error(
      `${cmd} ${args.join(" ")}: ${r.error.message} (timeout ${options.timeout} ms)\n${r.stdout}${r.stderr}`,
    );
  return r;
}
