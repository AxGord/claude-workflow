import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendTriage, fileLessons, formatLessons, takeTriage, triageRow } from "./lessons-file.js";
import { archiveQueue, readQueue } from "./queue.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface Env {
  readonly root: string;
  readonly proj: string;
  /** The repo the origin task works in (`repo:` of its line): not the queue's own project. */
  readonly eng: string;
  readonly queue: string;
  readonly triage: string;
  readonly records: string;
}

function setup(extraLines = ""): Env {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-lessons-")));
  dirs.push(root);
  const proj = path.join(root, "proj");
  const eng = path.join(root, "eng");
  for (const d of [proj, eng]) {
    fs.mkdirSync(d, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: d });
  }
  fs.mkdirSync(path.join(eng, "src"));
  fs.writeFileSync(path.join(eng, "src", "a.ts"), "a\n");
  fs.writeFileSync(path.join(eng, "src", "b.ts"), "b\n");
  fs.writeFileSync(path.join(proj, "only-in-proj.ts"), "p\n");
  fs.mkdirSync(path.join(proj, ".claude", "batch"), { recursive: true });
  const queue = path.join(proj, ".claude", "batch", "q.yaml");
  fs.writeFileSync(
    queue,
    `batch_size: 2
tasks:
  - id: ORIGIN
    status: done
    difficulty: 3
    repo: ${eng}
    workflow: engine-task
    touches: [src/a.ts]
    text: the origin task
${extraLines}`,
  );
  return {
    root,
    proj,
    eng,
    queue,
    triage: path.join(proj, ".claude", "backups", "slice-logs", "lessons-triage.txt"),
    records: path.join(root, "lessons.json"),
  };
}

const rec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "ENG-L1",
  kind: "unverified",
  touches: ["src/a.ts"],
  repro: "run it and read the output",
  text: "A defect found while doing the origin task, with enough words to be a brief.",
  ...over,
});

const write = (e: Env, ...records: Record<string, unknown>[]): void =>
  fs.writeFileSync(e.records, JSON.stringify({ lessons: records }));

const run = (e: Env, ...files: string[]) =>
  fileLessons({
    queue: e.queue,
    task: "ORIGIN",
    records: files.length > 0 ? files : [e.records],
    triage: e.triage,
  });

const triageRows = (e: Env): string[] =>
  fs.existsSync(e.triage) ? fs.readFileSync(e.triage, "utf8").split("\n").filter(Boolean) : [];

