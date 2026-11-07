import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { appendMarkdown, convertLine, jsonToYaml, markdownToYaml } from "./queue-convert.js";
import { markQueue, parseQueue, planPick, readQueue } from "./queue.js";
import { parseConfig } from "./pool-gate.js";
import { parseReadOnlyConfig } from "./read-only-gate.js";
import { parseYaml } from "./yaml-config.js";

const FIXTURE = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "fixtures",
  "wave-excerpt.md",
);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-convert-"));
  dirs.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, ".claude", "batch"), { recursive: true });
  return root;
}

describe("convertLine", () => {
  it("fields by key, lists split on top-level commas, ⏸ → parked, mark notes and dated notes", () => {
    const t = convertLine(
      "- [ ] A | LANDED x | ⏸ wait | difficulty: 4 | after: B, C (and D, E) | touches: src/a.ts, docs/ | exclusive: yes | The brief. | (user 2026-11-07, later) more |",
    );
    expect(t).toEqual({
      id: "A",
      status: "pending",
      fields: {
        difficulty: 4,
        after: ["B", "C (and D, E)"],
        touches: ["src/a.ts", "docs/"],
        exclusive: true,
        parked: true,
        text: "The brief.",
      },
      notes: [
        { from: "mark", text: "LANDED x" },
        { from: "mark", text: "⏸ wait" },
        { from: "user", date: "2026-11-07", text: "(user 2026-11-07, later) more" },
      ],
    });
    expect(convertLine("- [!] B | after: — | exclusive: — | only text")).toEqual({
      id: "B",
      status: "failed",
      fields: { text: "only text" },
      notes: [],
    });
    expect(convertLine("not a line")).toBeNull();
  });
});

describe("rows of the real queues' other shapes", () => {
  it("a ⏸ before the id parks the task; an id then prose (no `|`) takes the prose as text", () => {
    expect(convertLine("- [x] ⏸ P1 | РЕШЕНО 2026-10-22: L3 | model: — | brief")).toMatchObject({
      id: "P1",
      status: "done",
      fields: { model: "—", parked: true, text: "brief" },
      notes: [{ from: "mark", text: "РЕШЕНО 2026-10-22: L3" }],
    });
    expect(convertLine('- [ ] T1519 (2026-10-22) FLAKE: `a#b` (line 848 "x") — retry')).toEqual({
      id: "T1519",
      status: "pending",
      fields: { text: '(2026-10-22) FLAKE: `a#b` (line 848 "x") — retry' },
      notes: [],
    });
  });

  it("a task row it cannot read refuses the conversion, naming the row", () => {
    const md = "batch_size: 1\n## Tasks\n- [ ] A | x\n- [ ] (no id) at all\n- [ ] ;bad\n";
    expect(() => markdownToYaml(md, "q.md")).toThrow(
      /2 task row\(s\) not converted:\n {2}line 4: /,
    );
  });
});

