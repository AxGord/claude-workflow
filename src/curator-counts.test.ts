import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCuratorConfig } from "./curator.js";
import {
  errorShape,
  hygieneFindings,
  memoryCounts,
  transcriptFacts,
  transcriptFiles,
} from "./curator-counts.js";
import { parseQueue } from "./queue.js";

// ENG-CURATOR-SERVICE: the curator's counts are scripts, no model. The skills job counts a tool error's SHAPE (paths,
// numbers and quoted text written as placeholders) across transcripts and reports only a shape seen in 3 or more;
// the hygiene job names the queue lines that break a check; the memory job names orphans and dangling links.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-cur-cnt-")));
  dirs.push(d);
  return d;
};

const errorLine = (text: string): string =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", is_error: true, content: text }] },
  });
const skillLine = (skill: string): string =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Skill", input: { skill } }] },
  });

describe("curator skills job: error shapes", () => {
  it("one shape for errors that differ only in paths, numbers and quotes", () => {
    expect(
      errorShape("<tool_use_error>File does not exist: /a/b/c.ts (line 12)</tool_use_error>"),
    ).toBe("File does not exist: <path> (line N)");
    expect(errorShape("Exit code 2\nmore")).toBe("Exit code N");
    expect(errorShape('unknown option "--fast" at 3')).toBe("unknown option <q> at N");
  });

  it("counts a shape across transcripts and reports it only from 3 transcripts on, with the skills' usage", () => {
    const d = tmp();
    const sub = path.join(d, "conv", "subagents");
    fs.mkdirSync(sub, { recursive: true });
    const files = [
      path.join(d, "t1.jsonl"),
      path.join(d, "t2.jsonl"),
      path.join(sub, "agent-x.jsonl"),
      path.join(d, "t4.jsonl"),
    ];
    fs.writeFileSync(
      files[0],
      [
        errorLine("File does not exist: /x/1.ts"),
        errorLine("File does not exist: /x/2.ts"),
        skillLine("hxq"),
      ].join("\n"),
    );
    fs.writeFileSync(
      files[1],
      [errorLine("File does not exist: /y/9.ts"), errorLine("only twice: 1")].join("\n"),
    );
    fs.writeFileSync(
      files[2],
      [
        errorLine("File does not exist: /z/z.ts"),
        errorLine("only twice: 2"),
        skillLine("hxq"),
      ].join("\n"),
    );
    fs.writeFileSync(files[3], "not json\n");
    const found = transcriptFiles(d, undefined);
    expect(found.sort()).toEqual([...files].sort());
    const facts = transcriptFacts(found, []);
    expect(facts.shapes.map(s => [s.shape, s.transcripts, s.count])).toEqual([
      ["File does not exist: <path>", 3, 4],
    ]);
    expect(facts.shapes[0]?.example).toMatch(/^File does not exist/);
    expect(facts.usage).toEqual({ hxq: 2 });
    expect(transcriptFacts(found, [], 2).shapes.map(s => s.shape)).toContain("only twice: N");
  });
});

describe("curator hygiene job", () => {
  it("names a line without a required key, a research line without a research workflow, a stuck line, a duplicate, a project rule and a forbidden word", () => {
    const project = tmp();
    const queue = parseQueue(
      [
        "batch_size: 2",
        "tasks:",
        "  - {id: A, status: pending, difficulty: 3, workflow: w, touches: [a], text: one}",
        "  - {id: B, status: pending, difficulty: 3, text: two}",
        "  - {id: R, status: pending, difficulty: 3, kind: research, workflow: w, touches: [], text: three}",
        "  - {id: S, status: running, difficulty: 3, workflow: w, touches: [s], text: four}",
        "  - {id: D, status: backlog, difficulty: 3, text: one}",
        "  - {id: ENG-X, status: pending, difficulty: 3, workflow: engine-task, touches: [x], text: mentions Acme}",
        "  - {id: CURATOR-2026-11-26-1, status: running, text: the run itself}",
      ].join("\n"),
      path.join(project, "q.yaml"),
    );
    const job = parseCuratorConfig(
      "jobs:\n  hygiene:\n    rules: [{match: {id: '^ENG-'}, require: {repo: '.'}}]\n    forbid_words: [acme]\n",
      "c.yaml",
      project,
    ).jobs[0];
    const f = hygieneFindings(queue, job, project, new Set());
    expect(f.map(x => `${x.id} ${x.check}`)).toEqual([
      "B require",
      "B require",
      "R research",
      "S stuck",
      "D duplicate",
      "ENG-X rule",
      "ENG-X forbidden-word",
    ]);
    expect(
      hygieneFindings(queue, job, project, new Set(["S"])).some(x => x.check === "stuck"),
    ).toBe(false);
  });
});

