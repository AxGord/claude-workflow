import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideTrustWrite } from "./trust-write-gate.js";

// ENG-TRUST-GATE-SKIP-JS: the gate asks about every file in the global workflows directory, also
// those the engine never loads (a Claude Code native `.js` workflow). The files the engine reads
// (`.yaml` / `.yml`, `pool-gate.yaml` among them, and `settings.json`) and the directory itself ask.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-trust-js-")));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
const HOME = path.join(scratch, "home");
const STATE = path.join(HOME, ".claude", "workflow-state");
const GLOBAL = path.join(HOME, ".claude", "workflows");
const PROJECT = path.join(scratch, "proj");
for (const d of [STATE, GLOBAL, PROJECT]) fs.mkdirSync(d, { recursive: true });
const env = { HOME, STATE_DIR: STATE, WORKFLOW_DIR: GLOBAL } as NodeJS.ProcessEnv;

const tool = (name: string, file: string) =>
  decideTrustWrite({ tool_name: name, cwd: PROJECT, tool_input: { file_path: file } }, env)
    ?.permissionDecision;
const bash = (command: string) =>
  decideTrustWrite({ tool_name: "Bash", cwd: PROJECT, tool_input: { command } }, env)
    ?.permissionDecision;

describe("trust-write-gate: a file the engine does not load passes", () => {
  it("Write of a .js into the global workflows directory passes", () => {
    expect(tool("Write", path.join(GLOBAL, "native.js"))).toBeUndefined();
  });
  it("Edit of a .js into the global workflows directory passes", () => {
    expect(tool("Edit", path.join(GLOBAL, "native.js"))).toBeUndefined();
  });
  it("a Bash redirect into a .js there passes", () => {
    expect(bash(`echo x > ${GLOBAL}/native.js`)).toBeUndefined();
  });
  it("a .yaml write still asks", () => {
    expect(tool("Write", path.join(GLOBAL, "wf.yaml"))).toBe("ask");
  });
  it("a Bash command writing a .yaml there still asks", () => {
    expect(bash(`echo x > ${GLOBAL}/wf.yaml`)).toBe("ask");
  });
  it("a .yml write still asks", () => {
    expect(tool("Edit", path.join(GLOBAL, "wf.yml"))).toBe("ask");
  });
  it("pool-gate.yaml and settings.json, which the engine reads, still ask", () => {
    expect(tool("Write", path.join(GLOBAL, "pool-gate.yaml"))).toBe("ask");
    expect(tool("Write", path.join(GLOBAL, "settings.json"))).toBe("ask");
  });
  it("removing or moving the directory itself still asks", () => {
    expect(bash(`rm -r ${GLOBAL}`)).toBe("ask");
    expect(bash(`mv ${GLOBAL} ${GLOBAL}.old`)).toBe("ask");
  });
  it("a name that only starts like a .yaml does not ask, one that ends in it does", () => {
    expect(tool("Write", path.join(GLOBAL, "wf.yaml.js"))).toBeUndefined();
    expect(tool("Write", path.join(GLOBAL, "sub", "wf.yaml"))).toBe("ask");
  });
  it("an interpreter naming only a .js there passes, a .yaml there asks", () => {
    expect(
      bash(`node -e "require('fs').writeFileSync('${GLOBAL}/native.js','x')"`),
    ).toBeUndefined();
    expect(bash(`node -e "require('fs').writeFileSync('${GLOBAL}/wf.yaml','x')"`)).toBe("ask");
  });
  it("an interpreter naming the directory or a path past a .js still asks", () => {
    expect(bash(`node -e "require('fs').rmSync('${GLOBAL}')"`)).toBe("ask");
    expect(
      bash(`node -e "require('fs').writeFileSync('${GLOBAL}/native.js/../wf.yaml','x')"`),
    ).toBe("ask");
  });
  it("the name is read without case: wf.YAML, wf.Yml and Settings.json ask", () => {
    for (const n of ["wf.YAML", "wf.Yml", "Settings.json"])
      expect(tool("Write", path.join(GLOBAL, n))).toBe("ask");
    expect(bash(`node -e "require('fs').writeFileSync('${GLOBAL}/WF.YAML','x')"`)).toBe("ask");
  });
  it("the trust record still asks", () => {
    expect(tool("Write", path.join(STATE, "trusted-workflows.json"))).toBe("ask");
  });
});
