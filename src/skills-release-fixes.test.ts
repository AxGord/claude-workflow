import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addSkills,
  planRemove,
  removeSkills,
  splitSkill,
  syncSkills,
  type SkillsContext,
} from "./skills.js";
import { NON_SESSION_FILES, Storage } from "./storage.js";
import { TRUST_FILE } from "./trust.js";

// ENG-RELEASE-SKILLS-CLI-FIXES: the three symptoms, each by running the behaviour in a scratch plugin root and HOME.
describe("skills tooling: symptoms of the release-preparation line", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function setup(skills: Record<string, string>): SkillsContext {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wf-skills-release-"));
    dirs.push(base);
    const ctx: SkillsContext = {
      root: path.join(base, "plugin"),
      skillsDir: path.join(base, "home", ".claude", "skills"),
      stateDir: path.join(base, "state"),
      version: "1.0.0",
    };
    for (const [name, text] of Object.entries(skills)) {
      const dir = path.join(ctx.root, "templates", "skills", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), text);
    }
    return ctx;
  }

  it("`wf-skills add x x` installs and reports x once", () => {
    const ctx = setup({ x: "x v1\n" });
    const r = addSkills(ctx, ["x", "x"]);
    expect(r.installed).toEqual(["x"]);
  });

  it("`wf-skills remove` sweeps the .wf-new.* staging directory an interrupted update left", () => {
    const ctx = setup({ x: "x v1\n" });
    syncSkills(ctx);
    const stage = path.join(ctx.skillsDir, ".wf-new.x.4242");
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, "SKILL.md"), "half written\n");
    expect(planRemove(ctx).scratch).toEqual([".wf-new.x.4242"]);
    removeSkills(ctx);
    expect(fs.existsSync(stage)).toBe(false);
  });

  it("`wf-skills remove` leaves a directory that is not the engine's own staging", () => {
    const ctx = setup({ x: "x v1\n" });
    syncSkills(ctx);
    fs.mkdirSync(path.join(ctx.skillsDir, ".mine"), { recursive: true });
    removeSkills(ctx);
    expect(fs.existsSync(path.join(ctx.skillsDir, ".mine"))).toBe(true);
  });

  it("a session listing of the state directory skips trusted-workflows.json", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-state-"));
    dirs.push(stateDir);
    fs.writeFileSync(
      path.join(stateDir, TRUST_FILE),
      JSON.stringify({ version: 1, trusted: {}, projects: {} }),
    );
    const storage = new Storage(stateDir, { eventLog: false });
    expect(storage.list()).toEqual([]);
    expect(storage.readAll()).toEqual([]);
  });

  it("every file named in NON_SESSION_FILES is skipped by the session readers", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-state-"));
    dirs.push(stateDir);
    for (const f of NON_SESSION_FILES) fs.writeFileSync(path.join(stateDir, f), "{}");
    const storage = new Storage(stateDir, { eventLog: false });
    expect(storage.list()).toEqual([]);
    storage.pruneTerminal(0);
    for (const f of NON_SESSION_FILES) expect(fs.existsSync(path.join(stateDir, f))).toBe(true);
  });

  it("the learned-skill split keeps a short block that occurs inside a longer block already there", () => {
    const ctx = setup({ x: "x v1\n" });
    syncSkills(ctx);
    const learned = path.join(ctx.skillsDir, "learned-x");
    fs.mkdirSync(learned, { recursive: true });
    fs.writeFileSync(
      path.join(learned, "SKILL.md"),
      "---\nname: learned-x\ndescription: mine\n---\n\n# Learned: x\n\nAlways run the full test suite before you commit anything.\n",
    );
    fs.appendFileSync(path.join(ctx.skillsDir, "x", "SKILL.md"), "run the full test suite\n");
    const r = splitSkill(ctx, "x");
    expect(r.sections).toBe(1);
    expect(fs.readFileSync(path.join(learned, "SKILL.md"), "utf8")).toContain(
      "_Moved from your copy of x",
    );
  });

  it("the learned-skill split does not write a section twice when a run that died already wrote it", () => {
    const ctx = setup({ x: "x v1\n" });
    syncSkills(ctx);
    fs.appendFileSync(path.join(ctx.skillsDir, "x", "SKILL.md"), "my lesson\n");
    const learned = path.join(ctx.skillsDir, "learned-x");
    fs.mkdirSync(learned, { recursive: true });
    fs.writeFileSync(
      path.join(learned, "SKILL.md"),
      '---\nname: learned-x\ndescription: mine\n---\n\n# Learned: x\n\n_Moved from your copy of x (SKILL.md, after "x v1"):_\n\nmy lesson\n',
    );
    const r = splitSkill(ctx, "x");
    expect(r.sections).toBe(0);
    expect(
      fs.readFileSync(path.join(learned, "SKILL.md"), "utf8").match(/my lesson/g),
    ).toHaveLength(1);
  });

  it("`wf-skills add` takes a repeated name once with --all-stack too", () => {
    const ctx = setup({ x: "x v1\n" });
    expect(addSkills(ctx, ["x", "x"], true).installed).toEqual(["x"]);
  });
});
