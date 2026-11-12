import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addQueueLine,
  archiveQueue,
  archivePath,
  editQueueLine,
  markQueue,
  pickQueue,
  readQueue,
  restoreQueue,
  today,
} from "./queue.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function queueWith(tasks: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-restore-rearchive-"));
  dirs.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, ".claude", "batch"), { recursive: true });
  const file = path.join(root, ".claude", "batch", "queue.yaml");
  fs.writeFileSync(file, `batch_size: 2\narchive_after_days: 30\ntasks:\n${tasks}`);
  return file;
}

describe("ENG-QUEUE-RESTORE-REARCHIVE", () => {
  it("a restored old done line stays in the queue through the next pick's auto-archive", async () => {
    const file = queueWith(
      "  - id: OLD\n    status: done\n    ended: 2025-01-01\n    text: |-\n      old brief\n" +
        "  - id: KEEP\n    status: pending\n    text: x\n",
    );
    await archiveQueue(file, { olderThanDays: 30 });
    expect(readQueue(file).lines.map(l => l.id)).not.toContain("OLD");
    await restoreQueue(file, "OLD");
    expect(readQueue(file).lines.map(l => l.id)).toContain("OLD");
    await pickQueue(file); // the auto-archive by archive_after_days runs here
    expect(readQueue(file).lines.map(l => l.id)).toContain("OLD");
    expect(fs.readFileSync(archivePath(file), "utf8")).not.toMatch(/id: OLD/);
  });

  const OLD =
    "  - id: OLD\n    status: done\n    ended: 2025-01-01\n    text: |-\n      old brief\n" +
    "  - id: KEEP\n    status: pending\n    text: x\n";

  it("a restore writes restored: today and keeps ended as archived", async () => {
    const file = queueWith(OLD);
    await archiveQueue(file, { olderThanDays: 30 });
    await restoreQueue(file, "OLD");
    const l = readQueue(file).lines.find(x => x.id === "OLD");
    expect(l?.meta.restored).toBe(today());
    expect(l?.meta.ended).toBe("2025-01-01");
  });

  it("a restored line older than N days from the restore day goes out again", async () => {
    const file = queueWith(OLD);
    await archiveQueue(file, { olderThanDays: 30 });
    await restoreQueue(file, "OLD");
    const later = new Date();
    later.setDate(later.getDate() + 31);
    await archiveQueue(file, { olderThanDays: 30, now: later });
    expect(readQueue(file).lines.map(l => l.id)).not.toContain("OLD");
  });

  it("a retry of a restored failed line removes restored, and restored is read-only for add and edit", async () => {
    const file = queueWith(OLD.replace("status: done", "status: failed"));
    await archiveQueue(file, { olderThanDays: 30 });
    await restoreQueue(file, "OLD");
    await expect(editQueueLine(file, "OLD", { restored: "2026-01-01" })).rejects.toThrow(
      /restored is written/,
    );
    await expect(
      addQueueLine(file, { id: "NEW", text: "t", restored: "2026-01-01" }),
    ).rejects.toThrow(/restored is written/);
    await markQueue(file, "OLD", "running", undefined, { retry: true });
    expect(readQueue(file).lines.find(x => x.id === "OLD")?.meta.restored).toBeUndefined();
  });
});
