import { execFileSync } from "node:child_process";
import fs from "node:fs";
import YAML from "yaml";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addQueueLine,
  describeQueue,
  editQueueLine,
  explainLines,
  ignoreProbes,
  formatMark,
  formatTask,
  markQueue,
  parseQueue,
  pickQueue,
  planPick,
  readQueue,
  resolveQueueFile,
  setQueueWindow,
} from "./queue.js";
import { formatQueueNext } from "./tools.js";
import { convertLine, markdownToYaml } from "./queue-convert.js";

/** The old Markdown fixtures, read as the YAML they convert to. */
const parseMd = (text: string, file: string) => parseQueue(markdownToYaml(text), file);
/** A task written as an old `ID | key: value | … | text` line. */
function taskOf(line: string): Record<string, unknown> {
  const t = convertLine(line.trim().startsWith("- [") ? line.trim() : `- [ ] ${line.trim()}`);
  if (!t) throw new Error(`not a line: ${line}`);
  const notes = t.notes.length > 0 ? { notes: t.notes } : {};
  return {
    id: t.id,
    ...(t.status !== "pending" ? { status: t.status } : {}),
    ...t.fields,
    ...notes,
  };
}
const addLine = (file: string, line: string, ...rest: [] | [object] | [object, object]) =>
  addQueueLine(file, taskOf(line), ...(rest as [object?, object?]));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A project (a `.git` dir) with its queue at `.claude/batch/q.yaml` (written as the old Markdown, converted); returns the queue path. */
function queueFile(body: string, header = "batch_size: 2"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-queue-"));
  dirs.push(root);
  const proj = path.join(root, "proj");
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  fs.mkdirSync(path.join(proj, ".claude", "batch"), { recursive: true });
  const file = path.join(proj, ".claude", "batch", "q.yaml");
  fs.writeFileSync(file, markdownToYaml(`# Batch: t\n${header}\n\n## Tasks\n${body}\n`));
  return file;
}

const plan = (body: string, header?: string) => planPick(readQueue(queueFile(body, header)));
const admittedIds = (body: string, header?: string) => plan(body, header).admitted.map(a => a.id);
const MARK = { pending: " ", running: ">", done: "x", failed: "!", backlog: "~" } as const;
/** Each task's status as the old one-character mark (` ` pending, `>` running, `x` done, `!` failed). */
const marks = (file: string) =>
  Object.fromEntries(readQueue(file).lines.map(l => [l.id, MARK[l.status]] as const));
/** Each task as one row `- [m] ID | key: value | … | note(from): text`, in the file's key order. */
const taskRows = (file: string) =>
  (YAML.parse(fs.readFileSync(file, "utf8")) as { tasks: Record<string, unknown>[] }).tasks.map(
    t => {
      const parts = Object.entries(t)
        .filter(([k]) => k !== "id" && k !== "status")
        .flatMap(([k, v]) =>
          k === "notes"
            ? (v as { from: string; text: string }[]).map(n => `note(${n.from}): ${n.text}`)
            : [`${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`],
        );
      return [
        `- [${MARK[(t.status ?? "pending") as keyof typeof MARK]}] ${String(t.id)}`,
        ...parts,
      ].join(" | ");
    },
  );

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
      { id: "B", why: "after: R (running)" },
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

