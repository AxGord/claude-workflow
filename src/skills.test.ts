import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Storage } from "./storage.js";
import { secondRootRefusal } from "./session-scope.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_LINK,
  MANIFEST_FILE,
  addSkills,
  editedNote,
  hashTree,
  loadHistory,
  planRemove,
  planSkills,
  readManifest,
  removeSkills,
  shippedSkills,
  stackSkillNames,
  syncSkills,
  treeDigest,
  updateSkill,
  type SkillsContext,
} from "./skills.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Files = Record<string, string>;

describe("bundled skills: manifest, update, adoption, removal", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-skills-"));
    dirs.push(d);
    return d;
  };

  function put(dir: string, files: Files): void {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
  }

  /** A scratch plugin root shipping `skills` (name → files) as `version` (and `stack`: the pack), and a scratch HOME's skills and state dirs. */
  function setup(
    skills: Record<string, Files>,
    version = "1.0.0",
    stack: Record<string, Files> = {},
  ) {
    const base = tmp();
    const ctx: SkillsContext = {
      root: path.join(base, "plugin"),
      skillsDir: path.join(base, "home", ".claude", "skills"),
      stateDir: path.join(base, "state"),
      version,
    };
    let pack = stack;
    const ship = (
      all: Record<string, Files>,
      v?: string,
      nextStack?: Record<string, Files>,
    ): SkillsContext => {
      pack = nextStack ?? pack;
      for (const [set, skillsOf] of [
        ["skills", all],
        ["skills-stack", pack],
      ] as const) {
        fs.rmSync(path.join(ctx.root, "templates", set), { recursive: true, force: true });
        fs.mkdirSync(path.join(ctx.root, "templates", set), { recursive: true });
        for (const [name, files] of Object.entries(skillsOf))
          put(path.join(ctx.root, "templates", set, name), files);
      }
      return { ...ctx, version: v ?? ctx.version };
    };
    /** Record a version of a skill as shipped once (the history table). */
    const remember = (name: string, files: Files): void => {
      const scratch = path.join(base, "scratch", name);
      fs.rmSync(scratch, { recursive: true, force: true });
      put(scratch, files);
      fs.appendFileSync(
        path.join(ctx.root, "templates", "skills-history.txt"),
        `${treeDigest(hashTree(scratch))} ${name}\n`,
      );
    };
    ship(skills);
    return { ctx, ship, remember, base };
  }

  const read = (ctx: SkillsContext, name: string, rel = "SKILL.md"): string =>
    fs.readFileSync(path.join(ctx.skillsDir, name, rel), "utf8");
  const has = (ctx: SkillsContext, name: string): boolean =>
    fs.existsSync(path.join(ctx.skillsDir, name));

  const V1 = {
    a: { "SKILL.md": "a v1\n", "references/x.md": "x v1\n" },
    b: { "SKILL.md": "b v1\n" },
  };

  it("a fresh install copies every skill and records each file's sha256 and the shipping version", () => {
    const { ctx } = setup(V1, "1.2.3");
    syncSkills(ctx);
    expect(read(ctx, "a", "references/x.md")).toBe("x v1\n");
    const m = readManifest(ctx.stateDir)!;
    expect(Object.keys(m.skills).sort()).toEqual(["a", "b"]);
    expect(m.skills.a.engine).toBe("1.2.3");
    expect(m.skills.a.files).toEqual(hashTree(path.join(ctx.skillsDir, "a")));
    expect(m.skills.a.files["references/x.md"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an unedited copy is replaced by the version now shipped, a file the new version drops goes, the manifest follows", () => {
    const { ctx, ship } = setup(V1, "1.0.0");
    syncSkills(ctx);
    const next = ship({ a: { "SKILL.md": "a v2\n" }, b: V1.b }, "1.1.0");
    const r = syncSkills(next)!;
    expect(r.updated).toEqual(["a"]);
    expect(read(ctx, "a")).toBe("a v2\n");
    expect(has(ctx, "a") && fs.existsSync(path.join(ctx.skillsDir, "a", "references"))).toBe(false);
    const m = readManifest(ctx.stateDir)!;
    expect(m.skills.a.engine).toBe("1.1.0");
    expect(m.skills.a.files).toEqual(hashTree(path.join(ctx.skillsDir, "a")));
    expect(m.skills.b.engine).toBe("1.0.0");
  });

  it("an edited copy is left alone and named once per shipped version, with the commands to see and take it", () => {
    const { ctx, ship } = setup(V1);
    syncSkills(ctx);
    fs.writeFileSync(path.join(ctx.skillsDir, "a", "SKILL.md"), "mine\n");
    const v2 = ship({ a: { "SKILL.md": "a v2\n" }, b: V1.b }, "1.1.0");
    const first = syncSkills(v2)!;
    expect(read(ctx, "a")).toBe("mine\n");
    expect(first.named).toEqual(["a"]);
    expect(first.updated).toEqual([]);
    expect(syncSkills(v2)!.named).toEqual([]);
    const note = editedNote(first.named, "/p/scripts/wf-skills");
    expect(note).toContain("a");
    expect(note).toContain("/p/scripts/wf-skills diff a");
    expect(note).toContain("/p/scripts/wf-skills update a");
    // a later release that ships yet another version names it again
    const v3 = ship({ a: { "SKILL.md": "a v3\n" }, b: V1.b }, "1.2.0");
    expect(syncSkills(v3)!.named).toEqual(["a"]);
    expect(read(ctx, "a")).toBe("mine\n");
  });

  it("an edited copy that still equals nothing shipped is not named when the release ships nothing new for it", () => {
    const { ctx } = setup(V1);
    syncSkills(ctx);
    fs.writeFileSync(path.join(ctx.skillsDir, "a", "extra.md"), "notes\n");
    // the copy differs from the shipped files, so a first sync names it; the second is silent
    expect(syncSkills(ctx)!.named).toEqual(["a"]);
    expect(syncSkills(ctx)!.named).toEqual([]);
  });

  it("a skill the user deleted stays deleted, is recorded, and wf-skills update brings it back", () => {
    const { ctx } = setup(V1);
    syncSkills(ctx);
    fs.rmSync(path.join(ctx.skillsDir, "b"), { recursive: true });
    const r = syncSkills(ctx)!;
    expect(r.deleted).toEqual(["b"]);
    expect(has(ctx, "b")).toBe(false);
    expect(readManifest(ctx.stateDir)!.deleted).toEqual(["b"]);
    syncSkills(ctx);
    expect(has(ctx, "b")).toBe(false);
    expect(updateSkill(ctx, "b")).toBeNull();
    expect(read(ctx, "b")).toBe("b v1\n");
    expect(readManifest(ctx.stateDir)!.deleted).toEqual([]);
  });

  describe("the stack pack", () => {
    const STACK = { "lang-x": { "SKILL.md": "x v1\n" }, "domain-y": { "SKILL.md": "y v1\n" } };

    it("a fresh start copies the default set only: a stack skill is available, recorded nowhere, offered by list", () => {
      const { ctx } = setup(V1, "1.0.0", STACK);
      const r = syncSkills(ctx)!;
      expect(r.installed).toEqual(["a", "b"]);
      expect(fs.readdirSync(ctx.skillsDir).sort()).toEqual(["a", "b"]);
      expect(Object.keys(readManifest(ctx.stateDir)!.skills).sort()).toEqual(["a", "b"]);
      const rows = planSkills(ctx, readManifest(ctx.stateDir));
      expect(rows.filter(r => r.pack).map(r => `${r.name}:${r.state}`)).toEqual([
        "domain-y:available",
        "lang-x:available",
      ]);
      expect(syncSkills(ctx)!.installed).toEqual([]);
      expect(has(ctx, "lang-x")).toBe(false);
    });

    it("add installs a stack skill, the manifest knows it, and it is then updated and removed like a default skill", () => {
      const { ctx, ship } = setup(V1, "1.0.0", STACK);
      syncSkills(ctx);
      expect(addSkills(ctx, ["lang-x"])).toEqual({ installed: ["lang-x"], present: [] });
      expect(read(ctx, "lang-x")).toBe("x v1\n");
      const m = readManifest(ctx.stateDir)!;
      expect(m.skills["lang-x"].files).toEqual(hashTree(path.join(ctx.skillsDir, "lang-x")));
      expect(has(ctx, "domain-y")).toBe(false);
      const next = ship(V1, "1.1.0", { ...STACK, "lang-x": { "SKILL.md": "x v2\n" } });
      expect(syncSkills(next)!.updated).toEqual(["lang-x"]);
      expect(read(ctx, "lang-x")).toBe("x v2\n");
      expect(planRemove(next).remove).toContain("lang-x");
      removeSkills(next);
      expect(fs.readdirSync(ctx.skillsDir)).toEqual([]);
    });

    it("add --all-stack installs every stack skill and no default one; a skill already there is reported, not rewritten", () => {
      const { ctx } = setup(V1, "1.0.0", STACK);
      put(path.join(ctx.skillsDir, "lang-x"), { "SKILL.md": "mine\n" });
      const r = addSkills(ctx, [], true);
      expect(r).toEqual({ installed: ["domain-y"], present: ["lang-x"] });
      expect(read(ctx, "lang-x")).toBe("mine\n");
      expect(has(ctx, "a")).toBe(false);
      expect([...stackSkillNames(ctx.root)].sort()).toEqual(["domain-y", "lang-x"]);
    });

    it("add refuses a name nothing ships, and installs nothing then", () => {
      const { ctx } = setup(V1, "1.0.0", STACK);
      expect(() => addSkills(ctx, ["lang-x", "nope"])).toThrow(/no bundled skill named nope/);
      expect(has(ctx, "lang-x")).toBe(false);
    });

    it("an existing install keeps its stack skills: an unedited one is adopted and updated, an edited one stays", () => {
      // what a user of the release before the split has: every skill copied, the stack ones among them
      const { ctx, ship, remember } = setup({
        ...V1,
        "lang-x": STACK["lang-x"],
        "domain-y": STACK["domain-y"],
      });
      syncSkills(ctx);
      fs.writeFileSync(path.join(ctx.skillsDir, "domain-y", "SKILL.md"), "mine\n");
      remember("lang-x", STACK["lang-x"]);
      // the release now ships them in the pack, lang-x with new text
      const next = ship(V1, "1.1.0", {
        "lang-x": { "SKILL.md": "x v2\n" },
        "domain-y": STACK["domain-y"],
      });
      const r = syncSkills(next)!;
      expect(r.updated).toEqual(["lang-x"]);
      expect(r.deleted).toEqual([]);
      expect(read(ctx, "lang-x")).toBe("x v2\n");
      expect(read(ctx, "domain-y")).toBe("mine\n");
      expect(Object.keys(readManifest(ctx.stateDir)!.skills).sort()).toEqual([
        "a",
        "b",
        "domain-y",
        "lang-x",
      ]);
    });

    it("a copy that predates the manifest and equals a shipped version is adopted as a stack skill, a missing one stays available", () => {
      const { ctx } = setup(V1, "1.0.0", STACK);
      put(path.join(ctx.skillsDir, "lang-x"), STACK["lang-x"]);
      const r = syncSkills(ctx)!;
      expect(r.adopted).toEqual(["lang-x"]);
      expect(has(ctx, "domain-y")).toBe(false);
      expect(readManifest(ctx.stateDir)!.deleted).toEqual([]);
    });

    it("a stack skill the user deleted is `deleted`, not `available`: it is not offered again, and add brings it back", () => {
      const { ctx } = setup(V1, "1.0.0", STACK);
      syncSkills(ctx);
      addSkills(ctx, ["lang-x"]);
      fs.rmSync(path.join(ctx.skillsDir, "lang-x"), { recursive: true });
      expect(syncSkills(ctx)!.deleted).toEqual(["lang-x"]);
      const state = (n: string) =>
        planSkills(ctx, readManifest(ctx.stateDir)).find(r => r.name === n)?.state;
      expect(state("lang-x")).toBe("deleted");
      expect(state("domain-y")).toBe("available");
      syncSkills(ctx);
      expect(has(ctx, "lang-x")).toBe(false);
      addSkills(ctx, ["lang-x"]);
      expect(has(ctx, "lang-x")).toBe(true);
      expect(readManifest(ctx.stateDir)!.deleted).toEqual([]);
    });

    it("a sync leaves a link to the plugin's wf-skills beside the manifest", () => {
      const { ctx } = setup(V1, "1.0.0", STACK);
      syncSkills(ctx);
      expect(fs.readlinkSync(path.join(ctx.stateDir, CLI_LINK))).toBe(
        path.join(ctx.root, "scripts", "wf-skills"),
      );
      syncSkills(ctx);
      expect(fs.lstatSync(path.join(ctx.stateDir, CLI_LINK)).isSymbolicLink()).toBe(true);
    });
  });

  describe("adoption of copies made before the manifest", () => {
    it("a copy equal to a version the repo shipped is unedited and updated; an unknown one is edited and kept", () => {
      const { ctx, ship, remember } = setup({
        a: { "SKILL.md": "a old\n" },
        b: { "SKILL.md": "b old\n" },
      });
      remember("a", { "SKILL.md": "a old\n" });
      remember("b", { "SKILL.md": "b old\n" });
      put(path.join(ctx.skillsDir, "a"), { "SKILL.md": "a old\n" });
      put(path.join(ctx.skillsDir, "b"), { "SKILL.md": "b my own words\n" });
      const next = ship({ a: { "SKILL.md": "a new\n" }, b: { "SKILL.md": "b new\n" } }, "1.1.0");
      const r = syncSkills(next)!;
      expect(read(ctx, "a")).toBe("a new\n");
      expect(r.updated).toEqual(["a"]);
      expect(read(ctx, "b")).toBe("b my own words\n");
      expect(r.named).toEqual(["b"]);
      expect(readManifest(ctx.stateDir)!.skills.a.engine).toBe("1.1.0");
      expect(readManifest(ctx.stateDir)!.skills.b).toBeUndefined();
    });

    it("a copy equal to what is shipped now is adopted without a write; a missing skill is copied", () => {
      const { ctx } = setup(V1);
      put(path.join(ctx.skillsDir, "a"), V1.a);
      const before = fs.statSync(path.join(ctx.skillsDir, "a", "SKILL.md")).mtimeMs;
      const r = syncSkills(ctx)!;
      expect(r.adopted).toEqual(["a"]);
      expect(r.installed).toEqual(["b"]);
      expect(fs.statSync(path.join(ctx.skillsDir, "a", "SKILL.md")).mtimeMs).toBe(before);
      expect(Object.keys(readManifest(ctx.stateDir)!.skills).sort()).toEqual(["a", "b"]);
    });
  });

  it("a root that is not newer than the engine that shipped the copy does not take its update back", () => {
    const { ctx, ship } = setup(V1, "2.0.0");
    syncSkills(ctx);
    // an older plugin root (the install in the plugin cache beside the marketplace one) with another text
    const older = ship({ a: { "SKILL.md": "a older\n" }, b: V1.b }, "1.0.0");
    expect(syncSkills(older)!.updated).toEqual([]);
    expect(read(ctx, "a")).toBe("a v1\n");
    // the same version number with other text, and no history of the installed text: kept too
    const sameVersion = ship({ a: { "SKILL.md": "a same\n" }, b: V1.b }, "2.0.0");
    expect(syncSkills(sameVersion)!.updated).toEqual([]);
    expect(read(ctx, "a")).toBe("a v1\n");
  });

  it("the same version number takes the update when its history lists the installed text", () => {
    const { ctx, ship, remember } = setup(V1, "2.0.0");
    syncSkills(ctx);
    const later = ship({ a: { "SKILL.md": "a later\n" }, b: V1.b }, "2.0.0");
    remember("a", V1.a);
    expect(syncSkills(later)!.updated).toEqual(["a"]);
    expect(read(ctx, "a")).toBe("a later\n");
  });

  it("a skill directory that is a symlink is the user's and is never replaced", () => {
    const { ctx, base } = setup(V1);
    const target = path.join(base, "elsewhere");
    put(target, V1.a);
    fs.mkdirSync(ctx.skillsDir, { recursive: true });
    fs.symlinkSync(target, path.join(ctx.skillsDir, "a"));
    syncSkills(ctx);
    expect(fs.lstatSync(path.join(ctx.skillsDir, "a")).isSymbolicLink()).toBe(true);
  });

  it("a second process holding the lock makes sync do nothing", () => {
    const { ctx } = setup(V1);
    fs.mkdirSync(path.join(ctx.stateDir, "skills.lock"), { recursive: true });
    expect(syncSkills(ctx)).toBeNull();
    expect(has(ctx, "a")).toBe(false);
  });

  it("an interrupted copy's staging directory is swept at the next sync", () => {
    const { ctx } = setup(V1);
    put(path.join(ctx.skillsDir, ".wf-new.a.1"), { "SKILL.md": "half\n" });
    syncSkills(ctx);
    expect(fs.readdirSync(ctx.skillsDir).filter(n => n.startsWith(".wf-"))).toEqual([]);
  });

  it("the manifest is no session: Storage lists nothing after a sync and a parentless start is not refused for it", () => {
    const { ctx } = setup(V1);
    syncSkills(ctx);
    expect(fs.existsSync(path.join(ctx.stateDir, MANIFEST_FILE))).toBe(true);
    const storage = new Storage(ctx.stateDir, { eventLog: false });
    expect(storage.list()).toEqual([]);
    expect(storage.readAll()).toEqual([]);
    expect(secondRootRefusal(storage, process.pid, undefined)).toBeUndefined();
  });

  it("a state dir that cannot be written to makes sync return at once, installing nothing", () => {
    const { ctx } = setup(V1);
    fs.mkdirSync(ctx.stateDir);
    fs.chmodSync(ctx.stateDir, 0o500);
    try {
      const t0 = Date.now();
      expect(syncSkills(ctx)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(has(ctx, "a")).toBe(false);
      expect(() => updateSkill(ctx, "a")).toThrow();
    } finally {
      fs.chmodSync(ctx.stateDir, 0o700);
    }
  });

  it("a copy swapped out and not yet swapped back (a crash between the two renames) is restored, not taken for a deletion", () => {
    const { ctx } = setup(V1);
    syncSkills(ctx);
    fs.renameSync(path.join(ctx.skillsDir, "a"), path.join(ctx.skillsDir, ".wf-old.a.99999"));
    const r = syncSkills(ctx)!;
    expect(r.deleted).toEqual([]);
    expect(read(ctx, "a")).toBe("a v1\n");
    expect(readManifest(ctx.stateDir)!.deleted).toEqual([]);
    expect(fs.readdirSync(ctx.skillsDir).filter(n => n.startsWith(".wf-"))).toEqual([]);
  });

  describe("remove", () => {
    it("removes every unedited engine copy and the manifest, keeps an edited copy and a skill the engine never shipped", () => {
      const { ctx, ship } = setup({ ...V1, c: { "SKILL.md": "c\n" } });
      syncSkills(ctx);
      put(path.join(ctx.skillsDir, "mine"), { "SKILL.md": "not the engine's\n" });
      fs.writeFileSync(path.join(ctx.skillsDir, "c", "SKILL.md"), "edited c\n");
      // a: unedited but older than what is shipped now; b: current
      const next = ship({ ...V1, a: { "SKILL.md": "a v2\n" }, c: { "SKILL.md": "c\n" } }, "1.1.0");
      expect(planRemove(next)).toEqual({ remove: ["a", "b"], keep: ["c"], scratch: [] });
      removeSkills(next);
      expect(fs.readdirSync(ctx.skillsDir).sort()).toEqual(["c", "mine"]);
      expect(read(ctx, "c")).toBe("edited c\n");
      expect(fs.existsSync(path.join(ctx.stateDir, MANIFEST_FILE))).toBe(false);
    });

    it("an unedited copy left under .wf-old by an interrupted swap is restored and removed too", () => {
      const { ctx } = setup(V1);
      syncSkills(ctx);
      fs.renameSync(path.join(ctx.skillsDir, "a"), path.join(ctx.skillsDir, ".wf-old.a.99999"));
      removeSkills(ctx);
      expect(fs.readdirSync(ctx.skillsDir)).toEqual([]);
    });

    it("a copy that predates the manifest and equals a shipped version is removed too", () => {
      const { ctx, remember } = setup({ a: { "SKILL.md": "a new\n" } });
      remember("a", { "SKILL.md": "a old\n" });
      put(path.join(ctx.skillsDir, "a"), { "SKILL.md": "a old\n" });
      removeSkills(ctx);
      expect(has(ctx, "a")).toBe(false);
    });
  });

  it("planSkills reads without writing: no manifest, no skills dir change", () => {
    const { ctx } = setup(V1);
    put(path.join(ctx.skillsDir, "a"), V1.a);
    const rows = planSkills(ctx, null);
    expect(rows.map(r => `${r.name}:${r.state}`)).toEqual(["a:current", "b:missing"]);
    expect(fs.existsSync(ctx.stateDir)).toBe(false);
    expect(has(ctx, "b")).toBe(false);
  });
});

describe("the real bundled sets", () => {
  const DEFAULT = [
    "architecture",
    "browser-verify",
    "ci-github-actions",
    "claude-code-config",
    "cleanup",
    "coding-skill-selector",
    "debug-bridge-scaffold",
    "debugging",
    "knowledge-placement",
    "mcp-setup",
    "preferences",
    "skill-manager",
    "task-delegation",
    "web-reading",
    "wf-yaml-authoring",
  ];

  it("a fresh start on a scratch HOME copies exactly the 15 universal skills, and the stack pack is the other 15", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wf-skills-real-"));
    try {
      const ctx: SkillsContext = {
        root: REPO,
        skillsDir: path.join(base, "skills"),
        stateDir: path.join(base, "state"),
        version: "9.9.9",
      };
      syncSkills(ctx);
      expect(fs.readdirSync(ctx.skillsDir).sort()).toEqual(DEFAULT);
      const stack = [...stackSkillNames(REPO)].sort();
      expect(stack).toHaveLength(15);
      expect(stack.filter(n => DEFAULT.includes(n))).toEqual([]);
      expect(
        planSkills(ctx, readManifest(ctx.stateDir)).filter(r => r.state === "available"),
      ).toHaveLength(15);
      expect(shippedSkills(REPO).size).toBe(30);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("the history table of shipped versions", () => {
  it("holds the version of every bundled skill this tree ships (run `npm run skills:history` after editing templates/skills)", () => {
    const history = loadHistory(REPO);
    const missing = [...shippedSkills(REPO)]
      .filter(([name, files]) => history.get(name)?.has(treeDigest(files)) !== true)
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it("is ordered by digest, so two branches adding a line do not conflict", () => {
    const lines = fs
      .readFileSync(path.join(REPO, "templates", "skills-history.txt"), "utf8")
      .split("\n")
      .filter(l => /^[0-9a-f]{64} /.test(l));
    expect(lines).toEqual([...lines].sort());
    expect(lines.length).toBeGreaterThan(29);
  });
});

describe("the hook and wf-skills on a scratch HOME, built as installed", () => {
  const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), "wf-skills-build-"));
  beforeAll(() => {
    const r = spawnSync(
      process.execPath,
      [path.join(REPO, "node_modules/typescript7/bin/tsc"), "--outDir", path.join(BUILD, "build")],
      { cwd: REPO, encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`tsc: ${r.stdout}${r.stderr}`);
    fs.cpSync(path.join(REPO, "scripts"), path.join(BUILD, "scripts"), { recursive: true });
    fs.cpSync(path.join(REPO, "hooks"), path.join(BUILD, "hooks"), { recursive: true });
    fs.copyFileSync(path.join(REPO, "package.json"), path.join(BUILD, "package.json"));
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(BUILD, "node_modules"));
  });
  afterAll(() => fs.rmSync(BUILD, { recursive: true, force: true }));

  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A plugin root (the built engine plus the given templates) and a scratch HOME beside it. */
  function install(skills: Record<string, Files>, stack: Record<string, Files> = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wf-skills-hook-"));
    dirs.push(base);
    const root = path.join(base, "plugin");
    fs.cpSync(BUILD, root, { recursive: true, verbatimSymlinks: true });
    for (const [set, of] of [
      ["skills", skills],
      ["skills-stack", stack],
    ] as const) {
      for (const [name, files] of Object.entries(of)) {
        for (const [rel, text] of Object.entries(files)) {
          const f = path.join(root, "templates", set, name, rel);
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, text);
        }
      }
    }
    const home = path.join(base, "home");
    fs.mkdirSync(home);
    const env = {
      ...process.env,
      HOME: home,
      STATE_DIR: path.join(base, "state"),
      WF_POOL_DIR: path.join(base, "pool"),
      CLAUDE_CONFIG_DIR: path.join(base, "config"),
      CLAUDE_PLUGIN_ROOT: root,
      WORKFLOW_DIR: path.join(base, "workflows"),
    };
    delete env.CLAUDE_SKILLS_DIR;
    const hook = (): string => {
      const r = spawnSync("bash", [path.join(root, "hooks", "workflow-start.sh")], {
        input: `${JSON.stringify({ source: "startup", session_id: "c1", cwd: base })}\n`,
        env,
        encoding: "utf8",
      });
      if (r.status !== 0) throw new Error(`hook exited ${r.status}: ${r.stderr}`);
      return r.stdout;
    };
    const cli = (...args: string[]) =>
      spawnSync(path.join(root, "scripts", "wf-skills"), args, { env, encoding: "utf8" });
    return { base, root, home, skills: path.join(home, ".claude", "skills"), env, hook, cli };
  }

  const tree = (dir: string): string[] =>
    fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : [];

  it("the hook provisions the skills, records the manifest, and prints nothing extra on a clean start", () => {
    const t = install({ a: { "SKILL.md": "a\n" } });
    const out = t.hook();
    expect(fs.readFileSync(path.join(t.skills, "a", "SKILL.md"), "utf8")).toBe("a\n");
    expect(fs.existsSync(path.join(t.env.STATE_DIR, MANIFEST_FILE))).toBe(true);
    expect(out).toBe("STOP. Call mcp__plugin_workflow_wf__start (no args) first.\n");
  });

  it("the hook names an edited copy once, at the end of its output, with the command that shows the difference", () => {
    const t = install({ a: { "SKILL.md": "a\n" } });
    t.hook();
    fs.writeFileSync(path.join(t.skills, "a", "SKILL.md"), "mine\n");
    // the release's text changes under the copy
    fs.writeFileSync(path.join(t.root, "templates", "skills", "a", "SKILL.md"), "a, changed\n");
    const first = t.hook();
    expect(first).toContain("STOP. Call mcp__plugin_workflow_wf__start");
    expect(first).toContain(`${path.join(t.root, "scripts", "wf-skills")} diff a`);
    expect(first.indexOf("STOP.")).toBeLessThan(first.indexOf("diff a"));
    expect(t.hook()).not.toContain("diff a");
    expect(fs.readFileSync(path.join(t.skills, "a", "SKILL.md"), "utf8")).toBe("mine\n");
  });

  it("an unwritable state dir does not fail the hook: it still prints its usual line", () => {
    const t = install({ a: { "SKILL.md": "a\n" } });
    fs.mkdirSync(t.env.STATE_DIR);
    fs.chmodSync(t.env.STATE_DIR, 0o500);
    try {
      expect(t.hook()).toBe("STOP. Call mcp__plugin_workflow_wf__start (no args) first.\n");
    } finally {
      fs.chmodSync(t.env.STATE_DIR, 0o700);
    }
  });

  it("the hook and wf-skills use the same skills dir when CLAUDE_SKILLS_DIR is set", () => {
    const t = install({ a: { "SKILL.md": "a\n" } });
    const elsewhere = path.join(t.base, "elsewhere");
    t.env.CLAUDE_SKILLS_DIR = elsewhere;
    t.hook();
    expect(fs.existsSync(path.join(elsewhere, "a", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(t.skills)).toBe(false);
  });

  it("without the build the hook still copies a missing skill, as before", () => {
    const t = install({ a: { "SKILL.md": "a\n" } });
    fs.rmSync(path.join(t.root, "build"), { recursive: true });
    t.hook();
    expect(fs.existsSync(path.join(t.skills, "a", "SKILL.md"))).toBe(true);
  });

  it("a fresh HOME gets exactly the default set from the hook; wf-skills add installs a stack skill, list offers the rest", () => {
    const t = install(
      { a: { "SKILL.md": "a\n" }, b: { "SKILL.md": "b\n" } },
      { "lang-x": { "SKILL.md": "x\n" }, "domain-y": { "SKILL.md": "y\n" } },
    );
    t.hook();
    expect(fs.readdirSync(t.skills).sort()).toEqual(["a", "b"]);
    const states = (): Record<string, string> =>
      Object.fromEntries(
        (JSON.parse(t.cli("list", "--json").stdout) as { name: string; state: string }[]).map(r => [
          r.name,
          r.state,
        ]),
      );
    expect(states()).toMatchObject({ "lang-x": "available", "domain-y": "available" });
    const add = t.cli("add", "lang-x");
    expect(add.status).toBe(0);
    expect(add.stdout).toContain("installed lang-x");
    expect(fs.readFileSync(path.join(t.skills, "lang-x", "SKILL.md"), "utf8")).toBe("x\n");
    expect(fs.existsSync(path.join(t.skills, "domain-y"))).toBe(false);
    expect(Object.keys(readManifest(t.env.STATE_DIR)?.skills ?? {}).sort()).toEqual([
      "a",
      "b",
      "lang-x",
    ]);
    expect(states()).toMatchObject({ "lang-x": "current", "domain-y": "available" });
    t.hook();
    expect(fs.readdirSync(t.skills).sort()).toEqual(["a", "b", "lang-x"]);
    expect(t.cli("add", "nope").status).toBe(2);
    expect(t.cli("add").status).toBe(2);
    expect(t.cli("add", "--all-stack").status).toBe(0);
    expect(fs.readdirSync(t.skills).sort()).toEqual(["a", "b", "domain-y", "lang-x"]);
    // the link the selector tells an agent to run
    const viaLink = spawnSync(path.join(t.env.STATE_DIR, CLI_LINK), ["list", "--json"], {
      env: t.env,
      encoding: "utf8",
    });
    expect(viaLink.status).toBe(0);
  });

  it("the no-node fallback of the hook copies the default set and never the stack pack", () => {
    const t = install({ a: { "SKILL.md": "a\n" } }, { "lang-x": { "SKILL.md": "x\n" } });
    fs.rmSync(path.join(t.root, "build"), { recursive: true });
    t.hook();
    expect(fs.readdirSync(t.skills)).toEqual(["a"]);
  });

  it("in Zed the hook offers ide-zed only while it is available: plain load when installed, silence when the user deleted it", () => {
    const t = install({ a: { "SKILL.md": "a\n" } }, { "ide-zed": { "SKILL.md": "z\n" } });
    t.env.ZED_ENVIRONMENT = "1";
    const offer = `${path.join(t.root, "scripts", "wf-skills")} add ide-zed`;
    const out = t.hook();
    expect(out).toContain(offer);
    expect(fs.existsSync(path.join(t.skills, "ide-zed"))).toBe(false);
    // the offer repeats while it stays available
    expect(t.hook()).toContain(offer);

    expect(t.cli("add", "ide-zed").status).toBe(0);
    const installed = t.hook();
    expect(installed).toContain("Then load skill ide-zed (Skill tool).");
    expect(installed).not.toContain("wf-skills add");

    fs.rmSync(path.join(t.skills, "ide-zed"), { recursive: true });
    const deleted = t.hook();
    expect(deleted).not.toContain("ide-zed");
    expect(deleted).toBe("STOP. Call mcp__plugin_workflow_wf__start (no args) first.\n");
    expect(t.hook()).not.toContain("ide-zed");
  });

  it("wf-skills list, diff and update", () => {
    const t = install({ a: { "SKILL.md": "a\n" }, b: { "SKILL.md": "b\n" } });
    t.hook();
    fs.writeFileSync(path.join(t.skills, "a", "SKILL.md"), "mine\n");
    fs.rmSync(path.join(t.skills, "b"), { recursive: true });
    const list = t.cli("list").stdout;
    expect(list).toMatch(/a +shipped +installed +edited/);
    expect(list).toMatch(/b +shipped +deleted by you/);
    expect(JSON.parse(t.cli("list", "--json").stdout)).toEqual([
      { name: "a", shipped: true, pack: false, installed: true, state: "edited" },
      { name: "b", shipped: true, pack: false, installed: false, state: "deleted" },
    ]);
    const diff = t.cli("diff", "a").stdout;
    expect(diff).toContain("-mine");
    expect(diff).toContain("+a");
    const up = t.cli("update", "a", "b");
    expect(up.status).toBe(0);
    expect(fs.readFileSync(path.join(t.skills, "a", "SKILL.md"), "utf8")).toBe("a\n");
    expect(fs.existsSync(path.join(t.skills, "b"))).toBe(true);
    const saved = fs.readdirSync(path.join(t.env.STATE_DIR, "skill-backups"));
    expect(saved).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(t.env.STATE_DIR, "skill-backups", saved[0], "SKILL.md"), "utf8"),
    ).toBe("mine\n");
    expect(t.cli("diff", "nope").status).toBe(2);
  });

  it("wf-skills remove --dry-run changes nothing, remove leaves no unedited copy, --state removes the state and pool directories", () => {
    const t = install({ a: { "SKILL.md": "a\n" }, b: { "SKILL.md": "b\n" } });
    t.hook();
    fs.writeFileSync(path.join(t.skills, "b", "SKILL.md"), "mine\n");
    fs.mkdirSync(path.join(t.skills, "own"));
    fs.writeFileSync(path.join(t.skills, "own", "SKILL.md"), "own\n");
    fs.mkdirSync(t.env.WORKFLOW_DIR);
    fs.mkdirSync(path.join(t.env.WF_POOL_DIR), { recursive: true });
    fs.writeFileSync(path.join(t.env.WF_POOL_DIR, "pool.json"), "{}");
    const before = [
      tree(t.skills),
      tree(t.env.STATE_DIR),
      tree(t.env.WF_POOL_DIR),
      tree(t.env.WORKFLOW_DIR),
    ];

    const dry = t.cli("remove", "--state", "--dry-run");
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("would remove");
    expect(dry.stdout).toContain(t.env.STATE_DIR);
    expect(dry.stdout).toContain(t.env.WF_POOL_DIR);
    expect(dry.stdout).toContain(`${t.env.WORKFLOW_DIR} (empty)`);
    expect([
      tree(t.skills),
      tree(t.env.STATE_DIR),
      tree(t.env.WF_POOL_DIR),
      tree(t.env.WORKFLOW_DIR),
    ]).toEqual(before);

    const plain = t.cli("remove");
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain(`left in place: ${t.env.STATE_DIR}`);
    expect(fs.readdirSync(t.skills).sort()).toEqual(["b", "own"]);
    expect(fs.readFileSync(path.join(t.skills, "b", "SKILL.md"), "utf8")).toBe("mine\n");
    expect(fs.existsSync(path.join(t.env.STATE_DIR, MANIFEST_FILE))).toBe(false);
    expect(fs.existsSync(t.env.WF_POOL_DIR)).toBe(true);

    const all = t.cli("remove", "--state");
    expect(all.status).toBe(0);
    expect(fs.existsSync(t.env.STATE_DIR)).toBe(false);
    expect(fs.existsSync(t.env.WF_POOL_DIR)).toBe(false);
    expect(fs.existsSync(t.env.WORKFLOW_DIR)).toBe(false);
    expect(fs.readdirSync(t.skills).sort()).toEqual(["b", "own"]);
  });

  it("wf-skills remove --state keeps a workflow directory that holds the user's workflows", () => {
    const t = install({ a: { "SKILL.md": "a\n" } });
    t.hook();
    fs.mkdirSync(t.env.WORKFLOW_DIR);
    fs.writeFileSync(path.join(t.env.WORKFLOW_DIR, "mine.yaml"), "name: mine\n");
    expect(t.cli("remove", "--state").status).toBe(0);
    expect(fs.existsSync(path.join(t.env.WORKFLOW_DIR, "mine.yaml"))).toBe(true);
  });

  it("wf-skills refuses a usage error and a state directory that is the home directory", () => {
    const t = install({ a: { "SKILL.md": "a\n" } });
    t.hook();
    expect(t.cli("frobnicate").status).toBe(2);
    expect(t.cli("remove", "--bogus").status).toBe(2);
    // the scratch HOME stands in for the real one: the child's os.homedir() is this directory
    const r = spawnSync(path.join(t.root, "scripts", "wf-skills"), ["remove", "--state"], {
      env: { ...t.env, STATE_DIR: t.home },
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(fs.existsSync(t.skills)).toBe(true);
  });
});
