import { describe, expect, it } from "vitest";
import { fold, type WfEvent } from "./event-fold.js";
import { layout, scene, type MapLayout, type SceneEl, type SceneGroup } from "./map-layout.js";

// ENG-MAP-NEXT-STRIP-QUEUE: the `next:` strip merges the ready lines of every queue into one row with no
// queue name; and a root session that has its own task and has children counts as a dispatcher.

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
let seq = 0;
const log: WfEvent[] = [];
function start(id: string, parent: string | null, extra: Record<string, unknown> = {}) {
  log.push({
    seq: ++seq,
    run: "r1",
    ts: "2026-11-08T10:00:00.000Z",
    kind: "session_start",
    session: id,
    data: { workflow: "work", parent, task: null, difficulty: null, project: "p", ...extra },
  });
}
const q = (name: string) => `/repo/owner/.claude/batch/${name}.yaml`;
const flat = (g: SceneGroup): SceneEl[] => [...g.els, ...g.groups.flatMap(flat)];
/** every piece of text the scene draws for the `next:` strip(s) */
const nextText = (m: MapLayout): string[] =>
  flat(scene(m))
    .filter(e => e.key.includes("next") && typeof e.text === "string")
    .map(e => e.text as string);

function twoQueues(): MapLayout {
  log.length = 0;
  seq = 0;
  start("DX", null, { queue: q("x") });
  start("LX", "DX", { task: "X-RUN", queue: q("x") });
  start("DY", null, { queue: q("y") });
  start("LY", "DY", { task: "Y-RUN", queue: q("y") });
  // the ready lines carry the queue file they were read from; the cast keeps the test off the option's exact type
  const next = [
    { id: "X-1", queue: q("x") },
    { id: "Y-1", queue: q("y") },
    { id: "X-2", queue: q("x") },
  ] as unknown as NonNullable<Parameters<typeof layout>[2]["next"]>;
  return layout(fold([...log]), {}, { now: NOW, next });
}

describe("the next: strip names the queue of each ready line", () => {
  it("two queues give two named groups, each queue named the way its band heading names it", () => {
    const m = twoQueues();
    expect(m.bands.map(b => b.title)).toEqual([
      "p › owner/x.yaml · work",
      "p › owner/y.yaml · work",
    ]);
    const text = nextText(m);
    const at = (s: string) => text.findIndex(t => t.includes(s));
    expect(at("owner/x.yaml")).toBeGreaterThanOrEqual(0);
    expect(at("owner/y.yaml")).toBeGreaterThanOrEqual(0);
    // each queue's lines sit under its own name
    expect(
      text.filter(
        (_, i) => i > at("owner/x.yaml") && i < at("owner/y.yaml") && /^[XY]-/.test(text[i]),
      ),
    ).toEqual(["X-1", "X-2"]);
    expect(text.slice(at("owner/y.yaml")).filter(t => /^[XY]-/.test(t))).toEqual(["Y-1"]);
  });
});

describe("one queue", () => {
  it("keeps one row, named, in the order of the lines", () => {
    const m = twoQueues();
    const one = layout(
      fold([...log]),
      {},
      {
        now: NOW,
        next: [
          { id: "X-1", queue: q("x") },
          { id: "X-2", queue: q("x") },
        ],
      },
    );
    expect(m.next.map(n => n.queue)).toEqual(["owner/x.yaml", "owner/y.yaml"]);
    expect(one.next).toHaveLength(1);
    expect(one.next[0].lead).toBe("next: owner/x.yaml");
    expect(one.next[0].items.map(i => i.id)).toEqual(["X-1", "X-2"]);
  });
});

describe("a root with its own task and a child", () => {
  it("is one lane, not a dispatcher whose child becomes a lane", () => {
    log.length = 0;
    seq = 0;
    start("T", null, { task: "LINE-1", queue: q("x") });
    start("C", "T", {});
    const m = layout(fold([...log]), {}, { now: NOW });
    expect(m.bands.flatMap(b => b.lanes.map(l => l.session))).toEqual(["T"]);
    expect(m.bands[0].lanes[0].branches.map(b => b.session)).toEqual(["C"]);
  });
});
