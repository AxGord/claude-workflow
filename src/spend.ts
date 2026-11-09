// What one finished task really cost: the usage of every agent that worked on it, read from the agents'
// transcripts (`<projects>/<project>/<conversation>/subagents/agent-<id>.jsonl`), each turn priced by its own
// model from the one price table in calibration.ts. A turn is counted once (a transcript repeats a turn's usage
// per content block; the turn is its `message.id`) and only inside the task's window. An agent whose transcript
// cannot be read or whose model has no price leaves the task unmeasured, never $0.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { turnUsd } from "./calibration.js";
import type { LedgerSpend } from "./ledger.js";
import type { SessionState } from "./types.js";

/** `agent-<id>` and `<id>` both name an agent. */
const bareId = (id: string): string => id.replace(/^agent-/, "");

/**
 * The agents a context names: `agent_id_<stage>` (the driver's own stage keys) and any `<role>_agent` key
 * (`recon_agent`, `worker_agent`, `reviewer_agent`, `investigator_agent`, ...).
 */
function contextAgents(context: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(context)) {
    if (typeof v !== "string" || v.trim() === "") continue;
    if (/^agent_id_[a-z0-9_]+$/.test(k) || /^[a-z0-9]+(?:_[a-z0-9]+)*_agent$/.test(k))
      out.push(bareId(v.trim()));
  }
  return out;
}

/** A session and every session below it (by `parent_session_id`) among `all`. */
export function subtreeOf(root: SessionState, all: readonly SessionState[]): SessionState[] {
  const out: SessionState[] = [root];
  const seen = new Set([root.session_id]);
  for (let i = 0; i < out.length; i++) {
    for (const s of all) {
      if (s.parent_session_id === out[i].session_id && !seen.has(s.session_id)) {
        seen.add(s.session_id);
        out.push(s);
      }
    }
  }
  return out;
}

/** Every agent id the task's sessions name (own link, context keys), de-duplicated. */
export function agentsOf(sessions: readonly SessionState[]): string[] {
  const ids = new Set<string>();
  for (const s of sessions) {
    if (s.agent_id) ids.add(bareId(s.agent_id));
    for (const id of contextAgents(s.context)) ids.add(id);
  }
  return [...ids];
}

