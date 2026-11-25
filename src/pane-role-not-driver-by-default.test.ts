// Reproduces ENG-PANE-ROLE-NOT-DRIVER-BY-DEFAULT: the pane labels the agent of any workflow whose name holds none of
// review/worker/recon as `driver`, though only a workflow's own driver block makes an agent its driver.
import { describe, expect, it } from "vitest";
import { nodeText, paneTree, type PaneEl, type PaneNode } from "../hooks/pane-view.js";
import type { snapshotAt } from "./replay.js";

type Snapshot = ReturnType<typeof snapshotAt>;
type SessionRow = Snapshot["sessions"][number];

const T0 = 1_800_000_000_000;
const MIN = 60_000;

const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: "94fe30d6-aaaa-bbbb",
  parent: "",
  workflow: "slice-pipeline",
  state: "review",
  tag: "ENG-X",
  since: T0 - 5 * MIN,
  isWorking: false,
  agent: "",
  visit: 1,
  recent: [],
  next: [],
  ...over,
});

function lines(n: PaneNode): string[] {
  if (n === null || n === undefined || n === false) return [];
  if (typeof n === "string") return [n];
  if (Array.isArray(n)) return n.flatMap(lines);
  const el = n as PaneEl;
  if (el.el === "box" && el.props.flexDirection === "column") return el.children.flatMap(lines);
  return [nodeText(el)];
}

function paneLines(sessions: SessionRow[]): string[] {
  const snapshot = {
    at: T0,
    sessions,
    queue: null,
    lands: [],
    recent: 0,
    days: {},
    error: "",
  } as unknown as Snapshot;
  return lines(
    paneTree({
      snapshot,
      tab: "sessions",
      expanded: "",
      folded: [],
      now: T0,
      columns: 120,
      rows: 40,
      poolCounts: null,
      pool: null,
    }),
  );
}

describe("ENG-PANE-ROLE-NOT-DRIVER-BY-DEFAULT", () => {
  it("a plan-stage agent row is not labelled driver", () => {
    const out = paneLines([
      row({ agent: "driver-0123456789", role: "driver", model: "haiku" }),
      row({
        id: "c1",
        parent: "94fe30d6-aaaa-bbbb",
        workflow: "plan",
        state: "draft",
        tag: "",
        isWorking: true,
        agent: "plan-9876543",
        model: "opus",
      }),
    ]);
    const planRow = out.find(l => /plan-98/.test(l));
    expect(planRow).toBeDefined();
    expect(planRow).not.toMatch(/· driver ·/);
  });

  it("a real driver row is still labelled driver", () => {
    const out = paneLines([row({ agent: "driver-0123456789", role: "driver", model: "haiku" })]);
    expect(out.find(l => /◇ agent/.test(l))).toMatch(/· driver · haiku/);
  });
});
