import { expect, it } from "vitest";
import { earlierVisitNote } from "./takeover.js";
import { InMemoryStorage, cleanupDir, createTestLoader } from "./test-helpers.js";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";

// ENG-ABORT-HINT-DEAD-FALLBACK: abortHint once fell back to `s.parent_session_id` when the parent
// state was not at hand, but earlierVisitNote returns before building a hint in that case, so the
// fallback never ran and is gone. This pins that contract: no parent state, no note (so no hint
// naming a caller from the recorded id alone); with the parent's state the hint names it.
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

it("an earlier-visit note needs the parent state: without it there is no note and no abort hint, with it the hint names the parent", async () => {
  const storage = new InMemoryStorage();
  const { loader, dir } = createTestLoader({ task: TASK, child: CHILD });
  try {
    const engine = new Engine(storage, loader, new Executor());
    const p = (await engine.start("task")).sessionId;
    const w = (await engine.start("child", undefined, p)).sessionId;
    await engine.linkAgent(w, "worker1");
    const s = storage.read(w)!;
    expect(s.parent_session_id).toBe(p);
    expect(earlierVisitNote(s, undefined)).toBeUndefined();
    await engine.transition(p, "plan"); // the parent leaves the step the agent was linked at
    const note = earlierVisitNote(s, storage.read(p)!);
    expect(note).toBeDefined();
    expect(note).toContain(`caller_session_id: '${p}'`);
  } finally {
    cleanupDir(dir);
  }
});
