import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const PKG = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const WINDOW = read("docs/.vitepress/theme/TerminalWindow.vue");
const DRAWER = read("docs/.vitepress/theme/PaneView.vue");
const MOD = read("hooks/plan-pane.tsx");
const SHARED = read("hooks/pane-view.ts");
const STORE = read("docs/.vitepress/theme/replay-store.ts");
const MAP = read("docs/.vitepress/theme/MapReplay.vue");
const SCENE = read("docs/.vitepress/theme/Scene.vue");
const THEME = read("docs/.vitepress/theme/index.ts");
const RECORD = read("scripts/record-scene.mjs") + read("scripts/scene-capture.mjs");
const PAGES = read(".github/workflows/pages.yml");

describe("the scene: one stage, the map under the Claude Code window, one replay clock", () => {
  it("the plan pane is the mod's own code: one pure module both draw, no second copy of its rows", () => {
    // the mod draws the shared tree with Claude Code's elements
    expect(MOD).toContain("from './pane-view'");
    expect(MOD).toContain("paneTree({");
    // the site draws the same tree in the DOM, from the Snapshot the replay's events build
    expect(WINDOW).toContain('from "../../../hooks/pane-view"');
    expect(WINDOW).toContain("snapshotAt(shared.file, shared.at)");
    expect(WINDOW).toContain("paneTree({");
    // the sections are written once, in the shared module
    expect(SHARED).toContain("▶ Running");
    expect(SHARED).toContain("⏭ Next");
    for (const f of [MOD, WINDOW, DRAWER]) {
      expect(f).not.toContain("▶ Running");
      expect(f).not.toContain("⏭ Next");
      expect(f).not.toContain("'▰'");
    }
    expect(SHARED).not.toContain("from 'claude-code'");
  });

  it("the window and the map read the one clock, neither keeps its own", () => {
    expect(WINDOW).not.toContain("requestAnimationFrame");
    expect(MAP).not.toContain("advance(");
    expect(STORE).toContain("reactive<");
    expect(STORE).toContain("shared.file = file");
  });

  it("the landing mounts a 16:9 stage of 1920x1080 scaled to the page, the window over the map, the T toggle", () => {
    expect(SCENE).toContain("<MapReplay />");
    expect(SCENE).toContain('<TerminalWindow v-show="shared.terminal" />');
    expect(SCENE).toContain("const STAGE_W = 1920;");
    expect(SCENE).toContain("const STAGE_H = 1080;");
    expect(SCENE).toContain("aspect-ratio: 16 / 9");
    expect(SCENE).toContain('e.key !== "t" && e.key !== "T"');
    expect(THEME).toContain('"home-hero-after": () => [h(Scene), h(Install)]');
    expect(WINDOW).toContain("backdrop-filter: blur(");
  });

  it("keys the window's conversation lines by their index in the whole conversation, not by their own fields", () => {
    expect(WINDOW).toContain("conversationTail(shared.file, shared.at, LINES_SHOWN)");
    expect(WINDOW).toContain(':key="l.key"');
    expect(WINDOW).not.toContain("${l.at}-${l.kind}");
  });
});

describe("the recorder", () => {
  it("steps the replay by frame through the page's seek hook (?record), so the output does not depend on render speed", () => {
    expect(SCENE).toContain('location.search.includes("record")');
    expect(SCENE).toContain("__replay");
    // the recorders capture the landing's own stage at scale 1, not a restyled layout of their own
    expect(RECORD).toContain(".stage-frame { position: fixed !important;");
    expect(RECORD).toContain('style.transform === "scale(1)"');
    expect(RECORD).toContain("window.__replay.seek(ms)");
    expect(RECORD).toContain("/claude-workflow/?record");
  });

  it("writes a 960 px GIF under 4 MB with ffmpeg into docs/media, and an mp4 only with --mp4, into a git-ignored directory", () => {
    expect(RECORD).toContain("width: 1920, height: 1080");
    expect(RECORD).toContain("scale=960:-1");
    expect(RECORD).toContain("const GIF_LIMIT = 4 * 1024 * 1024");
    expect(RECORD).toContain('"scene.gif"');
    expect(RECORD).toContain('process.argv.includes("--mp4")');
    expect(RECORD).toContain('path.join(ROOT, "video/out/scene.mp4")');
    expect(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8")).toContain("video/out/");
    expect(RECORD).toContain("/opt/homebrew/bin/ffmpeg");
  });

  it("is one command and needs the playwright devDependency", () => {
    expect(PKG.scripts["docs:record"]).toBe("node scripts/record-scene.mjs");
    expect(PKG.devDependencies.playwright).toBeDefined();
  });

  it("the committed GIF is under the limit and no mp4 is committed beside it", () => {
    expect(fs.statSync(path.join(ROOT, "docs/media/scene.gif")).size).toBeLessThan(4 * 1024 * 1024);
    expect(fs.existsSync(path.join(ROOT, "docs/media/scene.mp4"))).toBe(false);
  });
});

describe("the Pages workflow", () => {
  it("builds the site on a push to master and deploys it with the Pages actions", () => {
    expect(PAGES).toContain("branches: [master]");
    expect(PAGES).toContain("npm run docs:build");
    expect(PAGES).toContain("path: docs/.vitepress/dist");
    expect(PAGES).toContain("actions/deploy-pages@v5");
    expect(PAGES).toContain("pages: write");
    expect(PAGES).toContain("id-token: write");
  });
});
