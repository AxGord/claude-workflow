import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const VUE = read("docs/.vitepress/theme/MapReplay.vue");
const SCENE = read("docs/.vitepress/theme/Scene.vue");
const STORE = read("docs/.vitepress/theme/replay-store.ts");
const TRANSPORT = read("docs/.vitepress/theme/Transport.vue");
const THEME = read("docs/.vitepress/theme/index.ts");
const CONFIG = read("docs/.vitepress/config.mts");
const MAP = read("dashboard/map.js");
const SCENE_DOM = read("dashboard/scene-dom.js");

describe("the landing's replay runs the dashboard map's own code", () => {
  it("lays out with the map's fold and layout from src/, no copy", () => {
    expect(VUE).toContain('from "../../../src/event-fold"');
    expect(VUE).toContain('from "../../../src/map-layout"');
    expect(VUE).toContain(
      "layout(fold(events.slice(0, rowsUntil(file, shared.at))), file.workflows, {",
    );
    expect(VUE).toContain("scene(map)");
    expect(VUE).not.toMatch(/function (layout|fold|scene)\b/);
  });

  it("draws with the one keyed renderer the dashboard map uses (dashboard/scene-dom.js)", () => {
    expect(VUE).toContain('import { reconcile } from "../../../dashboard/scene-dom.js"');
    expect(VUE).toContain("reconcile(svg.value, [scene(map)])");
    expect(SCENE_DOM).toContain("export function reconcile(");
    expect(MAP).toContain("import { reconcile } from '/scene-dom.js'");
    // the renderer lives in one file: map.js has no keyed reconciliation of its own
    expect(MAP).not.toMatch(/function (reconcile|setAttrs|enter|leave)\b/);
  });

  it("wears the dashboard's own tokens and component rules, scoped to the block", () => {
    expect(VUE).toContain('"../../../dashboard/tokens.css?raw"');
    expect(VUE).toContain('"../../../dashboard/components.css?raw"');
    expect(VUE).toContain("@scope (.map-replay)");
    expect(VUE).toContain('.replace(/^:root\\s*\\{/m, ".map-replay {")');
  });

  it("opens a folded group on a click, as /map does, and shows a tooltip on hover (a <title>)", () => {
    expect(VUE).toContain('e.target.closest("[data-group]")');
    expect(VUE).toContain('@click="onClick"');
    expect(SCENE_DOM).toContain("createElementNS(NS, 'title')");
  });
});

describe("the replay player", () => {
  it("one transport bar under the stage: play / pause, a speed per SPEEDS (1x to 60x) and a scrub range, on one clock", () => {
    expect(TRANSPORT).toContain('@click="toggle"');
    expect(TRANSPORT).toContain('v-for="s in speeds"');
    expect(TRANSPORT).toContain("const speeds = SPEEDS");
    expect(TRANSPORT).toContain('type="range"');
    expect(TRANSPORT).toContain('@input="scrub"');
    expect(STORE).toContain("advance(shared.at,");
    expect(STORE).toContain("requestAnimationFrame(frame)");
    // the map pane has no controls of its own: it only reads the clock
    expect(VUE).not.toContain('type="range"');
    expect(VUE).not.toContain("requestAnimationFrame(frame)");
    expect(SCENE).toContain("<Transport />");
  });

  it("loads one JSON file from the site itself: no server", () => {
    expect(SCENE).toContain('fetch(withBase("/replay/anyparse.json"))');
    for (const f of [VUE, SCENE, STORE]) {
      expect(f).not.toContain("EventSource");
      expect(f).not.toContain("/api/");
    }
  });

  it("the map never scrolls: scaled to its frame by the viewBox, a camera on the running lanes when it is taller", () => {
    expect(VUE).toContain("fitView(map.width, map.height, width, height)");
    expect(VUE).toContain("cameraTop(map, view.height)");
    expect(VUE).toContain('svg.value.setAttribute("viewBox"');
    expect(VUE).toContain("overflow: hidden");
    expect(VUE).not.toContain("scrollTop");
    expect(VUE).not.toContain("overflow: auto");
  });

  it("starts when it comes into view and not for a reader who asks for less motion", () => {
    expect(SCENE).toContain("IntersectionObserver");
    expect(SCENE).toContain("prefers-reduced-motion: reduce");
  });
});

describe("the landing page shows it", () => {
  it("the theme puts the component in the home hero's after-slot, outside the v-pre markdown", () => {
    expect(THEME).toContain('"home-hero-after": () => h(Scene)');
    expect(THEME).toContain("extends: DefaultTheme");
    expect(CONFIG).toContain('attrSet("v-pre"');
    expect(read("docs/index.md")).not.toContain("<MapReplay");
  });

  it("the build may import the engine's src/ and dashboard/, outside the docs root", () => {
    expect(CONFIG).toContain('fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] }');
  });

  it("the placeholder is gone and the hero image no longer competes with the map", () => {
    const page = read("docs/index.md");
    expect(page).not.toContain("Hero visual slot");
    expect(page.split("features:")[0]).not.toContain("image:");
  });
});

describe("docs:build compiles the landing with the replay", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("renders the block and ships the replay file beside the page", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "wf-site-"));
    dirs.push(out);
    execFileSync(
      "node",
      ["node_modules/vitepress/bin/vitepress.js", "build", "docs", "--outDir", out],
      { cwd: ROOT, stdio: "pipe" },
    );
    const page = fs.readFileSync(path.join(out, "index.html"), "utf8");
    expect(page).toContain("map-replay");
    expect(page).toContain("tr-play");
    expect(page).toContain("stage-frame");
    expect(fs.readFileSync(path.join(out, "replay", "anyparse.json"), "utf8")).toBe(
      read("docs/public/replay/anyparse.json"),
    );
    // the engine's own layout code (src/map-layout.ts) is in the page's bundle
    const scripts = fs
      .readdirSync(path.join(out, "assets"), { recursive: true, encoding: "utf8" })
      .filter(f => f.endsWith(".js"));
    expect(
      scripts.some(f =>
        fs.readFileSync(path.join(out, "assets", f), "utf8").includes("landed earlier:"),
      ),
    ).toBe(true);
  }, 120_000);
});
