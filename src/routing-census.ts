#!/usr/bin/env node
// wf-routing-census: where the reports and wakes of a project's nested agents were delivered, read from its Claude
// Code transcripts (read-only). For each message about a worker, reviewer, recon or investigator (an agent below a
// driver: spawn depth >= 2, not itself a driver) it tells whether it reached the agent that owns the worker or the
// main conversation, and what woke the worker's run (its own background shell, a SendMessage, the spawn prompt) and
// whether the owner had stopped with nothing live. Method: docs/queue.md, "Routing census".
//   wf-routing-census [--project PATH|DIR] [--from TS] [--to TS] [--cut TS]... [--json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

/** A turn end of an agent: `E` plain text, `H` SubagentHandback, `S` anything that keeps it running. */
type Mark = "E" | "H" | "S";

interface Marker {
  readonly ts: string;
  readonly code: Mark;
}

interface Input {
  readonly ts: string;
  readonly kind: string;
  readonly src: string;
}

/** A hand-back message or a task notification found in a transcript. */
export interface Received {
  readonly ts: string;
  readonly ver: string;
  readonly from?: string;
  readonly hb: boolean;
  readonly tid?: string;
  readonly status?: string;
  readonly summary?: string;
  readonly result?: string;
}

/** What one transcript says about its own agent. */
export interface AgentLog {
  readonly marks: Marker[];
  readonly sends: { readonly ts: string; readonly to: string }[];
  readonly recv: Received[];
  readonly inputs: Input[];
}

export interface AgentMeta {
  readonly agentType: string;
  readonly description: string;
  readonly parentAgentId?: string;
  readonly spawnDepth: number;
}

export interface ProjectData {
  readonly meta: ReadonlyMap<string, AgentMeta>;
  readonly logs: ReadonlyMap<string, AgentLog>;
}

interface Block {
  readonly type?: string;
  readonly name?: string;
  readonly input?: { readonly to?: unknown };
}

interface TLine {
  readonly type?: string;
  readonly timestamp?: string;
  readonly version?: string;
  readonly isMeta?: boolean;
  readonly origin?: { readonly kind?: string };
  readonly message?: { readonly content?: unknown; readonly stop_reason?: string | null };
  readonly attachment?: { readonly type?: string; readonly prompt?: unknown };
}

/**
 * A user line the harness wrote into the run (a reminder, a hand-back re-prompt) rather than a start of one. It is
 * recognised by its `isMeta` flag among the first 2,500 characters of the line, as the investigators' scan did, and the
 * verified table depends on it: a longer meta line (a skill body, a relayed coordinator message) counts as a run
 * start, which moves 45 runs between "SendMessage" and "spawn prompt" and keeps 7 drivers out of "finished".
 */
function isHarnessLine(line: string): boolean {
  const i = line.indexOf('"isMeta":true');
  return i >= 0 && i + '"isMeta":true'.length <= 2500;
}

const emptyLog = (): AgentLog => ({ marks: [], sends: [], recv: [], inputs: [] });
const MAIN = "main";
/** Records a transcript holds besides the conversation (api request blobs, queue operations, snapshots). */
const RECORD_PREFIX = /^\{"type":"([a-z-]+)"/;
const CONVERSATION = new Set(["user", "assistant", "attachment"]);
const FINISHED_NOTICE = "waiting on its own";
const TWIN_SECONDS = 5;

function parseNotice(ts: string, ver: string, text: string): Received {
  const from = /<agent-message from=\\?"([^"\\]+)/.exec(text)?.[1];
  const tid = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1];
  return {
    ts,
    ver,
    ...(from === undefined ? { hb: false } : { from, hb: text.includes("[Subagent hand-back]") }),
    ...(tid === undefined
      ? {}
      : {
          tid,
          status: /<status>([^<]*)<\/status>/.exec(text)?.[1],
          summary: /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.slice(0, 140),
          result: /<result>([\s\S]*?)<\/result>/.exec(text)?.[1]?.slice(0, 90),
        }),
  };
}

/** Folds the lines of one transcript, in file order, into what the census reads from it. */
export class TranscriptScanner {
  readonly log: AgentLog = emptyLog();
  private last: Mark | undefined;