describe("queue overlap: files, exclusive:, repos", () => {
  const T = "touches: ";
  const FILES = "batch_size: 5\noverlap: files";
  // [name, queue body, header, admitted ids]
  const cases: [string, string, string, string[]][] = [
    [
      "default (no overlap:) is paths: a directory entry still blocks what lies under it",
      `- [>] R | ${T}src/q\n- [ ] A | ${T}src/q/Foo.hx\n- [ ] B | ${T}src/q/sub\n- [ ] C | ${T}src/z`,
      "batch_size: 5",
      ["C"],
    ],
    [
      "overlap: paths reads as the default",
      `- [>] R | ${T}src/q\n- [ ] A | ${T}src/q/Foo.hx\n- [ ] B | ${T}src/z`,
      "batch_size: 5\noverlap: paths",
      ["B"],
    ],
    [
      "files: a directory entry is a hint and conflicts with nothing",
      `- [>] R | ${T}src/q\n- [ ] A | ${T}src/q/Foo.hx\n- [ ] B | ${T}src\n- [ ] C | ${T}src/q, docs`,
      FILES,
      ["A", "B", "C"],
    ],
    [
      "files: a glob entry is a hint even when its last segment holds a dot",
      `- [>] R | ${T}src/f/Doc*, src/*.hx\n- [ ] A | ${T}src/f/Doc.hx\n- [ ] B | ${T}src/x.hx`,
      FILES,
      ["A", "B"],
    ],
    [
      "files: the same file conflicts (dotfiles and root files are files), another file does not",
      `- [>] R | ${T}src/q/Foo.hx, .gitattributes\n- [ ] A | ${T}src/q/Foo.hx\n- [ ] B | ${T}./.gitattributes\n- [ ] C | ${T}src/q/Bar.hx, hxformat.json`,
      FILES,
      ["C"],
    ],
    [
      "files: a line admitted earlier in the same pick blocks the next on one file",
      `- [ ] A | ${T}hxformat.json, src\n- [ ] B | ${T}hxformat.json\n- [ ] C | ${T}src/c.hx`,
      FILES,
      ["A", "C"],
    ],
    [
      "files: owner: still conflicts with disjoint touches",
      `- [>] R | ${T}src/a | owner: typer\n- [ ] A | ${T}src/a | owner: typer.flow\n- [ ] B | ${T}src/a | owner: writer`,
      FILES,
      ["B"],
    ],
    [
      "files: a line without touches: still overlaps everything",
      `- [>] R | ${T}src/a\n- [ ] A | model: opus\n- [ ] B | ${T}src/b`,
      FILES,
      ["B"],
    ],
    [
      "exclusive: a running exclusive line blocks every line (files mode)",
      `- [>] R | ${T}src/a | exclusive: yes\n- [ ] A | ${T}docs/x.md`,
      FILES,
      [],
    ],
    [
      "exclusive: waits for every running line and blocks the lines after it (paths mode)",
      `- [>] R | ${T}a\n- [ ] A | ${T}b | exclusive: rename\n- [ ] B | ${T}c`,
      "batch_size: 5",
      ["B"],
    ],
    [
      "exclusive: admitted alone, then nothing joins it in the same pick",
      `- [ ] A | ${T}a | exclusive: yes\n- [ ] B | ${T}b`,
      FILES,
      ["A"],
    ],
    [
      "exclusive: — (or empty) is not exclusive",
      `- [>] R | ${T}a\n- [ ] A | ${T}b | exclusive: —`,
      FILES,
      ["A"],
    ],
  ];
  it.each(cases)("%s", (_name, body, header, expected) => {
    expect(admittedIds(body, header)).toEqual(expected);
  });

  describe("breaking:", () => {
    const pick = (tasks: string) =>
      planPick(parseQueue(`batch_size: 5\ntasks:\n${tasks}`, "/tmp/q.yaml"));
    const t = (id: string, extra = "", status = "pending") =>
      `  - {id: ${id}, status: ${status}, touches: [${id.toLowerCase()}]${extra}}\n`;
    it("is admitted into an empty window and nothing joins it in the same pick", () => {
      const r = pick(t("A", ", breaking: true") + t("B"));
      expect(r.admitted.map(a => a.id)).toEqual(["A"]);
      expect(r.reasons[0]?.why).toMatch(/breaking A runs alone/);
    });
    it("waits for a running line, whatever its position", () => {
      const r = pick(t("R", "", "running") + t("A", ", breaking: true"));
      expect(r.admitted).toEqual([]);
      expect(r.reasons[0]?.why).toMatch(/window not empty/);
    });
    it("waits behind lines admitted earlier in the same pick", () => {
      const r = pick(t("B") + t("A", ", breaking: true"));
      expect(r.admitted.map(a => a.id)).toEqual(["B"]);
    });
    it("a running breaking line admits nothing", () => {
      const r = pick(t("R", ", breaking: true", "running") + t("A"));
      expect(r.admitted).toEqual([]);
    });
    it("must be true or false", () => {
      expect(() => pick(t("A", ", breaking: maybe"))).toThrow(/breaking/);
    });
  });

  it("the reasons name an exclusive line and a file overlap", () => {
    const r = plan(
      `- [>] R | ${T}a.ts | exclusive: yes\n- [ ] A | ${T}b`,
      "batch_size: 3\noverlap: files",
    );
    expect(r.reasons).toEqual([{ id: "A", why: "overlaps R (exclusive R)" }]);
    const f = plan(`- [>] R | ${T}src/a.ts, src\n- [ ] A | ${T}src/a.ts`, FILES);
    expect(f.reasons).toEqual([{ id: "A", why: "overlaps R (touches src/a.ts ~ src/a.ts)" }]);
    const text = formatQueueNext({ ...r, dryRun: true }, true);
    expect(text).toContain("A: overlaps R (exclusive R)");
  });

  it.each(["paths", "files"])(
    "%s: touches: compare only within one repo; owner: compares across repos",
    mode => {
      const file = queueFile(
        [
          "- [>] R | repo: /abs/engine | touches: src/queue.ts",
          "- [ ] A | touches: src",
          "- [ ] B | repo: /abs/engine | touches: src/queue.ts",
          "- [ ] C | repo: /abs/other | touches: src/queue.ts | owner: q",
          "- [ ] D | repo: /abs/third | touches: x | owner: q.admit",
        ].join("\n"),
        `batch_size: 5\noverlap: ${mode}`,
      );
      const r = planPick(readQueue(file));
      expect(r.admitted.map(a => a.id)).toEqual(["A", "C"]);
      expect(r.reasons).toEqual([
        { id: "B", why: "overlaps R (touches src/queue.ts ~ src/queue.ts)" },
        { id: "D", why: "overlaps C (owner q.admit)" },
      ]);
    },
  );

  it("one repo spelled two ways (absent repo: and its absolute path) is still one repo", () => {
    const file = queueFile(`- [ ] A | touches: src/a.ts`, "batch_size: 3");
    const proj = path.resolve(path.dirname(file), "..", "..");
    fs.appendFileSync(file, `  - id: B\n    repo: ${proj}\n    touches: [src/a.ts]\n`);
    const r = planPick(readQueue(file));
    expect(r.admitted.map(a => a.id)).toEqual(["A"]);
    expect(r.reasons).toEqual([{ id: "B", why: "overlaps A (touches src/a.ts ~ src/a.ts)" }]);
  });

  it("an overlap: value that is neither paths nor files refuses the pick only; a # comment is allowed", async () => {
    const bad = parseMd("# x\nbatch_size: 1\noverlap: file\n## Tasks\n", "q");
    expect(bad.overlap).toBe("paths");
    expect(() => planPick(bad)).toThrow(/overlap: "file" is not one of paths, files/);
    expect(parseMd("# x\nbatch_size: 1\noverlap: files  # why\n## Tasks\n", "q").overlap).toBe(
      "files",
    );
    expect(parseMd("# x\nbatch_size: 1\n## Tasks\n", "q").overlap).toBe("paths");
    // The running lines are not stranded: marks, edits and the pause still go through the engine.
    const file = queueFile(
      `- [>] R | touches: a\n- [ ] A | touches: b`,
      "batch_size: 2\noverlap: file",
    );
    await expect(pickQueue(file)).rejects.toThrow(/overlap: "file"/);
    await expect(pickQueue(file, { dryRun: true })).rejects.toThrow(/overlap: "file"/);
    await markQueue(file, "R", "done", "landed");
    await editQueueLine(file, "A", { exclusive: "yes" });
    await setQueueWindow(file, 0, "typo in the header");
    expect(marks(file)).toEqual({ R: "x", A: " " });
    expect(readQueue(file).batchSize).toBe(0);
    // A bad overlap: header refuses the pick only: a hand mark still goes through.
    await markQueue(file, "A", "running");
    expect(marks(file)).toEqual({ R: "x", A: ">" });
  });

  it("files: an existing dotless file is a file; a missing dotless path or an existing dotted directory is a hint", () => {
    const file = queueFile(
      [
        "- [>] R | touches: Makefile, bin/hxq, lib.d",
        "- [ ] A | touches: Makefile",
        "- [ ] B | touches: bin/hxq",
        "- [ ] C | touches: lib.d",
      ].join("\n"),
      "batch_size: 5\noverlap: files",
    );
    const proj = path.resolve(path.dirname(file), "..", "..");
    fs.writeFileSync(path.join(proj, "Makefile"), "all:\n");
    fs.mkdirSync(path.join(proj, "lib.d"));
    const r = planPick(readQueue(file));
    expect(r.admitted.map(a => a.id)).toEqual(["B", "C"]);
    expect(r.reasons).toEqual([{ id: "A", why: "overlaps R (touches Makefile ~ Makefile)" }]);
    // Once it exists, a dotless path is a file too.
    fs.mkdirSync(path.join(proj, "bin"));
    fs.writeFileSync(path.join(proj, "bin", "hxq"), "");
    expect(planPick(readQueue(file)).admitted.map(a => a.id)).toEqual(["C"]);
  });

  it("a line without touches: overlaps only its own repo; exclusive: and owner: reach every repo", () => {
    const r = plan(
      [
        "- [>] R | repo: /abs/engine | touches: src/queue.ts",
        "- [ ] A | model: opus",
        "- [ ] B | repo: /abs/engine | model: opus",
        "- [ ] C | repo: /abs/other | touches: x | exclusive: yes",
      ].join("\n"),
      "batch_size: 5",
    );
    expect(r.admitted.map(a => a.id)).toEqual(["A"]);
    expect(r.reasons).toEqual([
      { id: "B", why: "overlaps R (no touches:)" },
      { id: "C", why: "overlaps R (exclusive C)" },
    ]);
  });

  it("queue_add and queue_edit take exclusive: as a field", async () => {
    const file = queueFile(`- [ ] A | touches: a`);
    await addLine(file, "B | touches: b | exclusive: yes | Move the tree.");
    expect(readQueue(file).lines.find(l => l.id === "B")?.meta.exclusive).toBe("yes");
    await editQueueLine(file, "A", { exclusive: true });
    expect(readQueue(file).lines.find(l => l.id === "A")?.meta.exclusive).toBe("yes");
    await editQueueLine(file, "A", { exclusive: "no" });
    expect(readQueue(file).lines.find(l => l.id === "A")?.meta.exclusive).toBeUndefined();
  });
});

