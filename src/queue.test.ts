import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { explainLines, markQueue, parseQueue, pickQueue, planPick, readQueue } from "./queue.js";
import { formatQueueNext } from "./tools.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A project (a `.git` dir) with its queue at `.claude/batch/q.md`; returns the queue path. */
function queueFile(body: string, header = "batch_size: 2"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-queue-"));
  dirs.push(root);
  const proj = path.join(root, "proj");
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  fs.mkdirSync(path.join(proj, ".claude", "batch"), { recursive: true });
  const file = path.join(proj, ".claude", "batch", "q.md");
  fs.writeFileSync(file, `# Batch: t\n${header}\n\n## Tasks\n${body}\n`);
  return file;
}

const plan = (body: string, header?: string) => planPick(readQueue(queueFile(body, header)));
const admittedIds = (body: string, header?: string) => plan(body, header).admitted.map(a => a.id);
const marks = (file: string) =>
  Object.fromEntries(readQueue(file).lines.map(l => [l.id, l.mark] as const));

describe("queue admission (parity with the picker script)", () => {
  const T = "touches: ";
  // [name, queue body, header, admitted ids]
  const cases: [string, string, string | undefined, string[]][] = [
    [
      "window = batch_size minus the [>] lines",
      `- [>] R1 | ${T}a\n- [ ] A | ${T}b\n- [ ] B | ${T}c`,
      undefined,
      ["A"],
    ],
    [
      "after: waits for [x]; a [>] or [ ] dependency blocks",
      `- [x] D | ${T}d\n- [ ] A | after: D | ${T}a\n- [ ] B | after: A | ${T}b`,
      "batch_size: 3",
      ["A"],
    ],
    [
      "after: an id-like token that names no line, or prose beside the ids, is manual",
      `- [x] D | ${T}d\n- [ ] A | after: X9 | ${T}a\n- [ ] B | after: D when ready | ${T}b`,
      undefined,
      [],
    ],
    [
      "touches: a prefix on a / boundary overlaps; a bare string prefix does not",
      `- [>] R | ${T}src/a\n- [ ] A | ${T}src/a/b.ts\n- [ ] B | ${T}src/ab, ./docs/`,
      "batch_size: 3",
      ["B"],
    ],
    [
      "touches: the running line's path under the candidate's overlaps too",
      `- [>] R | ${T}src/a/b\n- [ ] A | ${T}src/a\n- [ ] B | ${T}src/c`,
      "batch_size: 3",
      ["B"],
    ],
    [
      "touches: a line admitted earlier in the same pick blocks the next",
      `- [ ] A | ${T}src (all of it)\n- [ ] B | ${T}src/x`,
      undefined,
      ["A"],
    ],
    [
      "owner: equal or a .-prefix overlaps, even with disjoint touches",
      `- [>] R | ${T}a | owner: typer\n- [ ] A | ${T}b | owner: typer.flow\n- [ ] B | ${T}c | owner: writer`,
      "batch_size: 3",
      ["B"],
    ],
    [
      "owner: the running owner under the candidate's overlaps too",
      `- [>] R | ${T}a | owner: typer.flow\n- [ ] A | ${T}b | owner: typer\n- [ ] B | ${T}c | owner: writer`,
      "batch_size: 3",
      ["B"],
    ],
    [
      "a line without touches: overlaps everything",
      `- [>] R | ${T}a\n- [ ] A | model: opus\n- [ ] B | ${T}b`,
      "batch_size: 3",
      ["B"],
    ],
    [
      "without touches: it runs alone when nothing else does",
      `- [ ] A | model: opus\n- [ ] B | ${T}b`,
      "batch_size: 3",
      ["A"],
    ],
    [
      "⏸ in a metadata field or after: skips; ⏸ inside long prose is a mention",
      `- [ ] A | ⏸ | ${T}a\n- [ ] B | after: ⏸ | ${T}b\n- [ ] C | ${T}c | ${"x".repeat(170)} | later ⏸ mentioned`,
      "batch_size: 3",
      ["C"],
    ],
    [
      "model — is a parent-run line",
      `- [ ] A | model: — | ${T}a\n- [ ] B | model: sonnet | ${T}b`,
      undefined,
      ["B"],
    ],
    [
      "[x] / [!] lines are neither running nor pending",
      `- [x] A\n- [!] B\n- [ ] C`,
      undefined,
      ["C"],
    ],
  ];
  it.each(cases)("%s", (_name, body, header, expected) => {
    expect(admittedIds(body, header)).toEqual(expected);
  });

  it("exit codes: 0 admitted, 10 wait for a running line, 11 done", () => {
    expect(plan(`- [ ] A | ${"touches: a"}`).code).toBe(0);
    expect(plan(`- [>] R\n- [ ] A | touches: a`).code).toBe(10);
    expect(plan(`- [x] R\n- [ ] A | after: B | touches: a\n- [!] B`).code).toBe(11);
  });

  it("the reasons name why each pending line waits", () => {
    const r = plan(`- [>] R | touches: a\n- [ ] A | touches: a/b\n- [ ] B | after: R | touches: b`);
    expect(r.reasons).toEqual([
      { id: "A", why: "overlaps R (touches a/b ~ a)" },
      { id: "B", why: "after: R[>]" },
    ]);
  });

  it("an admitted line carries model, effort, repo and its free text", () => {
    const r = plan(`- [ ] A | model: sonnet | effort: medium | touches: a | Do the thing. |`);
    expect(r.admitted).toHaveLength(1);
    const a = r.admitted[0];
    expect([a.id, a.model, a.effort, a.text]).toEqual(["A", "sonnet", "medium", "Do the thing."]);
    expect(path.basename(a.repo)).toBe("proj");
    const d = plan(`- [ ] A | touches: a | text`).admitted[0];
    expect([d.model, d.effort]).toEqual(["opus", "-"]);
  });
});

