import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fold, type WfEvent } from "./event-fold.js";
import { Loader } from "./loader.js";
import { G, layout, scene, type MapWorkflow, type SceneGroup } from "./map-layout.js";
import { expandReplay, rowsUntil, type ReplayFile } from "./replay.js";
import { computeStations } from "./stations.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = JSON.parse(
  fs.readFileSync(path.join(ROOT, "docs/public/replay/anyparse.json"), "utf8"),
) as ReplayFile;

/** a state label is drawn `text-anchor: middle` (`.m-mid`) at its station's x: its box is the glyph count times the advance */
function stationBoxes(g: SceneGroup, out: { name: string; x0: number; x1: number }[] = []) {
  for (const el of g.els)
    if (el.cls.startsWith("m-station")) {
      const w = [...(el.text ?? "")].length * G.charW;
      const x = Number(el.attrs.x);
      out.push({ name: el.text ?? "", x0: x - w / 2, x1: x + w / 2 });
    }
  for (const sub of g.groups) stationBoxes(sub, out);
  return out;
}

function overlaps(width: number | undefined): string[] {
  const events = expandReplay(FILE);
  const t0 = Date.parse(FILE.start);
  return overlapsOf(
    fold(events.slice(0, rowsUntil(FILE, FILE.durationMs))),
    FILE.workflows,
    t0 + FILE.durationMs,
    width,
    FILE.taskKinds,
  );
}

function overlapsOf(
  folded: ReturnType<typeof fold>,
  workflows: Readonly<Record<string, MapWorkflow>>,
  now: number,
  width: number | undefined,
  kinds?: Readonly<Record<string, string>>,
): string[] {
  const found = new Set<string>();
  const m = layout(folded, workflows, {
    now,
    ...(width !== undefined ? { width } : {}),
    ...(kinds !== undefined ? { kinds } : {}),
  });
  const root = scene(m);
  for (const band of m.bands) {
    const group = root.groups.find(g => g.key === `band:${band.key}`) as SceneGroup;
    const boxes = stationBoxes(group);
    boxes.sort((a, b) => a.x0 - b.x0);
    for (let i = 1; i < boxes.length; i++)
      if (boxes[i].x0 < boxes[i - 1].x1)
        found.add(`${band.workflow}: ${boxes[i - 1].name} / ${boxes[i].name}`);
  }
  return [...found];
}

describe("state labels of the replay map (docs/public/replay/anyparse.json)", () => {
  it("no two state labels of engine-task overlap at the room the site gives the map", () => {
    expect(overlaps(1280)).toEqual([]);
  });
  it("none overlap with the room unbounded", () => {
    expect(overlaps(undefined)).toEqual([]);
  });
});

describe("state labels of every bundled workflow", () => {
  const TEMPLATES = path.join(ROOT, "templates");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-label-overlap-"));
  const defs = new Loader(TEMPLATES, dir, null).getAll();
  fs.rmSync(dir, { recursive: true, force: true });
  const workflows: Record<string, MapWorkflow> = {};
  for (const [name, def] of defs) workflows[name] = { stations: computeStations(def) };
  const NOW = Date.parse("2026-11-08T11:30:00.000Z");
  const events: WfEvent[] = Object.keys(workflows).map((name, i) => ({
    seq: i + 1,
    run: "r1",
    ts: "2026-11-08T10:00:00.000Z",
    kind: "session_start",
    session: `S${i}`,
    data: { workflow: name, parent: null, task: null, difficulty: null },
  }));
  it("lays out a band per workflow", () => {
    expect(Object.keys(workflows).length).toBeGreaterThan(5);
  });
  for (const width of [undefined, 1280, 390])
    it(`no two overlap at ${width ?? "unbounded"} px`, () => {
      expect(overlapsOf(fold(events), workflows, NOW, width)).toEqual([]);
    });
});