describe("lessons filed by script", () => {
  it("an unverified record becomes a backlog line, priority low, with the origin's repo and workflow", async () => {
    const e = setup();
    write(e, rec());
    const r = await run(e);
    expect(formatLessons(r)).toBe("lessons=filed 1, triage 0");
    const doc = YAML.parse(fs.readFileSync(e.queue, "utf8")) as {
      tasks: { id: string; text: string }[];
    };
    const line = doc.tasks.find(t => t.id === "ENG-L1")!;
    expect(line).toMatchObject({
      status: "backlog",
      priority: "low",
      repo: e.eng,
      workflow: "engine-task",
      touches: ["src/a.ts"],
    });
    expect(line.text).toContain("Lesson of ORIGIN");
    expect(line.text).toContain("Repro: run it and read the output");
    expect(triageRows(e)).toEqual([]);
  });

  it("an arm-rot-on-base record becomes a pending line, priority high, with a difficulty", async () => {
    const e = setup();
    write(
      e,
      rec({ id: "ENG-ROT", kind: "arm-rot-on-base", text: "A check passes with no input at all." }),
    );
    expect((await run(e)).filed).toBe(1);
    const line = readQueue(e.queue).lines.find(l => l.id === "ENG-ROT");
    expect([line?.status, line?.meta.priority, line?.meta.difficulty]).toEqual([
      "pending",
      "high",
      "4",
    ]);
  });

  it("every other kind goes to the triage file, not the queue", async () => {
    const e = setup();
    write(
      e,
      rec({ id: "L-A", kind: "reproduced-on-real-tree" }),
      rec({ id: "L-B", kind: "loss" }),
      rec({ id: "L-C", kind: "process" }),
    );
    const r = await run(e);
    expect([r.filed, r.triage]).toEqual([0, 3]);
    expect(readQueue(e.queue).lines.map(l => l.id)).toEqual(["ORIGIN"]);
    const rows = triageRows(e);
    expect(rows[0]).toBe("== ORIGIN");
    expect(rows[1]).toMatch(
      /^L-A \[reproduced-on-real-tree\] .* :: .* :: run it and read the output :: src\/a.ts$/,
    );
    expect(rows).toHaveLength(4);
  });

  it("dest is optional: a triage row carries `dest=<word>` when the record had one, and is unchanged without it", async () => {
    const e = setup();
    write(
      e,
      rec({ id: "L-D", kind: "loss", dest: "docs" }),
      rec({ id: "L-N", kind: "loss" }),
      rec({ id: "L-U", kind: "unverified", dest: "skill", touches: ["src/a.ts"] }),
    );
    const r = await run(e);
    expect([r.filed, r.triage]).toEqual([1, 2]);
    const rows = triageRows(e);
    expect(rows[1]).toMatch(
      /^L-D \[loss\] dest=docs .* :: .* :: run it and read the output :: src\/a.ts$/,
    );
    expect(rows[2]).toMatch(/^L-N \[loss\] [^d]/);
    expect(rows[2]).not.toContain("dest=");
    expect(readQueue(e.queue).lines.map(l => l.id)).toEqual(["ORIGIN", "L-U"]);
  });

  it.each([
    ["an unknown word", "stuff"],
    ["a wrong case", "Docs"],
    ["a non-string value", ["docs"]],
  ])(
    "a dest that is %s is refused as a kind is: a triage row naming the reason, never filed",
    async (_n, dest) => {
      const e = setup();
      write(e, rec({ id: "L-B", kind: "unverified", dest }));
      const r = await run(e);
      expect([r.filed, r.triage]).toEqual([0, 1]);
      const row = triageRows(e)[1];
      expect(row).toContain(
        "is not one of tool, workflow, skill, instructions, docs, decision, memory",
      );
      expect(row).not.toContain(" dest=");
    },
  );

  it("touches are checked against the origin's repo, not the queue's project", async () => {
    const e = setup();
    write(e, rec({ touches: ["only-in-proj.ts"] }));
    const r = await run(e);
    expect([r.filed, r.triage]).toEqual([0, 1]);
    expect(triageRows(e)[1]).toContain("touches only-in-proj.ts is not in");
  });

  it("a (new) path may be absent; the same path without the mark is refused", async () => {
    const e = setup();
    write(e, rec({ touches: ["src/a.ts", "src/fresh.ts (new)"] }));
    expect((await run(e)).filed).toBe(1);
    const e2 = setup();
    write(e2, rec({ touches: ["src/fresh.ts"] }));
    expect((await run(e2)).triage).toBe(1);
  });

  it.each([
    ["a bad kind", { kind: "weird" }, "kind weird is not one of"],
    ["a bad id", { id: "has space" }, "id is not"],
    ["an empty text", { text: " " }, "text is empty"],
    ["an empty repro", { repro: "" }, "repro is empty"],
    ["no touches", { touches: [] }, "touches is empty"],
    ["nine touches", { touches: Array.from({ length: 9 }, () => "src/a.ts") }, "more than 8"],
    ["a glob", { touches: ["src/*.ts"] }, "is a glob"],
    ["a parent path", { touches: ["../x.ts"] }, "is outside the repo"],
    ["an absolute path", { touches: ["/etc/hosts"] }, "is outside the repo"],
    ["a directory", { touches: ["src"] }, "is a directory"],
    ["an absent file", { touches: ["src/none.ts"] }, "is not in"],
  ])("%s is a triage row with its reason, nothing is filed", async (_name, over, why) => {
    const e = setup();
    write(e, rec(over));
    const r = await run(e);
    expect([r.filed, r.triage]).toEqual([0, 1]);
    expect(triageRows(e)[1]).toContain(why);
    expect(readQueue(e.queue).lines).toHaveLength(1);
  });

  it("a record that is not an object is a triage row", async () => {
    const e = setup();
    fs.writeFileSync(e.records, JSON.stringify({ lessons: ["just a string", rec()] }));
    const r = await run(e);
    expect([r.filed, r.triage]).toEqual([1, 1]);
    expect(triageRows(e)[1]).toContain("record is not an object");
  });

  it("an id another line holds, live or archived, is refused", async () => {
    const e = setup();
    write(e, rec({ id: "ORIGIN" }));
    expect((await run(e)).triage).toBe(1);
    expect(triageRows(e)[1]).toContain("id taken by another line");
  });

  it("an id the archive holds is refused", async () => {
    const e = setup(`  - id: OLD-ONE
    status: done
    ended: 2020-01-01
    text: long gone
`);
    await archiveQueue(e.queue, { olderThanDays: 30 });
    expect(readQueue(e.queue).archived.has("OLD-ONE")).toBe(true);
    write(e, rec({ id: "OLD-ONE" }));
    const r = await run(e);
    expect([r.filed, r.triage]).toEqual([0, 1]);
    expect(triageRows(e)[1]).toContain("id taken by an archived line");
  });

  it("a duplicate of an open line is refused: the same brief, or the same files and a named identifier", async () => {
    const e = setup(`  - id: OPEN-1
    status: backlog
    touches: [src/b.ts]
    text: |-
      Fix \`someFunction\` in the engine so it stops doing the odd thing.
  - id: OPEN-2
    status: pending
    difficulty: 3
    touches: [src/a.ts]
    text: A defect found while doing the origin task, with enough words to be a brief.
`);
    write(
      e,
      rec({ id: "DUP-1" }),
      rec({
        id: "DUP-2",
        touches: ["src/b.ts"],
        text: "The `someFunction` call is wrong on a second input.",
      }),
      rec({
        id: "FRESH",
        touches: ["src/b.ts"],
        text: "A different matter about `otherThing` entirely.",
      }),
      rec({
        id: "OTHER-FILES",
        touches: ["src/a.ts"],
        text: "The `someFunction` name, but in other files than the open line.",
      }),
    );
    const r = await run(e);
    expect([r.filed, r.triage]).toEqual([2, 2]);
    expect(triageRows(e).join("\n")).toContain("duplicate of OPEN-2");
    expect(triageRows(e).join("\n")).toContain(
      "duplicate of OPEN-1 (same files, same named identifier)",
    );
  });

  it("a short brief is not compared as a duplicate", async () => {
    const e = setup(`  - id: OPEN-S
    status: backlog
    touches: [src/b.ts]
    text: Fix it now.
`);
    write(e, rec({ id: "SHORT", text: "Fix it now." }));
    expect((await run(e)).filed).toBe(1);
  });

  it("a queue refusal is a triage row (here: a workflow name the queue refuses)", async () => {
    const e = setup();
    write(e, rec());
    const r = await fileLessons({
      queue: e.queue,
      task: "ORIGIN",
      records: [e.records],
      triage: e.triage,
      workflow: "bad name",
    });
    expect([r.filed, r.triage]).toEqual([0, 1]);
    expect(triageRows(e)[1]).toContain("queue refused:");
    expect(readQueue(e.queue).lines).toHaveLength(1);
  });

  it("an origin repo that resolves to no directory sends every record to triage", async () => {
    const e = setup();
    fs.writeFileSync(
      e.queue,
      fs.readFileSync(e.queue, "utf8").replace(`repo: ${e.eng}`, "repo: nowhere-at-all"),
    );
    write(e, rec());
    const r = await run(e);
    expect([r.filed, r.triage]).toEqual([0, 1]);
    expect(triageRows(e)[1]).toContain("resolves to no directory");
  });
});

