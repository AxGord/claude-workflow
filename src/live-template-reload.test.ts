import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { Loader } from "./loader.js";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { InMemoryStorage } from "./test-helpers.js";
import { registerTools } from "./tools.js";

// A running server reads bundled templates from the live checkout. A land that edits a template
// (here: a top-level key this server's schema does not know) must not take `batch` and its heirs away.
describe("live template reload under a running server", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  const BATCH = {
    name: "batch",
    description: "bundled batch",
    initial: "plan",
    states: {
      plan: { prompt: "Plan", transitions: { go: "work" } },
      work: { prompt: "Work", transitions: { finish: "done" } },
      done: { terminal: true, prompt: "Done", outcome: "complete" },
    },
  };

  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-live-reload-"));
    roots.push(root);
    const bundled = path.join(root, "bundled");
    const globalDir = path.join(root, "global");
    const project = path.join(root, "project");
    fs.mkdirSync(bundled);
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    fs.mkdirSync(path.join(project, ".claude", "workflows"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(bundled, "batch.yaml"), YAML.stringify(BATCH));
    fs.writeFileSync(
      path.join(project, ".claude", "workflows", "slice-dispatch.yaml"),
      YAML.stringify({ name: "slice-dispatch", extends: "batch" }),
    );
    // the server's own loader has no project tier: the project is reached through its cwd
    const loader = new Loader(bundled, globalDir, null);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, loader, new Executor());
    const newerTemplate = () =>
      fs.writeFileSync(
        path.join(bundled, "batch.yaml"),
        YAML.stringify({
          ...BATCH,
          dispatcher_from_a_newer_server: { model: "haiku" },
        }),
      );
    return {
      loader,
      engine,
      project,
      globalDir,
      newerTemplate,
      bundled,
      storage,
    };
  }

  it("a new session of an heir of `batch` still starts after the template gained a key", async () => {
    const { engine, project, newerTemplate } = setup();
    const root = await engine.start("slice-dispatch", undefined, undefined, project);
    expect(root.currentWorkflow).toBe("slice-dispatch");

    newerTemplate();

    const child = await engine.start("slice-dispatch", undefined, root.sessionId, project);
    expect(child.currentWorkflow).toBe("slice-dispatch");
  });

  it("the catalogue keeps `batch` after a reload that meets a template it cannot read", () => {
    const { loader, newerTemplate } = setup();
    expect(loader.names()).toContain("batch");

    newerTemplate();
    loader.reload(); // what the directory watcher / a trust change does

    expect(loader.names()).toContain("batch");
  });

  it("a session another process started (no snapshot here) keeps moving after the template gained a key", async () => {
    const { engine, loader, project, bundled, storage, newerTemplate } = setup();
    const root = await engine.start("slice-dispatch", undefined, undefined, project);
    // a second server on the same state directory: it never snapshotted this session
    const other = new Engine(storage, loader, new Executor());
    newerTemplate();

    await expect(other.transition(root.sessionId, "go")).resolves.toMatchObject({
      currentStateName: "work",
    });
    expect(fs.readFileSync(path.join(bundled, "batch.yaml"), "utf-8")).toContain("newer_server");
  });

  it("a bundled template that stops loading keeps serving its last good copy, listed as broken with the restart reason", () => {
    const { loader, newerTemplate } = setup();
    newerTemplate();
    loader.reload();

    expect(loader.get("batch")?.states.plan).toBeDefined();
    const [broken] = loader.broken();
    expect(broken).toMatchObject({ name: "batch", stale: true });
    expect(broken.reason).toContain('unknown key "dispatcher_from_a_newer_server"');
    expect(broken.reason).toContain("this server is older than the template");
    expect(broken.reason).toContain("restart");
  });

  it("a template that never loaded: the heir's start names the file and the reason, not `not found`", async () => {
    const { project, bundled, newerTemplate } = setup();
    newerTemplate();
    const loader = new Loader(bundled, path.join(project, "..", "global2"), null);
    const engine = new Engine(new InMemoryStorage(), loader, new Executor());

    const err = await engine.start("slice-dispatch", undefined, undefined, project).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(err).toMatch(/^Workflow "slice-dispatch" failed to load: /);
    expect(err).toContain(path.join(bundled, "batch.yaml"));
    expect(err).toContain("this server is older than the template");
    expect(err).not.toContain("not found");
  });

  it("`list` shows a file that failed to load as broken with the loader's reason", async () => {
    const { loader, engine, newerTemplate } = setup();
    newerTemplate();
    loader.reload();
    const handlers = new Map<string, (a: object) => Promise<{ content: { text: string }[] }>>();
    registerTools(
      {
        registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h),
      } as never,
      engine,
      {} as never,
      loader,
      {} as never,
    );

    const text = (await handlers.get("list")!({})).content[0].text;
    expect(text).toContain("BROKEN (did not load):");
    expect(text).toContain("batch.yaml");
    expect(text).toContain("restart");
  });

  it("a bundled file that passes the schema but fails to merge or validate keeps its last good copy", () => {
    const { loader, bundled } = setup();
    fs.writeFileSync(
      path.join(bundled, "batch.yaml"),
      YAML.stringify({ ...BATCH, initial: "nope" }),
    );
    loader.reload();

    expect(loader.names()).toContain("batch");
    expect(loader.get("batch")?.initial).toBe("plan");
    expect(loader.broken()).toMatchObject([{ name: "batch", stale: true }]);
    expect(loader.broken()[0].reason).toContain('initial state "nope"');
  });

  it("a refused bundled parent and a bundled heir changed in the same reload: the heir keeps its previous copy and starts", async () => {
    const { loader, engine, bundled } = setup();
    const heir = (go: string) =>
      YAML.stringify({
        name: "child",
        extends: "batch",
        states: { plan: { prompt: "Plan", transitions: { go } } },
      });
    fs.writeFileSync(path.join(bundled, "child.yaml"), heir("work"));
    loader.reload();
    expect(loader.get("child")?.states.plan.transitions?.go).toBe("work");

    // the moved checkout: the parent gains a state and a key this server does not know, the heir routes to the new state
    fs.writeFileSync(
      path.join(bundled, "batch.yaml"),
      YAML.stringify({
        ...BATCH,
        states: { ...BATCH.states, extra: { prompt: "Extra", transitions: { back: "plan" } } },
        a_key_from_a_newer_server: true,
      }),
    );
    fs.writeFileSync(path.join(bundled, "child.yaml"), heir("extra"));
    loader.reload();

    expect(loader.get("child")?.states.plan.transitions?.go).toBe("work");
    expect(loader.get("batch")?.states.extra).toBeUndefined();
    expect(loader.broken().every(b => b.stale)).toBe(true);
    const started = await engine.start("child");
    expect(started.currentWorkflow).toBe("child");
  });

  it("a call on a session whose workflow failed to load answers `failed to load: <file>: <reason>`", async () => {
    const { engine, loader, project, storage } = setup();
    const root = await engine.start("slice-dispatch", undefined, undefined, project);
    const heirFile = path.join(project, ".claude", "workflows", "slice-dispatch.yaml");
    fs.writeFileSync(
      heirFile,
      YAML.stringify({ name: "slice-dispatch", extends: "batch", initial: "nope" }),
    );
    // a server that never snapshotted this session reads the project's files afresh
    const other = new Engine(storage, loader, new Executor());

    const err = await other.transition(root.sessionId, "go").then(
      () => "",
      (e: Error) => e.message,
    );
    expect(err).toContain('Workflow "slice-dispatch" failed to load: ');
    expect(err).toContain(heirFile);
    expect(err).toContain('initial state "nope"');
    expect(err).not.toContain("not found");
  });

  it("the main and the project loader report the same failure once", () => {
    const { project, bundled, newerTemplate } = setup();
    newerTemplate();
    const loader = new Loader(bundled, path.join(project, "..", "global3"), null);
    const engine = new Engine(new InMemoryStorage(), loader, new Executor());

    const note = engine.brokenNote("batch", project);
    expect(note.split("\n")).toHaveLength(1);
  });
});
