import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { SessionState } from "./types.js";
import { LOCK_STALE_MS } from "./types.js";
import { EventLog } from "./event-log.js";
import { parseLedger, type LedgerEntry } from "./ledger.js";

export const LEDGER_FILE = "ledger.jsonl";
/** The ledger lines of the last `LEDGER_RECENT_DAYS` days: the plan pane reads this one, since the plugin API rejects a read of a file over 4 MiB and the ledger is never pruned. */
export const LEDGER_RECENT_FILE = "ledger-recent.jsonl";
export const LEDGER_RECENT_DAYS = 30;
/** Under the plugin API's 4 MiB read cap, with room to spare (a line is ASCII or near it). */
export const LEDGER_RECENT_MAX_BYTES = 3 * 1024 * 1024;
// A contended lock waits its turn instead of failing: a session file is
// written by its own transitions and, outside their queue, by set_priority;
// the ledger is shared by every session and process.
const LOCK_RETRIES = { retries: 100, minTimeout: 5, maxTimeout: 50, randomize: true };

export class Storage {
  private readonly _stateDir: string;
  /** What sessions did in this server run: derived from every session write. */
  public readonly events: EventLog;

  /** `eventLog: false` = a short-lived reader (session-cli): memory-only log, no files, no pruning. */
  constructor(stateDir: string, options: { readonly eventLog?: boolean } = {}) {
    this._stateDir = stateDir;
    this.events = new EventLog(options.eventLog === false ? undefined : stateDir);
    fs.mkdirSync(this._stateDir, { recursive: true });
  }

