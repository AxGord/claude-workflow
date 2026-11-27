import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideQueueWrite } from "./queue-write-gate.js";

// ENG-TASKFILE-WRITE-HOOK: a hand edit of a queue file is denied with the names of the queue's
// writers; a read, the engine's own writers and every other file pass.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-queue-write-")));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
const PROJECT = path.join(scratch, "proj");
const BATCH = path.join(PROJECT, ".claude", "batch");
const QUEUE = path.join(BATCH, "queue.yaml");
const NAMED = path.join(BATCH, "side.yml");
const ARCHIVE = path.join(BATCH, "queue.archive.yaml");
const ELSEWHERE = path.join(scratch, "other", "tasks-of-repo.yaml");
const PLAIN = path.join(scratch, "other", "plain.yaml");
const WORKFLOW = path.join(PROJECT, ".claude", "workflows", "wf.yaml");
const QUEUE_BODY = "batch_size: 2\ntasks:\n  - id: T1\n    status: pending\n    text: x\n";
for (const f of [QUEUE, NAMED, ARCHIVE, ELSEWHERE, PLAIN, WORKFLOW])
  fs.mkdirSync(path.dirname(f), { recursive: true });
for (const f of [QUEUE, NAMED, ARCHIVE, ELSEWHERE]) fs.writeFileSync(f, QUEUE_BODY);
fs.writeFileSync(PLAIN, "name: wf\nstates: {}\n");
fs.writeFileSync(WORKFLOW, "name: wf\nstates: {}\n");
const env = { HOME: path.join(scratch, "home") } as NodeJS.ProcessEnv;

const bash = (command: string, cwd = PROJECT) =>
  decideQueueWrite({ tool_name: "Bash", cwd, tool_input: { command } }, env)?.permissionDecision;
const tool = (name: string, file: string, cwd = PROJECT) =>
  decideQueueWrite({ tool_name: name, cwd, tool_input: { file_path: file } }, env)
    ?.permissionDecision;

describe("queue-write-gate: forms denied", () => {
  it.each(["Edit", "Write", "MultiEdit"])("%s of a queue file", name => {
    expect(tool(name, QUEUE)).toBe("deny");
  });

  it.each([
    ["a named queue", NAMED],
    ["the archive", ARCHIVE],
    ["a queue of another repo, named by its header", ELSEWHERE],
  ])("Write: %s", (_what, file) => {
    expect(tool("Write", file)).toBe("deny");
  });

  it("a queue file that does not exist yet in .claude/batch, and a relative path against the cwd", () => {
    expect(tool("Write", path.join(BATCH, "fresh.yaml"))).toBe("deny");
    expect(tool("Edit", ".claude/batch/queue.yaml")).toBe("deny");
    expect(tool("Edit", "queue.yaml", BATCH)).toBe("deny");
  });

  it.each([
    `sed -i s/pending/done/ ${QUEUE}`,
    `sed -i '' 's/a/b/' ${QUEUE}`,
    `perl -pi -e 's/a/b/' ${QUEUE}`,
    `echo x >> ${QUEUE}`,
    `echo x > .claude/batch/queue.yaml`,
    `cat /tmp/new.yaml > ${QUEUE}`,
    `printf x>${QUEUE}`,
    `echo x | tee -a ${QUEUE}`,
    `tee ${NAMED} < /tmp/x`,
    `cp /tmp/new.yaml ${QUEUE}`,
    `mv /tmp/new.yaml ${QUEUE}`,
    `mv ${QUEUE} /tmp/gone.yaml`,
    `rm ${QUEUE}`,
    `touch ${BATCH}/fresh.yaml`,
    `sh -c 'echo x > ${QUEUE}'`,
    `cd ${BATCH} && echo x > queue.yaml`,
    `cd ${PROJECT} && sed -i s/a/b/ .claude/batch/queue.yaml`,
    `echo x > ${ELSEWHERE}`,
    `cat <<EOF > ${QUEUE}\nbatch_size: 1\nEOF`,
    `bash <<EOF\necho x > ${QUEUE}\nEOF`,
    `if true; then cp /tmp/n.yaml ${QUEUE}; fi`,
  ])("Bash: %s", command => {
    expect(bash(command)).toBe("deny");
  });

  it("the reason names the file and the tools to use, on one block", () => {
    const d = decideQueueWrite(
      { tool_name: "Edit", cwd: PROJECT, tool_input: { file_path: QUEUE } },
      env,
    );
    const r = d?.permissionDecisionReason ?? "";
    expect(r).toContain(QUEUE);
    for (const name of ["queue_add", "queue_edit", "queue_mark", "queue_header", "wf-queue"])
      expect(r).toContain(name);
    expect(r).not.toContain("\n");
  });
});