describe("queue workflow:", () => {
  it("names the line's own task workflow; absent or `—` = none; a name that is not one word keeps the line out", () => {
    const r = plan(
      [
        "- [ ] A | workflow: engine-task | touches: a | Do A. |",
        "- [ ] B | workflow: — | touches: b",
        "- [ ] C | touches: c",
        "- [ ] D | workflow: two words | touches: d",
      ].join("\n"),
      "batch_size: 4",
    );
    expect(r.admitted.map(a => [a.id, a.workflow])).toEqual([
      ["A", "engine-task"],
      ["B", undefined],
      ["C", undefined],
    ]);
    expect(r.admitted[0].text).toBe("Do A.");
    expect(r.reasons).toEqual([{ id: "D", why: 'workflow: "two words" is not a workflow name' }]);
    const text = formatQueueNext({ ...r, dryRun: true }, false);
    expect(text).toContain("WOULD ADMIT A | model: opus | effort: - | repo: ");
    expect(text).toMatch(/WOULD ADMIT A \|.*\| workflow: engine-task \| kind: feature\n/);
    expect(text).not.toMatch(/WOULD ADMIT C \|.*workflow/);
  });
});

describe("queue difficulty:", () => {
  it("carries 1..10 to the pick (exec column, queue_next text); `-` = none; anything else keeps the line out", () => {
    const r = plan(
      [
        "- [ ] A | difficulty: 7 | touches: a | Do A. |",
        "- [ ] B | difficulty: - | touches: b",
        "- [ ] C | touches: c",
        "- [ ] D | difficulty: 11 | touches: d",
        "- [ ] E | difficulty: hard | touches: e",
      ].join("\n"),
      "batch_size: 5",
    );
    expect(r.admitted.map(a => [a.id, a.difficulty])).toEqual([
      ["A", 7],
      ["B", undefined],
      ["C", undefined],
    ]);
    expect(r.reasons).toEqual([
      { id: "D", why: 'difficulty "11" is not a whole number 1..10' },
      { id: "E", why: 'difficulty "hard" is not a whole number 1..10' },
    ]);
    expect(formatTask(r.admitted[0])).toBe(`A\topus\t-\t${r.admitted[0].repo}\t-\t7\tfeature`);
    expect(formatTask(r.admitted[2])).toMatch(/\t-\t-\tfeature$/);
    const text = formatQueueNext({ ...r, dryRun: true }, false);
    expect(text).toMatch(/WOULD ADMIT A \|.*\| difficulty: 7 \| kind: feature\n/);
    expect(text).not.toMatch(/WOULD ADMIT C \|.*difficulty/);
  });

  it("queue_add and queue_edit accept 1..10 and refuse anything else", async () => {
    const file = queueFile("- [ ] A | touches: a");
    await addLine(file, "B | difficulty: 3 | touches: b");
    await expect(addLine(file, "C | difficulty: 0 | touches: c")).rejects.toThrow(
      'C: difficulty "0" is not a whole number 1..10',
    );
    await editQueueLine(file, "A", { difficulty: "10" });
    await expect(editQueueLine(file, "A", { difficulty: "2.5" })).rejects.toThrow(
      'A: difficulty "2.5" is not a whole number 1..10',
    );
    expect(taskRows(file)).toEqual([
      "- [ ] A | difficulty: 10 | touches: a",
      "- [ ] B | difficulty: 3 | touches: b",
    ]);
  });
});

describe("queue kind:", () => {
  it("bug, feature and research reach the pick and queue_next; absent or `-` reads as feature; anything else keeps the line out", () => {
    const r = plan(
      [
        "- [ ] A | kind: bug | touches: a",
        "- [ ] B | kind: feature | touches: b",
        "- [ ] C | kind: research | touches: c",
        "- [ ] D | touches: d",
        "- [ ] E | kind: - | touches: e",
        "- [ ] F | kind: chore | touches: f",
      ].join("\n"),
      "batch_size: 9",
    );
    expect(r.admitted.map(a => [a.id, a.kind])).toEqual([
      ["A", "bug"],
      ["B", "feature"],
      ["C", "research"],
      ["D", "feature"],
      ["E", "feature"],
    ]);
    expect(r.reasons).toEqual([
      { id: "F", why: 'kind: "chore" is not one of bug, feature, research' },
    ]);
    expect(formatTask(r.admitted[0])).toMatch(/\t-\t-\tbug$/);
    expect(formatTask(r.admitted[3])).toMatch(/\t-\t-\tfeature$/);
    const text = formatQueueNext({ ...r, dryRun: true }, false);
    expect(text).toMatch(/WOULD ADMIT A \|.*\| kind: bug\n/);
    expect(text).toMatch(/WOULD ADMIT C \|.*\| kind: research\n/);
    expect(text).toMatch(/WOULD ADMIT D \|.*\| kind: feature\n/);
  });

  it("queue_add and queue_edit accept the three values and refuse anything else", async () => {
    const file = queueFile("- [ ] A | touches: a");
    await addLine(file, "B | kind: bug | touches: b");
    await expect(addLine(file, "C | kind: chore | touches: c")).rejects.toThrow(
      'C: kind: "chore" is not one of bug, feature, research',
    );
    await editQueueLine(file, "A", { kind: "research" });
    await expect(editQueueLine(file, "A", { kind: "x" })).rejects.toThrow(
      'A: kind: "x" is not one of bug, feature, research',
    );
    expect(taskRows(file)).toEqual([
      "- [ ] A | kind: research | touches: a",
      "- [ ] B | kind: bug | touches: b",
    ]);
  });
});

