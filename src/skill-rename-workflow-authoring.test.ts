import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("bundled skill name must not shadow Claude Code's native /workflow-authoring", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** Run the real SessionStart hook against the real templates with a sandboxed HOME. */
  let lastState = "";
  function runStart(preset?: (skills: string) => void): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-skill-"));
    dirs.push(root);
    const home = path.join(root, "home");
    const skills = path.join(home, ".claude", "skills");
    fs.mkdirSync(skills, { recursive: true });
    preset?.(skills);
    const r = spawnSync("bash", [path.join(ROOT, "hooks", "workflow-start.sh")], {
      input: JSON.stringify({ source: "startup", session_id: "conv-1", cwd: root }) + "\n",
      env: {
        ...process.env,
        HOME: home,
        STATE_DIR: path.join(root, "state"),
        CLAUDE_CONFIG_DIR: path.join(root, "config"),
        CLAUDE_PLUGIN_ROOT: ROOT,
      },
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`hook exited ${r.status}: ${r.stderr}`);
    lastState = path.join(root, "state");
    return skills;
  }

  it("a fresh install does not copy a skill named workflow-authoring into ~/.claude/skills", () => {
    const skills = runStart();
    expect(fs.readdirSync(skills)).not.toContain("workflow-authoring");
  });

  it("start removes an earlier install's copy of the engine skill, so the native one is visible again", () => {
    // The copy an earlier install made: the engine's SKILL.md as shipped before the rename.
    const engineSkill = spawnSync(
      "git",
      [
        "show",
        "a654cb5674044c64f6f5abb70e8c29e39f5c34ce:templates/skills/workflow-authoring/SKILL.md",
      ],
      { cwd: ROOT, encoding: "utf8" },
    ).stdout;
    expect(engineSkill).toContain("name: workflow-authoring");
    const skills = runStart(s => {
      fs.mkdirSync(path.join(s, "workflow-authoring"));
      fs.writeFileSync(path.join(s, "workflow-authoring", "SKILL.md"), engineSkill);
    });
    expect(fs.existsSync(path.join(skills, "workflow-authoring"))).toBe(false);
    // moved, not deleted: a live copy may hold enrichments
    const backups = fs.readdirSync(path.join(lastState, "skill-backups"));
    expect(backups).toHaveLength(1);
    const backup = path.join(lastState, "skill-backups", String(backups[0]), "SKILL.md");
    expect(fs.readFileSync(backup, "utf8")).toBe(engineSkill);
  });

  it("start moves the old copy even with a Finder .DS_Store beside its SKILL.md", () => {
    const old =
      "---\nname: workflow-authoring\ndescription: Reference for authoring workflow YAML — x\n---\nold\n";
    const skills = runStart(s => {
      fs.mkdirSync(path.join(s, "workflow-authoring"));
      fs.writeFileSync(path.join(s, "workflow-authoring", "SKILL.md"), old);
      fs.writeFileSync(path.join(s, "workflow-authoring", ".DS_Store"), "x");
    });
    expect(fs.existsSync(path.join(skills, "workflow-authoring"))).toBe(false);
  });

  it("a fresh install copies the engine's skill under its new name", () => {
    const skills = runStart();
    expect(fs.readFileSync(path.join(skills, "wf-yaml-authoring", "SKILL.md"), "utf8")).toMatch(
      /^---\nname: wf-yaml-authoring\n/,
    );
  });

  it("start removes the copy an older release made, whose description read differently", () => {
    const old =
      "---\nname: workflow-authoring\ndescription: Reference for creating workflows with exec/fetch action states\n---\nold\n";
    const skills = runStart(s => {
      fs.mkdirSync(path.join(s, "workflow-authoring"));
      fs.writeFileSync(path.join(s, "workflow-authoring", "SKILL.md"), old);
    });
    expect(fs.existsSync(path.join(skills, "workflow-authoring"))).toBe(false);
  });

  it("start keeps a directory of that name holding more than the engine's SKILL.md", () => {
    const skills = runStart(s => {
      fs.mkdirSync(path.join(s, "workflow-authoring"));
      fs.writeFileSync(
        path.join(s, "workflow-authoring", "SKILL.md"),
        "---\nname: workflow-authoring\ndescription: Reference for authoring workflow YAML — mine now\n---\n",
      );
      fs.writeFileSync(path.join(s, "workflow-authoring", "notes.md"), "mine\n");
    });
    expect(fs.existsSync(path.join(skills, "workflow-authoring", "notes.md"))).toBe(true);
  });

  it("start keeps a user's own skill of that name", () => {
    const own = "---\nname: workflow-authoring\ndescription: my own notes\n---\nmine\n";
    const skills = runStart(s => {
      fs.mkdirSync(path.join(s, "workflow-authoring"));
      fs.writeFileSync(path.join(s, "workflow-authoring", "SKILL.md"), own);
    });
    expect(fs.readFileSync(path.join(skills, "workflow-authoring", "SKILL.md"), "utf8")).toBe(own);
  });
});
