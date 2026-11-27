// The agent cap: a project's opt-in `agents.max_live` (`.claude/workflows/settings.json`) bounds how
// many agents of ONE Claude Code session tree are live at once. Outside a queue nothing else caps a
// fan-out, and a nested spawn (a driver's workers and reviewers) multiplies it.
//
// "Live" is what the hook sees by itself, with no engine record: an agent is counted from the moment
// its Agent call passed PreToolUse (a reservation: parallel calls of one message each see the others)
// until its SubagentStop. SubagentStart turns the oldest unclaimed reservation of the session into the
// agent's own entry. Background agents count the same way. A session's agents, nested ones included,
// carry the session's own `session_id` in every hook payload, so the count is per tree.
//
// Nothing may leak. An agent that dies with no stop event stops counting once it has been silent for
// `AGENT_TTL_MS` (silence = the later of its start and the last write of its own transcript); a
// reservation no SubagentStart claimed (a spawn another hook or the permission prompt refused) stops
// counting after `RESERVATION_TTL_MS`. A hook only decides: it never rewrites the call, and any
// failure here lets the call pass (the caller prints one stderr line).
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./workflow-dirs.js";
import { projectAgentCap } from "./project-settings.js";

export const AGENT_TTL_MS = 60 * 60_000;
export const RESERVATION_TTL_MS = 2 * 60_000;
/** A session's counter file nobody touched for this long is swept. */
const FILE_TTL_MS = 2 * 24 * 60 * 60_000;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10_000;

export interface AgentCapPayload {
  readonly hook_event_name?: unknown;
  readonly tool_name?: unknown;
  readonly tool_use_id?: unknown;
  readonly session_id?: unknown;
  readonly transcript_path?: unknown;
  readonly agent_transcript_path?: unknown;
  readonly agent_id?: unknown;
  readonly cwd?: string;
}

export interface AgentCapDecision {
  readonly permissionDecision: "deny";
  readonly permissionDecisionReason: string;
}

interface Entry {
  /** The Agent call's `tool_use_id` while it is only a reservation. */
  readonly tool_use_id?: string;
  /** Set by SubagentStart: the agent is running. */
  readonly agent_id?: string;
  /** Its own transcript, whose last write counts as a sign of life. */
  readonly transcript?: string;
  readonly at: number;
}

interface CapOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: number;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function agentCapFile(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), "agent-cap", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` holding the counter's lock (a directory: `mkdir` is atomic); a stale lock is broken. */
function locked<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS)
          fs.rmSync(lock, { recursive: true });
      } catch {
        /* released meanwhile */
      }
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error(`${lock}: lock not released`);
      sleepMs(5);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function readEntries(file: string): Entry[] {
  try {
    const v = (JSON.parse(fs.readFileSync(file, "utf8")) as { entries?: unknown }).entries;
    return Array.isArray(v) ? (v as Entry[]) : [];
  } catch {
    return [];
  }
}

function writeEntries(file: string, entries: readonly Entry[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ entries }) + "\n");
  fs.renameSync(tmp, file);
}

/** The time of the entry's last sign of life. */
function lastSeen(e: Entry): number {
  let t = e.at;
  if (e.transcript) {
    try {
      t = Math.max(t, fs.statSync(e.transcript).mtimeMs);
    } catch {
      /* no transcript yet */
    }
  }
  return t;
}

/** The entries that still count at `now`. */
export function liveEntries(entries: readonly Entry[], now: number): Entry[] {
  return entries.filter(e => now - lastSeen(e) <= (e.agent_id ? AGENT_TTL_MS : RESERVATION_TTL_MS));
}

/** An agent's own transcript: the payload's, else the layout `<session>/subagents/agent-<id>.jsonl`. */
function agentTranscript(
  p: AgentCapPayload,
  sessionId: string,
  agentId: string,
): string | undefined {
  const given = str(p.agent_transcript_path);
  if (given) return given;
  const main = str(p.transcript_path);
  return main
    ? path.join(path.dirname(main), sessionId, "subagents", `agent-${agentId}.jsonl`)
    : undefined;
}

/** The refusal's text: the cap, the setting, and what to do. */
export function capMessage(cap: number): string {
  return (
    `Agent cap reached: ${cap} agents of this session are already live ` +
    `(\`agents.max_live\` = ${cap} in the project's .claude/workflows/settings.json). ` +
    `Wait for a running agent to finish, then spawn; put the agents you could not start into the next wave.`
  );
}

/**
 * One hook payload of the cap: PreToolUse(Agent) reserves a slot or refuses at the cap, SubagentStart
 * claims a reservation, SubagentStop frees the agent's slot. Undefined = the call passes. A project
 * with no `agents.max_live` records nothing.
 */
export function handleAgentCap(
  payload: AgentCapPayload,
  opts: CapOptions = {},
): AgentCapDecision | undefined {
  const sessionId = str(payload.session_id);
  const event = str(payload.hook_event_name);
  if (!sessionId || !event) return undefined;
  const env = opts.env ?? process.env;
  const cap = projectAgentCap(payload.cwd ?? process.cwd());
  if (cap === undefined) return undefined;
  const now = opts.now ?? Date.now();
  const file = agentCapFile(sessionId, env);
  const agentId = str(payload.agent_id);

  if (event === "PreToolUse") {
    if (payload.tool_name !== "Agent" && payload.tool_name !== "Task") return undefined;
    return locked(file, () => {
      sweepOldFiles(file, now);
      const live = liveEntries(readEntries(file), now);
      if (live.length >= cap) {
        writeEntries(file, live);
        return { permissionDecision: "deny", permissionDecisionReason: capMessage(cap) } as const;
      }
      writeEntries(file, [...live, { tool_use_id: str(payload.tool_use_id), at: now }]);
      return undefined;
    });
  }
  if (event === "SubagentStart") {
    if (!agentId) return undefined;
    locked(file, () => {
      const live = liveEntries(readEntries(file), now);
      const started: Entry = {
        agent_id: agentId,
        transcript: agentTranscript(payload, sessionId, agentId),
        at: now,
      };
      const i = live.findIndex(e => !e.agent_id);
      if (i >= 0) live.splice(i, 1);
      writeEntries(file, [...live, started]);
    });
    return undefined;
  }
  if (event === "SubagentStop") {
    if (!agentId) return undefined;
    locked(file, () => {
      writeEntries(
        file,
        liveEntries(readEntries(file), now).filter(e => e.agent_id !== agentId),
      );
    });
  }
  return undefined;
}

/** Drop the counter files of sessions nobody has touched for days. */
function sweepOldFiles(own: string, now: number): void {
  const dir = path.dirname(own);
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    if (f === own || !name.endsWith(".json")) continue;
    try {
      if (now - fs.statSync(f).mtimeMs > FILE_TTL_MS) fs.rmSync(f, { force: true });
    } catch {
      /* gone already */
    }
  }
}
