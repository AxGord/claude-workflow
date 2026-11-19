import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideTrustWrite } from "./trust-write-gate.js";

// The guard's decision on the forms it names (and the ones it must leave alone), in a scratch home.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-trust-write-")));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
const HOME = path.join(scratch, "home");
const STATE = path.join(HOME, ".claude", "workflow-state");
const GLOBAL = path.join(HOME, ".claude", "workflows");
const PROJECT = path.join(scratch, "proj");
for (const d of [STATE, GLOBAL, path.join(PROJECT, ".claude", "workflows")])
  fs.mkdirSync(d, { recursive: true });
const TRUST = path.join(STATE, "trusted-workflows.json");
const env = { HOME, STATE_DIR: STATE, WORKFLOW_DIR: GLOBAL } as NodeJS.ProcessEnv;

const bash = (command: string, e: NodeJS.ProcessEnv = env, cwd = PROJECT) =>
  decideTrustWrite({ tool_name: "Bash", cwd, tool_input: { command } }, e)?.permissionDecision;
const tool = (name: string, key: string, file: string, cwd = PROJECT) =>
  decideTrustWrite({ tool_name: name, cwd, tool_input: { [key]: file } }, env)?.permissionDecision;

describe("trust-write-gate: forms asked", () => {
  it.each([
    ["MultiEdit", "file_path"],
    ["Write", "file_path"],
    ["NotebookEdit", "notebook_path"],
  ])("%s of the trust record", (name, key) => {
    expect(tool(name, key, TRUST)).toBe("ask");
  });

  it("a relative file_path resolves against the payload cwd", () => {
    expect(
      tool("Write", "file_path", "../home/.claude/workflow-state/trusted-workflows.json", PROJECT),
    ).toBe("ask");
    expect(tool("Write", "file_path", "x.yaml", GLOBAL)).toBe("ask");
  });

  it("a path through a symlink is the same file", () => {
    const link = path.join(scratch, "link");
    fs.symlinkSync(STATE, link);
    expect(tool("Write", "file_path", path.join(link, "trusted-workflows.json"))).toBe("ask");
  });

  it.each([
    `echo '{}' >> ${TRUST}`,
    `echo '{}' >${TRUST}`,
    `echo '{}' 2>/dev/null >| ${TRUST}`,
    `printf x &> ${GLOBAL}/a.yaml`,
    `mv /tmp/x ${TRUST}`,
    `mv ${TRUST} /tmp/x`,
    `rm ${TRUST}`,
    `cp -t ${GLOBAL} /tmp/x.yaml`,
    `install -m 644 /tmp/x ${GLOBAL}/x.yaml`,
    `dd if=/tmp/x of=${TRUST}`,
    `sed -i.bak s/a/b/ ${TRUST}`,
    `perl -pi -e 's/a/b/' ${TRUST}`,
    `echo x | tee -a ${GLOBAL}/x.yaml`,
    `touch ${GLOBAL}/x.yaml`,
    `cd /tmp && echo x > ~/.claude/workflows/x.yaml`,
    `echo x > $HOME/.claude/workflows/x.yaml`,
    `echo x > "${GLOBAL}/x.yaml"`,
    `sh -c 'echo x > ${TRUST}'`,
    `bash -lc "cp /tmp/x ${GLOBAL}/"`,
    `sudo cp /tmp/x ${GLOBAL}/`,
    `env A=1 tee ${TRUST}`,
    `node -e "require('fs').writeFileSync('${TRUST}','{}')"`,
    `python3 -c "open('${GLOBAL}/x.yaml','w')"`,
    `cat <<EOF > ${TRUST}\n{}\nEOF`,
    `echo hi>~/.claude/workflows/x.yaml`,
    `echo hi>>${TRUST}`,
    `echo hi 2>${GLOBAL}/x.yaml`,
    `tee<in ${TRUST}`,
    `if true; then cp /tmp/x ${GLOBAL}/x.yaml; fi`,
    `for f in a; do cp $f ${GLOBAL}/; done`,
    `! cp /tmp/x ${GLOBAL}/`,
    `{ cp /tmp/x ${GLOBAL}/; }`,
    `while true; do echo x > ${TRUST}; done`,
    `cd ${GLOBAL} && cp /tmp/x x.yaml`,
    `cd ${GLOBAL}; echo x > x.yaml`,
    `(cd ${STATE} && echo x > trusted-workflows.json)`,
    `pushd ${GLOBAL} >/dev/null && tee x.yaml`,
    `cd ~/.claude/workflows && touch x.yaml`,
    `python3 - <<EOF\nopen('${GLOBAL}/x.yaml','w')\nEOF`,
    `bash <<EOF\necho x > ${TRUST}\nEOF`,
  ])("Bash: %s", command => {
    expect(bash(command)).toBe("ask");
  });

  it("a moved state or workflows directory is resolved by the engine's own resolvers", () => {
    const moved = {
      HOME,
      STATE_DIR: path.join(scratch, "st"),
      WORKFLOW_DIR: path.join(scratch, "wfs"),
    };
    expect(bash(`echo x > ${scratch}/st/trusted-workflows.json`, moved)).toBe("ask");
    expect(bash(`echo x > ${scratch}/wfs/a.yaml`, moved)).toBe("ask");
    expect(bash(`echo x > ${TRUST}`, moved)).toBeUndefined();
    expect(bash(`echo x > ${GLOBAL}/a.yaml`, moved)).toBeUndefined();
  });
});

