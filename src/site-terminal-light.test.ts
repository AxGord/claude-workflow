// Pins of ENG-LIGHT-TERMINAL-PANE-AND-SITE: the plan pane names its colours by theme key (so a light terminal draws it
// in its own palette), and the site's terminal window carries a dark and a light palette for every key, following html.dark.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  conversationTail,
  poolCountsAt,
  poolStateAt,
  snapshotAt,
  type ReplayFile,
} from "./replay.js";
import {
  endLine,
  handBackLine,
  movesLine,
  paneTree,
  spawnLine,
  statusBandTree,
  TONE,
  type PaneEl,
  type PaneNode,
} from "../hooks/pane-view.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const PANE_VIEW = read("hooks/pane-view.ts");
const PLAN_PANE = read("hooks/plan-pane.tsx");
const PANE_VUE = read("docs/.vitepress/theme/PaneView.vue");
const WINDOW_VUE = read("docs/.vitepress/theme/TerminalWindow.vue");
const PALETTE = read("docs/.vitepress/theme/terminal-palette.css");
const STATUS_VUE = read("docs/.vitepress/theme/StatusLine.vue");
const DEMO_VUE = read("docs/.vitepress/theme/PoolDemo.vue");
const STRIP_VUE = read("docs/.vitepress/theme/PoolStrip.vue");
const KEYS = [...new Set(Object.values(TONE))];

/** The custom properties a rule's body declares, by name. */
const declared = (css: string, selector: string, prefix: string): string[] => {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} is in the stylesheet`).toBeGreaterThanOrEqual(0);
  const body = css.slice(at, css.indexOf("}", at));
  return [...body.matchAll(new RegExp(`(--${prefix}[\\w-]+):`, "g"))].map(m => m[1] ?? "");
};

/** Every color a tree draws. */
function colors(n: PaneNode, into: Set<string>): Set<string> {
  if (n === null || typeof n === "string") return into;
  if (Array.isArray(n)) {
    for (const c of n as readonly PaneNode[]) colors(c, into);
    return into;
  }
  const el = n as PaneEl;
  if (el.el === "link") return into;
  if (el.el === "text" && el.props.color !== undefined) into.add(el.props.color);
  for (const c of el.children) colors(c, into);
  return into;
}

describe("the plan pane's colours are theme keys, not terminal color names", () => {
  it("names no ANSI color and no hex in a text's color, in the shared module and in the mod", () => {
    const names = "cyan|cyanBright|green|red|yellow|blue|magenta|gray|grey|white|black|\\w+Bright";
    const legacy = new RegExp(`color(?:=|:\\s*)\\{?[^,}]*['"](?:${names}|#[0-9a-fA-F]{3,8})['"]`);
    for (const src of [PANE_VIEW, PLAN_PANE]) expect(src).not.toMatch(legacy);
    // the one place that spells a key is TONE
    expect(PANE_VIEW).not.toMatch(/'(?:cyan|cyanBright|green|red|yellow|blue|magenta|gray)'/);
    expect(PANE_VIEW).not.toMatch(/'#[0-9a-fA-F]{6}'/);
  });

  it("every color the pane draws, on every tab, in the conversation and in the band, is a TONE value", () => {
    const file = JSON.parse(read("docs/public/replay/anyparse.json")) as ReplayFile;
    const seen = new Set<string>();
    const t0 = Date.parse(file.start);
    for (let i = 1; i <= 16; i++) {
      const at = Math.floor((file.durationMs * i) / 17);
      const snapshot = snapshotAt(file, at);
      colors(statusBandTree(snapshot), seen);
      for (const tab of ["plan", "sessions", "waiting", "pool"] as const) {
        for (const expanded of ["", snapshot.sessions[0]?.id ?? ""]) {
          colors(
            paneTree({
              snapshot,
              tab,
              expanded,
              folded: [],
              now: t0 + at,
              columns: 80,
              rows: 30,
              poolCounts: poolCountsAt(file, at),
              pool: poolStateAt(file, at),
            }),
            seen,
          );
        }
      }
    }
    colors(spawnLine("S", "driver", "opus"), seen);
    colors(movesLine([{ label: "S", name: "go", to: "work" }], []), seen);
    colors(handBackLine("S", { kind: "needs", reason: "x" }), seen);
    colors(handBackLine("S", { kind: "landed", sha: "abc" }), seen);
    colors(endLine("S", "driver", "1m", { kind: "failed", state: "x" }), seen);
    expect(conversationTail(file, file.durationMs, 5).length).toBeGreaterThan(0);
    expect(seen.size).toBeGreaterThanOrEqual(5);
    for (const c of seen) expect(KEYS, `color ${c}`).toContain(c);
  });

  it("TONE values are distinct theme keys of Claude Code", () => {
    const stock = [
      "success",
      "error",
      "warning",
      "suggestion",
      "claude",
      "inactive",
      "remember",
      "autoAccept",
    ];
    for (const k of KEYS) expect(stock).toContain(k);
  });
});

