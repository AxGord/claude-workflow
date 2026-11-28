// Pins of ENG-PANE-AWAITING-ROW-FOLD: each row of the plan pane's `⏸ Awaiting you` section folds on its own
// (hooks/pane-view.ts draws it, hooks/plan-pane.tsx keeps the fold list), the parts that need no render harness.
import { describe, expect, it, vi } from "vitest";
vi.mock("claude-code", () => ({ atom: () => ({}), read: () => ({}), update: () => ({}) }));

interface El {
  el: string;
  props?: unknown;
  children?: Node[];
  action?: { kind: string; key?: string; answered?: boolean };
}
type Node = El | string | null | Node[];
interface ViewModule {
  paneTree: (input: unknown) => Node;
  nodeText: (n: Node) => string;
  awaitRowOpen: (folded: string[], key: string, answered: boolean) => boolean;
  awaitRowToggled: (folded: string[], key: string, answered: boolean) => string[];
}
const view = (): Promise<ViewModule> => import("../hooks/pane-view.ts") as Promise<ViewModule>;

const NOW = new Date(2026, 10, 27, 12, 0).getTime();
const WAITING = {
  id: "W-ONE",
  difficulty: "3",
  priority: "normal",
  session: "s1",
  question: "Which preview do you keep?",
  show: ["https://x.test/a", "/tmp/notes.md"],
  since: NOW - 5 * 60_000,
};
const ANSWERED = {
  id: "A-ONE",
  difficulty: "3",
  priority: "normal",
  session: "s2",
  question: "Land it?",
  show: [],
  since: NOW - 9 * 60_000,
  answered: "yes",
};
const QUEUE = {
  file: "/q",
  window: 3,
  done: 0,
  failed: 0,
  pending: 0,
  running: [],
  awaiting: [WAITING, ANSWERED],
  ready: [],
  unblocked: [],
  waiting: [],
  failedLines: [],
  marks: {},
};

async function draw(folded: string[]): Promise<{ texts: string[]; buttons: El[] }> {
  const { paneTree, nodeText } = await view();
  const snapshot = { at: 0, sessions: [], queue: QUEUE, lands: [], recent: 0, days: {}, error: "" };
  const tree = paneTree({
    snapshot,
    tab: "plan",
    expanded: "",
    folded,
    now: NOW,
    columns: 100,
    rows: 40,
    poolCounts: null,
    pool: null,
  });
  const texts: string[] = [];
  const buttons: El[] = [];
  const walk = (n: Node): void => {
    if (n === null || typeof n === "string") return;
    if (Array.isArray(n)) return void n.forEach(walk);
    if (n.el === "button") buttons.push(n);
    if (n.el === "text") texts.push(nodeText(n));
    if (n.el !== "link") (n.children ?? []).forEach(walk);
  };
  walk(tree);
  return { texts, buttons };
}

const awaitButton = (b: El[], id: string) =>
  b.find(x => x.action?.kind === "awaitRow" && x.action.key === `await-${id}`);

describe("ENG-PANE-AWAITING-ROW-FOLD", () => {
  it("a waiting row draws its question and links under its header line", async () => {
    const { texts } = await draw([]);
    expect(texts.some(t => t.includes("Which preview do you keep?"))).toBe(true);
    expect(texts.some(t => t.includes("https://x.test/a"))).toBe(true);
    expect(texts.some(t => /^▾ .*W-ONE .*waiting 5m/.test(t))).toBe(true);
  });

  it("a folded row draws one line: its header, no question and no link", async () => {
    const { texts } = await draw(["-await-W-ONE"]);
    expect(texts.filter(t => t.includes("W-ONE"))).toHaveLength(1);
    expect(texts.some(t => /^▸ .*W-ONE .*waiting 5m/.test(t))).toBe(true);
    expect(texts.some(t => t.includes("Which preview") || t.includes("notes.md"))).toBe(false);
  });

  it("an answered row is folded by default and opens on a toggle that survives a redraw", async () => {
    const { texts, buttons } = await draw([]);
    expect(texts.some(t => /^▸ .*A-ONE .*answered yes · resumes first/.test(t))).toBe(true);
    expect(texts.some(t => t.includes("Land it?"))).toBe(false);
    const { awaitRowToggled } = await view();
    const action = awaitButton(buttons, "A-ONE")!.action!;
    const opened = awaitRowToggled([], action.key!, action.answered!);
    const after = await draw(opened);
    expect(after.texts.some(t => t.includes("Land it?"))).toBe(true);
    expect((await draw(opened)).texts.some(t => t.includes("Land it?"))).toBe(true);
    // the other row is untouched by it
    expect(after.texts.some(t => t.includes("Which preview do you keep?"))).toBe(true);
  });

  it("the person's choice wins over the default, whichever way the row's state moves", async () => {
    const { awaitRowOpen, awaitRowToggled } = await view();
    const closedWhileWaiting = awaitRowToggled([], "await-X", false);
    expect(awaitRowOpen(closedWhileWaiting, "await-X", false)).toBe(false);
    // the answer arrives: the folded row stays folded
    expect(awaitRowOpen(closedWhileWaiting, "await-X", true)).toBe(false);
    const openedWhileAnswered = awaitRowToggled([], "await-X", true);
    expect(awaitRowOpen(openedWhileAnswered, "await-X", true)).toBe(true);
    expect(awaitRowToggled(openedWhileAnswered, "await-X", true)).toEqual(["-await-X"]);
  });

  it("a folded row's press is an awaitRow action naming its own key", async () => {
    const { buttons } = await draw([]);
    expect(awaitButton(buttons, "W-ONE")?.action).toEqual({
      kind: "awaitRow",
      key: "await-W-ONE",
      answered: false,
    });
    expect(awaitButton(buttons, "A-ONE")?.action).toEqual({
      kind: "awaitRow",
      key: "await-A-ONE",
      answered: true,
    });
  });

  it("the folded atom drops the keys of lines that no longer wait", async () => {
    const { pruneAwaitFolds } = (await import("../hooks/plan-pane.tsx")) as unknown as {
      pruneAwaitFolds: (f: string[], live: Set<string>) => string[];
    };
    expect(
      pruneAwaitFolds(["+await-A", "-await-B", "failed", "+lands-09.11"], new Set(["A"])),
    ).toEqual(["+await-A", "failed", "+lands-09.11"]);
  });
});
