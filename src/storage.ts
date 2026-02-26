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
}