describe("the site's terminal has a dark and a light palette with every name the pane uses", () => {
  it("PaneView defines --tc-<key> for each TONE value in the dark set and in the light one, and draws through them", () => {
    const dark = declared(PANE_VUE, ".pv", "tc-").sort();
    const light = declared(PANE_VUE, "html:not(.dark) .term-follows-site .pv", "tc-").sort();
    expect(dark).toEqual(KEYS.map(k => `--tc-${k}`).sort());
    expect(light).toEqual(dark);
    const rest = ["--pv-dim", "--pv-link", "--pv-hover"];
    expect(declared(PANE_VUE, ".pv", "pv-")).toEqual(expect.arrayContaining(rest));
    expect(declared(PANE_VUE, "html:not(.dark) .term-follows-site .pv", "pv-")).toEqual(
      expect.arrayContaining(rest),
    );
    expect(PANE_VUE).toContain("`var(--tc-${c})`");
    // no dark-only table of names survives
    expect(PANE_VUE).not.toContain("COLORS");
    expect(PANE_VUE).not.toMatch(/cyanBright|magenta/);
  });

  it("the two sets differ in every key's value (a light set copied from the dark one reads poorly on white)", () => {
    const value = (selector: string, key: string): string => {
      const at = PANE_VUE.indexOf(`${selector} {`);
      const body = PANE_VUE.slice(at, PANE_VUE.indexOf("}", at));
      return new RegExp(`--tc-${key}:\\s*([^;]+);`).exec(body)?.[1] ?? "";
    };
    for (const k of KEYS) {
      const d = value(".pv", k);
      const l = value("html:not(.dark) .term-follows-site .pv", k);
      expect(d).toMatch(/^#/);
      expect(l).toMatch(/^#/);
      // `claude` is the brand orange on both grounds; every other key is re-chosen for white
      if (k !== "claude") expect(l, k).not.toBe(d);
    }
  });

  it("the chrome palette is one file: the window, the status line and the Pool demo read the same --cc-* sets", () => {
    expect(read("docs/.vitepress/theme/index.ts")).toContain('import "./terminal-palette.css"');
    const dark = declared(PALETTE, ".cc-window,\n.term-surface", "cc-").sort();
    const light = declared(
      PALETTE,
      "html:not(.dark) .cc-window,\nhtml:not(.dark) .term-surface",
      "cc-",
    ).sort();
    expect(dark.length).toBeGreaterThanOrEqual(9);
    expect(dark).toContain("--cc-panel");
    expect(light).toEqual(dark);
    // no third copy: no component redefines the set
    for (const src of [WINDOW_VUE, STATUS_VUE, DEMO_VUE, STRIP_VUE])
      expect(src).not.toMatch(/--cc-[\w-]+\s*:/);
  });

  it("TerminalWindow follows html.dark through the palette: its scoped rules draw only with --cc-* (bar the three dots)", () => {
    expect(WINDOW_VUE).toContain('<section class="cc-window term-follows-site"');
    const scoped = WINDOW_VUE.slice(WINDOW_VUE.indexOf("<style scoped>"));
    expect(scoped.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)).toEqual(["#ff5f56", "#ffbd2e", "#27c93f"]);
    expect(scoped.match(/var\(--cc-/g)?.length).toBeGreaterThanOrEqual(8);
  });

  it("the status line and the Pool demo are terminal surfaces that follow the site, with no colour literal of their own", () => {
    for (const src of [STATUS_VUE, DEMO_VUE]) {
      expect(src).toContain("term-surface term-follows-site");
      const scoped = src.slice(src.indexOf("<style scoped>"));
      expect(scoped.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)).toBeNull();
      expect(scoped.match(/var\(--cc-/g)?.length).toBeGreaterThanOrEqual(4);
    }
    // the demo's two boxes (the live one and the status one) are both surfaces
    expect(DEMO_VUE.match(/class="pd-box[^"]*term-surface term-follows-site"/g)).toHaveLength(2);
  });

  it("PoolStrip keeps its dark defaults and the dashboard's tokens, and a light set under the following terminal, in the same variables", () => {
    const dark = declared(STRIP_VUE, ".pool-strip", "ps-").sort();
    const light = declared(
      STRIP_VUE,
      "html:not(.dark) .term-follows-site .pool-strip",
      "ps-",
    ).sort();
    expect(dark.length).toBeGreaterThanOrEqual(9);
    expect(light).toEqual(dark);
    expect(declared(STRIP_VUE, ".dash .pool-strip", "ps-").sort()).toEqual(dark);
    // the light set draws the title, the reading and the legend from the shared chrome palette
    const at = STRIP_VUE.indexOf("html:not(.dark) .term-follows-site .pool-strip {");
    const body = STRIP_VUE.slice(at, STRIP_VUE.indexOf("}", at));
    for (const v of ["--cc-panel", "--cc-text", "--cc-muted", "--cc-dim"])
      expect(body).toContain(`var(${v})`);
    // monospace strip font stays
    expect(STRIP_VUE).toContain("font-family: ui-monospace");
  });
});