describe("the record files", () => {
  it("a missing or empty file is no records; the step prints filed 0, triage 0 and writes no triage file", async () => {
    const e = setup();
    fs.writeFileSync(path.join(e.root, "empty.json"), "\n");
    const r = await run(e, path.join(e.root, "none.json"), path.join(e.root, "empty.json"));
    expect(formatLessons(r)).toBe("lessons=filed 0, triage 0");
    expect(fs.existsSync(e.triage)).toBe(false);
  });

  it("an unparseable file is ONE triage row holding its text", async () => {
    const e = setup();
    fs.writeFileSync(e.records, "{not json at all");
    const r = await run(e);
    expect([r.filed, r.triage]).toEqual([0, 1]);
    expect(triageRows(e)[1]).toContain("unparseable lessons.json: not JSON");
    expect(triageRows(e)[1]).toContain("{not json at all");
  });

  it("a document with no lessons array is a triage row too", async () => {
    const e = setup();
    fs.writeFileSync(e.records, JSON.stringify({ other: 1 }));
    expect((await run(e)).triage).toBe(1);
    expect(triageRows(e)[1]).toContain('no "lessons" array');
  });

  it("the worker's and the reviewer's files are both read, in order", async () => {
    const e = setup();
    const second = path.join(e.root, "review-lessons.json");
    write(e, rec({ id: "FROM-WORKER" }));
    fs.writeFileSync(
      second,
      JSON.stringify({
        lessons: [
          rec({
            id: "FROM-REVIEW",
            touches: ["src/b.ts"],
            text: "Another matter altogether, in a long enough brief.",
          }),
        ],
      }),
    );
    expect((await run(e, e.records, second)).filed).toBe(2);
  });
});

