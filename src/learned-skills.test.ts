import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  MANIFEST_FILE,
  learnedSkillStub,
  learnedSkills,
  planRemove,
  planSkills,
  readManifest,
  removeSkills,
  shippedSkills,
  splitSkill,
  syncSkills,
  type SkillsContext,
} from "./skills.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flat = (p: string): string =>
  fs.readFileSync(path.join(REPO, p), "utf8").replace(/\s+/g, " ");

const SHIPPED =
  "---\nname: a\ndescription: A skill\n---\n\n# A\n\n- one\n- two\n\n## Tail\n\nend\n";

describe("learned-<name>: lessons live beside a bundled skill, not inside it", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function setup(files: Record<string, string> = { "SKILL.md": SHIPPED }) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wf-learned-"));
    dirs.push(base);
    const ctx: SkillsContext = {
      root: path.join(base, "plugin"),
      skillsDir: path.join(base, "home", ".claude", "skills"),
      stateDir: path.join(base, "state"),
      version: "1.0.0",
    };
    const ship = (next: Record<string, string>, version = ctx.version): SkillsContext => {
      fs.rmSync(path.join(ctx.root, "templates", "skills", "a"), { recursive: true, force: true });
      for (const [rel, text] of Object.entries(next)) {
        const f = path.join(ctx.root, "templates", "skills", "a", rel);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, text);
      }
      return { ...ctx, version };
    };
    ship(files);
    const mine = path.join(ctx.skillsDir, "a");
    const learned = path.join(ctx.skillsDir, "learned-a");
    const read = (d: string, rel = "SKILL.md"): string =>
      fs.readFileSync(path.join(d, rel), "utf8");
    return { ctx, ship, mine, learned, read };
  }

  it("ENRICH writes the sibling and leaves the shipped copy unedited: the manifest still updates it, and never lists the sibling", () => {
    const t = setup();
    syncSkills(t.ctx);
    // what skill-manager's ENRICH prescribes: a stub, then a section
    fs.mkdirSync(t.learned);
    fs.writeFileSync(
      path.join(t.learned, "SKILL.md"),
      `${learnedSkillStub("a")}\n## A gotcha\n\nmine\n`,
    );
    expect(planSkills(t.ctx, readManifest(t.ctx.stateDir)).map(r => [r.name, r.state])).toEqual([
      ["a", "current"],
    ]);
    const next = t.ship({ "SKILL.md": `${SHIPPED}\nnew line\n` }, "1.1.0");
    const r = syncSkills(next);
    expect(r?.updated).toEqual(["a"]);
    expect(t.read(t.mine)).toBe(`${SHIPPED}\nnew line\n`);
    expect(t.read(t.learned)).toContain("## A gotcha");
    expect(Object.keys(readManifest(t.ctx.stateDir)?.skills ?? {})).toEqual(["a"]);
    expect(learnedSkills(t.ctx)).toEqual(["learned-a"]);
  });

  it("remove keeps every learned-* skill, even one a manifest wrongly records", () => {
    const t = setup();
    syncSkills(t.ctx);
    fs.mkdirSync(t.learned);
    fs.writeFileSync(path.join(t.learned, "SKILL.md"), learnedSkillStub("a"));
    const manifest = readManifest(t.ctx.stateDir)!;
    fs.writeFileSync(
      path.join(t.ctx.stateDir, MANIFEST_FILE),
      JSON.stringify({
        ...manifest,
        skills: { ...manifest.skills, "learned-a": manifest.skills.a },
      }),
    );
    expect(planRemove(t.ctx)).toEqual({ remove: ["a"], keep: [], scratch: [] });
    removeSkills(t.ctx);
    expect(fs.readdirSync(t.ctx.skillsDir)).toEqual(["learned-a"]);
  });

  it("a release never ships a learned-* skill: a template of that name is not a bundled skill", () => {
    const t = setup();
    const f = path.join(t.ctx.root, "templates", "skills", "learned-x", "SKILL.md");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "x\n");
    expect([...shippedSkills(t.ctx.root).keys()]).toEqual(["a"]);
    syncSkills(t.ctx);
    expect(fs.existsSync(path.join(t.ctx.skillsDir, "learned-x"))).toBe(false);
  });

  describe("split", () => {
    it("moves the added section and the added file into learned-<name>, restores the shipped text, and the copy updates again", () => {
      const t = setup();
      syncSkills(t.ctx);
      fs.writeFileSync(
        path.join(t.mine, "SKILL.md"),
        SHIPPED.replace("- two\n", "- two\n- my bullet\n") + "\n## My lesson\n\nread first\n",
      );
      fs.mkdirSync(path.join(t.mine, "references"));
      fs.writeFileSync(path.join(t.mine, "references", "x.md"), "extra\n");
      expect(planSkills(t.ctx, readManifest(t.ctx.stateDir)).find(r => r.name === "a")?.state).toBe(
        "edited",
      );

      const r = splitSkill(t.ctx, "a");
      expect(r.sections).toBe(2);
      expect(r.files).toEqual(["references/x.md"]);
      expect(r.backup).not.toBeNull();
      expect(t.read(t.mine)).toBe(SHIPPED);
      expect(fs.existsSync(path.join(t.mine, "references"))).toBe(false);
      const l = t.read(t.learned);
      expect(l).toContain("name: learned-a");
      expect(l).toContain("- my bullet");
      expect(l).toContain('after "- two"');
      expect(l).toContain("## My lesson\n\nread first");
      expect(t.read(t.learned, "references/x.md")).toBe("extra\n");
      expect(
        planSkills(t.ctx, readManifest(t.ctx.stateDir)).find(r2 => r2.name === "a")?.state,
      ).toBe("current");
      const next = t.ship({ "SKILL.md": `${SHIPPED}more\n` }, "1.1.0");
      expect(syncSkills(next)?.updated).toEqual(["a"]);
    });

    it("a second split appends to the learned skill it already made", () => {
      const t = setup();
      syncSkills(t.ctx);
      fs.writeFileSync(path.join(t.mine, "SKILL.md"), `${SHIPPED}\n## First\n\none\n`);
      splitSkill(t.ctx, "a");
      fs.writeFileSync(path.join(t.mine, "SKILL.md"), `${SHIPPED}\n## Second\n\ntwo\n`);
      splitSkill(t.ctx, "a");
      const l = t.read(t.learned);
      expect(l.indexOf("## First")).toBeLessThan(l.indexOf("## Second"));
      expect(l.match(/name: learned-a/g)).toHaveLength(1);
    });

    it("a run that died after the learned write is finished by the next one: the block is not appended twice", () => {
      const t = setup();
      syncSkills(t.ctx);
      const edited = `${SHIPPED}\n## My lesson\n\nread first\n`;
      fs.writeFileSync(path.join(t.mine, "SKILL.md"), edited);
      splitSkill(t.ctx, "a");
      // the crash: learned already holds the block, the copy is still the edited one
      fs.writeFileSync(path.join(t.mine, "SKILL.md"), edited);
      const r = splitSkill(t.ctx, "a");
      expect(r.sections).toBe(0);
      expect(t.read(t.learned).match(/read first/g)).toHaveLength(1);
      expect(t.read(t.mine)).toBe(SHIPPED);
    });

    it("a skills lock held by another process makes split refuse before it writes anything", () => {
      const t = setup();
      syncSkills(t.ctx);
      fs.writeFileSync(path.join(t.mine, "SKILL.md"), `${SHIPPED}\n## Mine\n\nx\n`);
      fs.mkdirSync(path.join(t.ctx.stateDir, "skills.lock"));
      expect(() => splitSkill(t.ctx, "a")).toThrow(/another process/);
      expect(fs.existsSync(t.learned)).toBe(false);
      expect(t.read(t.mine)).toContain("## Mine");
    }, 30_000);

    it("an added file moves byte for byte, a non-UTF-8 one included", () => {
      const t = setup();
      syncSkills(t.ctx);
      const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]);
      fs.mkdirSync(path.join(t.mine, "assets"));
      fs.writeFileSync(path.join(t.mine, "assets", "x.bin"), bytes);
      splitSkill(t.ctx, "a");
      expect(fs.readFileSync(path.join(t.learned, "assets", "x.bin")).equals(bytes)).toBe(true);
    });

    const refuses = (label: string, edit: (mine: string) => void, reason: RegExp): void => {
      it(`refuses ${label}, writing nothing`, () => {
        const t = setup();
        syncSkills(t.ctx);
        edit(t.mine);
        const before = fs.readFileSync(path.join(t.mine, "SKILL.md"), "utf8");
        expect(() => splitSkill(t.ctx, "a")).toThrow(reason);
        expect(fs.existsSync(t.learned)).toBe(false);
        expect(fs.readFileSync(path.join(t.mine, "SKILL.md"), "utf8")).toBe(before);
      });
    };
    refuses(
      "a copy with a rewritten line",
      m => fs.writeFileSync(path.join(m, "SKILL.md"), SHIPPED.replace("- one", "- uno")),
      /lines changed or removed/,
    );
    refuses(
      "a copy with a removed line",
      m => fs.writeFileSync(path.join(m, "SKILL.md"), SHIPPED.replace("- two\n", "") + "\nadded\n"),
      /lines changed or removed/,
    );
    refuses(
      "a line added to the frontmatter",
      m =>
        fs.writeFileSync(
          path.join(m, "SKILL.md"),
          SHIPPED.replace("description: A skill\n", "description: A skill\nextra: 1\n"),
        ),
      /frontmatter/,
    );
    it("refuses an unedited copy, a copy that is a link and a skill that is not bundled", () => {
      const t = setup();
      syncSkills(t.ctx);
      expect(() => splitSkill(t.ctx, "a")).toThrow(/not edited \(current\)/);
      expect(() => splitSkill(t.ctx, "nope")).toThrow(/no bundled skill/);
      fs.rmSync(t.mine, { recursive: true });
      fs.mkdirSync(path.join(t.ctx.skillsDir, "elsewhere"));
      fs.symlinkSync(path.join(t.ctx.skillsDir, "elsewhere"), t.mine);
      expect(() => splitSkill(t.ctx, "a")).toThrow(/is a link/);
    });
    it("refuses a copy that lost a shipped file", () => {
      const t = setup({ "SKILL.md": SHIPPED, "references/r.md": "r\n" });
      syncSkills(t.ctx);
      fs.rmSync(path.join(t.mine, "references", "r.md"));
      expect(() => splitSkill(t.ctx, "a")).toThrow(/references\/r.md was deleted/);
    });
  });
});

