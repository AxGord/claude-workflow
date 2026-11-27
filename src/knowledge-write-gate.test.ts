import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideKnowledgeWrite, PLACEMENT_ROWS } from "./knowledge-write-gate.js";

// ENG-MEMORY-WRITE-GATE: the creation of a new memory file asks or denies unless its frontmatter
// names a placement reason; everything else (an edit, an index, a project that never opted in) passes.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-knowledge-gate-")));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
const HOME = path.join(scratch, "home");
const MEM = path.join(HOME, ".claude", "projects", "-some-project", "memory");
const PROJECT = path.join(scratch, "proj");
const OTHER = path.join(scratch, "other");
fs.mkdirSync(MEM, { recursive: true });
for (const [dir, settings] of [
  [PROJECT, '{"memory_write_gate":"deny"}'],
  [path.join(scratch, "asking"), '{"memory_write_gate":"ask"}'],
  [path.join(scratch, "noKey"), '{"priority":"high"}'],
  [path.join(scratch, "badValue"), '{"memory_write_gate":"block"}'],
  [OTHER, undefined],
] as const) {
  fs.mkdirSync(path.join(dir, ".claude", "workflows"), { recursive: true });
  if (settings !== undefined)
    fs.writeFileSync(path.join(dir, ".claude", "workflows", "settings.json"), settings);
}
const env = { HOME } as NodeJS.ProcessEnv;
const EXISTING = path.join(MEM, "existing.md");
fs.writeFileSync(EXISTING, "---\nname: x\n---\nold\n");
fs.writeFileSync(path.join(MEM, "MEMORY.md"), "# index\n");
const NEW = path.join(MEM, "new_note.md");
const WITH7 = "---\nname: n\nwhy-memory: 7 not findable in the tree\n---\nbody\n";
const WITH6 =
  "---\nname: n\nwhy-memory: 6 the map line names memory as the owner-call home\n---\nbody\n";

const call = (tool_name: string, tool_input: Record<string, unknown>, cwd = PROJECT, e = env) =>
  decideKnowledgeWrite({ tool_name, cwd, tool_input }, e);
const write = (file: string, content: string, cwd = PROJECT, e = env) =>
  call("Write", { file_path: file, content }, cwd, e)?.permissionDecision;
const bash = (command: string, cwd = PROJECT, e = env) =>
  call("Bash", { command }, cwd, e)?.permissionDecision;

describe("knowledge-write-gate: a new memory file", () => {
  it("is denied with no why-memory line, the reason is the table's seven rows", () => {
    const d = call("Write", { file_path: NEW, content: "---\nname: n\n---\nbody\n" });
    expect(d?.permissionDecision).toBe("deny");
    const lines = d?.permissionDecisionReason.split("\n") ?? [];
    for (const row of PLACEMENT_ROWS) expect(lines).toContain(row);
    expect(PLACEMENT_ROWS).toHaveLength(7);
    expect(d?.permissionDecisionReason).toContain(NEW);
    expect(d?.permissionDecisionReason).toContain("why-memory: 7");
  });

  it("is denied with no frontmatter at all", () => {
    expect(write(NEW, "just a note\n")).toBe("deny");
  });

  it.each([
    ["row 7", WITH7],
    ["row 6", WITH6],
  ])("passes with a why-memory line of %s", (_name, content) => {
    expect(write(NEW, content)).toBeUndefined();
  });

  it.each([
    ["a row outside 6 and 7", "---\nwhy-memory: 5 a doc would hold it\n---\nx\n"],
    ["no reason after the row", "---\nwhy-memory: 7\n---\nx\n"],
    ["the line in the body, not the frontmatter", "---\nname: n\n---\nwhy-memory: 7 here\n"],
    ["the line before the frontmatter", "why-memory: 7 here\n---\nname: n\n---\n"],
  ])("is denied with %s", (_name, content) => {
    expect(write(NEW, content)).toBe("deny");
  });

  it("is asked, not denied, in a project that set `ask`", () => {
    expect(write(NEW, "x", path.join(scratch, "asking"))).toBe("ask");
  });

  it("is created by an Edit or a MultiEdit from an empty old_string", () => {
    expect(
      call("Edit", { file_path: NEW, old_string: "", new_string: "x" })?.permissionDecision,
    ).toBe("deny");
    expect(call("Edit", { file_path: NEW, old_string: "", new_string: WITH7 })).toBeUndefined();
    const multi = (first: string, then: string) =>
      call("MultiEdit", {
        file_path: NEW,
        edits: [
          { old_string: "", new_string: first },
          { old_string: "TAG", new_string: then },
        ],
      })?.permissionDecision;
    expect(multi("---\nname: n\n---\nTAG\n", "b")).toBe("deny");
    expect(multi("---\nwhy-memory: 7 TAG\n---\n", "no row fits")).toBeUndefined();
  });

  it("resolves a relative path against the payload cwd and a `~` path", () => {
    expect(write("../home/.claude/projects/-some-project/memory/rel.md", "x")).toBe("deny");
    expect(write("~/.claude/projects/-some-project/memory/tilde.md", "x")).toBe("deny");
  });

  it("is guarded where CLAUDE_CONFIG_DIR puts the projects", () => {
    const cfg = path.join(scratch, "cfg");
    const e = { HOME, CLAUDE_CONFIG_DIR: cfg } as NodeJS.ProcessEnv;
    expect(write(path.join(cfg, "projects", "-p", "memory", "n.md"), "x", PROJECT, e)).toBe("deny");
    expect(write(NEW, "x", PROJECT, e)).toBeUndefined();
  });
});