  push(line: string): void {
    const rec = RECORD_PREFIX.exec(line.slice(0, 40));
    if (rec !== null && !CONVERSATION.has(rec[1])) return;
    let o: TLine;
    try {
      o = JSON.parse(line) as TLine;
    } catch {
      return;
    }
    if (typeof o.timestamp !== "string") return;
    if (o.type === "assistant") this.assistant(o.timestamp, o);
    else if (o.type === "user") this.user(o.timestamp, o, isHarnessLine(line));
    else if (o.type === "attachment") this.attachment(o.timestamp, o);
  }

  private mark(ts: string, code: Mark): void {
    this.log.marks.push({ ts, code });
    this.last = code;
  }

  private assistant(ts: string, o: TLine): void {
    const content = o.message?.content;
    const tools = Array.isArray(content)
      ? (content as Block[]).filter(b => b.type === "tool_use")
      : [];
    for (const b of tools)
      if (b.name === "SendMessage" && typeof b.input?.to === "string")
        this.log.sends.push({ ts, to: b.input.to });
    const code: Mark = tools.some(b => b.name === "SubagentHandback")
      ? "H"
      : o.message?.stop_reason === "end_turn"
        ? "E"
        : "S";
    if (code === "S" && this.last === "S") return;
    this.mark(ts, code);
  }

  private user(ts: string, o: TLine, harness: boolean): void {
    const content = o.message?.content;
    const toolResult =
      Array.isArray(content) && (content as Block[]).some(b => b.type === "tool_result");
    const kind = o.origin?.kind;
    const text = typeof content === "string" ? content : JSON.stringify(content ?? null);
    if (
      kind === "peer" ||
      kind === "task-notification" ||
      (!toolResult && text.slice(0, 5000).includes("agent-message from"))
    ) {
      const ev = parseNotice(ts, o.version ?? "", text);
      this.log.recv.push(ev);
      this.log.inputs.push({ ts, kind: kind ?? "", src: ev.tid ?? ev.from ?? "" });
      if (this.last !== "S") this.mark(ts, "S");
      return;
    }
    if (toolResult || harness) {
      if (!harness && this.last !== "S") this.mark(ts, "S");
      return;
    }
    this.log.inputs.push({ ts, kind: "user", src: "" });
    if (this.last !== "S") this.mark(ts, "S");
  }

  /** A notice that reached the agent mid-turn is recorded as a `queued_command` attachment, not a user line. */
  private attachment(ts: string, o: TLine): void {
    const a = o.attachment;
    if (a?.type !== "queued_command") return;
    const text = typeof a.prompt === "string" ? a.prompt : JSON.stringify(a.prompt ?? null);
    const head = text.slice(0, 60000);
    if (!head.includes("<task-notification>") && !head.includes("agent-message from")) return;
    this.log.recv.push(parseNotice(ts, o.version ?? "", text));
  }
}

async function scanFile(file: string): Promise<AgentLog> {
  const sc = new TranscriptScanner();
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) sc.push(line);
  return sc.log;
}

function readMeta(file: string): AgentMeta | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AgentMeta>;
    return {
      agentType: m.agentType ?? "",
      description: m.description ?? "",
      parentAgentId: m.parentAgentId,
      spawnDepth: m.spawnDepth ?? 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * The transcripts of one Claude Code project directory: each top-level `<session>.jsonl` is the main conversation
 * (all of them are merged into one agent, `main`), each `<session>/subagents/agent-<id>.jsonl` with its
 * `.meta.json` one nested agent.
 */
export async function readProject(dir: string): Promise<ProjectData> {
  const meta = new Map<string, AgentMeta>();
  const logs = new Map<string, AgentLog>();
  const main = emptyLog();
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".jsonl")) continue;
    const log = await scanFile(path.join(dir, f));
    main.sends.push(...log.sends);
    main.recv.push(...log.recv);
    const sub = path.join(dir, f.slice(0, -".jsonl".length), "subagents");
    if (!fs.existsSync(sub)) continue;
    for (const a of fs.readdirSync(sub).sort()) {
      const m = /^agent-(.+)\.jsonl$/.exec(a);
      if (m === null) continue;
      logs.set(m[1], await scanFile(path.join(sub, a)));
      const mm = readMeta(path.join(sub, `agent-${m[1]}.meta.json`));
      if (mm !== undefined) meta.set(m[1], mm);
    }
  }
  logs.set(MAIN, main);
  return { meta, logs };
}