/** The directory the transcripts live under: `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function projectsDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects");
}

/** The transcript of an agent: the conversations' own directories first, then any under `projects`. */
function transcriptOf(
  id: string,
  conversations: readonly string[],
  projects: string,
): string | undefined {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return undefined;
  }
  const file = `agent-${id}.jsonl`;
  for (const conv of [...conversations, ""]) {
    for (const d of dirs) {
      const p = conv === "" ? undefined : path.join(projects, d, conv, "subagents", file);
      if (p !== undefined && fs.existsSync(p)) return p;
    }
  }
  for (const d of dirs) {
    let convs: string[];
    try {
      convs = fs.readdirSync(path.join(projects, d));
    } catch {
      continue;
    }
    for (const c of convs) {
      const p = path.join(projects, d, c, "subagents", file);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

interface TranscriptLine {
  readonly type?: string;
  readonly timestamp?: string;
  readonly message?: {
    readonly id?: string;
    readonly model?: string;
    readonly usage?: {
      readonly input_tokens?: number;
      readonly output_tokens?: number;
      readonly cache_read_input_tokens?: number;
      readonly cache_creation_input_tokens?: number;
      readonly cache_creation?: {
        readonly ephemeral_5m_input_tokens?: number;
        readonly ephemeral_1h_input_tokens?: number;
      };
    };
  };
}

interface Totals {
  usd: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/** The usage of one transcript inside [from, to] (ms); undefined when it cannot be read or a model has no price. */
export function readTranscriptSpend(file: string, from: number, to: number): Totals | undefined {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const turns = new Map<
    string,
    { model: string; u: Record<string, number>; five: number; hour: number }
  >();
  for (const line of content.split("\n")) {
    if (line === "" || !line.includes('"usage"')) continue;
    let j: TranscriptLine;
    try {
      j = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    const m = j?.message;
    if (j?.type !== "assistant" || !m?.usage || typeof m.id !== "string") continue;
    const at = Date.parse(j.timestamp ?? "");
    if (Number.isNaN(at) || at < from || at > to) continue;
    const u = m.usage;
    const prev = turns.get(m.id);
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    const cur = {
      model: String(m.model ?? ""),
      u: {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cache_read: num(u.cache_read_input_tokens),
        cache_write: num(u.cache_creation_input_tokens),
      },
      five: num(u.cache_creation?.ephemeral_5m_input_tokens),
      hour: num(u.cache_creation?.ephemeral_1h_input_tokens),
    };
    // a repeated turn keeps the largest reading of each counter (a streamed turn grows)
    if (prev) {
      for (const k of Object.keys(cur.u) as Array<keyof typeof cur.u>)
        cur.u[k] = Math.max(cur.u[k], prev.u[k]);
      cur.five = Math.max(cur.five, prev.five);
      cur.hour = Math.max(cur.hour, prev.hour);
    }
    turns.set(m.id, cur);
  }
  const t: Totals = {
    usd: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
  };
  for (const x of turns.values()) {
    // a synthetic or empty turn (no usage) costs nothing and has no rate to look up
    if (x.u.input + x.u.output + x.u.cache_read + x.u.cache_write === 0) continue;
    const usd = turnUsd(x.model, {
      input: x.u.input,
      output: x.u.output,
      cache_read: x.u.cache_read,
      cache_write_5m: x.five > 0 || x.hour > 0 ? x.five : x.u.cache_write,
      cache_write_1h: x.hour,
    });
    if (usd === undefined) return undefined;
    t.usd += usd;
    t.input += x.u.input;
    t.output += x.u.output;
    t.cache_read += x.u.cache_read;
    t.cache_write += x.u.cache_write;
  }
  return t;
}

/**
 * Agent transcripts of the task's conversations that were active in its window and that no key or link names
 * (a replaced `agent_id`, a respawned worker, an unlinked decider). They may also belong to a concurrent task of
 * the same conversation: a count that says the figure may be incomplete, never a cost.
 */
function unnamedAgents(
  named: ReadonlySet<string>,
  conversations: readonly string[],
  projects: string,
  from: number,
  to: number,
): number {
  let n = 0;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return 0;
  }
  for (const d of dirs) {
    for (const conv of conversations) {
      const sub = path.join(projects, d, conv, "subagents");
      let files: string[];
      try {
        files = fs.readdirSync(sub);
      } catch {
        continue;
      }
      for (const f of files) {
        const m = /^agent-(.+)\.jsonl$/.exec(f);
        if (!m || named.has(m[1])) continue;
        try {
          const st = fs.statSync(path.join(sub, f));
          if (st.birthtimeMs <= to && st.mtimeMs >= from) n++;
        } catch {
          // gone meanwhile
        }
      }
    }
  }
  return n;
}

/**
 * The real spend of a task: its agents (see `agentsOf`) read from `projects` inside [startedAt, endedAt].
 * undefined when the task named no agent. Any agent unread leaves `usd` absent and lists it in `unmeasured`.
 */
export function measureSpend(
  sessions: readonly SessionState[],
  startedAt: string,
  endedAt: string,
  projects: string = projectsDir(),
): LedgerSpend | undefined {
  const ids = agentsOf(sessions);
  if (ids.length === 0) return undefined;
  const from = Date.parse(startedAt);
  const to = Date.parse(endedAt);
  const conversations = [
    ...new Set(sessions.map(s => s.claude_session_id).filter((c): c is string => !!c)),
  ];
  const sum: Totals = {
    usd: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
  };
  const unmeasured: string[] = [];
  for (const id of ids) {
    const file = transcriptOf(id, conversations, projects);
    const t = file === undefined ? undefined : readTranscriptSpend(file, from, to);
    if (t === undefined) {
      unmeasured.push(id);
      continue;
    }
    for (const k of Object.keys(sum) as Array<keyof Totals>) sum[k] += t[k];
  }
  const unnamed = unnamedAgents(new Set(ids), conversations, projects, from, to);
  return {
    agents: ids.length,
    ...(unnamed > 0 ? { unnamed } : {}),
    ...(unmeasured.length === 0 ? { usd: sum.usd } : { unmeasured }),
    input: sum.input,
    output: sum.output,
    cache_read: sum.cache_read,
    cache_write: sum.cache_write,
  };
}