describe("knowledge-write-gate: what passes", () => {
  it("an edit of an existing file, an index line included", () => {
    expect(write(EXISTING, "no frontmatter at all")).toBeUndefined();
    expect(
      call("Edit", { file_path: EXISTING, old_string: "old", new_string: "new" }),
    ).toBeUndefined();
    expect(
      call("MultiEdit", {
        file_path: EXISTING,
        edits: [{ old_string: "old", new_string: "new" }],
      }),
    ).toBeUndefined();
    expect(
      call("Edit", {
        file_path: path.join(MEM, "MEMORY.md"),
        old_string: "# index",
        new_string: "# index\n- [x](x.md) — a line",
      }),
    ).toBeUndefined();
  });

  it("a new index file (no lower-case letter in its name) and a file that is not .md", () => {
    expect(write(path.join(MEM, "PARENT.md"), "# parent")).toBeUndefined();
    expect(write(path.join(MEM, "check_index.py"), "print(1)")).toBeUndefined();
  });

  it("an Edit that cannot create the file (a non-empty old_string)", () => {
    expect(call("Edit", { file_path: NEW, old_string: "a", new_string: "b" })).toBeUndefined();
  });

  it("a write outside a memory directory, and tools that write nothing", () => {
    const projects = path.join(HOME, ".claude", "projects", "-some-project");
    expect(write(path.join(projects, "notes.md"), "x")).toBeUndefined();
    expect(write(path.join(MEM, "sub", "..", "..", "x.md"), "x")).toBeUndefined();
    expect(write(path.join(HOME, ".claude", "skills", "s", "SKILL.md"), "x")).toBeUndefined();
    expect(write(path.join(scratch, "memory", "x.md"), "x")).toBeUndefined();
    expect(call("Read", { file_path: NEW })).toBeUndefined();
    expect(call("Grep", { path: MEM })).toBeUndefined();
  });

  it("a malformed payload decides nothing", () => {
    expect(
      decideKnowledgeWrite({ tool_name: "Bash", tool_input: { command: 5 } }, env),
    ).toBeUndefined();
    expect(decideKnowledgeWrite({ tool_name: "Write" }, env)).toBeUndefined();
    expect(decideKnowledgeWrite({}, env)).toBeUndefined();
  });
});

describe("knowledge-write-gate: opt-in per project", () => {
  it("no settings file, or a file with no memory_write_gate key: no gate", () => {
    for (const cwd of [OTHER, path.join(scratch, "noKey")]) {
      expect(write(NEW, "x", cwd)).toBeUndefined();
      expect(bash(`echo x > ${NEW}`, cwd)).toBeUndefined();
    }
  });

  it("a value outside deny / ask is refused, not read as off", () => {
    expect(() => write(NEW, "x", path.join(scratch, "badValue"))).toThrow(/memory_write_gate/);
  });

  it("a call that creates no memory file never reads the settings", () => {
    expect(write(EXISTING, "x", path.join(scratch, "badValue"))).toBeUndefined();
  });
});

describe("knowledge-write-gate: Bash", () => {
  it.each([
    `echo x > ${NEW}`,
    `echo x >> ${NEW}`,
    `cat > ${NEW} <<EOF\n---\nname: n\n---\nEOF`,
    `printf 'a' | tee ${NEW}`,
    `touch ${NEW}`,
    `cp /tmp/x.md ${NEW}`,
    `mv /tmp/x.md ${NEW}`,
    `install -m 644 /tmp/x.md ${NEW}`,
    `sh -c 'echo x > ${NEW}'`,
    `cd ${MEM} && echo x > new_note.md`,
    `echo x > $HOME/.claude/projects/-some-project/memory/var.md`,
    `python3 -c "open('${NEW}','w').write('x')"`,
  ])("is denied: %s", command => {
    expect(bash(command)).toBe("deny");
  });

  it("passes when the command's own text carries the why-memory line", () => {
    expect(
      bash(`cat > ${NEW} <<EOF\n---\nwhy-memory: 7 not in the tree\n---\nEOF`),
    ).toBeUndefined();
    expect(bash(`printf -- '---\\nwhy-memory: 6 the map\\n---\\n' > ${NEW}`)).toBeUndefined();
    expect(bash(`printf -- '---\\nwhy-memory: 5 x\\n---\\n' > ${NEW}`)).toBe("deny");
  });

  it.each([
    `cat ${EXISTING}`,
    `ls ${MEM}`,
    `grep why ${MEM}/existing.md`,
    `echo x >> ${EXISTING}`,
    `sed -i s/old/new/ ${EXISTING}`,
    `mv ${EXISTING} /tmp/moved.md`,
    `mv ${EXISTING} ${MEM}/MEMORY.md`,
    `rm ${NEW}`,
    `rm -f ${MEM}/never_there.md`,
    `unlink ${NEW}`,
    `cp ${EXISTING} /tmp/copy.md`,
    `echo x > ${MEM}/note.txt`,
    `echo x > /tmp/new_note.md`,
    `node build.js`,
    `python3 ${MEM}/check_index.py`,
    `git commit -m "memory: ${NEW}"`,
  ])("passes: %s", command => {
    expect(bash(command)).toBeUndefined();
  });
});

describe("knowledge-write-gate: the hook script", () => {
  it("a payload that does not mention memory exits at once with no output, and no build needed", () => {
    const script = path.resolve(import.meta.dirname, "..", "hooks", "knowledge-write-gate.sh");
    const run = spawnSync("sh", [script], {
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/tmp/x.md" } }),
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });
});
