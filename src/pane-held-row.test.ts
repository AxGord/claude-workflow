// Pin of ENG-PARENT-HOLD-UNTIL-CONDITION: the plan pane's running row of a task the parent holds says what it waits
// for (hooks/pane-view.ts draws it from the session row's `held`, hooks/plan-pane.tsx reads it from `context.parent_hold`).
import { describe, expect, it, vi } from "vitest";
vi.mock("claude-code", () => ({ atom: () => ({}), read: () => ({}), update: () => ({}) }));

interface El {
  el: string;
  children?: Node[];
}
type Node = El | string | null | Node[];
interface ViewModule {
  paneTree: (input: unknown) => Node;
  nodeText: (n: Node) => string;
}
const view = (): Promise<ViewModule> => import("../hooks/pane-view.ts") as Promise<ViewModule>;

const NOW = new Date(2026, 10, 27, 12, 0).getTime();
const LINE = {
  id: "T-HELD",
  status: "running",
  difficulty: "3",
  isParked: false,
  isExclusive: false,
  isParentRun: false,
  after: [],
};
const row = (over: object) => ({
  id: "s1",
  parent: "",
  workflow: "engine-task",
  state: "blocked",
  tag: "T-HELD",
  since: NOW - 5 * 60_000,
  isWorking: false,
  agent: "",
  visit: 1,
  recent: [],
  next: [],
  ...over,
});

async function draw(sessions: object[]): Promise<string[]> {
  const { paneTree, nodeText } = await view();
  const queue = {
    file: "/q",
    window: 3,
    done: 0,
    failed: 0,
    pending: 0,
    running: [LINE],
    awaiting: [],
    ready: [],
    unblocked: [],
    waiting: [],
    failedLines: [],
    marks: {},
  };
  const snapshot = { at: 0, sessions, queue, lands: [], recent: 0, days: {}, error: "" };
  const tree = paneTree({
    snapshot,
    tab: "plan",
    expanded: "",
    folded: [],
    now: NOW,
    columns: 120,
    rows: 40,
    poolCounts: null,
    pool: null,
  });
  const texts: string[] = [];
  const walk = (n: Node): void => {
    if (n === null || typeof n === "string") return;
    if (Array.isArray(n)) return void n.forEach(walk);
    if (n.el === "text") texts.push(nodeText(n));
    if (n.el !== "link") (n.children ?? []).forEach(walk);
  };
  walk(tree);
  return texts;
}

describe("the plan pane's row of a held task", () => {
  it("a held task's running row shows `held until <condition>`", async () => {
    const texts = await draw([row({ held: "DEP is done" })]);
    expect(texts.some(t => /T-HELD .*blocked · held until DEP is done/.test(t))).toBe(true);
  });

  it("a task with no hold shows no such words", async () => {
    const texts = await draw([row({})]);
    expect(texts.some(t => t.includes("T-HELD"))).toBe(true);
    expect(texts.some(t => t.includes("held until"))).toBe(false);
  });
});
