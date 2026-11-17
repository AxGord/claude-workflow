import { afterEach, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { registerTools } from "./tools.js";
import { earlierVisitNote } from "./takeover.js";
import { InMemoryStorage, cleanupDir, createTestLoader } from "./test-helpers.js";

// ENG-ABORT-GUARD-FOLLOWUPS (2): the abort hint of an earlier visit's agent
// must be followable: executing it verbatim on a session that has active
// descendants must not be refused by the abort guard.
const TASK = {
  initial: "work",
  driver: { model: "haiku", effort: "low", prompt_ref: "task-driver" },
  states: {
    work: { prompt: "work", transitions: { plan: "plan_next" } },
    plan_next: { prompt: "plan", transitions: { done: "fin" } },
    fin: { terminal: true, outcome: "complete" },
  },
};
const CHILD = {
  initial: "go",
  states: { go: { prompt: "go", transitions: { end: "fin" } }, fin: { terminal: true } },
};

let dir: string | undefined;
afterEach(() => {
  if (dir) cleanupDir(dir);
  dir = undefined;
});

it("following the earlier-visit abort hint verbatim on a session with active descendants is not refused", async () => {
  const storage = new InMemoryStorage();
  const result = createTestLoader({ task: TASK, child: CHILD });
  dir = result.dir;
  const engine = new Engine(storage, result.loader, new Executor());
  const handlers = new Map<
    string,
    (args: object) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
  >();
  registerTools(
    { registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h) } as never,
    engine,
    {} as never,
    result.loader,
    storage,
  );
  const p = (await engine.start("task")).sessionId;
  const w = (await engine.start("child", undefined, p)).sessionId;
  const g = (await engine.start("child", undefined, w)).sessionId; // active descendant of w
  await engine.linkAgent(w, "worker1");
  await engine.transition(p, "plan"); // parent leaves the visit w was linked at
  const note = earlierVisitNote(storage.read(w)!, storage.read(p)!);
  expect(note).toBeDefined();
  const m = /abort\((\{[^)]*\})\)/.exec(note!);
  expect(m).not.toBeNull();
  // the hint is a JS object literal of quoted ids: read its pairs as the agent would pass them
  const args = Object.fromEntries(
    [...m![1].matchAll(/(\w+): (?:'([^']*)'|(true|false))/g)].map(([, k, s, b]) => [
      k,
      s ?? b === "true",
    ]),
  );
  const r = await handlers.get("abort")!(args);
  expect(r.content[0].text).not.toContain("abort refused");
  expect(r.isError).toBeUndefined();
  expect((storage.read(g)?.stack.length ?? 0) === 0).toBe(true);
});
