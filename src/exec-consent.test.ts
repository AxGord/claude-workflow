import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { Modifier } from "./modifier.js";
import { TrustStore, hashContent } from "./trust.js";
import { runTrust, type TrustIO } from "./trust-run.js";
import {
  InMemoryStorage,
  MULTI_STATE_WORKFLOW,
  cleanupDir,
  createTestLoader,
} from "./test-helpers.js";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wf-consent-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) cleanupDir(d);
});

/** What the exec writes: its marker file shows whether the command ran. */
function touching(marker: string): string {
  return `touch ${marker}`;
}

/** A project's workflows dir with `<name>.yaml` per workflow, a bundled tier and a global one. */
function tiers(opts: {
  bundled?: Record<string, object>;
  project?: Record<string, object>;
  global?: Record<string, object>;
}) {
  const root = tmp();
  const write = (dir: string, wfs: Record<string, object> = {}) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, def] of Object.entries(wfs))
      fs.writeFileSync(path.join(dir, `${name}.yaml`), YAML.stringify({ name, ...def }));
    return dir;
  };
  const bundled = write(path.join(root, "bundled"), opts.bundled);
  const global = write(path.join(root, "global"), opts.global);
  const projectRoot = path.join(root, "proj");
  const project = write(path.join(projectRoot, ".claude", "workflows"), opts.project);
  const store = new TrustStore(path.join(root, "state", "trusted-workflows.json"));
  return { root, bundled, global, project, projectRoot, store };
}

const MARK = () => path.join(tmp(), "ran");
const execFlow = (marker: string) => ({
  initial: "run",
  states: {
    run: {
      type: "exec",
      command: touching(marker),
      on_success: "done",
      on_error: "done",
    },
    done: { terminal: true, outcome: "complete" },
  },
});
const promptFlow = (text: string) => ({
  initial: "a",
  states: { a: { prompt: text, transitions: { go: "z" } }, z: { terminal: true } },
});

function terminal(answer: string, interactive = true): TrustIO & { lines: string[] } {
  const lines: string[] = [];
  return { interactive, lines, out: l => lines.push(l), ask: () => Promise.resolve(answer) };
}

