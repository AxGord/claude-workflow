// A project is trusted when Claude Code's own folder-trust answer says so (read from its user config,
// never written); `wf-trust <project>` is the fallback for a folder Claude Code has no record for;
// strict mode keeps the per-file sha256. Every case runs on a scratch config dir and home.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { ClaudeFolderTrust, folderTrustKeys } from "./claude-trust.js";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { TrustStore, strictFromEnv } from "./trust.js";
import { runTrust, type TrustIO } from "./trust-run.js";
import { InMemoryStorage, cleanupDir } from "./test-helpers.js";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-claude-trust-")));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const execFlow = (marker: string) => ({
  initial: "run",
  states: {
    run: { type: "exec", command: `touch ${marker}`, on_success: "done", on_error: "done" },
    done: { terminal: true, outcome: "complete" },
  },
});

/** A scratch world: a home, a Claude Code config dir, and a state dir; `config(projects)` writes the user config. */
function world() {
  const root = tmp();
  const home = path.join(root, "home");
  const configDir = path.join(root, "claude-config");
  fs.mkdirSync(home);
  fs.mkdirSync(configDir);
  const env = { CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;
  const claude = new ClaudeFolderTrust(env, home);
  return {
    root,
    home,
    configDir,
    env,
    claude,
    /** The config file as Claude Code writes it: `projects[dir] = { hasTrustDialogAccepted }` and unrelated keys. */
    config: (projects: unknown) =>
      fs.writeFileSync(
        path.join(configDir, ".claude.json"),
        JSON.stringify({ numStartups: 3, projects }),
      ),
    store: (opts: { strict?: boolean } = {}) =>
      new TrustStore(path.join(root, "state", "trusted-workflows.json"), { ...opts, claude }),
  };
}

/** `<dir>/.claude/workflows/<name>.yaml` per workflow; returns the workflows dir. */
function projectWith(dir: string, wfs: Record<string, object>): string {
  const wd = path.join(dir, ".claude", "workflows");
  fs.mkdirSync(wd, { recursive: true });
  for (const [name, def] of Object.entries(wfs))
    fs.writeFileSync(path.join(wd, `${name}.yaml`), YAML.stringify({ name, ...def }));
  return wd;
}

const loaderOf = (w: ReturnType<typeof world>, wd: string, strict = false) =>
  new Loader(null, path.join(w.root, "global"), wd, w.store({ strict }));

/** A linked worktree as git writes one: `.git` file -> `<main>/.git/worktrees/<name>`, which points back (`gitdir`) and at the common dir (`commondir`). `forged`: the back-pointer is missing. */
function linkWorktree(main: string, wt: string, forged = false): string {
  const gitdir = path.join(main, ".git", "worktrees", path.basename(wt));
  fs.mkdirSync(gitdir, { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gitdir}\n`);
  fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  if (!forged) fs.writeFileSync(path.join(gitdir, "gitdir"), `${path.join(wt, ".git")}\n`);
  return gitdir;
}

function terminal(answer: string): TrustIO & { lines: string[] } {
  const lines: string[] = [];
  return { interactive: true, lines, out: l => lines.push(l), ask: () => Promise.resolve(answer) };
}

const trusted = (dir: string) => ({ [dir]: { hasTrustDialogAccepted: true } });

describe("Claude Code's folder trust gates a project's exec states", () => {
  it("a trusted folder loads and runs its exec states, and an edited file still loads", async () => {
    const w = world();
    const proj = path.join(w.root, "proj");
    const marker = path.join(w.root, "ran");
    const wd = projectWith(proj, { deploy: execFlow(marker) });
    w.config(trusted(proj));
    const loader = loaderOf(w, wd);
    expect(loader.get("deploy")).toBeDefined();
    expect(loader.untrusted()).toEqual([]);
    await new Engine(new InMemoryStorage(), loader, new Executor()).start("deploy");
    expect(fs.existsSync(marker)).toBe(true);

    const file = path.join(wd, "deploy.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8") + "\n# edited\n");
    loader.reload();
    expect(loader.get("deploy")).toBeDefined();
  });

  it.each([
    ["the flag is false", { "<P>": { hasTrustDialogAccepted: false } }],
    ["the folder has no entry", { "/somewhere/else": { hasTrustDialogAccepted: true } }],
    ["the entry has no flag (a renamed flag)", { "<P>": { trustAccepted: true } }],
    ["the flag is not a boolean true", { "<P>": { hasTrustDialogAccepted: "true" } }],
    ["projects is not an object", ["<P>"]],
    ["there is no projects key", null],
  ])(
    "%s: left out, with one sentence naming the project and both ways to fix it",
    (_n, projects) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const w = world();
      const proj = path.join(w.root, "proj");
      const wd = projectWith(proj, { deploy: execFlow("/never") });
      w.config(projects && JSON.parse(JSON.stringify(projects).replaceAll("<P>", proj)));
      const loader = loaderOf(w, wd);
      expect(loader.get("deploy")).toBeUndefined();
      const note = loader.untrustedNote();
      expect(note).toContain(proj);
      expect(note).toContain("no Claude Code folder trust is recorded");
      expect(note).toContain("accept its trust question");
      expect(note).toContain(`wf-trust ${proj}`);
    },
  );

  it("a missing, an unreadable and a malformed config all fail closed", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = world();
    const proj = path.join(w.root, "proj");
    const wd = projectWith(proj, { deploy: execFlow("/never") });
    expect(loaderOf(w, wd).get("deploy")).toBeUndefined(); // no file
    const file = path.join(w.configDir, ".claude.json");
    fs.writeFileSync(file, "{ not json");
    expect(loaderOf(w, wd).get("deploy")).toBeUndefined();
    fs.rmSync(file);
    fs.mkdirSync(file); // a directory where the file should be: unreadable
    expect(loaderOf(w, wd).get("deploy")).toBeUndefined();
  });

  it("a project file with prompt states only needs no trust", () => {
    const w = world();
    const wd = projectWith(path.join(w.root, "proj"), {
      plain: {
        initial: "a",
        states: { a: { prompt: "P", transitions: { go: "z" } }, z: { terminal: true } },
      },
    });
    expect(loaderOf(w, wd).get("plain")).toBeDefined();
  });

  it("the config is read from CLAUDE_CONFIG_DIR, else from the home directory", () => {
    const w = world();
    const proj = path.join(w.root, "proj");
    w.config(trusted(proj));
    expect(w.claude.file).toBe(path.join(w.configDir, ".claude.json"));
    expect(w.claude.trusted(proj)).toBe(true);
    const atHome = new ClaudeFolderTrust({}, w.home);
    expect(atHome.file).toBe(path.join(w.home, ".claude.json"));
    expect(atHome.trusted(proj)).toBe(false);
    fs.writeFileSync(
      path.join(w.home, ".claude.json"),
      JSON.stringify({ projects: trusted(proj) }),
    );
    expect(atHome.trusted(proj)).toBe(true);
    expect(new ClaudeFolderTrust({ CLAUDE_CONFIG_DIR: "" }, w.home).file).toBe(atHome.file);
  });

  it("CLAUDE_CODE_IGNORE_PERSISTED_TRUST makes no record count", () => {
    const w = world();
    const proj = path.join(w.root, "proj");
    w.config(trusted(proj));
    expect(
      new ClaudeFolderTrust({ ...w.env, CLAUDE_CODE_IGNORE_PERSISTED_TRUST: "1" }, w.home).trusted(
        proj,
      ),
    ).toBe(false);
    expect(
      new ClaudeFolderTrust({ ...w.env, CLAUDE_CODE_IGNORE_PERSISTED_TRUST: "0" }, w.home).trusted(
        proj,
      ),
    ).toBe(true);
  });

  it("an answer given in Claude Code after the load takes effect on the next read; an unrelated config rewrite reloads nothing", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = world();
    const proj = path.join(w.root, "proj");
    const wd = projectWith(proj, { deploy: execFlow("/never") });
    w.config({});
    const loader = loaderOf(w, wd);
    expect(loader.get("deploy")).toBeUndefined();
    const before = loader.untrusted();
    w.config({ "/elsewhere": { hasTrustDialogAccepted: true } });
    expect(loader.untrusted()).toBe(before);
    w.config(trusted(proj));
    expect(loader.get("deploy")).toBeDefined();
    expect(loader.untrusted()).toEqual([]);
  });
});

describe("how Claude Code keys the folder-trust answer", () => {
  it("a trusted parent directory covers its children outside a repository", () => {
    const w = world();
    const parent = path.join(w.root, "work");
    const child = path.join(parent, "a", "b");
    const wd = projectWith(child, { deploy: execFlow("/never") });
    w.config(trusted(parent));
    expect(loaderOf(w, wd).get("deploy")).toBeDefined();
  });

  it("inside a repository the repo root's answer covers a subdirectory, and an ancestor above the repo does not", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = world();
    const outer = path.join(w.root, "outer");
    const repo = path.join(outer, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const wd = projectWith(path.join(repo, "pkg"), { deploy: execFlow("/never") });
    w.config(trusted(outer));
    expect(loaderOf(w, wd).get("deploy")).toBeUndefined();
    w.config(trusted(repo));
    expect(loaderOf(w, wd).get("deploy")).toBeDefined();
  });

  it("a linked worktree is the main checkout's entry alone", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = world();
    const main = path.join(w.root, "main");
    const wt = path.join(w.root, "wt");
    linkWorktree(main, wt);
    const wd = projectWith(wt, { deploy: execFlow("/never") });
    expect(folderTrustKeys(wt, w.home)).toEqual([main]);
    w.config(trusted(wt)); // the worktree's own entry says nothing
    expect(loaderOf(w, wd).get("deploy")).toBeUndefined();
    w.config(trusted(main));
    expect(loaderOf(w, wd).get("deploy")).toBeDefined();
  });

  it("a session whose cwd is a worktree resolves to the main checkout's project and its trust", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = world();
    const main = path.join(w.root, "main");
    const wt = path.join(w.root, "wt");
    linkWorktree(main, wt);
    const marker = path.join(w.root, "ran");
    projectWith(main, { deploy: execFlow(marker) });
    const server = new Loader(null, path.join(w.root, "global"), null, w.store());
    const engine = new Engine(new InMemoryStorage(), server, new Executor());
    w.config({});
    await expect(engine.start("deploy", undefined, undefined, wt)).rejects.toThrow(
      /not found.*trusted/s,
    );
    expect(fs.existsSync(marker)).toBe(false);
    w.config(trusted(main));
    await engine.start("deploy", undefined, undefined, wt);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("a forged worktree pointer is its own root: it is not trusted through the project it names", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = world();
    const main = path.join(w.root, "main");
    fs.mkdirSync(path.join(main, ".git"), { recursive: true });
    w.config(trusted(main));
    const marker = path.join(w.root, "ran");
    // a cloned repo whose .git file names the trusted project's .git as its worktree gitdir
    const clone = path.join(w.root, "clone");
    linkWorktree(main, clone, true);
    expect(folderTrustKeys(clone, w.home)).toEqual([clone]);
    const wd = projectWith(clone, { deploy: execFlow(marker) });
    expect(loaderOf(w, wd).get("deploy")).toBeUndefined();
    // a back-pointer naming another worktree, a missing commondir, a gitdir outside <common>/worktrees, an unreadable file
    const other = path.join(w.root, "other");
    const gitdir = linkWorktree(main, other);
    fs.writeFileSync(path.join(gitdir, "gitdir"), `${path.join(clone, ".git")}\n`);
    expect(folderTrustKeys(other, w.home)).toEqual([other]);
    fs.writeFileSync(path.join(gitdir, "gitdir"), `${path.join(other, ".git")}\n`);
    expect(folderTrustKeys(other, w.home)).toEqual([main]);
    fs.rmSync(path.join(gitdir, "commondir"));
    expect(folderTrustKeys(other, w.home)).toEqual([other]);
    const flat = path.join(w.root, "flat");
    fs.mkdirSync(flat);
    // every pointer valid, but the gitdir is not a direct child of <common>/worktrees
    const elsewhere = path.join(main, ".git", "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "commondir"), "..\n");
    fs.writeFileSync(path.join(elsewhere, "gitdir"), `${path.join(flat, ".git")}\n`);
    fs.writeFileSync(path.join(flat, ".git"), `gitdir: ${path.join(main, ".git", "elsewhere")}\n`);
    expect(folderTrustKeys(flat, w.home)).toEqual([flat]);
    const broken = path.join(w.root, "broken");
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, ".git"), "garbage");
    expect(folderTrustKeys(broken, w.home)).toEqual([broken]);
    // wf-trust approvals follow the same rule
    const store = w.store();
    store.addProject(main);
    expect(store.projectTrust(clone)).toBeUndefined();
  });

  it("a symlinked .git does not pass for a worktree's own: the folder is its own root and its exec file is left out", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = world();
    const main = path.join(w.root, "main");
    const wt = path.join(w.root, "wt");
    fs.mkdirSync(path.join(main, ".git"), { recursive: true });
    linkWorktree(main, wt);
    w.config(trusted(main));
    const sneaky = path.join(w.root, "sneaky");
    fs.mkdirSync(sneaky);
    fs.symlinkSync(path.join(wt, ".git"), path.join(sneaky, ".git"));
    expect(folderTrustKeys(wt, w.home)).toEqual([main]);
    expect(folderTrustKeys(sneaky, w.home)).toEqual([sneaky]);
    const wd = projectWith(sneaky, { deploy: execFlow("/never") });
    expect(loaderOf(w, wd).get("deploy")).toBeUndefined();
  });

  it("the home directory's answer never covers a project below it, and a project at home has no key", () => {
    const w = world();
    const proj = path.join(w.home, "proj");
    fs.mkdirSync(proj);
    w.config(trusted(w.home));
    expect(w.claude.trusted(proj)).toBe(false);
    expect(w.claude.trusted(w.home)).toBe(false);
    expect(folderTrustKeys(proj, w.home)).toEqual([proj]);
    expect(folderTrustKeys(w.home, w.home)).toEqual([]);
  });
});

describe("wf-trust is the fallback when Claude Code has no record", () => {
  it("one typed yes trusts the project directory: its files load, an edit still loads, --list shows it, --revoke withdraws it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = world();
    const proj = path.join(w.root, "proj");
    const wd = projectWith(proj, { deploy: execFlow("/never") });
    w.config({});
    const store = w.store();
    const loader = new Loader(null, path.join(w.root, "global"), wd, store);
    expect(loader.get("deploy")).toBeUndefined();

    const io = terminal("yes");
    expect(await runTrust([proj], store, io)).toBe(0);
    expect(io.lines.join("\n")).toContain("/never");
    expect(store.list()).toEqual([]); // no per-file hash: the project is the unit
    expect(store.listProjects().map(p => p.dir)).toEqual([proj]);
    expect(loader.get("deploy")).toBeDefined();

    const file = path.join(wd, "deploy.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8") + "\n# edited\n");
    loader.reload();
    expect(loader.get("deploy")).toBeDefined();
    expect(await runTrust([proj], store, terminal(""))).toBe(0); // nothing left to approve

    const listed = terminal("");
    await runTrust(["--list"], store, listed);
    expect(listed.lines.join("\n")).toContain(proj);
    expect(await runTrust(["--revoke", proj], store, terminal(""))).toBe(0);
    expect(loader.get("deploy")).toBeUndefined();
  });

  it("the project's .claude/workflows directory names the project", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = world();
    const proj = path.join(w.root, "proj");
    const wd = projectWith(proj, { deploy: execFlow("/never") });
    const store = w.store();
    expect(await runTrust([wd], store, terminal("yes"))).toBe(0);
    expect(store.listProjects().map(p => p.dir)).toEqual([proj]);
  });

  it("wf-trust in a linked worktree names the main checkout it records and says it covers its worktrees", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = world();
    const main = path.join(w.root, "main");
    const wt = path.join(w.root, "wt");
    linkWorktree(main, wt);
    projectWith(wt, { deploy: execFlow("/never") });
    const store = w.store();
    const asked: string[] = [];
    const io: TrustIO & { lines: string[] } = {
      ...terminal("yes"),
      ask: q => {
        asked.push(q);
        return Promise.resolve("yes");
      },
    };
    expect(await runTrust([wt], store, io)).toBe(0);
    expect(store.listProjects().map(p => p.dir)).toEqual([main]);
    for (const text of [asked[0], io.lines.at(-1) ?? ""]) {
      expect(text).toContain(main);
      expect(text).toContain("main checkout");
      expect(text).toContain("covers its worktrees");
    }
  });

  it("wf-trust on a symlinked plain project names the directory, with no main-checkout wording", async () => {
    const w = world();
    const real = path.join(w.root, "real");
    projectWith(real, { deploy: execFlow("/never") });
    const link = path.join(w.root, "link");
    fs.symlinkSync(real, link);
    const asked: string[] = [];
    const io: TrustIO & { lines: string[] } = {
      ...terminal("yes"),
      ask: q => {
        asked.push(q);
        return Promise.resolve("yes");
      },
    };
    expect(await runTrust([link], w.store(), io)).toBe(0);
    for (const text of [asked[0], io.lines.at(-1) ?? ""]) {
      expect(text).toContain(real);
      expect(text).not.toContain("main checkout");
    }
  });

  it("no terminal, or anything but a typed yes, trusts nothing", async () => {
    const w = world();
    const proj = path.join(w.root, "proj");
    projectWith(proj, { deploy: execFlow("/never") });
    const store = w.store();
    expect(await runTrust([proj], store, { ...terminal("yes"), interactive: false })).toBe(3);
    for (const answer of ["", "y", "no"])
      expect(await runTrust([proj], store, terminal(answer))).toBe(3);
    expect(store.listProjects()).toEqual([]);
  });

  it("a single file target approves that file's exact content only", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = world();
    const proj = path.join(w.root, "proj");
    const wd = projectWith(proj, { deploy: execFlow("/never"), other: execFlow("/never2") });
    const store = w.store();
    expect(await runTrust([path.join(wd, "deploy.yaml")], store, terminal("yes"))).toBe(0);
    expect(store.listProjects()).toEqual([]);
    const loader = new Loader(null, path.join(w.root, "global"), wd, store);
    expect(loader.get("deploy")).toBeDefined();
    expect(loader.get("other")).toBeUndefined();
  });

  it("a folder Claude Code trusts has nothing for wf-trust to do", async () => {
    const w = world();
    const proj = path.join(w.root, "proj");
    projectWith(proj, { deploy: execFlow("/never") });
    w.config(trusted(proj));
    const io = terminal("");
    expect(await runTrust([proj], w.store(), io)).toBe(0);
    expect(io.lines.join("\n")).toContain("trusted in Claude Code");
  });

  it("a config that renamed the flag falls back to wf-trust and never trusts on its own", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = world();
    const proj = path.join(w.root, "proj");
    const wd = projectWith(proj, { deploy: execFlow("/never") });
    w.config({ [proj]: { workspaceTrusted: true } });
    const store = w.store();
    const loader = new Loader(null, path.join(w.root, "global"), wd, store);
    expect(loader.get("deploy")).toBeUndefined();
    await runTrust([proj], store, terminal("yes"));
    expect(loader.get("deploy")).toBeDefined();
  });
});

describe("strict mode keeps the per-file hash", () => {
  it("a trusted folder and a project approval do not load a file; its approved hash does, until it is edited", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = world();
    const proj = path.join(w.root, "proj");
    const wd = projectWith(proj, { deploy: execFlow("/never") });
    w.config(trusted(proj));
    const store = w.store({ strict: true });
    store.addProject(proj);
    const loader = new Loader(null, path.join(w.root, "global"), wd, store);
    expect(loader.get("deploy")).toBeUndefined();
    expect(loader.untrustedNote()).toContain("WF_TRUST_STRICT");

    // wf-trust on the project records the hash in strict mode
    expect(await runTrust([proj], store, terminal("yes"))).toBe(0);
    expect(store.list()).toHaveLength(1);
    expect(loader.get("deploy")).toBeDefined();
    const file = path.join(wd, "deploy.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8") + "\n# edited\n");
    loader.reload();
    expect(loader.get("deploy")).toBeUndefined();
  });

  it("the env switch: WF_TRUST_STRICT on, off, unset", () => {
    expect(strictFromEnv({ WF_TRUST_STRICT: "1" })).toBe(true);
    expect(strictFromEnv({ WF_TRUST_STRICT: "true" })).toBe(true);
    for (const v of [undefined, "", "0", "false", "FALSE"])
      expect(strictFromEnv({ WF_TRUST_STRICT: v })).toBe(false);
  });

  it("the production store reads both from the env", () => {
    const w = world();
    const proj = path.join(w.root, "proj");
    w.config(trusted(proj));
    const state = path.join(w.root, "state");
    expect(TrustStore.inStateDir(state, w.env).allows(proj, "x")).toBe(true);
    expect(TrustStore.inStateDir(state, { ...w.env, WF_TRUST_STRICT: "1" }).allows(proj, "x")).toBe(
      false,
    );
    expect(TrustStore.inStateDir(state, {}).strict).toBe(false);
  });
});