describe("queue-write-gate: forms left alone", () => {
  it.each([
    `cat ${QUEUE}`,
    `grep -n 'id: T1' ${QUEUE}`,
    `sed -n 1,5p ${QUEUE}`,
    `head -20 .claude/batch/queue.yaml`,
    `diff ${QUEUE} ${NAMED}`,
    `cp ${QUEUE} /tmp/queue-copy.yaml`,
    `cp ${QUEUE} ${QUEUE}.bak`,
    `ls ${BATCH}`,
    `wf-queue ${QUEUE} --add '{id: T2, text: a > b}'`,
    `wf-queue --queue side --edit T1 --set difficulty=3`,
    `wf-queue ${QUEUE} --done T1 --note x`,
    `wf-queue ${QUEUE} --batch-size 0 --reason pause`,
    `/some/plugin/scripts/wf-queue ${ELSEWHERE} --header batch_size`,
    `node build/queue-cli.js ${QUEUE} --path`,
    `node -e "console.log(require('fs').readFileSync('${QUEUE}','utf8'))"`,
    `python3 -c "import yaml; print(yaml.safe_load(open('${QUEUE}')))"`,
    `echo x > /tmp/out.txt`,
    `echo x > ${PLAIN}`,
    `echo x > ${WORKFLOW}`,
    `sed -i s/a/b/ ${PLAIN}`,
    `echo x > ${BATCH}/notes.md`,
    `echo x > ${BATCH}/sub/inner.yaml`,
    `echo "see ${QUEUE}" > /tmp/note.txt`,
    `git commit -F - <<EOF\nthe file ${QUEUE} changed\nEOF`,
    `cd ${BATCH} && cp queue.yaml /tmp/x.yaml`,
  ])("Bash: %s", command => {
    expect(bash(command)).toBeUndefined();
  });

  it("a read tool, a write elsewhere and a malformed payload", () => {
    expect(tool("Read", QUEUE)).toBeUndefined();
    expect(tool("Grep", QUEUE)).toBeUndefined();
    expect(tool("Write", PLAIN)).toBeUndefined();
    expect(tool("Write", WORKFLOW)).toBeUndefined();
    expect(tool("Write", path.join(BATCH, "report.md"))).toBeUndefined();
    expect(tool("Write", path.join(BATCH, "dir", "x.yaml"))).toBeUndefined();
    expect(
      decideQueueWrite({ tool_name: "Bash", tool_input: { command: 5 } }, env),
    ).toBeUndefined();
    expect(decideQueueWrite({ tool_name: "Write" }, env)).toBeUndefined();
    expect(decideQueueWrite({}, env)).toBeUndefined();
  });

  it("a yaml file with a header but no task list, or a task list but no header, is no queue", () => {
    const half = path.join(scratch, "other", "half.yaml");
    fs.writeFileSync(half, "batch_size: 2\n");
    expect(tool("Write", half)).toBeUndefined();
    fs.writeFileSync(half, "tasks:\n  - a\n");
    expect(tool("Write", half)).toBeUndefined();
  });
});

describe("queue-write-gate: the hook wiring", () => {
  const root = path.resolve(import.meta.dirname, "..");

  it("hooks.json runs the gate on Bash, Write, Edit and MultiEdit, and the script is executable", () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json"), "utf8")) as {
      hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
    };
    const entry = hooks.hooks.PreToolUse.find(e =>
      e.hooks.some(h => h.command.endsWith("/hooks/queue-write-gate.sh")),
    );
    expect(entry?.matcher.split("|").sort()).toEqual(["Bash", "Edit", "MultiEdit", "Write"]);
    fs.accessSync(path.join(root, "hooks", "queue-write-gate.sh"), fs.constants.X_OK);
  });

  it("a payload that names no yaml file exits at once with no output, and no build needed", () => {
    const run = spawnSync("sh", [path.join(root, "hooks", "queue-write-gate.sh")], {
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/tmp/x.md" } }),
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });
});