describe("a rerun", () => {
  it("files nothing twice: the same records say `already`, the queue and the triage file stay as they were", async () => {
    const e = setup();
    write(e, rec(), rec({ id: "L-P", kind: "process" }));
    expect(formatLessons(await run(e))).toBe(`lessons=filed 1, triage 1 triage_file=${e.triage}`);
    const queueBefore = fs.readFileSync(e.queue, "utf8");
    const triageBefore = fs.readFileSync(e.triage, "utf8");
    expect(formatLessons(await run(e))).toBe("lessons=filed 0, triage 0, already 2");
    expect(fs.readFileSync(e.queue, "utf8")).toBe(queueBefore);
    expect(fs.readFileSync(e.triage, "utf8")).toBe(triageBefore);
  });

  it("a changed record file adds only the rows its block lacks", async () => {
    const e = setup();
    write(e, rec({ id: "L-P", kind: "process" }));
    await run(e);
    write(e, rec({ id: "L-P", kind: "process" }), rec({ id: "L-Q", kind: "loss" }));
    const r = await run(e);
    expect([r.filed, r.triage, r.already]).toEqual([0, 1, 1]);
    const rows = triageRows(e);
    expect(rows.filter(x => x === "== ORIGIN")).toHaveLength(1);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatch(/^L-Q /);
  });

  it("another task's block is kept apart: a new block is added at the end", async () => {
    const e = setup();
    write(e, rec({ id: "L-P", kind: "process" }));
    await run(e);
    await appendTriage(e.triage, "OTHER", ["X [loss] r :: t :: p :: f"]);
    await appendTriage(e.triage, "ORIGIN", ["Y [loss] r :: t :: p :: f"]);
    expect(
      fs
        .readFileSync(e.triage, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(l => l.slice(0, 8)),
    ).toEqual(["== ORIGI", "L-P [pro", "Y [loss]", "== OTHER", "X [loss]"]);
  });
});

describe("triage rows", () => {
  it("a row is one line: newlines in a text are folded, a long text is cut", () => {
    const row = triageRow({
      id: "I",
      kind: "loss",
      reason: "why",
      text: `a\n\nb ${"x".repeat(800)}`,
      repro: "r",
      touches: "f",
    });
    expect(row).not.toContain("\n");
    expect(row.length).toBeLessThan(900);
  });

  it("the step's line is `lessons=filed N, triage M` and names `already` only when it is not 0", () => {
    expect(formatLessons({ filed: 2, triage: 1, already: 0 })).toBe("lessons=filed 2, triage 1");
    expect(formatLessons({ filed: 0, triage: 0, already: 3 })).toBe(
      "lessons=filed 0, triage 0, already 3",
    );
  });

  it("the line names the triage file when rows were added, and only then", () => {
    expect(formatLessons({ filed: 1, triage: 2, already: 0, triageFile: "/q/t.txt" })).toBe(
      "lessons=filed 1, triage 2 triage_file=/q/t.txt",
    );
    expect(formatLessons({ filed: 1, triage: 0, already: 0, triageFile: "/q/t.txt" })).toBe(
      "lessons=filed 1, triage 0",
    );
  });

  it("fileLessons reports the absolute triage file", async () => {
    const e = setup();
    write(e, rec({ kind: "process" }));
    const r = await run(e);
    expect(formatLessons(r)).toBe(`lessons=filed 0, triage 1 triage_file=${e.triage}`);
  });
});

describe("taking the triage file", () => {
  it("returns the rows and leaves an empty file; a later append starts a fresh block", async () => {
    const e = setup();
    write(e, rec({ kind: "process" }));
    await run(e);
    const before = fs.readFileSync(e.triage, "utf8");
    expect(await takeTriage(e.triage)).toBe(before);
    expect(fs.readFileSync(e.triage, "utf8")).toBe("");
    expect(await takeTriage(e.triage)).toBe("");
    expect((await run(e)).triage).toBe(1);
    expect(fs.readFileSync(e.triage, "utf8")).toBe(before);
  });

  it("a missing file is empty and is not created", async () => {
    const e = setup();
    expect(await takeTriage(e.triage)).toBe("");
    expect(fs.existsSync(e.triage)).toBe(false);
  });

  it("waits for the lock an append holds: nothing is read or emptied under it", async () => {
    const e = setup();
    await appendTriage(e.triage, "T", ["A [loss] r :: t :: p :: f"]);
    const release = await lockfile.lock(e.triage, { realpath: false });
    let done = false;
    const taken = takeTriage(e.triage).then(t => {
      done = true;
      return t;
    });
    await new Promise(r => setTimeout(r, 200));
    expect(done).toBe(false);
    expect(fs.readFileSync(e.triage, "utf8")).toContain("A [loss]");
    await release();
    expect(await taken).toContain("A [loss]");
    expect(fs.readFileSync(e.triage, "utf8")).toBe("");
  });
});

describe("wf-queue --lessons", () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
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
    process.argv = ["node", "wf-queue", ...args];
    process.exitCode = undefined;
    vi.resetModules();
    await import("./queue-cli.js");
    for (let i = 0; i < 100 && process.exitCode === undefined; i++)
      await new Promise(r => setTimeout(r, 10));
    vi.restoreAllMocks();
    return { code: process.exitCode, out: out.join(""), err: err.join("") };
  }

  it("prints the step's line and exits 0; the triage file defaults to ../backups/slice-logs beside the queue's directory", async () => {
    const e = setup();
    write(e, rec(), rec({ id: "L-P", kind: "process" }));
    const r = await cli(e.queue, "--lessons", "ORIGIN", "--records", e.records);
    expect([r.code, r.out]).toEqual([0, `lessons=filed 1, triage 1 triage_file=${e.triage}\n`]);
    expect(fs.existsSync(e.triage)).toBe(true);
  });

  it("--lessons-take prints the triage file (the same default and header rules) and empties it", async () => {
    const e = setup();
    write(e, rec({ kind: "process" }));
    await cli(e.queue, "--lessons", "ORIGIN", "--records", e.records);
    const rows = fs.readFileSync(e.triage, "utf8");
    const r = await cli(e.queue, "--lessons-take");
    expect([r.code, r.out]).toEqual([0, rows]);
    expect(fs.readFileSync(e.triage, "utf8")).toBe("");
    expect((await cli(e.queue, "--lessons-take")).out).toBe("");
    const flagged = path.join(e.root, "other.txt");
    fs.writeFileSync(flagged, "== X\nrow\n");
    expect((await cli(e.queue, "--lessons-take", "--triage", flagged)).out).toBe("== X\nrow\n");
    expect((await cli(e.queue, "--lessons-take", "--bogus", "x")).code).toBe(2);
  });

  it("the header's lessons_triage: (relative = beside the queue) and --triage move the file", async () => {
    const e = setup();
    fs.writeFileSync(
      e.queue,
      `lessons_triage: elsewhere/t.txt\n${fs.readFileSync(e.queue, "utf8")}`,
    );
    write(e, rec({ kind: "process" }));
    await cli(e.queue, "--lessons", "ORIGIN", "--records", e.records);
    expect(fs.existsSync(path.join(path.dirname(e.queue), "elsewhere", "t.txt"))).toBe(true);
    const flagged = path.join(e.root, "flag.txt");
    write(e, rec({ id: "L-Z", kind: "process" }));
    await cli(e.queue, "--lessons", "ORIGIN", "--records", e.records, "--triage", flagged);
    expect(fs.existsSync(flagged)).toBe(true);
  });

  it("a missing task id or --records is a usage error: exit 2, nothing written", async () => {
    const e = setup();
    const before = fs.readFileSync(e.queue, "utf8");
    const noId = await cli(e.queue, "--lessons", "--records", e.records);
    expect([noId.code, noId.err]).toEqual([2, "wf-queue: --lessons needs the task id\n"]);
    expect((await cli(e.queue, "--lessons", "ORIGIN")).code).toBe(2);
    expect(fs.readFileSync(e.queue, "utf8")).toBe(before);
  });
});