export const WAKE_SOURCES = [
  "own bg shell, driver finished",
  "own bg shell, driver parked",
  "own bg shell, driver running",
  "SendMessage",
  "spawn prompt",
  "own sub-agent notice",
  "other",
] as const;
export type WakeSource = (typeof WAKE_SOURCES)[number];

export type Kind = "report" | "waiting" | "other" | "twin";

export interface Row {
  readonly ts: string;
  readonly ver: string;
  readonly kind: Kind;
  /** The worker the message is about, the agent that owns it, and the transcript that holds the message. */
  readonly worker: string;
  readonly owner: string;
  readonly to: string;
  readonly toMain: boolean;
  readonly dest: "owner" | "main" | "other";
  readonly source: WakeSource;
}

export interface Pair {
  events: number;
  main: number;
}

export interface Dest {
  events: number;
  owner: number;
  main: number;
  other: number;
}

export interface WindowCensus {
  from: string | null;
  to: string | null;
  tasks: number;
  versions: string;
  reports: Pair;
  waiting: Pair;
  other: Pair;
  twin: Pair;
  /** Messages that reached main and are not the twin of another: reports, waiting notices and other notices. */
  distinctMain: number;
  /** `distinctMain` per 20 tasks (a task = a distinct driver description started in the window); null with no task. */
  per20: number | null;
  /** Runs woken by their own background shell, and how many of those went to main. */
  bgWakes: Pair;
  sources: Record<WakeSource, Dest>;
}

export interface Census {
  project: string;
  from: string | null;
  to: string | null;
  agents: number;
  /** Messages about nested non-driver agents the main conversation did not itself resume, in the range. */
  events: number;
  windows: WindowCensus[];
  sources: Record<WakeSource, Dest>;
}

