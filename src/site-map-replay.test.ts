import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { setTerminal, shared, toggleZoom } from "../docs/.vitepress/theme/replay-store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const VUE = read("docs/.vitepress/theme/MapReplay.vue");
const SCENE = read("docs/.vitepress/theme/Scene.vue");
const STORE = read("docs/.vitepress/theme/replay-store.ts");
const TRANSPORT = read("docs/.vitepress/theme/Transport.vue");
const WINDOW = read("docs/.vitepress/theme/TerminalWindow.vue");
const THEME = read("docs/.vitepress/theme/index.ts");
const CONFIG = read("docs/.vitepress/config.mts");
const DASH_CSS = read("docs/.vitepress/theme/dashboard-css.ts");
const POOL_STRIP = read("docs/.vitepress/theme/PoolStrip.vue");
const POOL_DEMO = read("docs/.vitepress/theme/PoolDemo.vue");
const TOKENS = read("dashboard/tokens.css");
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
    expect(VUE).toContain("useDashboardCss()");
    expect(VUE).toContain(':class="DASH"');
    expect(DASH_CSS).toContain('"../../../dashboard/tokens.css?raw"');
    expect(DASH_CSS).toContain('"../../../dashboard/components.css?raw"');
    expect(DASH_CSS).toContain("@scope (.${DASH})");
    expect(DASH_CSS).toContain(".replace(/^:root\\s*\\{/m, `.${DASH} {`)");
  });

  it("the landing's stage follows the site's theme: map and pool strip wear the tokens, the terminal has its own light and dark palettes", () => {
    const literal = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/;
    // the strip is a `.dash` element, so it takes the light or the dark set with `html.dark`, as the map above it
    expect(SCENE).toContain('class="stage-strip" :class="DASH"');
    expect(SCENE).toContain("onMounted(async () => {\n  useDashboardCss();");
    // the frame and the strip's border read a token or VitePress's own variable, never a colour of their own
    const style = SCENE.slice(SCENE.indexOf("<style>"));
    expect(style).not.toMatch(literal);
    expect(style).toContain("border-top: 1px solid var(--panel-border);");
    // the dashboard's `*` reset must not reach the terminal: `.dash` is on the strip, not on the frame or the stage
    expect(SCENE).not.toMatch(/class="stage(?:-frame)?"[^>]*:class="DASH"/);
    const terminal = read("docs/.vitepress/theme/TerminalWindow.vue");
    expect(terminal).not.toContain("DASH");
    // the window itself follows the site's theme (src/site-terminal-light.test.ts pins its palettes)
    expect(read("docs/.vitepress/theme/terminal-palette.css")).toContain(
      "html:not(.dark) .term-surface {\n  --cc-bg: rgba(255, 255, 255, 0.94);",
    );
    // the strip: every colour it draws is a --ps-* variable; dark by default, the dashboard's tokens under `.dash`
    const body = (sel: string): string =>
      new RegExp(`${sel.replaceAll(".", "\\.")} \\{([^}]*)\\}`).exec(POOL_STRIP)?.[1] ?? "";
    const defaults = [...body(".pool-strip").matchAll(/(--ps-[\w-]+):\s*([^;]+);/g)];
    const mapped = new Map(
      [...body(".dash .pool-strip").matchAll(/(--ps-[\w-]+):\s*var\((--[\w-]+)\);/g)].map(m => [
        m[1],
        m[2],
      ]),
    );
    expect(defaults.length).toBeGreaterThanOrEqual(10);
    expect([...mapped.keys()]).toEqual(defaults.map(m => m[1]));
    for (const token of mapped.values()) expect(TOKENS).toContain(`${token}:`);
    const rules = POOL_STRIP.slice(POOL_STRIP.indexOf(".ps-title"));
    expect(rules).not.toMatch(literal);
    expect(rules.match(/var\(--ps-/g)?.length).toBeGreaterThanOrEqual(10);
    // `.dash` on the strip pulls it under the dashboard's `svg text { font-family }`; the labels name the monospace face themselves
    expect(POOL_STRIP).toContain(
      ".pool-strip text {\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n}",
    );
    // the Pool page keeps the strip in its own terminal panel (src/site-terminal-light.test.ts pins its themes): no `.dash` there
    expect(POOL_DEMO).not.toContain("DASH");
    expect(POOL_DEMO).toContain("background: var(--cc-panel);");
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
    expect(THEME).toContain('"home-hero-after": () => [h(Scene), h(Install)]');
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
    // the live graphs and the status line are in the landing, the workflow definitions ship beside it
    expect(page).toContain('class="wfg dash"');
    expect(page).toContain("sl-term");
    expect(fs.readFileSync(path.join(out, "workflows.json"), "utf8")).toBe(
      read("docs/public/workflows.json"),
    );
    expect(page).toContain("tr-play");
    expect(page).toContain("stage-frame");
    // the hero (src/site-hero.test.ts pins its source; one build serves both, two would share docs/.vitepress/.temp)
    const templates = fs.readdirSync(path.join(ROOT, "templates")).filter(f => f.endsWith(".yaml"));
    expect(page).toContain('class="hero"');
    expect(page).toContain(`${templates.length} workflows`);
    expect(page).toMatch(/class="Layout[^"]*has-hero/);
    expect(page).toContain('<span class="brand-a">Claude</span> Workflow');
    expect(fs.readFileSync(path.join(out, "concepts.html"), "utf8")).not.toContain("has-hero");
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

describe("the site's preview and the file map", () => {
  it("docs:preview rebuilds before it serves the git-ignored, long-lived dist", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const script = pkg.scripts["docs:preview"] ?? "";
    // a preview of docs/.vitepress/dist alone shows the build of an older source
    expect(script).toMatch(/^npm run docs:build && vitepress preview docs$/);
    expect(read(".gitignore")).toContain("docs/.vitepress/dist/");
    expect(read("docs/development.md")).toContain("`npm run docs:preview`");
  });

  it("CLAUDE.md maps src/replay.ts, scripts/export-replay.mjs and dashboard/scene-dom.js", () => {
    const rows = read("CLAUDE.md").split("\n");
    for (const file of ["replay.ts", "scripts/export-replay.mjs", "dashboard/scene-dom.js"]) {
      expect(rows.some(r => r.startsWith(`| \`${file}\` |`))).toBe(true);
    }
  });
});

describe("the recorder's ?record hook on the production site", () => {
  it("is one assignment, only on a `?record` URL, handing over nothing but seek and the duration", () => {
    const assigns = SCENE.match(/\.__replay = /g) ?? [];
    expect(assigns).toHaveLength(1);
    expect(SCENE).toContain('if (location.search.includes("record")) {');
    expect(SCENE).toContain("__replay = { seek, durationMs: shared.duration };");
    // the claim in the changelog and beside the hook: it is left in on purpose, not gated by a build flag
    expect(SCENE).toContain("left in the production");
    expect(read("CHANGELOG.md")).toContain("stays in the production build on purpose");
  });
});

describe("the plan pane's Landed day row", () => {
  it("says `landed` beside its count when its sum includes failed or closed lines that are not rows", () => {
    const pane = read("hooks/pane-view.ts");
    expect(pane).toContain("spend.failed + spend.closed > 0 ? ' landed' : ''");
  });

  it("the window's traffic lights work: close and minimise hide it into the Terminal button, green and a title double-click zoom it", () => {
    const button = (cls: string): string =>
      new RegExp(`<button[^>]*class="dot ${cls}"[^>]*>`).exec(WINDOW)?.[0] ?? "";
    // real buttons with a name each, not painted dots
    expect(button("r")).toContain('@click="setTerminal(false)"');
    expect(button("r")).toContain("aria-label=");
    expect(button("y")).toContain('@click="setTerminal(false)"');
    expect(button("y")).toContain("aria-label=");
    expect(button("g")).toContain('@click="toggleZoom"');
    expect(button("g")).toContain(":aria-label=");
    expect(WINDOW).toContain('<div class="cc-title" @dblclick="toggleZoom">');
    // a double-click on a light is not also a double-click on the title bar
    expect(WINDOW).toContain('<span class="lights" @dblclick.stop>');
    // the glyphs show on hover of the group or when a button has the keyboard
    expect(WINDOW).toContain(".lights:hover .glyph,\n.lights:focus-within .glyph {\n  opacity: 1;");
    // zoomed fills the stage; the minimise is a transition of the same v-show the pill flips, plain under reduced motion
    expect(WINDOW).toContain(':class="{ zoomed: shared.zoom }"');
    expect(WINDOW).toContain("width: 1920px;\n  height: 1080px;");
    expect(SCENE).toContain(
      '<Transition name="cc-minimise"><TerminalWindow v-show="shared.terminal" /></Transition>',
    );
    // the rule that turns the zoom's own transition off sits in the scoped block, after the base rule it must beat
    const scoped = WINDOW.slice(0, WINDOW.indexOf("</style>"));
    const base = scoped.indexOf(".cc-window {\n  position: absolute;");
    const reducedAt = scoped.indexOf(
      "@media (prefers-reduced-motion: reduce) {\n  .cc-window {\n    transition: none;",
    );
    expect(base).toBeGreaterThanOrEqual(0);
    expect(reducedAt).toBeGreaterThan(base);
    // and the minimise's enter and leave rules are off under it too
    const reduced = WINDOW.slice(WINDOW.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".cc-window.cc-minimise-leave-active {\n    transition: none;");
    // the pill, the T key and the lights share one switch; Esc leaves zoom
    expect(TRANSPORT).toContain('@click="setTerminal(!shared.terminal)"');
    expect(SCENE).toContain("else setTerminal(!shared.terminal);");
    expect(SCENE).toContain('if (e.key === "Escape") {\n    if (shared.zoom) toggleZoom();');
  });

  it("hiding the window also ends its zoom, so it comes back in place", () => {
    shared.terminal = true;
    shared.zoom = false;
    toggleZoom();
    expect(shared.zoom).toBe(true);
    setTerminal(false);
    expect(shared.terminal).toBe(false);
    expect(shared.zoom).toBe(false);
    setTerminal(true);
    expect(shared.terminal).toBe(true);
    expect(shared.zoom).toBe(false);
    toggleZoom();
    toggleZoom();
    expect(shared.zoom).toBe(false);
  });
});
