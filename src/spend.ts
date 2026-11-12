// What one finished task really cost: the usage of every agent that worked on it, read from the agents'
// transcripts (`<projects>/<project>/<conversation>/subagents/agent-<id>.jsonl`), each turn priced by its own
// model from the one price table in calibration.ts. A turn is counted once (a transcript repeats a turn's usage
// per content block; the turn is its `message.id`) and only inside the task's window. An agent whose transcript
// cannot be read or whose model has no price leaves the task unmeasured, never $0.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { turnUsd } from "./calibration.js";
import type { LedgerAgentSpend, LedgerEntry, LedgerParentSpend, LedgerSpend } from "./ledger.js";
import type { AgentLink, SessionState } from "./types.js";

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

/** Every agent id the task's sessions name (every agent ever linked, context keys), de-duplicated: an agent named twice is read once, so each turn is summed once. */
export function agentsOf(sessions: readonly SessionState[]): string[] {
  const ids = new Set<string>();
  for (const s of sessions) {
    if (s.agent_id) ids.add(bareId(s.agent_id));
    for (const id of s.linked_agents ?? []) ids.add(bareId(id));
    for (const l of s.agent_links ?? []) ids.add(bareId(l.agent_id));
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

interface Usage {
  usd: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/** A reading of a transcript window: `model` is the one that cost the most in it. */
interface Totals extends Usage {
  model?: string;
}

/** The usage of one transcript inside [from, to] (ms); undefined when it cannot be read or a model has no price. */
export function readTranscriptSpend(file: string, from: number, to: number): Totals | undefined {
  const lines = readLines(file);
  return lines === undefined ? undefined : spendOfLines(lines, from, to);
}

/** The lines of a transcript; undefined when it cannot be read. */
function readLines(file: string): string[] | undefined {
  try {
    return fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return undefined;
  }
}

/** One stretch of an agent's transcript and the state and stage it counts under. */
interface Window {
  readonly from: number;
  readonly to: number;
  readonly state?: string;
  readonly stage?: string;
}

/**
 * The stretches of an agent's life inside [from, to]: one for an agent no `link_agent` call is on record for; else the
 * stretch of each call runs from its time to the next call's (the first from `from`, the last to `to`), so a worker
 * linked again for a fix round splits there. A call that spawns no stage keeps the stage before it.
 */
function windowsOf(links: readonly AgentLink[], from: number, to: number): Window[] {
  const at = links
    .map(l => ({ l, t: Date.parse(l.at) }))
    .filter(x => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t);
  if (at.length === 0) return [{ from, to }];
  const out: Window[] = [];
  let stage: string | undefined;
  at.forEach(({ l, t }, i) => {
    stage = l.stage ?? stage;
    const a = i === 0 ? from : Math.max(from, t);
    const b = i === at.length - 1 ? to : Math.min(to, at[i + 1].t - 1);
    if (a > b) return;
    out.push({ from: a, to: b, state: l.state, stage });
  });
  return out;
}

/** The usage of transcript lines inside [from, to] (ms), a turn once; undefined when a model has no price. */
function spendOfLines(lines: Iterable<string>, from: number, to: number): Totals | undefined {
  const turns = new Map<
    string,
    { model: string; u: Record<string, number>; five: number; hour: number }
  >();
  for (const line of lines) {
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
  const byModel = new Map<string, number>();
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
    byModel.set(x.model, (byModel.get(x.model) ?? 0) + usd);
    t.input += x.u.input;
    t.output += x.u.output;
    t.cache_read += x.u.cache_read;
    t.cache_write += x.u.cache_write;
  }
  const top = [...byModel].sort((a, b) => b[1] - a[1])[0];
  return top === undefined ? t : { ...t, model: top[0] };
}

/**
 * Agent transcripts of the task's conversations that were active in its window and that no key or link names
 * (an unlinked decider, a respawned worker nothing linked). They may also belong to a concurrent task of
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
 * The real spend of a task: its agents (see `agentsOf`) read from `projects` inside [startedAt, endedAt], also
 * per agent and linked state (`by_agent`: an agent's stretches of one state and stage are one row).
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
  const links = new Map<string, AgentLink[]>();
  for (const s of sessions)
    for (const l of s.agent_links ?? []) {
      const id = bareId(l.agent_id);
      links.set(id, [...(links.get(id) ?? []), l]);
    }
  const sum: Usage = {
    usd: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
  };
  const unmeasured: string[] = [];
  const rows: LedgerAgentSpend[] = [];
  for (const id of ids) {
    const file = transcriptOf(id, conversations, projects);
    const windows = windowsOf(links.get(id) ?? [], from, to);
    const lines = file === undefined ? undefined : readLines(file);
    const read = windows.map(w => ({
      w,
      t: lines === undefined ? undefined : spendOfLines(lines, w.from, w.to),
    }));
    const ok = read.every(r => r.t !== undefined);
    if (!ok) unmeasured.push(id);
    const byKey = new Map<string, Array<{ w: Window; t: Totals | undefined }>>();
    for (const r of read) {
      const key = JSON.stringify([r.w.state, r.w.stage]);
      byKey.set(key, [...(byKey.get(key) ?? []), { w: r.w, t: ok ? r.t : undefined }]);
    }
    for (const group of byKey.values()) {
      const { state, stage } = group[0].w;
      const model = group
        .filter(g => g.t?.model !== undefined)
        .sort((a, b) => b.t!.usd - a.t!.usd)[0]?.t?.model;
      const part = (k: keyof Usage): number => group.reduce((n, g) => n + (g.t?.[k] ?? 0), 0);
      rows.push({
        agent: id,
        ...(state !== undefined ? { state } : {}),
        ...(stage !== undefined ? { stage } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(ok ? { usd: part("usd") } : {}),
        input: part("input"),
        output: part("output"),
        cache_read: part("cache_read"),
        cache_write: part("cache_write"),
      });
    }
    if (!ok) continue;
    for (const { t } of read)
      for (const k of Object.keys(sum) as Array<keyof Usage>) sum[k] += t![k];
  }
  const unnamed = unnamedAgents(new Set(ids), conversations, projects, from, to);
  return {
    agents: ids.length,
    by_agent: rows,
    ...(unnamed > 0 ? { unnamed } : {}),
    ...(unmeasured.length === 0 ? { usd: sum.usd } : { unmeasured }),
    input: sum.input,
    output: sum.output,
    cache_read: sum.cache_read,
    cache_write: sum.cache_write,
  };
}

/** The first read of a transcript's tail (bytes); a longer last turn doubles it. */
const TAIL_START = 1 << 18;

/**
 * The context an agent's last assistant turn held: its input, cache read and cache write tokens. Only the tail
 * of the transcript is read, widened until the last turn's own lines are whole (a turn repeats per content block,
 * each counter at its largest). A turn with no usage is not a turn. undefined: no readable turn.
 */
export function lastTurnContext(file: string): number | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    for (let len = TAIL_START; ; len *= 2) {
      const from = Math.max(0, size - len);
      const buf = Buffer.alloc(size - from);
      let got = 0;
      while (got < buf.length) {
        const n = fs.readSync(fd, buf, got, buf.length - got, from + got);
        if (n === 0) break;
        got += n;
      }
      const lines = buf.toString("utf8", 0, got).split("\n");
      // the first line of a tail may be cut
      if (from > 0) lines.shift();
      const found = lastTurnOf(lines);
      if (found !== undefined && (found.closed || from === 0)) return found.context;
      if (from === 0) return undefined;
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The last turn of `lines` (its context, and whether a turn before it proves all its lines are here). */
function lastTurnOf(lines: readonly string[]): { context: number; closed: boolean } | undefined {
  let id: string | undefined;
  let counters = [0, 0, 0];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"usage"')) continue;
    let j: TranscriptLine;
    try {
      j = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    const m = j?.message;
    if (j?.type !== "assistant" || !m?.usage || typeof m.id !== "string") continue;
    const u = m.usage;
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    const read = [
      num(u.input_tokens),
      num(u.cache_read_input_tokens),
      num(u.cache_creation_input_tokens),
    ];
    if (read[0] + read[1] + read[2] + num(u.output_tokens) === 0) continue;
    if (id === undefined) id = m.id;
    else if (m.id !== id) return { context: counters[0] + counters[1] + counters[2], closed: true };
    counters = counters.map((c, k) => Math.max(c, read[k]));
  }
  return id === undefined
    ? undefined
    : { context: counters[0] + counters[1] + counters[2], closed: false };
}

/**
 * The context of the agent linked to a session (`agent_id`, the latest if it was respawned): its last turn's
 * size (`lastTurnContext`). undefined when no agent is linked or its transcript cannot be found or read.
 */
export function agentContextOf(
  session: Pick<SessionState, "agent_id" | "claude_session_id">,
  projects: string = projectsDir(),
): number | undefined {
  if (!session.agent_id) return undefined;
  const conversations = session.claude_session_id ? [session.claude_session_id] : [];
  const file = transcriptOf(bareId(session.agent_id), conversations, projects);
  return file === undefined ? undefined : lastTurnContext(file);
}

/** The conversation's own transcript and the project directory it lives under: `<projects>/<project>/<conversation>.jsonl`. */
function conversationTranscript(
  conversation: string,
  projects: string,
): { file: string; project: string } | undefined {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const p = path.join(projects, d, `${conversation}.jsonl`);
    if (fs.existsSync(p)) return { file: p, project: d };
  }
  return undefined;
}

/**
 * The complete lines of `file` from byte `start` whose turns are not after `to` (ms), and the byte offset just past
 * the last one consumed. Only the part from `start` is read (a conversation's transcript grows without end); the scan
 * stops at the first turn after `to` (a transcript is append-only, in time order) and leaves an incomplete last line
 * for the next read. A `start` beyond the file (it was rewritten) reads from the top.
 */
function readTail(
  file: string,
  start: number,
  to: number,
): { lines: string[]; end: number } | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const from = start > size ? 0 : start;
    const buf = Buffer.alloc(size - from);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, from + got);
      if (n === 0) break;
      got += n;
    }
    const lines: string[] = [];
    let at = 0;
    let end = from;
    while (at < got) {
      const nl = buf.indexOf(10, at);
      if (nl === -1 || nl >= got) break;
      const line = buf.toString("utf8", at, nl);
      if (line.includes('"usage"')) {
        let stamp = Number.NaN;
        try {
          stamp = Date.parse((JSON.parse(line) as TranscriptLine).timestamp ?? "");
        } catch {
          // a damaged line is skipped like any other
        }
        if (stamp > to) break;
        lines.push(line);
      }
      at = nl + 1;
      end = from + at;
    }
    return { lines, end };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The parent's own spend (the conversation that dispatches, never its sub-agents: those are `measureSpend`'s) over
 * the stretch the ledger does not hold yet: after the latest `parent_spend.to` among `recorded` lines of the same
 * conversation, else from `startedAt`, up to `endedAt`. The transcript is read from the byte offset that line
 * recorded, so a task's end costs the new turns, not the whole conversation. Priced by the same table as an agent
 * turn. undefined when nothing new lies in the stretch, the transcript cannot be read or a model has no price: no
 * line is recorded then and the next one covers the stretch.
 */