describe("queue repo:", () => {
  it("absolute path; a name via base: or beside the project; an unknown name is not admitted", () => {
    const file = queueFile(
      [
        "- [ ] A | repo: /abs/x | touches: a",
        "- [ ] B | repo: lib | touches: b",
        "- [ ] C | repo: sib | touches: c",
        "- [ ] D | repo: nowhere | touches: d",
      ].join("\n"),
      "batch_size: 4\nbase: /src/lib=abc123",
    );
    fs.mkdirSync(path.join(path.dirname(file), "..", "..", "..", "sib"));
    const r = planPick(readQueue(file));
    expect(Object.fromEntries(r.admitted.map(a => [a.id, a.repo]))).toEqual({
      A: "/abs/x",
      B: "/src/lib",
      C: path.join(path.dirname(file), "..", "..", "..", "sib"),
    });
    expect(r.reasons).toEqual([{ id: "D", why: 'repo: "nowhere" resolves to no directory' }]);
  });
});

describe("queue pause (batch_size: 0)", () => {
  it("admits nothing; 12 when nothing runs, 10 while a line still runs; the comment is shown", () => {
    const header = "batch_size: 0  # пауза: машина занята, было 4";
    const idle = plan(`- [ ] A | touches: a`, header);
    expect(idle.admitted).toEqual([]);
    expect(idle.code).toBe(12);
    expect(idle.batchComment).toBe("пауза: машина занята, было 4");
    const text = formatQueueNext({ ...idle, dryRun: false }, true);
    expect(text).toContain("window 0 — paused: пауза: машина занята, было 4");
    expect(text).toContain("A: paused (batch_size 0)");
    expect(plan(`- [>] R | touches: r\n- [ ] A | touches: a`, header).code).toBe(10);
  });

  it("a header without batch_size, or without ## Tasks, is an error", () => {
    expect(() => parseQueue("# x\nbatch_size: n\n## Tasks\n", "q")).toThrow(/batch_size/);
    expect(() => parseQueue("# x\nbatch_size: 1\n", "q")).toThrow(/## Tasks/);
  });
});

describe("queue writes", () => {
  it("a pick marks the admitted lines [>] and changes nothing else; dry run writes nothing", async () => {
    const file = queueFile(`- [ ] A | touches: a | text one |\n- [ ] B | after: A | touches: b`);
    const before = fs.readFileSync(file, "utf8");
    const dry = await pickQueue(file, { dryRun: true });
    expect(dry.admitted.map(a => a.id)).toEqual(["A"]);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    await pickQueue(file);
    expect(fs.readFileSync(file, "utf8")).toBe(before.replace("- [ ] A |", "- [>] A |"));
  });

  it("queue_mark moves only from the expected mark; a note lands after the id", async () => {
    const file = queueFile(`- [>] A | touches: a\n- [ ] B | touches: b`);
    await expect(markQueue(file, "B", "done")).rejects.toThrow("B is [ ], expected [>]");
    await expect(markQueue(file, "Z", "done")).rejects.toThrow("no line Z");
    await expect(markQueue(file, "A;rm", "done")).rejects.toThrow("refused task id");
    expect(await markQueue(file, "A", "done", "LANDED abc")).toEqual({
      id: "A",
      from: ">",
      to: "x",
    });
    await markQueue(file, "B", "running");
    await markQueue(file, "B", "released");
    expect(readQueue(file).rows.filter(r => r.startsWith("- ["))).toEqual([
      "- [x] A | LANDED abc | touches: a",
      "- [ ] B | touches: b",
    ]);
    await markQueue(file, "B", "running");
    await markQueue(file, "B", "failed");
    expect(marks(file)).toEqual({ A: "x", B: "!" });
  });

  it("a note that would rewrite the line's fields is refused", async () => {
    const file = queueFile(`- [>] A | touches: a`);
    for (const note of ["x | touches: b", "after: B", "  model: x", "wait ⏸", "two\nlines"])
      await expect(markQueue(file, "A", "done", note)).rejects.toThrow("a note is one line");
    expect(marks(file).A).toBe(">");
    await markQueue(file, "A", "done", "LANDED abc; tokens: 5k");
    expect(readQueue(file).rows).toContain("- [x] A | LANDED abc; tokens: 5k | touches: a");
  });

  it("a hand edit made between the read and the write is kept: the pick plans again", async () => {
    const file = queueFile(`- [ ] A | touches: a`);
    const real = fs.readFileSync;
    let reads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, o?: never) => {
      const text = real(p, o);
      if (p === file && ++reads === 1) fs.appendFileSync(file, "- [ ] HAND | touches: h\n");
      return text;
    }) as typeof fs.readFileSync);
    const r = await pickQueue(file);
    expect(reads).toBeGreaterThan(2);
    expect(r.admitted.map(a => a.id)).toEqual(["A", "HAND"]);
    expect(marks(file)).toEqual({ A: ">", HAND: ">" });
  });

  it("a dead holder's lock (stale mtime) is taken over", async () => {
    const file = queueFile(`- [ ] A | touches: a`);
    fs.mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${file}.lock`, old, old);
    expect((await pickQueue(file)).admitted.map(a => a.id)).toEqual(["A"]);
  });

  it("parallel picks never admit one line twice", async () => {
    const body = Array.from({ length: 6 }, (_, i) => `- [ ] T${i} | touches: d${i}`).join("\n");
    const file = queueFile(body, "batch_size: 4");
    const results = await Promise.all(Array.from({ length: 5 }, () => pickQueue(file)));
    const ids = results.flatMap(r => r.admitted.map(a => a.id));
    expect(ids.sort()).toEqual(["T0", "T1", "T2", "T3"]);
    expect(Object.values(marks(file)).filter(m => m === ">")).toHaveLength(4);
  });

  it("waits for a lock directory beside the queue (the picker script's lock) to go", async () => {
    const file = queueFile(`- [ ] A | touches: a`);
    fs.mkdirSync(`${file}.lock`);
    let done = false;
    const pick = pickQueue(file).then(r => {
      done = true;
      return r;
    });
    await new Promise(r => setTimeout(r, 150));
    expect(done).toBe(false);
    expect(marks(file).A).toBe(" ");
    fs.rmdirSync(`${file}.lock`);
    expect((await pick).admitted.map(a => a.id)).toEqual(["A"]);
  });
});

describe("wf-queue CLI", () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
  });

  async function cli(...args: string[]): Promise<{ code: unknown; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(c => (out.push(String(c)), true));
    vi.spyOn(process.stderr, "write").mockImplementation(c => (err.push(String(c)), true));
    process.argv = ["node", "wf-queue", ...args];
    process.exitCode = undefined;
    vi.resetModules();
    await import("./queue-cli.js");
    for (let i = 0; i < 100 && process.exitCode === undefined; i++)
      await new Promise(r => setTimeout(r, 10));
    vi.restoreAllMocks();
    return { code: process.exitCode, out: out.join(""), err: err.join("") };
  }

  it("prints the admitted lines, routes by exit code, marks and reads the header", async () => {
    const file = queueFile(
      `- [ ] A | model: haiku | touches: a\n- [ ] B | after: A | touches: b`,
      "batch_size: 2\nland_test: npm test",
    );
    const first = await cli(file, "--explain");
    expect(first.code).toBe(0);
    expect(first.out).toBe(`A\thaiku\t-\t${path.resolve(file, "../../..")}\n`);
    expect(first.err).toContain("B: after: A[ ]");
    expect((await cli(file)).code).toBe(10);
    expect((await cli(file, "--done", "A")).out).toBe("A: [>] → [x]\n");
    expect((await cli(file, "--header", "land_test")).out).toBe("npm test");
    expect((await cli(file)).code).toBe(0);
    await cli(file, "--failed", "B");
    expect((await cli(file)).code).toBe(11);
    expect((await cli(file, "--bogus")).code).toBe(2);
  });
});

describe("explainLines", () => {
  const full = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `W${i}`, why: "window full" }));
  const content = [
    { id: "A", why: "after: X[>]" },
    { id: "B", why: "overlaps X (touches a ~ a)" },
  ];
  const cases: [string, Parameters<typeof explainLines>[0], boolean | "all", string[]][] = [
    ["off", [...content, ...full(3)], false, []],
    [
      "mixed: content first, then folded",
      [full(1)[0], content[0], ...full(7).slice(1), content[1]],
      true,
      [
        "  A: after: X[>]",
        "  B: overlaps X (touches a ~ a)",
        "  7 lines: window full — first: W0, W1, W2, W3, W4 …",
      ],
    ],
    ["one blank stays by name", [...full(1)], true, ["  W0: window full"]],
    [
      "five blanks, no ellipsis",
      full(5),
      true,
      ["  5 lines: window full — first: W0, W1, W2, W3, W4"],
    ],
    [
      "all keeps file order",
      [full(1)[0], content[0]],
      "all",
      ["  W0: window full", "  A: after: X[>]"],
    ],
  ];
  it.each(cases)("%s", (_n, reasons, mode, expected) => {
    expect(explainLines(reasons, mode)).toEqual(expected);
  });
});
