import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { appendMarkdown } from "./queue-convert.js";
import {
  archivePath,
  archiveQueue,
  pickQueue,
  readQueue,
  restoreQueue,
  rewriteQueue,
} from "./queue.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const NOW = new Date(2026, 10, 9, 12);

function queueWith(tasks: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-archive-tails-"));
  dirs.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, ".claude", "batch"), { recursive: true });
  const file = path.join(root, ".claude", "batch", "queue.yaml");
  fs.writeFileSync(file, `batch_size: 2\ntasks:\n${tasks}`);
  return file;
}

const DONE_A =
  "  - id: A\n    status: done\n    ended: 2026-09-01\n    text: |-\n      brief of A\n" +
  "  - id: KEEP\n    status: pending\n    text: x\n";

describe("ENG-QUEUE-ARCHIVE-TAILS", () => {
  // (1) `wf-queue --convert old.md --into queue.yaml` runs exactly this: appendMarkdown inside rewriteQueue.
  it("--convert --into refuses an id the archive holds, as queue_add does", async () => {
    const file = queueWith(DONE_A);
    await archiveQueue(file, { olderThanDays: 30, now: NOW });
    const md = "batch_size: 2\n\n## Tasks\n- [ ] A | model: opus | the old brief of A |\n";
    const convert = rewriteQueue(file, cur => {
      const r = appendMarkdown(cur, md, "backlog", "old.md");
      return { text: r.text, answer: r.added };
    });
    await expect(convert).rejects.toThrow(/A is already in .*\(archived\)/);
    expect(readQueue(file).lines.filter(l => l.id === "A")).toHaveLength(0);
  });

  // (3) a crash between the archive write and the queue write leaves A in both files; the retry's
  // re-archive must keep the fresher (queue) copy, not the stale archived one.
  it("a re-archive after a crash keeps the fresher copy of a line held in both files", async () => {
    const file = queueWith(DONE_A);
    await archiveQueue(file, { olderThanDays: 30, now: NOW });
    const fresher =
      "  - id: A\n    status: failed\n    ended: 2026-09-02\n    text: |-\n      fresher brief of A\n";
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("tasks:\n", `tasks:\n${fresher}`));
    await archiveQueue(file, { olderThanDays: 30, now: NOW });
    const arch = YAML.parse(fs.readFileSync(archivePath(file), "utf8")) as {
      tasks: { id: string; status: string; text: string }[];
    };
    const a = arch.tasks.filter(t => t.id === "A");
    expect(a).toHaveLength(1);
    expect(a[0].status).toBe("failed");
    expect(a[0].text).toBe("fresher brief of A");
  });

  // (2) restore: one archived id back into the queue, whole, under the lock.
  const WAITER = "  - id: W\n    status: pending\n    after: [A]\n    text: waits\n";
  const FAILED_A =
    "  - id: A\n    status: failed\n    ended: 2026-09-01\n    text: |-\n      brief of A\n";

  it("restoreQueue moves an archived failed line back whole, so a waiter on it is a queue line again", async () => {
    const file = queueWith(FAILED_A + "  - id: KEEP\n    status: pending\n    text: x\n");
    await archiveQueue(file, { olderThanDays: 30, now: NOW });
    fs.writeFileSync(file, fs.readFileSync(file, "utf8") + WAITER);
    expect(
      (await pickQueue(file, { dryRun: true })).reasons.some(r =>
        /A \(failed, archived\)/.test(r.why),
      ),
    ).toBe(true);
    const r = await restoreQueue(file, "A");
    expect(r).toMatchObject({ id: "A", status: "failed", inQueue: false });
    const q = readQueue(file);
    expect(q.lines.map(l => l.id)).toEqual(["KEEP", "W", "A"]);
    expect(q.lines[2]).toMatchObject({ status: "failed", meta: { ended: "2026-09-01" } });
    expect(q.lines[2].text).toBe("brief of A");
    expect(q.archived.has("A")).toBe(false);
    expect(fs.readFileSync(archivePath(file), "utf8")).not.toContain("brief of A");
    // an id the archive does not hold is refused, the queue untouched
    const before = fs.readFileSync(file, "utf8");
    await expect(restoreQueue(file, "A")).rejects.toThrow(/A is not in .*queue\.archive\.yaml/);
    await expect(restoreQueue(file, "NOPE")).rejects.toThrow(/NOPE is not in/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("restoreQueue on a line held in both files (a crash) removes only the archive's copy", async () => {
    const file = queueWith(DONE_A);
    await archiveQueue(file, { olderThanDays: 30, now: NOW });
    const fresher =
      "  - id: A\n    status: failed\n    ended: 2026-09-02\n    text: |-\n      fresher brief of A\n";
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("tasks:\n", `tasks:\n${fresher}`));
    const r = await restoreQueue(file, "A");
    expect(r.inQueue).toBe(true);
    const a = readQueue(file).lines.filter(l => l.id === "A");
    expect(a).toHaveLength(1);
    expect(a[0].text).toBe("fresher brief of A");
    expect(readQueue(file).archived.has("A")).toBe(false);
  });

  it("wf-queue --restore ID is the CLI form; there is no MCP tool for it", async () => {
    const file = queueWith(DONE_A);
    await archiveQueue(file, { olderThanDays: 30, now: NOW });
    const out: string[] = [];
    const argv = process.argv;
    vi.spyOn(process.stdout, "write").mockImplementation(c => (out.push(String(c)), true));
    process.argv = ["node", "wf-queue", file, "--restore", "A"];
    process.exitCode = undefined;
    try {
      vi.resetModules();
      await import("./queue-cli.js");
      for (let i = 0; i < 100 && process.exitCode === undefined; i++)
        await new Promise(r => setTimeout(r, 10));
      expect(process.exitCode).toBe(0);
    } finally {
      process.argv = argv;
      process.exitCode = undefined;
      vi.restoreAllMocks();
    }
    expect(out.join("")).toBe(`restored A (done) ← ${archivePath(file)}\n`);
    expect(readQueue(file).lines.map(l => l.id)).toContain("A");
    expect(fs.readFileSync(path.join(import.meta.dirname, "tools.ts"), "utf8")).not.toMatch(
      /queue_restore/,
    );
  });
});