describe("the real queue excerpt", () => {
  const md = fs.readFileSync(FIXTURE, "utf8");
  const yaml = markdownToYaml(md, FIXTURE);
  const q = parseQueue(yaml, "/x/q.yaml");

  it("keeps every task, its status, parks ⏸ lines and renames a duplicate id", () => {
    const rows = md.split("\n").filter(r => /^- \[.\] /.test(r));
    expect(q.lines).toHaveLength(rows.length);
    expect(q.lines.map(l => l.id)).toContain("DOC-0-2");
    const by = Object.fromEntries(q.lines.map(l => [l.id, l]));
    expect(by["ENG-QUEUE-YAML"].status).toBe("running");
    expect(by["UTIL-1"].status).toBe("failed");
    expect(by.W0.status).toBe("done");
    expect(by.W0.notes.at(-1)?.text).toBe("was [-] in the Markdown queue");
    expect(by.T7b.paused).toBe(true);
    expect(by["MEM-1"].paused).toBe(false); // its ⏸ stands in long prose: a mention, as the old picker read it
    expect(by["UTIL-1"].meta.exclusive).toBe("yes");
    expect(q.batchSize).toBe(5);
    expect(q.batchComment).toMatch(/^window 5/);
    expect(q.overlap).toBe("files");
    expect(q.baseRepos).toEqual(["/Users/axg/dev/lab/anyparse"]);
    expect((YAML.parse(yaml) as { preamble: string }).preamble).toMatch(/^# wave-D/);
  });

  it("no text is lost: every field of every row is in the task (as a key, text or a note)", () => {
    const rows = md.split("\n").filter(r => /^- \[.\] /.test(r));
    for (const [i, row] of rows.entries()) {
      const l = q.lines[i];
      const all = [l.text, ...l.notes.map(n => n.text), ...Object.values(l.meta)].join(" ");
      const prose = row
        .replace(/^- \[.\] \S+ \|/, "")
        .split(" | ")
        .map(f => f.trim().replace(/\s*\|$/, ""))
        .filter(f => f !== "" && f !== "—" && !/^[a-z]+:/.test(f));
      for (const f of prose) expect(all, `${l.id}: ${f.slice(0, 40)}`).toContain(f);
    }
  });

  it("round-trips: a converted queue converts the same twice, and a write changes only what it sets", async () => {
    expect(markdownToYaml(md, FIXTURE)).toBe(yaml);
    const root = project();
    const file = path.join(root, ".claude", "batch", "queue.yaml");
    fs.writeFileSync(file, yaml);
    await markQueue(file, "ENG-QUEUE-YAML", "done");
    const after = fs.readFileSync(file, "utf8");
    expect(after).toBe(
      yaml.replace(
        "- id: ENG-QUEUE-YAML\n    status: running",
        "- id: ENG-QUEUE-YAML\n    status: done",
      ),
    );
    expect(planPick(readQueue(file)).running).toEqual([]);
  });

  it("appends a second queue's open tasks with a chosen status; a duplicate id is refused", () => {
    const into = "batch_size: 1  # keep me\ntasks:\n  - id: KEEP\n    status: done\n";
    const other =
      "batch_size: 1\n## Tasks\n- [ ] N1 | touches: a\n- [x] N2 | touches: b\n- [!] N3 | x\n";
    const { text: out, added } = appendMarkdown(into, other, "backlog");
    expect(added).toBe(2);
    expect(out.startsWith("batch_size: 1 # keep me\ntasks:\n  - id: KEEP\n")).toBe(true);
    const q2 = parseQueue(out, "q");
    expect(q2.lines.map(l => [l.id, l.status])).toEqual([
      ["KEEP", "done"],
      ["N1", "backlog"],
      ["N3", "backlog"],
    ]);
    expect(planPick(q2).admitted).toEqual([]);
    expect(() => appendMarkdown(out, other)).toThrow("N1 is already in the queue");
    expect(() => appendMarkdown(into, "batch_size: 1\n## Tasks\n- [x] D | x\n")).toThrow(
      "no open task to append",
    );
  });
});

describe("JSON configs to YAML", () => {
  it("the same document: pool-gate and read-only configs read the YAML as they read the JSON", () => {
    const gate = JSON.stringify({ rules: [{ match: "npm test", threads: 4 }], wrappers: ["x.sh"] });
    expect(parseConfig(jsonToYaml(gate))).toEqual(parseConfig(gate));
    const ro = JSON.stringify({ write: ["/rm /"], env: { A: "1" } });
    expect(parseReadOnlyConfig(jsonToYaml(ro))).toEqual(parseReadOnlyConfig(ro));
    expect(jsonToYaml(JSON.stringify({ budget: 6 }))).toBe("budget: 6\n");
    // a config holding only comments reads as empty, not as a broken config
    expect(parseYaml("# nothing yet\n")).toEqual({});
    expect(parseConfig("# nothing yet\n")).toEqual({ rules: [], wrappers: [] });
    expect(parseReadOnlyConfig("")).toEqual(parseReadOnlyConfig("{}"));
  });
});