describe("wf-skills list and split, built as installed", () => {
  const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), "wf-learned-build-"));
  beforeAll(() => {
    const r = spawnSync(
      process.execPath,
      [path.join(REPO, "node_modules/typescript7/bin/tsc"), "--outDir", path.join(BUILD, "build")],
      { cwd: REPO, encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`tsc: ${r.stdout}${r.stderr}`);
    fs.cpSync(path.join(REPO, "scripts"), path.join(BUILD, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(REPO, "package.json"), path.join(BUILD, "package.json"));
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(BUILD, "node_modules"));
    fs.mkdirSync(path.join(BUILD, "templates", "skills", "a"), { recursive: true });
    fs.writeFileSync(path.join(BUILD, "templates", "skills", "a", "SKILL.md"), SHIPPED);
  });
  afterAll(() => fs.rmSync(BUILD, { recursive: true, force: true }));

  it("list names the learned skills under their own heading; split moves an addition and says where it went", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wf-learned-cli-"));
    try {
      const env = {
        ...process.env,
        HOME: path.join(base, "home"),
        STATE_DIR: path.join(base, "state"),
        WF_POOL_DIR: path.join(base, "pool"),
        CLAUDE_CONFIG_DIR: path.join(base, "config"),
        WORKFLOW_DIR: path.join(base, "workflows"),
      };
      delete (env as Record<string, string | undefined>).CLAUDE_SKILLS_DIR;
      const cli = (...args: string[]) =>
        spawnSync(path.join(BUILD, "scripts", "wf-skills"), args, { env, encoding: "utf8" });
      expect(cli("sync", "--quiet").status).toBe(0);
      const skills = path.join(base, "home", ".claude", "skills");
      fs.appendFileSync(path.join(skills, "a", "SKILL.md"), "\n## Mine\n\nlesson\n");
      const split = cli("split", "a");
      expect(split.status).toBe(0);
      expect(split.stdout).toContain(`to ${path.join(skills, "learned-a")}`);
      expect(split.stdout).toContain("your edited copy was saved to");
      const list = cli("list");
      expect(list.stdout).toContain(
        "learned (yours: never shipped, updated or removed):\n  learned-a",
      );
      expect(list.stdout).toContain("1 skill(s)");
      const again = cli("split", "a");
      expect(again.status).toBe(2);
      expect(again.stderr).toContain("not edited");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("learned skills: what the reflection flow, the skill text and the docs say", () => {
  it("reflection ENRICH of a bundled skill goes to learned-<name>, never into the shipped copy", () => {
    const y = flat("templates/reflection.yaml");
    expect(y).toContain("a lesson for a bundled skill goes to `learned-<name>`");
    expect(y).toContain("never into the shipped copy");
    const s = flat("templates/skills/skill-manager/SKILL.md");
    expect(s).toContain("~/.claude/skills/learned-<name>/SKILL.md");
    expect(s).toContain("NEVER into the shipped copy");
    expect(s).toContain("One file per bundled skill");
    expect(s).toContain("A CREATE of a wholly new skill is unchanged");
  });

  it("the gate is untouched: the sibling loads by its description, no `?learned-` entry is added", () => {
    const doc = flat("docs/concepts.md");
    expect(doc).toContain("Claude Code loads the sibling by its description");
    expect(doc).toContain("`wf-skills split <name>`");
    expect(doc).toContain("Promotion into the bundle is the maintainer's act");
    for (const f of fs.readdirSync(path.join(REPO, "templates")).filter(n => n.endsWith(".yaml"))) {
      const wf = parse(fs.readFileSync(path.join(REPO, "templates", f), "utf8")) as {
        states?: Record<string, { skills?: string[] }>;
      };
      for (const st of Object.values(wf.states ?? {})) {
        for (const sk of st.skills ?? []) expect(sk).not.toContain("learned-");
      }
    }
  });
});