describe("queue priority:", () => {
  it("a high line far down is admitted before a normal one on top; equal priorities keep file order", () => {
    const r = plan(
      [
        "- [ ] A | touches: a",
        "- [ ] B | touches: b",
        "- [ ] C | priority: low | touches: c",
        "- [ ] D | priority: high | touches: d",
        "- [ ] E | priority: urgent | touches: e",
        "- [ ] F | priority: high | touches: f",
      ].join("\n"),
      "batch_size: 4",
    );
    expect(r.admitted.map(a => [a.id, a.priority])).toEqual([
      ["E", "urgent"],
      ["D", "high"],
      ["F", "high"],
      ["A", undefined],
    ]);
    expect(r.reasons.map(x => x.id)).toEqual(["B", "C"]);
    expect(formatQueueNext({ ...r, dryRun: true }, false)).toMatch(
      /WOULD ADMIT D \|.*\| priority: high\n/,
    );
  });

  it("queue_add and queue_edit accept the four values and refuse anything else", async () => {
    const file = queueFile("- [ ] A | touches: a");
    await addLine(file, "B | priority: high | touches: b");
    await expect(addLine(file, "C | priority: soon | touches: c")).rejects.toThrow(
      'C: priority: "soon" is not one of urgent, high, normal, low',
    );
    await editQueueLine(file, "A", { priority: "low" });
    await expect(editQueueLine(file, "A", { priority: "x" })).rejects.toThrow(/not one of/);
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

  it("a task key this server does not know reads, picks, marks and round-trips, and is named", async () => {
    const file = queueFile("- [ ] A | touches: a");
    const doc = YAML.parse(fs.readFileSync(file, "utf8")) as { tasks: Record<string, unknown>[] };
    doc.tasks[0].future = "x";
    fs.writeFileSync(file, YAML.stringify(doc));
    expect(readQueue(file).lines[0].unknownKeys).toEqual(["future"]);
    expect(admittedIds("- [ ] B")).toEqual(["B"]);
    const dry = await pickQueue(file, { dryRun: true });
    expect(dry.admitted.map(a => a.id)).toEqual(["A"]);
    expect(formatQueueNext(dry, false)).toContain(
      "unknown key future on A: ignored by this server",
    );
    const r = await markQueue(file, "A", "running");
    expect(formatMark(r)).toContain("unknown key future on A: ignored by this server");
    expect(fs.readFileSync(file, "utf8")).toContain("future: x");
    await expect(addQueueLine(file, { id: "C", future: "y" })).rejects.toThrow(
      'unknown key "future"',
    );
  });

  it("a header without batch_size, a bad tasks: list or a bad task is an error", () => {
    expect(() => parseQueue("batch_size: n\ntasks: []\n", "q")).toThrow(/batch_size/);
    expect(() => parseQueue("tasks: []\n", "q")).toThrow(/batch_size/);
    expect(() => parseQueue("batch_size: 1\ntasks: {}\n", "q")).toThrow(/tasks: is a list/);
    expect(() => parseQueue("batch_size: 1\ntasks:\n  - id: A\n    status: open\n", "q")).toThrow(
      /status "open"/,
    );
    expect(() => parseQueue("batch_size: 1\ntasks:\n  - id: A\n  - id: A\n", "q")).toThrow(/twice/);
    expect(() => parseQueue("batch_size: [1\n", "q")).toThrow(/not YAML/);
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
    expect(fs.readFileSync(file, "utf8")).toBe(
      before.replace("- id: A\n    status: pending", "- id: A\n    status: running"),
    );
  });

  it("queue_mark moves only from the expected status; a note goes to notes:", async () => {
    const file = queueFile(`- [>] A | touches: a\n- [ ] B | touches: b`);
    await expect(markQueue(file, "B", "done")).rejects.toThrow("B is pending, expected running");
    await expect(markQueue(file, "Z", "done")).rejects.toThrow("no task Z");
    await expect(markQueue(file, "A;rm", "done")).rejects.toThrow("refused task id");
    expect(await markQueue(file, "A", "done", "LANDED abc")).toEqual({
      id: "A",
      from: "running",
      to: "done",
    });
    await markQueue(file, "B", "running");
    await markQueue(file, "B", "released");
    expect(taskRows(file)).toEqual([
      "- [x] A | touches: a | note(mark): LANDED abc",
      "- [ ] B | touches: b",
    ]);
    await markQueue(file, "B", "shelved");
    expect(planPick(readQueue(file)).pending).toBe(0);
    await markQueue(file, "B", "promoted");
    await markQueue(file, "B", "running");
    await markQueue(file, "B", "failed");
    expect(marks(file)).toEqual({ A: "x", B: "!" });
  });

  it("queue_mark running refuses a line the picker would not admit; force marks it and notes the reason", async () => {
    const file = queueFile(
      `- [>] R | touches: a/b\n- [ ] O | touches: a/b/c\n- [ ] W | after: Z | touches: w\n- [ ] P ⏸ | touches: p\n- [ ] OK | touches: ok`,
    );
    await expect(markQueue(file, "O", "running")).rejects.toThrow(
      "O would not be admitted: overlaps R",
    );
    await expect(markQueue(file, "W", "running")).rejects.toThrow(
      "W would not be admitted: after:",
    );
    await expect(markQueue(file, "P", "running")).rejects.toThrow(
      "P would not be admitted: parked",
    );
    expect(marks(file)).toEqual({ R: ">", O: " ", W: " ", P: " ", OK: " " });
    await markQueue(file, "OK", "running");
    await markQueue(file, "O", "running", undefined, { force: "disjoint in fact" });
    const o = readQueue(file).lines.find(l => l.id === "O");
    expect(o?.status).toBe("running");
    expect(o?.notes[0]?.text).toContain("forced running over: overlaps R");
    expect(o?.notes[0]?.text).toContain("disjoint in fact");
  });

  it("queue_mark running ignores a pause and model —, refuses exclusive and breaking lines", async () => {
    const paused = queueFile(`- [ ] A | model: — | touches: a`, "batch_size: 0");
    await markQueue(paused, "A", "running");
    expect(marks(paused)).toEqual({ A: ">" });
    const ex = queueFile(`- [>] R | touches: r\n- [ ] E | touches: e | exclusive: yes`);
    await expect(markQueue(ex, "E", "running")).rejects.toThrow("E would not be admitted");
    const br = queueFile(`- [>] R | touches: r\n- [ ] B | touches: b`);
    await editQueueLine(br, "B", { breaking: "true" });
    await expect(markQueue(br, "B", "running")).rejects.toThrow(/breaking: window not empty/);
  });

  it("a note is data: `|`, `key:`, ⏸ and line breaks stay text and touch no field", async () => {
    const file = queueFile(`- [>] A | touches: a`);
    await markQueue(file, "A", "done", "x | touches: b\nafter: B ⏸", { from: "driver" });
    const a = readQueue(file).lines[0];
    expect(a.meta).toEqual({ touches: "a" });
    expect(a.paused).toBe(false);
    expect(a.notes).toEqual([
      {
        from: "driver",
        date: expect.stringMatching(/^\d{4}-\d\d-\d\d$/) as unknown,
        text: "x | touches: b\nafter: B ⏸",
      },
    ]);
  });

  it("a hand edit made between the read and the write is kept: the pick plans again", async () => {
    const file = queueFile(`- [ ] A | touches: a`);
    const real = fs.readFileSync;
    let reads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, o?: never) => {
      const text = real(p, o);
      if (p === file && ++reads === 1)
        fs.appendFileSync(file, "  - id: HAND\n    status: pending\n    touches: [h]\n");
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

describe("queue line writes (queue_add / queue_edit / queue_header)", () => {
  it("add: last, after_id / before_id; a backlog task; comments and order of the file stay", async () => {
    const file = queueFile(`- [ ] A | touches: a\n- [x] B | touches: b`);
    fs.writeFileSync(file, `# the queue\n${fs.readFileSync(file, "utf8")}# trailing comment\n`);
    const c = await addLine(file, "C | touches: c | brief |");
    expect(c.id).toBe("C");
    expect(fs.readFileSync(file, "utf8").split("\n")[c.lineNo - 1]).toBe("  - id: C");
    await addLine(file, "- [ ] D | after: B | touches: d |", { after: "A" });
    await addLine(file, "E | touches: e | owner: x", { before: "A" });
    await addQueueLine(file, {
      id: "F",
      status: "backlog",
      touches: "f",
      text: "later",
      notes: [{ from: "user", date: "2026-01-02", text: "kept date" }, { text: "today" }],
    });
    expect(taskRows(file)).toEqual([
      "- [ ] E | touches: e | owner: x",
      "- [ ] A | touches: a",
      "- [ ] D | after: B | touches: d",
      "- [x] B | touches: b",
      "- [ ] C | touches: c | text: brief",
      "- [~] F | touches: f | text: later | note(user): kept date | note(parent): today",
    ]);
    const f = readQueue(file).lines.find(l => l.id === "F");
    expect(f?.notes[0].date).toBe("2026-01-02");
    expect(f?.notes[1].date).toMatch(/^\d{4}-\d\d-\d\d$/);
    const text = fs.readFileSync(file, "utf8");
    expect(text.startsWith("# the queue\n")).toBe(true);
    expect(text).toContain("# trailing comment");
    expect(text).toContain("    text: |-\n      brief\n");
    expect(planPick(readQueue(file)).admitted.map(a => a.id)).toEqual(["E", "A"]);
  });

  it("add refuses what a pick would misread or never admit", async () => {
    const file = queueFile(`- [ ] A | touches: a\n- [ ] B | after: A | touches: b`);
    const before = fs.readFileSync(file, "utf8");
    const refusals: [string, string, { after?: string; before?: string }?][] = [
      ["A | touches: z", "A is already in"],
      ["C | after: A, X9 | touches: c", "after: X9 — no such task"],
      ["C | after: C | touches: c", "closes a cycle C → C"],
      ["C | workflow: two words", "is not a workflow name"],
      ["C | repo: nowhere-such", "resolves to no directory"],
      ["- [x] C | touches: c", "a new task is pending or backlog, not done"],
      ["C | touches: c", "no task Z", { after: "Z" }],
      ["C | touches: c", "exclude each other", { after: "A", before: "B" }],
    ];
    for (const [line, why, pos] of refusals)
      await expect(addLine(file, line, pos)).rejects.toThrow(why);
    await expect(addQueueLine(file, { id: "C;rm" })).rejects.toThrow("refused task id");
    await expect(addQueueLine(file, { id: "C", toches: ["c"] })).rejects.toThrow(
      'unknown key "toches"',
    );
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    // Prose beside the ids is a condition for a human, as in a pick: allowed.
    await addLine(file, "C | after: B + a week of data | touches: c");
    expect(planPick(readQueue(file)).reasons.find(x => x.id === "C")?.why).toContain("manual");
  });

  it("an add and a mark racing on one file both land", async () => {
    const body = Array.from({ length: 4 }, (_, i) => `- [>] R${i} | touches: r${i}`).join("\n");
    const file = queueFile(body, "batch_size: 4");
    await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => markQueue(file, `R${i}`, "done", `landed ${i}`)),
      ...Array.from({ length: 4 }, (_, i) =>
        addLine(file, `N${i} | after: R${i} | touches: n${i}`),
      ),
    ]);
    const m = marks(file);
    expect(Object.keys(m).sort()).toEqual(["N0", "N1", "N2", "N3", "R0", "R1", "R2", "R3"]);
    for (let i = 0; i < 4; i++) {
      expect(m[`R${i}`]).toBe("x");
      expect(m[`N${i}`]).toBe(" ");
    }
    expect(taskRows(file)).toContain("- [x] R2 | touches: r2 | note(mark): landed 2");
  });

  it("a mark written between an op's read and its write is kept: add, edit and header plan again", async () => {
    const ops: [string, (file: string) => Promise<unknown>, string][] = [
      ["add", f => addLine(f, "N | touches: n"), "- [ ] N | touches: n"],
      [
        "edit",
        f => editQueueLine(f, "B", { model: "sonnet" }),
        "- [ ] B | model: sonnet | touches: b",
      ],
      ["header", f => setQueueWindow(f, 0, "pause"), "- [ ] B | touches: b"],
    ];
    for (const [name, op, row] of ops) {
      const file = queueFile(`- [>] A | touches: a\n- [ ] B | touches: b`);
      const real = fs.readFileSync;
      let reads = 0;
      const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((
        p: fs.PathOrFileDescriptor,
        o?: never,
      ) => {
        const text = real(p, o);
        // An exec's mark lands right after the op's first read, outside its lock.
        if (p === file && ++reads === 1)
          fs.writeFileSync(
            file,
            String(text).replace("- id: A\n    status: running", "- id: A\n    status: done"),
          );
        return text;
      }) as typeof fs.readFileSync);
      await op(file);
      spy.mockRestore();
      expect(reads, name).toBeGreaterThan(2);
      const rows = taskRows(file);
      expect(rows, name).toContain("- [x] A | touches: a");
      expect(rows, name).toContain(row);
      if (name === "header") expect(readQueue(file).batchSize).toBe(0);
    }
  });

  it('edit: a set field keeps its place, a new one goes in key order, "" removes, a note goes to notes:', async () => {
    const file = queueFile(
      `- [>] A | LANDED x | model: opus | touches: a | brief text |\n- [ ] B | touches: b | model: haiku`,
    );
    const a = await editQueueLine(
      file,
      "A",
      { model: "sonnet", effort: "high" },
      "requeued by hand",
    );
    expect(a.task).toMatch(
      /^id: A\nstatus: running\nmodel: sonnet\neffort: high\ntouches: \[ a \]\ntext: \|-\n {2}brief text\nnotes:\n/,
    );
    expect(taskRows(file)[0]).toBe(
      "- [>] A | model: sonnet | effort: high | touches: a | text: brief text | note(mark): LANDED x | note(parent): requeued by hand",
    );
    await editQueueLine(file, "B", { model: "", after: "A", text: "two\nlines" });
    expect(taskRows(file)[1]).toBe("- [ ] B | after: A | touches: b | text: two\nlines");
    await editQueueLine(file, "B", { after: ["A"], touches: null, parked: true });
    expect(readQueue(file).lines[1].paused).toBe(true);
    expect(readQueue(file).lines[1].meta.touches).toBeUndefined();
    expect(marks(file)).toEqual({ A: ">", B: " " });
    const before = fs.readFileSync(file, "utf8");
    const refusals: [string, Record<string, unknown>, string | undefined, string][] = [
      ["A", { status: "done" }, undefined, 'unknown field "status"'],
      ["A", { model: "a\nb" }, undefined, "a value is one line"],
      ["A", { after: "Q1" }, undefined, "after: Q1 — no such task"],
      ["A", { after: "B" }, undefined, "closes a cycle A → B → A"],
      ["A", {}, undefined, "nothing to edit"],
      ["Z", { model: "x" }, undefined, "no task Z"],
    ];
    for (const [id, set, note, why] of refusals)
      await expect(editQueueLine(file, id, set, note)).rejects.toThrow(why);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("header: batch_size with its reason; the pause reads back as a pause", async () => {
    const file = queueFile(`- [ ] A | touches: a`, "batch_size: 2  # two at once");
    expect(readQueue(file).batchComment).toBe("two at once");
    expect(await setQueueWindow(file, 0, "user review, was 2")).toEqual({
      from: 2,
      to: 0,
      reason: "user review, was 2",
    });
    const q = readQueue(file);
    expect(fs.readFileSync(file, "utf8")).toMatch(/^batch_size: 0\nreason: user review, was 2\n/);
    expect(q.batchComment).toBe("user review, was 2");
    expect(planPick(q).code).toBe(12);
    await expect(setQueueWindow(file, 1, " ")).rejects.toThrow("the reason is one non-empty line");
    await expect(setQueueWindow(file, -1, "x")).rejects.toThrow("whole number");
    await setQueueWindow(file, 3, "resumed");
    expect(readQueue(file).batchSize).toBe(3);
  });

  it("mark retry: failed → running only with retry and `running`", async () => {
    const file = queueFile(`- [!] A | failed once | touches: a\n- [ ] B | touches: b`);
    await expect(markQueue(file, "A", "running")).rejects.toThrow("retry: true restarts");
    await expect(markQueue(file, "A", "done", undefined, { retry: true })).rejects.toThrow(
      "with `running` only",
    );
    await expect(markQueue(file, "B", "running", undefined, { retry: true })).rejects.toThrow(
      "B is pending, expected failed",
    );
    expect(await markQueue(file, "A", "running", "retry 2", { retry: true })).toEqual({
      id: "A",
      from: "failed",
      to: "running",
    });
    expect(taskRows(file)[0]).toBe(
      "- [>] A | touches: a | text: failed once | note(mark): retry 2",
    );
  });

  it("mark retry raises the line's difficulty: by one, capped at 10; a line without one is unchanged", async () => {
    const file = queueFile(
      [
        "- [!] A | difficulty: 4 | touches: a | Do A. |",
        "- [!] B | touches: b | difficulty: 10",
        "- [!] C | difficulty: - | touches: c",
        "- [!] D | touches: d",
        "- [>] E | difficulty: 2 | touches: e",
      ].join("\n"),
      "batch_size: 5",
    );
    const a = await markQueue(file, "A", "running", "retry 1", { retry: true });
    expect(a).toEqual({ id: "A", from: "failed", to: "running", difficulty: { from: 4, to: 5 } });
    expect(formatMark(a)).toBe("A: failed → running (difficulty 4 → 5)");
    const b = await markQueue(file, "B", "running", undefined, { retry: true });
    expect(b.difficulty).toEqual({ from: 10, to: 10 });
    expect(formatMark(b)).toBe("B: failed → running (difficulty 10: already the cap)");
    for (const id of ["C", "D"]) {
      const r = await markQueue(file, id, "running", undefined, { retry: true });
      expect(r.difficulty).toBeUndefined();
      expect(formatMark(r)).toBe(`${id}: failed → running`);
    }
    // only a retry raises it
    await markQueue(file, "E", "done");
    expect(taskRows(file)).toEqual([
      "- [>] A | difficulty: 5 | touches: a | text: Do A. | note(mark): retry 1",
      "- [>] B | difficulty: 10 | touches: b",
      "- [>] C | difficulty: - | touches: c",
      "- [>] D | touches: d",
      "- [x] E | difficulty: 2 | touches: e",
    ]);
    expect(planPick(readQueue(file)).running).toEqual(["A", "B", "C", "D"]);
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

  it("--queue NAME, --path and no file resolve the project's queues; --add says when it creates", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-queue-cli-"));
    dirs.push(root);
    fs.mkdirSync(path.join(root, ".git"));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const def = path.join(root, ".claude", "batch", "queue.yaml");
    const named = path.join(root, ".claude", "batch", "wave.yaml");
    const made = await cli("--add", "{id: A, touches: [a]}");
    expect(made.out).toBe(`A: added at line 3; the queue did not exist — created ${def}\n`);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    expect((await cli("--path")).out).toBe(def);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    expect((await cli("--queue", "wave", "--path")).out).toBe(named);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    expect((await cli("--queue", "wave", "--add", "{id: B, touches: [b]}")).out).toContain(
      "created",
    );
    vi.spyOn(process, "cwd").mockReturnValue(root);
    expect((await cli("--queue", "wave", "--add", "{id: C, touches: [c]}")).out).toBe(
      "C: added at line 6\n",
    );
    vi.spyOn(process, "cwd").mockReturnValue(root);
    expect((await cli("--queue", "wave", "--add", "C | touches: c")).code).toBe(2);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    expect((await cli("--queue")).code).toBe(2);
    const typo = path.join(root, "typo.yaml");
    expect((await cli(typo, "--add", "{id: D}")).code).toBe(2);
    expect(fs.existsSync(typo)).toBe(false);
  });

  it("prints the admitted lines, routes by exit code, marks and reads the header", async () => {
    const file = queueFile(
      `- [ ] A | model: haiku | touches: a\n- [ ] B | after: A | workflow: engine-task | touches: b`,
      "batch_size: 2\nland_test: npm test",
    );
    const repo = path.resolve(file, "../../..");
    const first = await cli(file, "--explain");
    expect(first.code).toBe(0);
    expect(first.out).toBe(`A\thaiku\t-\t${repo}\t-\t-\tfeature\n`);
    expect(first.err).toContain("B: after: A (pending)");
    expect((await cli(file)).code).toBe(10);
    expect((await cli(file, "--done", "A", "--note", "landed abc", "--from", "land")).out).toBe(
      "A: running → done\n",
    );
    expect(readQueue(file).lines[0].notes.map(n => [n.from, n.text])).toEqual([
      ["land", "landed abc"],
    ]);
    expect((await cli(file, "--header", "land_test")).out).toBe("npm test");
    const second = await cli(file);
    expect(second.code).toBe(0);
    expect(second.out).toBe(`B\topus\t-\t${repo}\tengine-task\t-\tfeature\n`);
    await cli(file, "--failed", "B");
    expect((await cli(file)).code).toBe(11);
    expect((await cli(file, "--bogus")).code).toBe(2);
  });

  it("--convert --into an existing queue appends under its lock and says how many; none is an error", async () => {
    const file = queueFile(`- [ ] A | touches: a`);
    const md = path.join(path.dirname(file), "old.md");
    fs.writeFileSync(md, "batch_size: 1\n## Tasks\n- [ ] T9 (2026-10-22) FLAKE: x\n- [x] D | y\n");
    fs.mkdirSync(`${file}.lock`);
    const run = cli("--convert", md, "--into", file);
    await new Promise(r => setTimeout(r, 100));
    expect(readQueue(file).lines).toHaveLength(1);
    fs.rmdirSync(`${file}.lock`);
    expect((await run).out).toBe(`appended 1 task(s) to ${file}\n`);
    expect(readQueue(file).lines.map(l => [l.id, l.status])).toEqual([
      ["A", "pending"],
      ["T9", "backlog"],
    ]);
    fs.writeFileSync(md, "batch_size: 1\n## Tasks\n- [x] D | y\n");
    const none = await cli("--convert", md, "--into", file);
    expect(none.code).toBe(2);
    expect(none.err).toContain("no open task to append");
  });

  it("adds, edits, sets the window and retries a failed line", async () => {
    const file = queueFile(`- [!] A | touches: a`, "batch_size: 2");
    const added = await cli(
      file,
      "--add",
      "{id: B, after: [A], touches: [b], text: x}",
      "--before",
      "A",
    );
    expect(added.out).toMatch(/^B: added at line \d+\n$/);
    expect((await cli(file, "--add", "{id: C, after: [Q7]}")).code).toBe(2);
    expect((await cli(file, "--edit", "B", "--set", "model=sonnet", "--set", "after=")).out).toBe(
      "id: B\nstatus: pending\nmodel: sonnet\ntouches: [ b ]\ntext: |-\n  x\n",
    );
    expect((await cli(file, "--edit", "B", "--set", "nokey")).code).toBe(2);
    expect((await cli(file, "--batch-size", "0", "--reason", "pause for review")).out).toBe(
      "batch_size 2 → 0  # pause for review\n",
    );
    expect((await cli(file, "--batch-size", "1")).code).toBe(2);
    expect((await cli(file, "--running", "A")).code).toBe(2);
    expect((await cli(file, "--running", "A", "--retry")).out).toBe("A: failed → running\n");
    await cli(file, "--failed", "A");
    expect((await cli(file, "--edit", "A", "--set", "difficulty=6")).code).toBe(0);
    expect((await cli(file, "--running", "A", "--retry")).out).toBe(
      "A: failed → running (difficulty 6 → 7)\n",
    );
    expect((await cli(file, "--done", "A", "--retry")).code).toBe(2);
    expect(marks(file)).toEqual({ B: " ", A: ">" });
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

describe("queue names", () => {
  function project(): { root: string; main: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-queue-name-"));
    dirs.push(root);
    const main = path.join(root, "main");
    fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
    fs.mkdirSync(path.join(main, "sub"), { recursive: true });
    return { root, main };
  }

  it("no file and no queue: the project's default queue, from a subdirectory", () => {
    const { main } = project();
    const want = path.join(main, ".claude", "batch", "queue.yaml");
    expect(resolveQueueFile({}, main)).toBe(want);
    expect(resolveQueueFile({}, path.join(main, "sub"))).toBe(want);
  });

  it("a name is .claude/batch/<name>.yaml; a path is taken as it is; a path-like name is refused", () => {
    const { root, main } = project();
    expect(resolveQueueFile({ queue: "wave-D" }, main)).toBe(
      path.join(main, ".claude", "batch", "wave-D.yaml"),
    );
    expect(resolveQueueFile({ file: "/x/y/q.yaml" }, main)).toBe("/x/y/q.yaml");
    expect(() => resolveQueueFile({ queue: "../evil" }, main)).toThrow("refused queue name");
    expect(() => resolveQueueFile({ queue: "wave-D.yaml" }, main)).toThrow(
      'the stem without .yaml: "wave-D"',
    );
    expect(() => resolveQueueFile({ queue: "wave-D.md" }, main)).toThrow(
      'the stem without .md: "wave-D"',
    );
    expect(() => resolveQueueFile({ queue: "WAVE.MD" }, main)).toThrow("refused queue name");
    expect(() => resolveQueueFile({ file: "/a.md", queue: "b" }, main)).toThrow("not both");
    expect(root).toBeTruthy();
  });

  it("a linked worktree resolves to its main checkout", () => {
    const { root, main } = project();
    const wt = path.join(root, "wt");
    fs.mkdirSync(wt);
    fs.writeFileSync(
      path.join(wt, ".git"),
      `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`,
    );
    expect(resolveQueueFile({ queue: "q" }, wt)).toBe(
      path.join(main, ".claude", "batch", "q.yaml"),
    );
  });

  it("the first queue_add creates the default queue; a read of a missing queue names the path", async () => {
    const { main } = project();
    const file = resolveQueueFile({}, main);
    expect(() => readQueue(file)).toThrow(file);
    const r = await addLine(file, "A | touches: a | first |", {}, { create: true });
    expect(r.created).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toMatch(/^batch_size: 1\ntasks:\n {2}- id: A\n/);
    expect(readQueue(file).lines.map(l => l.id)).toEqual(["A"]);
    expect((await addLine(file, "B | touches: b")).created).toBeUndefined();
  });

  it("a full file path that does not exist is never created", async () => {
    const { main } = project();
    const file = path.join(main, "typo.yaml");
    await expect(addLine(file, "A | touches: a", {}, { create: false })).rejects.toThrow(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("a refused first line leaves no queue behind", async () => {
    const { main } = project();
    const file = resolveQueueFile({ queue: "new" }, main);
    await expect(
      addLine(file, "A | difficulty: 0 | touches: a", {}, { create: true }),
    ).rejects.toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("a task session in another repo marks the dispatcher's queue through the absolute path", async () => {
    const { root, main } = project();
    const file = resolveQueueFile({ queue: "q" }, main);
    await addLine(file, "A | touches: a", {}, { create: true });
    await markQueue(file, "A", "running");
    const other = path.join(root, "other");
    fs.mkdirSync(path.join(other, ".git"), { recursive: true });
    expect(resolveQueueFile({ file }, other)).toBe(file);
    expect(resolveQueueFile({ queue: "q" }, other)).not.toBe(file);
    await markQueue(resolveQueueFile({ file }, other), "A", "done");
    expect(readQueue(file).lines[0].status).toBe("done");
  });

  it("a refused first line cannot delete a line another call wrote", async () => {
    const { main } = project();
    const file = resolveQueueFile({ queue: "race" }, main);
    const bad = addLine(file, "A | difficulty: 0 | touches: a", {}, { create: true });
    const good = addLine(file, "B | touches: b", {}, { create: true });
    await expect(bad).rejects.toThrow();
    await good;
    expect(readQueue(file).lines.map(l => l.id)).toEqual(["B"]);
  });
});

describe("describeQueue", () => {
  const q = parseMd(
    [
      "# x",
      "batch_size: 1",
      "## Tasks",
      "- [>] A | repo: /tmp | touches: src/a.ts | text of a is long enough to be prose here",
      "- [ ] B | repo: /tmp | touches: src/a.ts | text of b is long enough to be prose here",
      "- [ ] C | repo: /tmp | touches: src/c.ts | text of c is long enough to be prose here",
      "- [ ] D | repo: /tmp | after: B | text of d is long enough to be prose here",
      "- [ ] E | repo: /tmp | model: — | text of e is long enough to be prose here",
      "- [ ] F | repo: /tmp | exclusive: yes | text of f is long enough to be prose here",
      "",
    ].join("\n"),
    "/tmp/q.md",
  );
  const reasons = Object.fromEntries(describeQueue(q).lines.map(l => [l.id, l.reason]));

  it("gives a real reason to every pending line past the window", () => {
    expect(reasons.A).toBeUndefined();
    expect(reasons.B).toMatch(/^overlaps A/);
    expect(reasons.C).toBe("ready");
    expect(reasons.D).toBe("after: B (pending)");
    expect(reasons.E).toBe("parent-run (model —)");
    expect(reasons.F).toMatch(/^overlaps /);
  });

  it("afterIds are the ids the picker resolves: a known id inside parentheses is prose", () => {
    const aq = parseMd(
      [
        "# x",
        "batch_size: 1",
        "## Tasks",
        "- [ ] A | repo: /tmp | text of a is long enough to be prose here",
        "- [ ] B | repo: /tmp | text of b is long enough to be prose here",
        "- [ ] C | repo: /tmp | after: B (once A is read, nested (A)) | text of c is long enough to be prose here",
        "",
      ].join("\n"),
      "/tmp/q.md",
    );
    const ids = Object.fromEntries(describeQueue(aq).lines.map(l => [l.id, l.afterIds]));
    expect(ids).toEqual({ A: [], B: [], C: ["B"] });
  });

  it("keeps the window reason in the real pick", () => {
    expect(planPick(q).reasons.find(r => r.id === "C")?.why).toBe("window full");
  });
});

describe("touches: tracked in the repo", () => {
  /** A real git repo with `.claude/` ignored and a `src/` dir; returns a queue file inside it. */
  function ignoredRepo(task: string): { file: string; repo: string } {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wf-queue-ign-"));
    dirs.push(repo);
    execFileSync("git", ["init", "-q", repo]);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".claude/\n");
    fs.mkdirSync(path.join(repo, "src"));
    const file = path.join(repo, "q.yaml");
    fs.writeFileSync(file, `batch_size: 2\ntasks:\n${task}`);
    return { file, repo };
  }

  it("an ignored .claude/ entry is not admitted and is named; a new file in an existing dir is", () => {
    const { file, repo } = ignoredRepo(
      `  - id: A\n    status: pending\n    repo: ${"REPO"}\n    touches: [ .claude/workflows/x.yaml ]\n    text: a\n` +
        `  - id: B\n    status: pending\n    repo: ${"REPO"}\n    touches: [ src/new.ts ]\n    text: b\n`,
    );
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("REPO", repo));
    const r = planPick(readQueue(file));
    expect(r.admitted.map(a => a.id)).toEqual(["B"]);
    expect(r.reasons.find(x => x.id === "A")?.why).toMatch(
      /parent-run.*\.claude\/workflows\/x\.yaml/,
    );
  });

  it("queue_add warns on an ignored entry and on a file in a missing directory", async () => {
    const { file, repo } = ignoredRepo("  []\n");
    fs.writeFileSync(file, "batch_size: 2\ntasks: []\n");
    fs.mkdirSync(path.join(repo, ".claude", "w"), { recursive: true });
    const r = await addQueueLine(file, {
      id: "A",
      repo,
      touches: [".claude/w/x.yaml", "nodir/y.ts", "src/ok.ts"],
      text: "a",
    });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings?.join("\n")).toMatch(/git-ignored/);
    expect(r.warnings?.join("\n")).toMatch(/nodir does not exist/);
    const e = await editQueueLine(file, "A", { touches: ["src/ok.ts"] });
    expect(e.warnings).toBeUndefined();
  });

  it("a plan over many entries of one repo spawns git once", () => {
    const rows = [1, 2, 3, 4, 5].map(
      n =>
        `  - id: T${n}\n    status: pending\n    repo: REPO\n    touches: [ src/a${n}.ts, src/b${n}.ts ]\n    text: t\n`,
    );
    const { file, repo } = ignoredRepo(rows.join(""));
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("REPO", repo));
    ignoreProbes.count = 0;
    planPick(readQueue(file), { ignoreWindow: true });
    expect(ignoreProbes.count).toBe(1);
  });

  it("an entry past a symlink costs only itself: the other ignored entries stay ignored", () => {
    const { file, repo } = ignoredRepo(
      `  - id: A\n    status: pending\n    repo: REPO\n    touches: [ lnk/passwd, .claude/b.yaml ]\n    text: a\n`,
    );
    fs.symlinkSync(os.tmpdir(), path.join(repo, "lnk"));
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("REPO", repo));
    const r = planPick(readQueue(file));
    expect(r.admitted.map(a => a.id)).toEqual([]);
    expect(r.reasons.find(x => x.id === "A")?.why).toMatch(/parent-run.*\.claude\/b\.yaml/);
  });

  it("an entry outside the repo does not hide an ignored one on another line", () => {
    const { file, repo } = ignoredRepo(
      `  - id: A\n    status: pending\n    repo: REPO\n    touches: [ .claude/x.yaml ]\n    text: a\n` +
        `  - id: B\n    status: pending\n    repo: REPO\n    touches: [ ../x.ts, /abs/y.ts ]\n    text: b\n`,
    );
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("REPO", repo));
    const r = planPick(readQueue(file));
    expect(r.reasons.find(x => x.id === "A")?.why).toMatch(/parent-run/);
  });
});