describe("modify and create refuse exec/fetch states", () => {
  it("modify refuses an exec state, leaves no overlay, and nothing runs", async () => {
    const storage = new InMemoryStorage();
    const r = createTestLoader({ multi: MULTI_STATE_WORKFLOW });
    dirs.push(r.dir);
    const engine = new Engine(storage, r.loader, new Executor());
    const modifier = new Modifier(storage, r.loader);
    modifier.setEngine(engine);
    const { sessionId } = await engine.start("multi");
    const marker = MARK();
    await expect(
      modifier.modify(sessionId, {
        add_state: {
          name: "evil",
          type: "exec",
          command: touching(marker),
          on_success: "c",
          on_error: "c",
        },
      }),
    ).rejects.toThrow(/wf-trust/);
    expect(storage.read(sessionId)!.overrides).toEqual({});
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("modify refuses a fetch state too", async () => {
    const storage = new InMemoryStorage();
    const r = createTestLoader({ multi: MULTI_STATE_WORKFLOW });
    dirs.push(r.dir);
    const modifier = new Modifier(storage, r.loader);
    const engine = new Engine(storage, r.loader, new Executor());
    const { sessionId } = await engine.start("multi");
    await expect(
      modifier.modify(sessionId, {
        add_state: {
          name: "f",
          type: "fetch",
          url: "http://127.0.0.1:1/x",
          on_success: "c",
          on_error: "c",
        },
      }),
    ).rejects.toThrow(/exec\/fetch states are not accepted/);
  });

  it("modify still adds a prompt state", async () => {
    const storage = new InMemoryStorage();
    const r = createTestLoader({ multi: MULTI_STATE_WORKFLOW });
    dirs.push(r.dir);
    const modifier = new Modifier(storage, r.loader);
    const engine = new Engine(storage, r.loader, new Executor());
    const { sessionId } = await engine.start("multi");
    await modifier.modify(sessionId, {
      add_state: { name: "extra", prompt: "hi", terminal: true },
    });
    expect(storage.read(sessionId)!.overrides.multi?.add_states?.extra).toBeDefined();
  });

  it("create refuses a definition with an exec state and writes no file", async () => {
    const storage = new InMemoryStorage();
    const r = createTestLoader({ multi: MULTI_STATE_WORKFLOW });
    dirs.push(r.dir);
    const modifier = new Modifier(storage, r.loader);
    await expect(
      modifier.create("evil", {
        initial: "run",
        states: {
          run: { type: "exec", command: "true", on_success: "done", on_error: "done" },
          done: { terminal: true },
        },
      }),
    ).rejects.toThrow(/wf-trust/);
    expect(fs.existsSync(path.join(r.dir, "evil.yaml"))).toBe(false);
  });

  it("an exec state already stored in a session's overlay never runs", async () => {
    const storage = new InMemoryStorage();
    const r = createTestLoader({ multi: MULTI_STATE_WORKFLOW });
    dirs.push(r.dir);
    const engine = new Engine(storage, r.loader, new Executor());
    const { sessionId } = await engine.start("multi");
    const marker = MARK();
    const s = storage.read(sessionId)!;
    await storage.write(sessionId, {
      ...s,
      overrides: {
        multi: {
          add_states: {
            evil: { type: "exec", command: touching(marker), on_success: "c", on_error: "c" },
          },
          add_transitions: [{ from: "a", name: "go_evil", to: "evil" }],
        },
      },
    });
    await expect(engine.transition(sessionId, "go_evil")).rejects.toThrow(/not accepted/);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("a stored overlay cannot change what an existing exec state runs", () => {
  it("a modify_states entry with another command is refused, one that only reroutes is not", async () => {
    const storage = new InMemoryStorage();
    const flow = {
      initial: "a",
      states: {
        a: { prompt: "A", transitions: { go: "run" } },
        run: { type: "exec", command: "true", on_success: "z", on_error: "z" },
        z: { terminal: true },
      },
    };
    const r = createTestLoader({ flow });
    dirs.push(r.dir);
    const engine = new Engine(storage, r.loader, new Executor());
    const marker = MARK();
    const { sessionId } = await engine.start("flow");
    const s = storage.read(sessionId)!;
    await storage.write(sessionId, {
      ...s,
      overrides: { flow: { modify_states: { run: { command: touching(marker) } } } },
    });
    await expect(engine.transition(sessionId, "go")).rejects.toThrow(/not accepted/);
    expect(fs.existsSync(marker)).toBe(false);
    await storage.write(sessionId, {
      ...s,
      overrides: { flow: { modify_states: { run: { on_success: "a" } } } },
    });
    await expect(engine.transition(sessionId, "go")).resolves.toBeDefined();
  });
});

describe("a stored overlay cannot reach a command through fanout", () => {
  it.each([
    ["adds fanout.items_command to an exec state", undefined],
    [
      "changes fanout.items_command of an exec state",
      { items_command: "echo base", threads_each: 1 },
    ],
  ])(
    "a modify_states entry that %s is refused and the command never runs",
    async (_name, baseFanout) => {
      const storage = new InMemoryStorage();
      const flow = {
        initial: "a",
        states: {
          a: { prompt: "A", transitions: { go: "run" } },
          run: {
            type: "exec",
            command: "true",
            ...(baseFanout ? { fanout: baseFanout } : {}),
            on_success: "z",
            on_error: "z",
          },
          z: { terminal: true },
        },
      };
      const r = createTestLoader({ flow });
      dirs.push(r.dir);
      const engine = new Engine(storage, r.loader, new Executor());
      const marker = MARK();
      const { sessionId } = await engine.start("flow");
      const s = storage.read(sessionId)!;
      await storage.write(sessionId, {
        ...s,
        overrides: {
          flow: {
            modify_states: {
              run: { fanout: { items_command: touching(marker), threads_each: 1 } },
            },
          },
        },
      });
      await expect(engine.transition(sessionId, "go")).rejects.toThrow(/not accepted/);
      expect(fs.existsSync(marker)).toBe(false);
    },
  );
});

describe("a project workflow file's exec states need the user's approval", () => {
  it("an untrusted project master over the bundled one is not loaded: the bundled master starts, its exec never runs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const marker = MARK();
    const t = tiers({
      bundled: { master: promptFlow("BUNDLED") },
      project: { master: execFlow(marker) },
    });
    const loader = new Loader(t.bundled, t.global, t.project, t.store);
    const engine = new Engine(new InMemoryStorage(), loader, new Executor());
    const status = await engine.start("master");
    expect(status.currentStateName).toBe("a");
    expect(fs.existsSync(marker)).toBe(false);
    expect(loader.untrusted().map(u => u.name)).toEqual(["master"]);
    expect(engine.untrustedNote("master", undefined)).toContain(`wf-trust ${t.projectRoot}`);
  });

  it("a project-only untrusted workflow is not found, and the error says how the USER approves it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const marker = MARK();
    const t = tiers({ project: { deploy: execFlow(marker) } });
    const loader = new Loader(t.bundled, t.global, t.project, t.store);
    const engine = new Engine(new InMemoryStorage(), loader, new Executor());
    await expect(engine.start("deploy")).rejects.toThrow(/not found.*wf-trust/s);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("a project file with prompt states only loads with no approval", () => {
    const t = tiers({ project: { plain: promptFlow("P") } });
    const loader = new Loader(t.bundled, t.global, t.project, t.store);
    expect(loader.get("plain")).toBeDefined();
    expect(loader.untrusted()).toEqual([]);
  });

  it("bundled and global files with exec states load unchanged", () => {
    const t = tiers({ bundled: { b: execFlow("/x") }, global: { g: execFlow("/y") } });
    const loader = new Loader(t.bundled, t.global, t.project, t.store);
    expect(loader.get("b")).toBeDefined();
    expect(loader.get("g")).toBeDefined();
    expect(loader.untrusted()).toEqual([]);
  });

  it("a describe-only loader (the replay export's graphs) sees an unapproved file, which nothing there runs", () => {
    const t = tiers({ project: { deploy: execFlow("/never") } });
    expect(
      new Loader(t.bundled, t.global, t.project, TrustStore.describeOnly()).get("deploy"),
    ).toBeDefined();
    expect(new Loader(t.bundled, t.global, t.project, t.store).get("deploy")).toBeUndefined();
  });

  it("a fetch state is gated like an exec state", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = tiers({
      project: {
        hook: {
          initial: "f",
          states: {
            f: { type: "fetch", url: "http://127.0.0.1:1/x", on_success: "z", on_error: "z" },
            z: { terminal: true },
          },
        },
      },
    });
    const loader = new Loader(t.bundled, t.global, t.project, t.store);
    expect(loader.get("hook")).toBeUndefined();
    expect(loader.untrusted().map(u => u.name)).toEqual(["hook"]);
  });

  it("the trust round trip: wf-trust shows the command, approves after a typed yes, the running loader picks it up, an edit asks again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const marker = MARK();
    const t = tiers({ project: { deploy: execFlow(marker) } });
    const loader = new Loader(t.bundled, t.global, t.project, t.store);
    expect(loader.get("deploy")).toBeUndefined();

    const io = terminal("yes");
    expect(await runTrust([t.projectRoot], t.store, io)).toBe(0);
    expect(io.lines.join("\n")).toContain(touching(marker));
    // no reload call, no restart: the same loader sees the approval
    expect(loader.get("deploy")).toBeDefined();
    const engine = new Engine(new InMemoryStorage(), loader, new Executor());
    await engine.start("deploy");
    expect(fs.existsSync(marker)).toBe(true);

    // the file changes: the approval no longer covers it
    const file = path.join(t.project, "deploy.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8") + "\n# edited\n");
    loader.reload(); // what the server's directory watcher does on a .yaml change
    expect(loader.get("deploy")).toBeUndefined();
    expect(loader.untrusted()[0].hash).toBe(hashContent(fs.readFileSync(file)));
  });

  it("the approval lines show every command and request a file runs: fanout items_command, cwd, env, fetch headers and body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = tiers({
      project: {
        shards: {
          initial: "run",
          states: {
            run: {
              type: "exec",
              command: "echo SHARD_CMD",
              cwd: "/work/dir",
              env: { TOKEN: "ENV_VALUE" },
              fanout: { items_command: "echo ITEMS_CMD", threads_each: 1 },
              on_success: "hook",
              on_error: "hook",
            },
            hook: {
              type: "fetch",
              url: "http://127.0.0.1:1/x",
              method: "POST",
              headers: { Authorization: "HEADER_VALUE" },
              body: "BODY_VALUE",
              on_success: "z",
              on_error: "z",
            },
            z: { terminal: true },
          },
        },
      },
    });
    const io = terminal("no");
    await runTrust([t.projectRoot], t.store, io);
    const shown = io.lines.join("\n");
    for (const part of [
      "SHARD_CMD",
      "ITEMS_CMD",
      "/work/dir",
      "ENV_VALUE",
      "POST http://127.0.0.1:1/x",
      "HEADER_VALUE",
      "BODY_VALUE",
    ])
      expect(shown).toContain(part);
  });

  it("an approval of identical content also covers a copy of the file elsewhere (a worktree)", async () => {
    const t = tiers({ project: { deploy: execFlow("/never") } });
    expect(await runTrust([t.projectRoot], t.store, terminal("yes"))).toBe(0);
    const copy = tiers({});
    fs.copyFileSync(path.join(t.project, "deploy.yaml"), path.join(copy.project, "deploy.yaml"));
    expect(
      new Loader(copy.bundled, copy.global, copy.project, t.store).get("deploy"),
    ).toBeDefined();
  });

  it("wf-trust without a terminal approves nothing and exits 3", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = tiers({ project: { deploy: execFlow("/never") } });
    const io = terminal("yes", false);
    expect(await runTrust([t.projectRoot], t.store, io)).toBe(3);
    expect(t.store.list()).toEqual([]);
    expect(io.lines.join("\n")).toMatch(/needs a terminal/);
  });

  it("anything but a typed yes approves nothing", async () => {
    const t = tiers({ project: { deploy: execFlow("/never") } });
    for (const answer of ["", "y", "no", "YES please"]) {
      expect(await runTrust([t.projectRoot], t.store, terminal(answer))).toBe(3);
    }
    expect(t.store.list()).toEqual([]);
  });

  it("wf-trust --list and --revoke", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = tiers({ project: { deploy: execFlow("/never") } });
    const loader = new Loader(t.bundled, t.global, t.project, t.store);
    await runTrust([t.projectRoot], t.store, terminal("yes"));
    expect(loader.get("deploy")).toBeDefined();
    const listed = terminal("");
    await runTrust(["--list"], t.store, listed);
    const hash = t.store.list()[0].hash;
    expect(listed.lines.join("\n")).toContain(hash.slice(0, 12));
    expect(await runTrust(["--revoke", hash.slice(0, 8)], t.store, terminal(""))).toBe(0);
    expect(loader.get("deploy")).toBeUndefined();
  });

  it("a restarted engine on a file edited after its approval does not resume into the edited exec", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const marker = MARK();
    const flow = {
      initial: "a",
      states: {
        a: { prompt: "A", transitions: { go: "run" } },
        run: { type: "exec", command: "true", on_success: "z", on_error: "z" },
        z: { terminal: true },
      },
    };
    const t = tiers({ project: { deploy: flow } });
    await runTrust([t.projectRoot], t.store, terminal("yes"));
    const storage = new InMemoryStorage();
    const first = new Engine(
      storage,
      new Loader(t.bundled, t.global, t.project, t.store),
      new Executor(),
    );
    const { sessionId } = await first.start("deploy");
    const file = path.join(t.project, "deploy.yaml");
    fs.writeFileSync(
      file,
      YAML.stringify({
        name: "deploy",
        ...flow,
        states: { ...flow.states, run: { ...flow.states.run, command: touching(marker) } },
      }),
    );
    // a new server process reads the edited, unapproved file
    const second = new Engine(
      storage,
      new Loader(t.bundled, t.global, t.project, t.store),
      new Executor(),
    );
    await expect(second.transition(sessionId, "go")).rejects.toThrow();
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("the docs do not tell users to auto-allow modify/create/delete", () => {
  it("the recommended allowlist names none of them, and says why", () => {
    const doc = fs.readFileSync(new URL("../docs/getting-started.md", import.meta.url), "utf8");
    const block = /"allow": \[([^\]]*)\]/s.exec(doc)?.[1] ?? "";
    expect(block).toContain("wf__start");
    for (const tool of ["modify", "create", "delete"]) expect(block).not.toContain(`wf__${tool}`);
    expect(doc).toContain("wf-trust");
  });
});