describe("curator memory job", () => {
  it("lists orphans, dangling links, a file in two indexes, a file without a description and the index budget", () => {
    const mem = tmp();
    fs.writeFileSync(path.join(mem, "MEMORY.md"), "- [A](a.md)\n- [Gone](gone.md)\n- [C](c.md)\n");
    fs.writeFileSync(path.join(mem, "ARCHIVE.md"), "- [C](c.md)\n");
    fs.writeFileSync(path.join(mem, "a.md"), "---\ndescription: a\n---\nA\n");
    fs.writeFileSync(path.join(mem, "b.md"), "no frontmatter\n");
    fs.writeFileSync(path.join(mem, "c.md"), "---\ndescription: c\n---\nC\n");
    const job = parseCuratorConfig(
      `jobs:\n  memory: {dirs: [${mem}], index_budget_bytes: 10}\n`,
      "c.yaml",
      mem,
    ).jobs[0];
    const [d] = memoryCounts(job, mem, undefined);
    expect(d).toMatchObject({
      orphans: ["b.md"],
      dangling: [{ index: "MEMORY.md", target: "gone.md" }],
      multiIndexed: ["c.md"],
      indexBudget: { name: "MEMORY.md", budget: 10 },
    });
    expect(d?.files.find(x => x.name === "b.md")?.description).toBe(false);
  });

  // ENG-CURATOR-MEMORY-LINKS: a project's index links hub files, the hubs link the notes with `[[name]]`.
  const hubFixture = (): {
    mem: string;
    job: ReturnType<typeof parseCuratorConfig>["jobs"][number];
  } => {
    const mem = tmp();
    fs.writeFileSync(path.join(mem, "MEMORY.md"), "- [Hub A](hub_a.md)\n");
    fs.writeFileSync(
      path.join(mem, "hub_a.md"),
      "---\ndescription: hub\n---\n- [[note-x]]\n- [[slug-y|label]]\n- [[slug-y#part]]\n",
    );
    fs.writeFileSync(path.join(mem, "note-x.md"), "---\ndescription: x\n---\nX\n");
    fs.writeFileSync(path.join(mem, "y.md"), "---\nname: slug-y\ndescription: y\n---\nY\n");
    const job = parseCuratorConfig(`jobs:\n  memory: {dirs: [${mem}]}\n`, "c.yaml", mem).jobs[0];
    return { mem, job };
  };

  it("a note reached through a hub by `[[name]]` links (a file name or a frontmatter name) is no orphan and no link is dangling", () => {
    const { mem, job } = hubFixture();
    const [d] = memoryCounts(job, mem, undefined);
    expect(d?.orphans).toEqual([]);
    expect(d?.dangling).toEqual([]);
    expect(d?.indexes).toMatchObject([{ name: "MEMORY.md", links: 1 }]);
    expect(d?.files.find(x => x.name === "y.md")?.indexes).toEqual(["MEMORY.md"]);
  });

  it("a `[[missing]]` link of a hub is dangling, and a note no chain reaches is still an orphan", () => {
    const { mem, job } = hubFixture();
    fs.appendFileSync(path.join(mem, "hub_a.md"), "- [[missing]]\n");
    fs.writeFileSync(path.join(mem, "lonely.md"), "---\ndescription: l\n---\n[[note-x]]\n");
    const [d] = memoryCounts(job, mem, undefined);
    expect(d?.dangling).toEqual([{ index: "hub_a.md", target: "missing" }]);
    expect(d?.orphans).toEqual(["lonely.md"]);
  });

  it("a `[[link]]` written in an index counts as its link; a note two hub chains reach is multi-indexed", () => {
    const { mem, job } = hubFixture();
    fs.writeFileSync(path.join(mem, "ARCHIVE.md"), "- [Z](hub_z.md)\n- [[nobody]]\n");
    fs.writeFileSync(path.join(mem, "hub_z.md"), "---\ndescription: z\n---\n- [[note-x]]\n");
    const [d] = memoryCounts(job, mem, undefined);
    expect(d?.indexes.find(i => i.name === "ARCHIVE.md")?.links).toBe(2);
    expect(d?.multiIndexed).toEqual(["note-x.md"]);
    expect(d?.dangling).toEqual([{ index: "ARCHIVE.md", target: "nobody" }]);
  });

  it("a direct link wins over a chain: a note one index lists and another's hub reaches belongs to the lister only", () => {
    const { mem, job } = hubFixture();
    fs.writeFileSync(path.join(mem, "ARCHIVE.md"), "- [[note-x]]\n");
    const [d] = memoryCounts(job, mem, undefined);
    expect(d?.multiIndexed).toEqual([]);
    expect(d?.files.find(x => x.name === "note-x.md")?.indexes).toEqual(["ARCHIVE.md"]);
  });

  it("a link from a note of one index to a note another index lists is no membership", () => {
    const mem = tmp();
    fs.writeFileSync(path.join(mem, "MEMORY.md"), "- [a1](a1.md)\n");
    fs.writeFileSync(path.join(mem, "B.md"), "- [b1](b1.md)\n");
    fs.writeFileSync(path.join(mem, "a1.md"), "---\ndescription: a\n---\nRelated: [[b1]]\n");
    fs.writeFileSync(path.join(mem, "b1.md"), "---\ndescription: b\n---\nB\n");
    const job = parseCuratorConfig(`jobs:\n  memory: {dirs: [${mem}]}\n`, "c.yaml", mem).jobs[0];
    const [d] = memoryCounts(job, mem, undefined);
    expect(d?.multiIndexed).toEqual([]);
    expect(d?.files.find(x => x.name === "b1.md")?.indexes).toEqual(["B.md"]);
    expect(d?.files.find(x => x.name === "a1.md")?.indexes).toEqual(["MEMORY.md"]);
  });
});