describe("trust-write-gate: forms left alone", () => {
  it.each([
    `cat ${TRUST}`,
    `ls ${GLOBAL}`,
    `grep exec ${GLOBAL}/x.yaml`,
    `cp ${GLOBAL}/x.yaml /tmp/copy.yaml`,
    `sed -n 1,5p ${TRUST}`,
    `diff ${TRUST} /tmp/other`,
    `echo x > /tmp/out.txt`,
    `echo x > ${PROJECT}/.claude/workflows/local.yaml`,
    `wf-trust --list`,
    `wf-trust ${PROJECT}`,
    `echo "see ${TRUST}" > /tmp/note.txt`,
    `node script.js`,
    `rm ${HOME}/.claude/workflow-state/other.json`,
    `cat <<EOF > /tmp/note.md\nsee ${TRUST} and ${GLOBAL}\nEOF`,
    `git commit -F - <<EOF\nmention trusted-workflows.json\nEOF`,
    `cd ${GLOBAL} && cp x.yaml /tmp/x.yaml`,
    `cd ${GLOBAL} && cd /tmp && echo x > x.yaml`,
    `cd /tmp && echo x > x.yaml`,
    `echo a>/tmp/a.txt`,
    `echo "a>b" > /tmp/a.txt`,
  ])("Bash: %s", command => {
    expect(bash(command)).toBeUndefined();
  });

  it("a write elsewhere and a tool that writes nothing", () => {
    expect(
      tool("Write", "file_path", path.join(PROJECT, ".claude", "workflows", "a.yaml")),
    ).toBeUndefined();
    expect(tool("Write", "file_path", path.join(STATE, "other.json"))).toBeUndefined();
    expect(tool("Read", "file_path", TRUST)).toBeUndefined();
    expect(tool("Grep", "path", GLOBAL)).toBeUndefined();
  });

  it("a malformed payload decides nothing", () => {
    expect(
      decideTrustWrite({ tool_name: "Bash", tool_input: { command: 5 } }, env),
    ).toBeUndefined();
    expect(decideTrustWrite({ tool_name: "Write" }, env)).toBeUndefined();
    expect(decideTrustWrite({}, env)).toBeUndefined();
  });
});

describe("trust-write-gate: the reason", () => {
  it("names the file and wf-trust for the record, and the missing consent step for the directory", () => {
    const rec = decideTrustWrite(
      { tool_name: "Write", cwd: PROJECT, tool_input: { file_path: TRUST } },
      env,
    );
    expect(rec?.permissionDecisionReason).toContain(TRUST);
    expect(rec?.permissionDecisionReason).toContain("wf-trust");
    const dir = decideTrustWrite(
      { tool_name: "Write", cwd: PROJECT, tool_input: { file_path: `${GLOBAL}/a.yaml` } },
      env,
    );
    expect(dir?.permissionDecisionReason).toContain("without a consent step");
    expect(dir?.permissionDecisionReason).not.toContain("\n");
  });
});
