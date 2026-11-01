import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { currentStep, linkStanding, linkedAgentLines } from "./agent-link.js";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { pickupReport } from "./session-cli.js";
import { formatResume, registerTools } from "./tools.js";
import { InMemoryStorage, cleanupDir, createTestLoader } from "./test-helpers.js";
import type { SessionState } from "./types.js";

// A task that loops work ⇄ review, as bundled batch-task does; each agent runs its own child session.
const TASK = {
  initial: "work",
  driver: { model: "haiku", effort: "low", prompt_ref: "task-driver" },
  states: {
    work: { prompt: "work", transitions: { review: "review" } },
    review: { prompt: "review", transitions: { fix: "work", land: "done" } },
    done: { terminal: true, outcome: "complete" },
  },
};
// A dispatcher without `driver:`: each visit of `dispatch` ADDS an agent, so its earlier visits' agents stay current.
const LOOP = {
  initial: "dispatch",
  states: {
    dispatch: { prompt: "dispatch", transitions: { dispatched: "collect" } },
    collect: { prompt: "collect", transitions: { again: "dispatch", end: "fin" } },
    fin: { terminal: true },
  },
};
const CHILD = {
  initial: "go",
  states: { go: { prompt: "go", transitions: { end: "fin" } }, fin: { terminal: true } },
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanupDir(d);
});

function mount() {
  const storage = new InMemoryStorage();
  const { loader, dir } = createTestLoader({ task: TASK, child: CHILD, loop: LOOP });
  dirs.push(dir);
  const engine = new Engine(storage, loader, new Executor());
  const restart = () => new Engine(storage, loader, new Executor());
  type Handler = (args: object) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  const handlers = new Map<string, Handler>();
  const server = { registerTool: (name: string, _c: unknown, h: Handler) => handlers.set(name, h) };
  registerTools(server as never, engine, {} as never, loader, storage);
  const call = async (name: string, args: object) =>
    (await handlers.get(name)!(args)).content[0].text;
  return { storage, engine, restart, call };
}

const HEAD = "— only a current one is this visit's agent:";

describe("agent links (pure)", () => {
  const session = (over: Partial<SessionState>): SessionState => ({
    session_id: "c",
    parent_session_id: "p",
    stack: [],
    active_frame: 0,
    started_at: "",
    updated_at: "",
    history: [],
    overrides: {},
    context: {},
    ...over,
  });
  const frame = { workflow: "task", current_state: "work", state_visits: { work: 3 } };

  it("a link stands current at its visit, stale or running at a later one, nothing at another state", () => {
    const now = currentStep(session({ stack: [frame as never] }))!;
    expect(now).toEqual({ workflow: "task", state: "work", visit: 3 });
    const at = (visit: number, state = "work") => ({ workflow: "task", state, visit });
    expect(linkStanding(session({ agent_id: "a", agent_step: at(3) }), now)).toBe("current");
    expect(linkStanding(session({ agent_id: "a", agent_step: at(2) }), now)).toBe("stale");
    expect(
      linkStanding(session({ agent_id: "a", agent_step: at(2), stack: [frame as never] }), now),
    ).toBe("running");
    expect(linkStanding(session({ agent_id: "a", agent_step: at(3, "review") }), now)).toBe(
      undefined,
    );
    expect(linkStanding(session({ agent_id: "a" }), now)).toBe(undefined);
    expect(linkStanding(session({ agent_step: at(3) }), now)).toBe(undefined);
    // no child linked at this state: no block
    const parent = session({
      session_id: "p",
      parent_session_id: undefined,
      stack: [frame as never],
    });
    expect(
      linkedAgentLines(parent, [session({ agent_id: "a", agent_step: at(1, "review") })]),
    ).toEqual([]);
  });
});

