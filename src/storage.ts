import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { SessionState } from "./types.js";
import { LOCK_STALE_MS } from "./types.js";

export class Storage {
  private readonly _stateDir: string;

  constructor(stateDir: string) {
    this._stateDir = stateDir;
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
    const fp = this._filePath(sessionId);
    const dir = path.dirname(fp);
    fs.mkdirSync(dir, { recursive: true });

    // Create file if it doesn't exist (lockfile needs it)
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, "{}");
    }

    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(fp, { stale: LOCK_STALE_MS });
      const tmp = fp + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, fp);
    } finally {
      if (release) await release();
    }
  }

  public list(): string[] {
    if (!fs.existsSync(this._stateDir)) return [];
    return fs.readdirSync(this._stateDir)
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
  del: (sessionId: string) => void
): void {
  if (keep < 0) throw new Error(`prunePolicy: keep must be >= 0, got ${keep}`);
  const terminal = sessions.filter(s => s.stack?.length === 0);
  terminal.sort(
    (a, b) =>
      b.updated_at.localeCompare(a.updated_at) || b.session_id.localeCompare(a.session_id)
  );
  for (const s of terminal.slice(keep)) del(s.session_id);
}