  private _filePath(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this._stateDir, `${safe}.json`);
  }

  public read(sessionId: string): SessionState | null {
    const fp = this._filePath(sessionId);
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, "utf-8");
    return JSON.parse(raw) as SessionState;
  }

  public async write(sessionId: string, state: SessionState): Promise<void> {
    await this._locked(sessionId, () => state);
  }

  /**
   * Read-modify-write under the session file's lock: `change` gets the
   * session as stored now (null when there is none) and returns the state to
   * write, or null to leave it as it is; it must be pure (an absent session
   * may see it called twice). For a writer outside the session's transition
   * queue, whose earlier snapshot may be stale by the time it writes.
   */
  public async update(
    sessionId: string,
    change: (current: SessionState | null) => SessionState | null,
  ): Promise<SessionState | null> {
    if (!fs.existsSync(this._filePath(sessionId)) && change(null) === null) return null;
    return this._locked(sessionId, () => {
      const current = this.read(sessionId);
      // write()'s `{}` placeholder of a session being created is no session yet
      return change(current?.session_id ? current : null);
    });
  }

  /** The stored session; null when absent, unreadable or the `{}` placeholder of one being created. */
  private _current(sessionId: string): SessionState | null {
    try {
      const cur = this.read(sessionId);
      return cur?.session_id ? cur : null;
    } catch {
      return null;
    }
  }

  private async _locked(
    sessionId: string,
    next: () => SessionState | null,
  ): Promise<SessionState | null> {
    const fp = this._filePath(sessionId);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    // proper-lockfile locks an existing file; update() reads this placeholder as no session.
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, "{}");

    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(fp, { stale: LOCK_STALE_MS, retries: LOCK_RETRIES });
      const prev = this._current(sessionId);
      const state = next();
      if (state) {
        const tmp = fp + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, fp);
        if (state.session_id)
          this.events.observe(
            prev,
            state,
            state.parent_session_id ? this._current(state.parent_session_id) : null,
          );
      }
      return state;
    } finally {
      if (release) await release();
    }
  }

  /**
   * Append one JSON line to `$STATE_DIR/ledger.jsonl` under the same lock
   * discipline as session writes. The ledger is never pruned: it outlives the
   * terminal-session cap.
   */
  public async appendLedger(entry: object): Promise<void> {
    const fp = path.join(this._stateDir, LEDGER_FILE);
    fs.mkdirSync(this._stateDir, { recursive: true });
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, "", { flag: "a" });

    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(fp, { stale: LOCK_STALE_MS, retries: LOCK_RETRIES });
      fs.appendFileSync(fp, JSON.stringify(entry) + "\n");
      this._writeLedgerRecent(fp);
    } finally {
      if (release) await release();
    }
  }

  /**
   * Rewrite `ledger-recent.jsonl` from the ledger (caller holds the ledger lock): the lines that ended within the
   * window, cut to the fields the plan pane reads (task runs and parent stretches only), and never over
   * `LEDGER_RECENT_MAX_BYTES`: past it the oldest lines are dropped.
   */
  private _writeLedgerRecent(ledgerFile: string): void {
    const since = Date.now() - LEDGER_RECENT_DAYS * 86_400_000;
    const keep: string[] = [];
    for (const line of fs.readFileSync(ledgerFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        if (!(Date.parse(typeof j.ended_at === "string" ? j.ended_at : "") >= since)) continue;
        if (typeof j.task !== "string" && !j.parent_spend) continue;
        const spend = j.spend as { usd?: unknown } | undefined;
        const ps = j.parent_spend as { to?: unknown; project?: unknown; usd?: unknown } | undefined;
        keep.push(
          JSON.stringify({
            task: j.task,
            workflow: j.workflow,
            started_at: j.started_at,
            ended_at: j.ended_at,
            outcome: j.outcome,
            visits: j.visits,
            difficulty: j.difficulty,
            ...(spend && spend.usd !== undefined ? { spend: { usd: spend.usd } } : {}),
            ...(ps ? { parent_spend: { to: ps.to, project: ps.project, usd: ps.usd } } : {}),
          }),
        );
      } catch {
        // a damaged line is not a run
      }
    }
    let bytes = 0;
    let from = keep.length;
    while (from > 0 && bytes + keep[from - 1].length + 1 <= LEDGER_RECENT_MAX_BYTES)
      bytes += keep[--from].length + 1;
    const out = path.join(this._stateDir, LEDGER_RECENT_FILE);
    fs.writeFileSync(
      `${out}.tmp`,
      keep
        .slice(from)
        .map(l => `${l}\n`)
        .join(""),
    );
    fs.renameSync(`${out}.tmp`, out);
  }

  /** Every line of the ledger (a damaged line is skipped); none when it was never written. */
  public readLedger(): LedgerEntry[] {
    const fp = path.join(this._stateDir, LEDGER_FILE);
    return fs.existsSync(fp) ? parseLedger(fs.readFileSync(fp, "utf8")) : [];
  }

  /** A JSON file of the state directory (an operator's setting), or null when absent or damaged. */
  public readStateJson(name: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(path.join(this._stateDir, name), "utf8"));
    } catch {
      return null;
    }
  }

  public list(): string[] {
    if (!fs.existsSync(this._stateDir)) return [];
    return fs
      .readdirSync(this._stateDir)
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(/\.json$/, ""));
  }

  public delete(sessionId: string): boolean {
    const fp = this._filePath(sessionId);
    if (!fs.existsSync(fp)) return false;
    fs.unlinkSync(fp);
    return true;
  }

  public readAll(): SessionState[] {
    return this.list()
      .map(id => this.read(id))
      .filter((s): s is SessionState => s !== null);
  }

  /**
   * Keep only the `keep` most recently updated terminal sessions; delete older ones.
   * Active sessions are untouched. Corrupt/unreadable session files are also deleted.
   *
   * No plan-referenced-session guard is needed here (unlike workflow-cleanup.sh):
   * plan resume requires an active stack, while this only prunes empty-stack
   * (terminal) sessions, so the two sets can never collide.
   */
  public pruneTerminal(keep: number): void {
    const sessions: SessionState[] = [];
    for (const id of this.list()) {
      try {
        const s = this.read(id);
        if (s) sessions.push(s);
      } catch (e) {
        console.error(`Deleting corrupt session file ${id}:`, e);
        this.delete(id);
      }
    }
    prunePolicy(sessions, keep, id => this.delete(id));
  }
}

/**
 * Shared terminal-session retention policy. Deletes all but the `keep` most
 * recently updated terminal (empty-stack) sessions via `del`.
 *
 * Secondary sort by session_id: _cascadeAbandonChildren stamps every child
 * with one identical updated_at, so a stable tiebreak is required for the
 * retained set to be deterministic and to match workflow-cleanup.sh.
 * The `s.stack?.length` guard skips transient `{}` placeholder files that
 * write() creates before its lock+rename completes.
 */
export function prunePolicy(
  sessions: SessionState[],
  keep: number,
  del: (sessionId: string) => void,
): void {
  if (keep < 0) throw new Error(`prunePolicy: keep must be >= 0, got ${keep}`);
  const terminal = sessions.filter(s => s.stack?.length === 0);
  // A terminal child of a parent that is not itself terminal (still running, or
  // not yet written) stays: the parent's ledger spend sums its children's agents
  // when it ends, and a pruned child would drop out of that sum.
  const terminalIds = new Set(terminal.map(s => s.session_id));
  const retainable = terminal.filter(
    s => !s.parent_session_id || terminalIds.has(s.parent_session_id),
  );
  retainable.sort(
    (a, b) => b.updated_at.localeCompare(a.updated_at) || b.session_id.localeCompare(a.session_id),
  );
  for (const s of retainable.slice(keep)) del(s.session_id);
}
