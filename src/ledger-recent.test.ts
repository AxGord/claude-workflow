import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LEDGER_RECENT_FILE, LEDGER_RECENT_MAX_BYTES, Storage } from "./storage.js";

describe("ENG-PANE-LANDED-ROW-BROKEN: ledger-recent.jsonl", () => {
  it("holds only the lines that ended within the window, rewritten on each append", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-ledger-recent."));
    try {
      const st = new Storage(dir);
      const old = { task: "OLD", ended_at: "2020-01-01T00:00:00Z" };
      const fresh = { task: "NEW", ended_at: new Date().toISOString() };
      await st.appendLedger(old);
      await st.appendLedger(fresh);
      const lines = fs.readFileSync(path.join(dir, LEDGER_RECENT_FILE), "utf8").trim().split("\n");
      expect(lines.map(l => (JSON.parse(l) as { task: string }).task)).toEqual(["NEW"]);
      expect(st.readLedger().length).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays under the byte cap over more than 4 MiB of fresh lines and keeps the newest row whole", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-ledger-recent."));
    try {
      const st = new Storage(dir);
      const now = Date.now();
      const row = (i: number) => ({
        task: `T${i}`,
        workflow: "engine-task",
        started_at: new Date(now - 60_000).toISOString(),
        ended_at: new Date(now - i).toISOString(),
        outcome: "completed",
        visits: { land: 1 },
        difficulty: 3,
        spend: { usd: 1.5, agents: 1 },
        pad: "x".repeat(2000),
      });
      const rows = Array.from({ length: 2400 }, (_, i) => row(2400 - i));
      fs.writeFileSync(
        path.join(dir, "ledger.jsonl"),
        rows.map(r => `${JSON.stringify(r)}\n`).join(""),
      );
      expect(fs.statSync(path.join(dir, "ledger.jsonl")).size).toBeGreaterThan(4 * 1024 * 1024);
      await st.appendLedger(row(0));
      const file = path.join(dir, LEDGER_RECENT_FILE);
      expect(fs.statSync(file).size).toBeLessThanOrEqual(LEDGER_RECENT_MAX_BYTES);
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1]) as {
        task: string;
        spend: { usd: number };
        started_at: string;
        pad?: string;
      };
      expect(last.task).toBe("T0");
      expect(last.spend).toEqual({ usd: 1.5 });
      expect(last.started_at).toBe(rows[0].started_at);
      expect(last.pad).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
