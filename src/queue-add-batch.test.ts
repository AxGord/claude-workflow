import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addQueueLine,
  addQueueLines,
  archiveQueue,
  markQueue,
  planPick,
  QueueError,
  readQueue,
} from "./queue.js";
import { registerTools } from "./tools.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/** A queue with a running line P (the one a split mark closes) and a done line D. */
function setup(extra = ""): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-qbatch-")));
  dirs.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, ".claude", "batch"), { recursive: true });
  const file = path.join(root, ".claude", "batch", "q.yaml");
  fs.writeFileSync(
    file,
    `batch_size: 4
tasks:
  - id: D
    status: done
    difficulty: 2
    text: finished
  - id: P
    status: running
    difficulty: 5
    touches: [p]
    text: the line to split
${extra}`,
  );
  return file;
}

const SLICES = [
  { id: "S1", difficulty: 3, touches: ["a"], text: "first" },
  { id: "S2", difficulty: 3, touches: ["b"], after: ["S1"], text: "second" },
  { id: "S3", difficulty: 4, touches: ["c"], after: ["S1", "D"], text: "third" },
];

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(QueueError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("queue_add_batch: all or nothing", () => {
  it("a list with one bad line writes nothing and names that line", async () => {
    const file = setup();
    const before = fs.readFileSync(file, "utf8");
    const msg = await refusal(
      addQueueLines(file, [SLICES[0], { id: "S2", touches: ["b"], text: "no difficulty" }]),
    );
    expect(msg).toContain("nothing written");
    expect(msg).toContain("line 2 (S2): difficulty: <1-10> is required on a pending line");
    expect(msg).not.toContain("line 1");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("a refusal names every failing line, whichever check caught it", async () => {
    const file = setup();
    const before = fs.readFileSync(file, "utf8");
    const msg = await refusal(
      addQueueLines(file, [
        { id: "S1", difficulty: 3, text: "ok" },
        { id: "D", difficulty: 3, text: "taken by the queue" },
        { id: "S1", difficulty: 3, text: "repeats line 1" },
        { id: "S4", difficulty: 3, bogus: 1 },
        { id: "S5", difficulty: 99 },
        { id: "S6", difficulty: 3, after: ["NOPE-1"] },
        "not a mapping" as never,
      ]),
    );
    expect(msg).toContain("line 2 (D): D is already in");
    expect(msg).toContain("line 3 (S1): the id repeats line 1");
    expect(msg).toContain('line 4 (S4): unknown key "bogus"');
    expect(msg).toContain("line 5 (S5):");
    expect(msg).toContain("line 6 (S6): after: NOPE-1 — no such task in the queue");
    expect(msg).toContain("line 7: is not a mapping");
    expect(msg).not.toContain("line 1 (S1):");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("a valid list lands in one write, in order, with the engine's stamps", async () => {
    const file = setup();
    const renames = vi.spyOn(fs, "renameSync");
    const r = await addQueueLines(file, SLICES);
    expect(renames).toHaveBeenCalledTimes(1);
    expect(r.ids).toEqual(["S1", "S2", "S3"]);
    const q = readQueue(file);
    expect(q.lines.map(l => l.id)).toEqual(["D", "P", "S1", "S2", "S3"]);
    expect(q.lines[2].meta.added).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(q.lines[2].meta.text_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(q.lines[4].meta.after).toBe("S1, D");
  });

  it("the list goes after_id / before_id as one block, in order", async () => {
    const file = setup();
    await addQueueLines(file, SLICES.slice(0, 2), { before: "P" });
    expect(readQueue(file).lines.map(l => l.id)).toEqual(["D", "S1", "S2", "P"]);
    await addQueueLines(file, [{ id: "S3", difficulty: 3, text: "x" }], { after: "D" });
    expect(readQueue(file).lines.map(l => l.id)).toEqual(["D", "S3", "S1", "S2", "P"]);
  });

  it("after: between two new lines is accepted; a cycle between them is refused", async () => {
    const file = setup();
    const before = fs.readFileSync(file, "utf8");
    const msg = await refusal(
      addQueueLines(file, [
        { id: "X1", difficulty: 3, after: ["X2"], text: "x1" },
        { id: "X2", difficulty: 3, after: ["X1"], text: "x2" },
      ]),
    );
    expect(msg).toMatch(/after: closes a cycle X[12] → X[12] → X[12]/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    // a forward reference inside the list is no cycle
    await addQueueLines(file, [
      { id: "Y1", difficulty: 3, after: ["Y2"], text: "y1" },
      { id: "Y2", difficulty: 3, text: "y2" },
    ]);
    expect(readQueue(file).lines.find(l => l.id === "Y1")?.meta.after).toBe("Y2");
  });
});

describe("split_from and the split mark", () => {
  it("split_from round-trips through a plain queue_add; an unknown parent is refused", async () => {
    const file = setup();
    await addQueueLine(file, { id: "F", difficulty: 3, split_from: "P", text: "slice" });
    expect(readQueue(file).lines.find(l => l.id === "F")?.meta.split_from).toBe("P");
    expect(fs.readFileSync(file, "utf8")).toContain("split_from: P\n");
    await expect(
      addQueueLine(file, { id: "G", difficulty: 3, split_from: "NOPE-1", text: "x" }),
    ).rejects.toThrow(/split_from: NOPE-1 — no such task/);
    await expect(addQueueLine(file, { id: "H", split_into: ["F"], difficulty: 3 })).rejects.toThrow(
      /split_into is written by the split mark/,
    );
  });

  it("split: marks the running line failed with split_into, and every new line carries split_from, in one write", async () => {
    const file = setup();
    const renames = vi.spyOn(fs, "renameSync");
    const r = await addQueueLines(file, SLICES, { split: "P" });
    expect(renames).toHaveBeenCalledTimes(1);
    expect(r.split).toBe("P");
    const q = readQueue(file);
    const p = q.lines.find(l => l.id === "P");
    expect(p?.status).toBe("failed");
    expect(p?.meta.split_into).toBe("S1, S2, S3");
    expect(p?.meta.ended).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(p?.notes.at(-1)).toMatchObject({ from: "split", text: "split into S1, S2, S3" });
    for (const id of ["S1", "S2", "S3"]) {
      const l = q.lines.find(x => x.id === id);
      expect(l?.status).toBe("pending");
      expect(l?.meta.split_from).toBe("P");
    }
  });

  it("a line that is not running is not marked split, and the whole list is refused", async () => {
    const file = setup();
    const before = fs.readFileSync(file, "utf8");
    expect(await refusal(addQueueLines(file, SLICES, { split: "D" }))).toContain(
      "split: D is done: only a running line is marked split",
    );
    expect(await refusal(addQueueLines(file, SLICES, { split: "NOPE-1" }))).toContain("split:");
    expect(
      await refusal(addQueueLines(file, [{ ...SLICES[0], split_from: "D" }], { split: "P" })),
    ).toContain("split_from: is P under split: P");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("a bad line under split: leaves the running line running", async () => {
    const file = setup();
    await refusal(addQueueLines(file, [SLICES[0], { id: "S2", text: "x" }], { split: "P" }));
    expect(readQueue(file).lines.find(l => l.id === "P")?.status).toBe("running");
  });

  it("a line after the split line waits for its slices; a split line is not retried", async () => {
    const file = setup(
      "  - id: AFTER\n    status: pending\n    difficulty: 2\n    after: [P]\n    touches: [z]\n    text: later\n",
    );
    await addQueueLines(file, SLICES.slice(0, 2), { split: "P" });
    const waiting = planPick(readQueue(file));
    expect(waiting.reasons.find(x => x.id === "AFTER")?.why).toContain("P (split) → S1 (pending)");
    await markQueue(file, "S1", "running");
    await markQueue(file, "S1", "done");
    await markQueue(file, "S2", "running");
    await markQueue(file, "S2", "done");
    expect(planPick(readQueue(file)).admitted.map(a => a.id)).toContain("AFTER");
    await expect(markQueue(file, "P", "running", undefined, { retry: true })).rejects.toThrow(
      /was split into S1, S2: a retry would run it again/,
    );
  });
});

describe("a nested split and the archive", () => {
  const ended = "    ended: 2026-09-01\n";
  const nested = (sub: string): string =>
    `  - id: P2\n    status: failed\n${ended}    split_into: [S1, S2]\n    text: top\n` +
    `  - id: S1\n    status: failed\n${ended}    split_into: [S1a, S1b]\n    text: mid\n` +
    `  - id: S1a\n    status: ${sub}\n${ended}    text: a\n` +
    `  - id: S1b\n    status: done\n${ended}    text: b\n` +
    `  - id: S2\n    status: done\n${ended}    text: c\n` +
    "  - id: W\n    status: pending\n    difficulty: 2\n    after: [P2]\n    touches: [w]\n    text: waits\n";

  it("keeps a slice that was split in turn, so a line after the top line is admitted once the sub-slices are done", async () => {
    const file = setup(nested("done"));
    await archiveQueue(file, { olderThanDays: 30, now: new Date(2026, 10, 9, 12) });
    const q = readQueue(file);
    expect(q.lines.map(l => l.id)).toContain("S1");
    expect(q.archived.has("S1")).toBe(false);
    expect(planPick(q).admitted.map(a => a.id)).toEqual(["W"]);
  });

  it("a sub-slice that is not done waits the dependent without sticking it", async () => {
    const file = setup(nested("failed"));
    await archiveQueue(file, { olderThanDays: 30, now: new Date(2026, 10, 9, 12) });
    const why = planPick(readQueue(file)).reasons.find(x => x.id === "W")?.why;
    expect(why).toContain("S1a (failed)");
  });
});

describe("the entries to queue_add_batch", () => {
  it("the MCP tool takes `lines`, answers with the ids and refuses as the function does", async () => {
    const file = setup();
    const handlers = new Map<
      string,
      (a: object) => Promise<{ isError?: boolean; content: { text: string }[] }>
    >();
    registerTools(
      { registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const call = handlers.get("queue_add_batch");
    expect(call).toBeDefined();
    const bad = await call?.({ file, lines: [{ id: "S1", text: "no difficulty" }] });
    expect(bad?.isError).toBe(true);
    expect(bad?.content[0].text).toContain("line 1 (S1): difficulty");
    const ok = await call?.({ file, lines: SLICES, split: "P" });
    expect(ok?.isError).toBeUndefined();
    expect(ok?.content[0].text).toContain("3 tasks added from line");
    expect(ok?.content[0].text).toContain("P marked split");
    expect(readQueue(file).lines.map(l => l.id)).toEqual(["D", "P", "S1", "S2", "S3"]);
  });

  async function cli(...args: string[]): Promise<{ code: unknown; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown, cb?: unknown) => {
      out.push(String(c));
      if (typeof cb === "function") (cb as () => void)();
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(c => (err.push(String(c)), true));
    const argv = process.argv;
    process.argv = ["node", "wf-queue", ...args];
    process.exitCode = undefined;
    vi.resetModules();
    await import("./queue-cli.js");
    for (let i = 0; i < 100 && process.exitCode === undefined; i++)
      await new Promise(r => setTimeout(r, 10));
    vi.restoreAllMocks();
    process.argv = argv;
    return { code: process.exitCode, out: out.join(""), err: err.join("") };
  }

  it("wf-queue --add-batch reads a YAML list; a bad one exits 2 with the file unchanged", async () => {
    const file = setup();
    const list = path.join(path.dirname(file), "list.yaml");
    fs.writeFileSync(list, "- {id: S1, difficulty: 3, text: one}\n- {id: S2}\n");
    const before = fs.readFileSync(file, "utf8");
    const bad = await cli(file, "--add-batch", list, "--split", "P");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("line 2 (S2): difficulty: <1-10> is required");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    fs.writeFileSync(
      list,
      "tasks:\n  - {id: S1, difficulty: 3, text: one}\n  - {id: S2, difficulty: 3, text: two}\n",
    );
    const ok = await cli(file, "--add-batch", list, "--split", "P");
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("2 tasks added from line");
    expect(readQueue(file).lines.map(l => `${l.id}:${l.status}`)).toEqual([
      "D:done",
      "P:failed",
      "S1:pending",
      "S2:pending",
    ]);
  });
});
