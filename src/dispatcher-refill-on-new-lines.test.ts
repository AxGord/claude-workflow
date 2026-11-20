import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, cleanupDir } from "./test-helpers.js";
import { registerTools } from "./tools.js";

// ENG-DISPATCHER-REFILL-ON-NEW-LINES: a batch session at `collect` with free slots and lines added
// after the last pick has no way to admit them short of a land's `slot_free`.

const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const task = (id: string, status: string, touches: string): string =>
  `  - {id: ${id}, status: ${status}, touches: [${touches}], repo: REPO, workflow: batch-task, difficulty: 3}\n`;

function mount() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-refill-")));
  dirs.push(dir);
  const storage = new InMemoryStorage();
  const engine = new Engine(storage, new Loader(TEMPLATES, dir, null), new Executor());
  const handlers = new Map<
    string,
    (a: object) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
  >();
  registerTools(
    {
      registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h),
    } as never,
    engine,
    {} as never,
    new Loader(TEMPLATES, dir, null),
    storage,
  );
  const call = async (name: string, args: object) => {
    const r = await handlers.get(name)!(args);
    return { isError: r.isError, text: r.content[0].text };
  };
  return { dir, call };
}

describe("a batch session at collect with free slots refills on new lines", () => {
  it("lines added at collect are admitted by `refill`, without a land", async () => {
    const { dir, call } = mount();
    const queue = path.join(dir, "q.yaml");
    const body = (tasks: string) =>
      `batch_size: 3\noverlap: files\ntasks:\n${tasks}`.replaceAll("REPO", dir);
    fs.writeFileSync(queue, body(task("RUN", "running", "r.ts")));
    const s = await call("start", { workflow: "batch", cwd: dir, reply: "id" });
    const id = /SESSION: (\w+)/.exec(s.text)![1];
    await call("context_set", {
      session_id: id,
      key: "queue_file",
      value: queue,
    });
    await call("transition", { session_id: id, transition: "continue" });
    await call("transition", { session_id: id, transition: "ready" }); // plan_queue -> pick
    const st = await call("status", { session_id: id });
    expect(st.text).toContain("collect"); // pick admitted nothing (RUN fills what is pending)

    // two admissible lines arrive while two slots are free
    fs.writeFileSync(
      queue,
      body(
        task("RUN", "running", "r.ts") +
          task("A", "pending", "a.ts") +
          task("B", "pending", "b.ts"),
      ),
    );
    const r = await call("transition", {
      session_id: id,
      transition: "refill",
    });
    expect(r.isError).toBeUndefined();
    const after = await call("status", { session_id: id });
    expect(after.text).toContain("dispatch");
    expect(fs.readFileSync(queue, "utf8")).toMatch(
      /id: A[^\n]*status: running|status: running[^\n]*id: A/,
    );
  });

  it("refill with no admissible line admits nothing and stays at collect", async () => {
    const { dir, call } = mount();
    const queue = path.join(dir, "q.yaml");
    const text =
      `batch_size: 3\noverlap: files\ntasks:\n${task("RUN", "running", "r.ts")}`.replaceAll(
        "REPO",
        dir,
      );
    fs.writeFileSync(queue, text);
    const s = await call("start", { workflow: "batch", cwd: dir, reply: "id" });
    const id = /SESSION: (\w+)/.exec(s.text)![1];
    await call("context_set", {
      session_id: id,
      key: "queue_file",
      value: queue,
    });
    await call("transition", { session_id: id, transition: "continue" });
    await call("transition", { session_id: id, transition: "ready" });
    const r = await call("transition", {
      session_id: id,
      transition: "refill",
    });
    expect(r.isError).toBeUndefined();
    expect((await call("status", { session_id: id })).text).toContain("collect");
    expect(fs.readFileSync(queue, "utf8")).toBe(text);
  });

  it("queue_add tells the caller to refill when a free slot and an admissible line exist", async () => {
    const { dir, call } = mount();
    const queue = path.join(dir, "q.yaml");
    fs.writeFileSync(
      queue,
      `batch_size: 3\noverlap: files\ntasks:\n${task("RUN", "running", "r.ts")}`.replaceAll(
        "REPO",
        dir,
      ),
    );
    const r = await call("queue_add", {
      file: queue,
      task: {
        id: "A",
        status: "pending",
        difficulty: 3,
        touches: ["a.ts"],
        repo: dir,
        text: "x",
      },
    });
    expect(r.text).toContain("tell its dispatcher");
    await call("queue_header", { file: queue, batch_size: 1, reason: "full" });
    const full = await call("queue_add", {
      file: queue,
      task: {
        id: "B",
        status: "pending",
        difficulty: 3,
        touches: ["b.ts"],
        repo: dir,
        text: "x",
      },
    });
    expect(full.text).not.toContain("tell its dispatcher");
  });

  it("a heir with its own `collect` refuses `refill` until it declares it", async () => {
    for (const declares of [false, true]) {
      const { dir, call } = mount();
      fs.mkdirSync(path.join(dir, ".claude", "workflows"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".claude", "workflows", "heir.yaml"),
        `name: heir\nextends: batch\nstates:\n  collect:\n    prompt: own collect\n    transitions:\n      slot_free: pick\n${declares ? "      refill: pick\n" : ""}`,
      );
      const queue = path.join(dir, "q.yaml");
      fs.writeFileSync(
        queue,
        `batch_size: 3\noverlap: files\ntasks:\n${task("RUN", "running", "r.ts")}`.replaceAll(
          "REPO",
          dir,
        ),
      );
      const s = await call("start", { workflow: "heir", cwd: dir, reply: "id" });
      const id = /SESSION: (\w+)/.exec(s.text)![1];
      await call("context_set", { session_id: id, key: "queue_file", value: queue });
      await call("transition", { session_id: id, transition: "continue" });
      await call("transition", { session_id: id, transition: "ready" });
      const r = await call("transition", { session_id: id, transition: "refill" });
      expect(r.isError === true).toBe(!declares);
    }
  });
});