export interface CensusOptions {
  readonly from?: string;
  readonly to?: string;
  /** Ascending boundaries; N of them make N+1 windows. */
  readonly cuts?: readonly string[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Index of the first element whose key is not below `key` (a bisect over a sorted array). */
function lowerBound<T>(arr: readonly T[], key: string, get: (x: T) => string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (get(arr[mid]) < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type State = "main" | "none" | "ended" | "handed-back" | "running";

function secondsApart(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 1000;
}

function newest(a: string, b: string): string {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? a : b;
  }
  return a;
}

interface Event {
  readonly ts: string;
  readonly ver: string;
  readonly kind: "report" | "notif";
  /** What the message is: a hand-back, a notice carrying the report inline, or any other notice. */
  readonly k2: "report" | "wake";
  readonly x: string;
  readonly to: string;
  readonly e: Received;
}

/** Every message about a nested agent, with the transcript that holds it. */
function events(data: ProjectData): Event[] {
  const out: Event[] = [];
  for (const [to, log] of data.logs)
    for (const e of log.recv) {
      let x: string;
      let kind: "report" | "notif";
      if (e.from !== undefined && e.hb) {
        x = e.from;
        kind = "report";
      } else if (e.tid !== undefined) {
        x = e.tid;
        kind = "notif";
      } else continue;
      const m = data.meta.get(x);
      if (m === undefined || m.spawnDepth < 2 || !data.logs.has(x)) continue;
      const inline =
        kind === "notif" &&
        e.status === "completed" &&
        (e.result ?? "").startsWith("&lt;artifact") &&
        (e.summary ?? "").endsWith("finished");
      out.push({
        ts: e.ts,
        ver: e.ver,
        kind,
        k2: kind === "report" || inline ? "report" : "wake",
        x,
        to,
        e,
      });
    }
  return out.sort((a, b) => cmp(a.ts, b.ts));
}

/** A cut outside (from, to) would make an empty window and let the next one reach past `--from` or `--to`. */
function checkCuts(from: string | null, to: string | null, cuts: readonly string[]): void {
  for (const c of cuts)
    if ((from !== null && c <= from) || (to !== null && c >= to))
      throw new Error(`cut ${c} outside (${from ?? "start"}, ${to ?? "end"})`);
}

/**
 * Each message about a nested non-driver agent, classed by what woke the agent's run and by whether it reached the
 * agent that owned it (the last agent that sent it a SendMessage while it was stopped, else its spawner) or main.
 * Messages to agents main itself resumed are left out: reaching main is right for those.
 */
export function classify(data: ProjectData): Row[] {
  const { meta, logs } = data;
  for (const log of logs.values()) {
    log.marks.sort((a, b) => cmp(a.ts, b.ts) || cmp(a.code, b.code));
    log.inputs.sort((a, b) => cmp(a.ts, b.ts) || cmp(a.kind, b.kind) || cmp(a.src, b.src));
  }
  const state = (id: string, ts: string): State => {
    const log = logs.get(id);
    if (id === MAIN || log === undefined) return "main";
    const i = lowerBound(log.marks, ts, m => m.ts);
    if (i === 0) return "none";
    const code = log.marks[i - 1].code;
    return code === "E" ? "ended" : code === "H" ? "handed-back" : "running";
  };
  const sendsTo = new Map<string, { ts: string; from: string }[]>();
  for (const [id, log] of logs)
    for (const s of log.sends) {
      const l = sendsTo.get(s.to) ?? [];
      l.push({ ts: s.ts, from: id });
      sendsTo.set(s.to, l);
    }
  for (const l of sendsTo.values()) l.sort((a, b) => cmp(a.ts, b.ts) || cmp(a.from, b.from));
  const ownerOf = (x: string, ts: string): string => {
    let best: string | undefined;
    for (const s of sendsTo.get(x) ?? []) {
      if (s.ts >= ts) break;
      const st = state(x, s.ts);
      if (st === "ended" || st === "handed-back" || s.from === MAIN) best = s.from;
    }
    return best ?? meta.get(x)?.parentAgentId ?? MAIN;
  };
  // A driver's own `finished` notice: it stopped with no live background child.
  const finished = new Map<string, string[]>();
  for (const log of logs.values())
    for (const e of log.recv)
      if (
        e.tid !== undefined &&
        e.status === "completed" &&
        (e.summary ?? "").endsWith("finished")
      ) {
        const l = finished.get(e.tid) ?? [];
        l.push(e.ts);
        finished.set(e.tid, l);
      }
  const driverFinished = (owner: string, ts: string): boolean => {
    const log = logs.get(owner);
    if (log === undefined) return false;
    let tf: string | undefined;
    for (const t of finished.get(owner) ?? []) if (t < ts && (tf === undefined || t > tf)) tf = t;
    if (tf === undefined) return false;
    const after = tf;
    const i = lowerBound(log.inputs, after, x => x.ts);
    // The first input strictly after `tf`.
    let j = i;
    while (j < log.inputs.length && log.inputs[j].ts <= after) j++;
    return j >= log.inputs.length || log.inputs[j].ts >= ts;
  };
  const wakeOf = (x: string, ts: string): { kind: string; src: string } | undefined => {
    const log = logs.get(x);
    if (log === undefined) return undefined;
    const i = lowerBound(log.inputs, ts, m => m.ts);
    return i === 0 ? undefined : log.inputs[i - 1];
  };

  const evs = events(data);
  const handBacks = new Map<string, string[]>();
  for (const ev of evs)
    if (ev.kind === "report") {
      const k = `${ev.x}\n${ev.to}`;
      const l = handBacks.get(k) ?? [];
      l.push(ev.ts);
      handBacks.set(k, l);
    }
  const rows: Row[] = [];
  for (const ev of evs) {
    const m = meta.get(ev.x);
    if (m === undefined || m.agentType.includes("driver")) continue;
    const owner = ownerOf(ev.x, ev.ts);
    if (owner === MAIN) continue;
    const toMain = ev.to === MAIN;
    const dest = ev.to === owner ? "owner" : toMain ? "main" : "other";
    const w = wakeOf(ev.x, ev.ts);
    let source: WakeSource;
    if (w?.kind === "task-notification" && !meta.has(w.src))
      source = driverFinished(owner, ev.ts)
        ? "own bg shell, driver finished"
        : ((s: State) =>
            s === "ended" || s === "handed-back"
              ? "own bg shell, driver parked"
              : "own bg shell, driver running")(state(owner, ev.ts));
    else if (w?.kind === "peer") source = "SendMessage";
    else if (w?.kind === "user") source = "spawn prompt";
    else if (w?.kind === "task-notification") source = "own sub-agent notice";
    else source = "other";
    let kind: Kind = "report";
    if (ev.k2 === "wake" && (ev.e.summary ?? "").includes(FINISHED_NOTICE)) kind = "waiting";
    else if (ev.kind === "notif") {
      kind = ev.k2 === "wake" ? "other" : "report";
      const twin = (handBacks.get(`${ev.x}\n${ev.to}`) ?? []).some(
        t => secondsApart(t, ev.ts) <= TWIN_SECONDS,
      );
      if (twin) kind = "twin";
    }
    rows.push({
      ts: ev.ts,
      ver: ev.ver,
      kind,
      worker: ev.x,
      owner,
      to: ev.to,
      toMain,
      dest,
      source,
    });
  }
  return rows;
}

/** The census of a project's transcripts: the classified messages counted per window and per wake source. */
export function census(data: ProjectData, project: string, opts: CensusOptions = {}): Census {
  const { meta, logs } = data;
  const rows = classify(data);

  const from = opts.from ?? null;
  const to = opts.to ?? null;
  const cuts = [...(opts.cuts ?? [])].sort(cmp);
  checkCuts(from, to, cuts);
  const bounds: (string | null)[] = [from, ...cuts, to];
  const inRange = (ts: string, lo: string | null, hi: string | null): boolean =>
    (lo === null || ts >= lo) && (hi === null || ts < hi);
  const firstSeen = (id: string): string | undefined => {
    const marks = logs.get(id)?.marks;
    return marks === undefined || marks.length === 0 ? undefined : marks[0].ts;
  };
  const newDest = (): Dest => ({ events: 0, owner: 0, main: 0, other: 0 });
  const newSources = (): Record<WakeSource, Dest> =>
    Object.fromEntries(WAKE_SOURCES.map(s => [s, newDest()])) as Record<WakeSource, Dest>;
  const count = (d: Dest, r: Row): void => {
    d.events++;
    d[r.dest]++;
  };
  const total = newSources();
  const windows: WindowCensus[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const lo = bounds[i];
    const hi = bounds[i + 1];
    const descriptions = new Set<string>();
    for (const [id, m] of meta) {
      const t = firstSeen(id);
      if (m.agentType.includes("driver") && t !== undefined && inRange(t, lo, hi))
        descriptions.add(m.description);
    }
    const w: WindowCensus = {
      from: lo,
      to: hi,
      tasks: descriptions.size,
      versions: "",
      reports: { events: 0, main: 0 },
      waiting: { events: 0, main: 0 },
      other: { events: 0, main: 0 },
      twin: { events: 0, main: 0 },
      distinctMain: 0,
      per20: null,
      bgWakes: { events: 0, main: 0 },
      sources: newSources(),
    };
    let oldest = "";
    let latest = "";
    for (const r of rows) {
      if (!inRange(r.ts, lo, hi)) continue;
      const p = w[r.kind === "report" ? "reports" : r.kind === "waiting" ? "waiting" : r.kind];
      p.events++;
      if (r.toMain) {
        p.main++;
        if (r.kind !== "twin") w.distinctMain++;
      }
      if (r.source.startsWith("own bg shell")) {
        w.bgWakes.events++;
        if (r.toMain) w.bgWakes.main++;
      }
      count(w.sources[r.source], r);
      count(total[r.source], r);
      if (r.ver !== "") {
        oldest = oldest === "" || newest(r.ver, oldest) === oldest ? r.ver : oldest;
        latest = latest === "" ? r.ver : newest(r.ver, latest);
      }
    }
    w.versions = oldest === latest ? oldest : `${oldest}-${latest}`;
    w.per20 = w.tasks === 0 ? null : (20 * w.distinctMain) / w.tasks;
    windows.push(w);
  }
  return {
    project,
    from,
    to,
    agents: meta.size,
    events: Object.values(total).reduce((n, d) => n + d.events, 0),
    windows,
    sources: total,
  };
}

const rate = (n: number | null): string => (n === null ? "-" : n.toFixed(2));
const pair = (p: Pair): string => `${p.events} (${p.main})`;

export function formatCensus(c: Census): string {
  const out: string[] = [];
  out.push(
    `routing census of ${c.project}: ${c.agents} agents, ${c.events} messages about nested workers` +
      ` (${c.from ?? "start"} .. ${c.to ?? "end"})`,
  );
  out.push(
    "messages: events (to main); a twin is a finished notice that repeats a hand-back sent within 5 s",
  );
  const head = [
    "window",
    "versions",
    "tasks",
    "reports",
    "waiting",
    "other",
    "twin",
    "distinct main",
    "per 20 tasks",
    "bg wakes",
  ];
  const lines: string[][] = [head];
  c.windows.forEach((w, i) =>
    lines.push([
      `W${i + 1} ${w.from?.slice(0, 16) ?? "start"}..${w.to?.slice(0, 16) ?? "end"}`,
      w.versions || "-",
      String(w.tasks),
      pair(w.reports),
      pair(w.waiting),
      pair(w.other),
      pair(w.twin),
      String(w.distinctMain),
      rate(w.per20),
      pair(w.bgWakes),
    ]),
  );
  out.push(...table(lines));
  out.push("");
  out.push(
    "wake source of the worker's run (the message went to its owner / to main / to a third agent):",
  );
  const src: string[][] = [["wake source", "events", "owner", "main", "other"]];
  for (const s of WAKE_SOURCES) {
    const d = c.sources[s];
    src.push([s, String(d.events), String(d.owner), String(d.main), String(d.other)]);
  }
  const rest = WAKE_SOURCES.filter(s => !s.startsWith("own bg shell")).reduce(
    (n, s) => n + c.sources[s].events,
    0,
  );
  const restMain = WAKE_SOURCES.filter(s => !s.startsWith("own bg shell")).reduce(
    (n, s) => n + c.sources[s].main,
    0,
  );
  out.push(...table(src));
  out.push(`not woken by its own background shell: ${restMain} of ${rest} to main`);
  return out.join("\n");
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  return rows.map(r =>
    r
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
      .join("  ")
      .trimEnd(),
  );
}

const USAGE =
  "usage: wf-routing-census [--project PATH|DIR] [--from TS] [--to TS] [--cut TS]... [--json]\n" +
  "  --project  a project path (default: the working directory) or a Claude Code transcript directory\n" +
  "  --from/--to  messages in [from, to); --cut TS  split the range into windows at TS (repeatable)\n" +
  "  reads the transcripts only; it reads every transcript of the project: under a minute for several GB";

function projectDir(arg: string): string {
  if (fs.existsSync(arg) && fs.readdirSync(arg).some(f => f.endsWith(".jsonl"))) return arg;
  const root = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "projects",
  );
  return path.join(root, path.resolve(arg).replace(/[^A-Za-z0-9-]/g, "-"));
}

function iso(flag: string, v: string): string {
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`bad ${flag} ${v}`);
  return new Date(t).toISOString();
}

export async function runRoutingCensus(argv: readonly string[]): Promise<string> {
  if (argv.includes("--help") || argv.includes("-h")) return USAGE;
  let project = process.cwd();
  let json = false;
  let from: string | undefined;
  let to: string | undefined;
  const cuts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
      continue;
    }
    if (!["--project", "--from", "--to", "--cut"].includes(a))
      throw new Error(`unknown argument ${a}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    if (a === "--project") project = v;
    else if (a === "--from") from = iso(a, v);
    else if (a === "--to") to = iso(a, v);
    else cuts.push(iso(a, v));
  }
  checkCuts(from ?? null, to ?? null, cuts);
  const dir = projectDir(project);
  if (!fs.existsSync(dir)) throw new Error(`no transcripts at ${dir}`);
  const c = census(await readProject(dir), project, { from, to, cuts });
  return json ? JSON.stringify(c, null, 2) : formatCensus(c);
}

if (
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runRoutingCensus(process.argv.slice(2)).then(
    out => {
      console.log(out);
    },
    (err: unknown) => {
      console.error(`wf-routing-census: ${(err as Error).message}`);
      process.exit(2);
    },
  );
}