describe("agent links (engine)", () => {
  it("a fix round after a linked worker shows the old agent as stale; linked again, it is current", async () => {
    const { storage, engine, call } = mount();
    const p = (await engine.start("task")).sessionId;
    const w = (await engine.start("child", undefined, p)).sessionId;
    const x = (await engine.start("child", undefined, p)).sessionId;
    expect(await call("link_agent", { session_id: w, agent_id: "a1" })).toBe(
      `Session "${w}" linked to agent a1 at its parent's work visit 1.`,
    );
    await engine.linkAgent(x, "x1");
    expect(storage.read(w)!.agent_step).toEqual({ workflow: "task", state: "work", visit: 1 });
    expect(engine.linkedAgentLines(p)).toEqual([
      `LINKED AGENTS at work (visit 1) ${HEAD}`,
      `  agent a1 → session ${w}: linked at visit 1 → current`,
      `  agent x1 → session ${x}: linked at visit 1 → current`,
    ]);
    // a session without a parent records no step
    const root = (await engine.start("child")).sessionId;
    expect(await engine.linkAgent(root, "r")).toBeUndefined();
    expect(storage.read(root)!.agent_step).toBeUndefined();

    await engine.transition(w, "end");
    await engine.transition(p, "review");
    // the review shows no link of the work state
    expect(engine.linkedAgentLines(p)).toEqual([]);
    await engine.transition(p, "fix");

    const at2 = engine.linkedAgentLines(p);
    expect(at2).toEqual([
      `LINKED AGENTS at work (visit 2) ${HEAD}`,
      `  agent a1 → session ${w}: linked at visit 1, now visit 2 → stale (its session ended)`,
      `  agent x1 → session ${x}: linked at visit 1, now visit 2 → an earlier visit's (its session still runs)`,
    ]);
    const status = await call("status", { session_id: p });
    expect(status).toContain(`work (visit 2)\n`);
    expect(status).toContain(at2.join("\n"));

    // the fix round SendMessages the same worker and links it again
    await call("link_agent", { session_id: w, agent_id: "a1" });
    expect(engine.linkedAgentLines(p)[1]).toBe(
      `  agent a1 → session ${w}: linked at visit 2 → current`,
    );
  });

  /** P at review visit 2: the worker's session ended, review 1's left running (suspended by the restart), review 2's linked. */
  async function midReview(m: ReturnType<typeof mount>) {
    const { storage, engine } = m;
    const p = (await engine.start("task")).sessionId;
    const w = (await engine.start("child", undefined, p)).sessionId;
    await engine.linkAgent(w, "worker1");
    await engine.transition(w, "end");
    await engine.transition(p, "review");
    const r1 = (await engine.start("child", undefined, p)).sessionId;
    await engine.linkAgent(r1, "rev1");
    await engine.transition(p, "fix");
    await engine.linkAgent(w, "worker1");
    await engine.transition(p, "review");
    const r2 = (await engine.start("child", undefined, p)).sessionId;
    await engine.linkAgent(r2, "rev2");
    const dead = spawn("true");
    await new Promise(r => dead.on("exit", r));
    for (const id of [p, r1, r2]) {
      const s = storage.read(id)!;
      await storage.write(id, {
        ...s,
        claude_session_id: "conv",
        context: { ...s.context, claude_code_pid: dead.pid! },
      });
    }
    await engine.reapOrphanedSessions();
    return { p, r1, r2 };
  }
  const earlier = (r1: string) =>
    `rev1 → ${r1} → child @ go — linked at its parent's review visit 1, the parent is now at visit 2: an earlier visit's agent — not woken; abort({ session_id: '${r1}', force: true }) once it is not needed`;

  it("a restart mid-review: resume wakes the current reviewer only; status marks the earlier one", async () => {
    const m = mount();
    const { p, r1, r2 } = await midReview(m);
    const next = m.restart();
    const r = await next.resume(p);
    expect(r.suspendedChildren.map(c => c.session_id).sort()).toEqual([r1, r2].sort());
    const text = formatResume(r);
    expect(text).toContain(`rev2 → ${r2} → child @ go\n`);
    expect(text).toContain(`SendMessage({ to: "rev2"`);
    expect(text).toContain(earlier(r1));
    expect(text).not.toContain(`SendMessage({ to: "rev1"`);
    expect(text).not.toContain("worker1");
    expect(next.linkedAgentLines(p)).toEqual([
      `LINKED AGENTS at review (visit 2) ${HEAD}`,
      `  agent rev2 → session ${r2}: linked at visit 2 → current`,
      `  agent rev1 → session ${r1}: linked at visit 1, now visit 2 → an earlier visit's (its session still runs)`,
    ]);
  });

  it("a restart mid-review: the SessionStart pickup wakes the current reviewer only", async () => {
    const m = mount();
    const { r1, r2 } = await midReview(m);
    const text = await pickupReport(m.storage, "conv", process.pid);
    expect(text).toContain(`rev2 → ${r2} → child @ go\n`);
    expect(text).toContain(`SendMessage({ to: "rev2"`);
    expect(text).toContain(earlier(r1));
    expect(text).not.toContain(`SendMessage({ to: "rev1"`);
    expect(text).not.toContain("worker1");
  });

  /** A dispatcher at `dispatch` visit 2, its visit-1 driver's session still running, then a restart. */
  async function dispatcherLoop(m: ReturnType<typeof mount>) {
    const { storage, engine } = m;
    const d = (await engine.start("loop")).sessionId;
    const c1 = (await engine.start("child", undefined, d)).sessionId;
    expect(await engine.linkAgent(c1, "drv1")).toBeUndefined();
    await engine.transition(d, "dispatched");
    await engine.transition(d, "again");
    const c2 = (await engine.start("child", undefined, d)).sessionId;
    await engine.linkAgent(c2, "drv2");
    expect(storage.read(c1)!.agent_step).toBeUndefined();
    expect(engine.linkedAgentLines(d)).toEqual([]);
    const dead = spawn("true");
    await new Promise(r => dead.on("exit", r));
    for (const id of [d, c1, c2]) {
      const s = storage.read(id)!;
      await storage.write(id, {
        ...s,
        claude_session_id: "conv",
        context: { ...s.context, claude_code_pid: dead.pid! },
      });
    }
    await engine.reapOrphanedSessions();
    return { d, c1, c2 };
  }

  it("a parent without driver: is never visit-scoped — a restart in its loop wakes every agent, none offered abort", async () => {
    const m = mount();
    const { d, c1 } = await dispatcherLoop(m);
    const text = formatResume(await m.restart().resume(d));
    for (const agent of ["drv1", "drv2"]) expect(text).toContain(`SendMessage({ to: "${agent}"`);
    expect(text).toContain(`drv1 → ${c1} → child @ go\n`);
    expect(text).not.toContain("an earlier visit's agent — not woken");
    expect(text).not.toContain(`abort({ session_id: '${c1}'`);
    expect(await m.call("status", { session_id: d })).not.toContain("LINKED AGENTS");

    const m2 = mount();
    await dispatcherLoop(m2);
    const pickup = await pickupReport(m2.storage, "conv", process.pid);
    for (const agent of ["drv1", "drv2"]) expect(pickup).toContain(`SendMessage({ to: "${agent}"`);
    expect(pickup).not.toContain("an earlier visit's agent — not woken");
  });
});
