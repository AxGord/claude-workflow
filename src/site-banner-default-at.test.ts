// Reproduces ENG-BANNER-DEFAULT-AT-LANDED: the banner's default replay moment must show a Landed row with `$`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { nodeText, paneTree, type PaneEl, type PaneNode } from "../hooks/pane-view.js";
import { snapshotAt, type ReplayFile } from "./replay.js";

vi.mock("claude-code", () => ({ atom: () => ({}), read: () => ({}), update: () => ({}) }));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const B = (await import(pathToFileURL(path.join(ROOT, "scripts/render-banner.mjs")).href)) as {
  defaultAt(file: ReplayFile, rows?: number): number;
  DEFAULT_LANDED_ROWS: number;
  REPLAY_FILE: string;
};
const file = JSON.parse(fs.readFileSync(path.join(ROOT, B.REPLAY_FILE), "utf8")) as ReplayFile;
const DEFAULT_AT = B.defaultAt(file);

const draw = (at: number): PaneNode =>
  paneTree({
    snapshot: snapshotAt(file, at),
    tab: "plan",
    expanded: "",
    folded: [],
    now: Date.parse(file.start) + at,
    columns: 80,
    rows: 40,
    poolCounts: null,
    pool: null,
  });

function texts(n: PaneNode, re: RegExp): string[] {
  if (n === null || typeof n === "string") return [];
  if (Array.isArray(n)) return (n as readonly PaneNode[]).flatMap(c => texts(c, re));
  const el = n as PaneEl;
  if (el.el === "link") return [];
  const own = el.el === "text" && re.test(nodeText(el)) ? [nodeText(el)] : [];
  return [...own, ...el.children.flatMap(c => texts(c, re))];
}

describe("render-banner defaultAt lands on a moment that shows prices", () => {
  it("at the default moment the plan pane shows a Done row with `$`", () => {
    const at = DEFAULT_AT * 1000;
    expect(at).toBeLessThanOrEqual(file.durationMs);
    const snap = snapshotAt(file, at);
    const landedWithUsd = snap.lands.filter(l => l.usd !== undefined);
    expect(landedWithUsd.length).toBeGreaterThanOrEqual(B.DEFAULT_LANDED_ROWS);
    expect(texts(draw(at), /✓ Done.*\$\d/).length).toBeGreaterThan(0);
  });

  it("the moment is the FIRST second with that many priced lands, read from the replay", () => {
    const priced = (s: number): number =>
      snapshotAt(file, s * 1000).lands.filter(l => l.usd !== undefined).length;
    expect(priced(DEFAULT_AT - 1)).toBe(B.DEFAULT_LANDED_ROWS - 1);
    expect(priced(DEFAULT_AT)).toBeGreaterThanOrEqual(B.DEFAULT_LANDED_ROWS);
  });

  it("a replay that never lands that many priced tasks is refused, not rendered without prices", () => {
    expect(() => B.defaultAt({ ...file, events: [], sessions: [] })).toThrow(/fewer than/);
  });
});