export function measureParentSpend(
  conversation: string,
  startedAt: string,
  endedAt: string,
  recorded: readonly LedgerEntry[],
  projects: string = projectsDir(),
): LedgerParentSpend | undefined {
  let held = -Infinity;
  let offset = 0;
  for (const e of recorded) {
    const p = e.parent_spend;
    if (p?.conversation !== conversation) continue;
    const to = Date.parse(p.to);
    if (to > held) {
      held = to;
      offset = typeof p.offset === "number" ? p.offset : 0;
    }
  }
  const from = held === -Infinity ? Date.parse(startedAt) : held + 1;
  const to = Date.parse(endedAt);
  if (Number.isNaN(from) || Number.isNaN(to) || from > to) return undefined;
  const found = conversationTranscript(conversation, projects);
  const tail = found === undefined ? undefined : readTail(found.file, offset, to);
  const t = tail === undefined ? undefined : spendOfLines(tail.lines, from, to);
  if (found === undefined || tail === undefined || t === undefined) return undefined;
  if (t.input + t.output + t.cache_read + t.cache_write === 0) return undefined;
  return {
    conversation,
    project: found.project,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    offset: tail.end,
    usd: t.usd,
    input: t.input,
    output: t.output,
    cache_read: t.cache_read,
    cache_write: t.cache_write,
  };
}
