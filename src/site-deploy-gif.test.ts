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
const PANE = read("docs/.vitepress/theme/TerminalPane.vue");
const MAP = read("docs/.vitepress/theme/MapReplay.vue");
const SCENE = read("docs/.vitepress/theme/Scene.vue");
const THEME = read("docs/.vitepress/theme/index.ts");
const RECORD = read("scripts/record-scene.mjs");
const PAGES = read(".github/workflows/pages.yml");

describe("the scene: the terminal pane and the map on one replay clock", () => {
  it("the pane draws from planAt at the shared position, not from a clock of its own", () => {
    expect(PANE).toContain("planAt(shared.file, shared.at)");
    expect(PANE).not.toContain("requestAnimationFrame");
    expect(read("docs/.vitepress/theme/replay-store.ts")).toContain("reactive<");
  });

  it("the map player publishes the file and every position to the store", () => {
    expect(MAP).toContain("shared.file = file");
    expect(MAP).toContain("shared.at = v");
  });

  it("the landing mounts both side by side in the hero's after-slot", () => {
    expect(SCENE).toContain("<TerminalPane />");
    expect(SCENE).toContain("<MapReplay />");
    expect(THEME).toContain('"home-hero-after": () => h(Scene)');
  });

  it("the pane has Running, Next and Landed rows with difficulty bars", () => {
    expect(PANE).toContain("▶ Running");
    expect(PANE).toContain("⏭ Next");
    expect(PANE).toContain("✓ Landed");
    expect(PANE).toContain("difficultyCells(row.difficulty)");
  });
});

describe("the recorder", () => {
  it("steps the replay by frame through the page's seek hook (?record), so the output does not depend on render speed", () => {
    expect(MAP).toContain('location.search.includes("record")');
    expect(MAP).toContain("__replay");
    expect(RECORD).toContain("window.__replay.seek(ms)");
    expect(RECORD).toContain("/claude-workflow/?record");
  });

  it("writes a 1920x1080 mp4 and a 960 px GIF under 4 MB with ffmpeg, into docs/media", () => {
    expect(RECORD).toContain("width: 1920, height: 1080");
    expect(RECORD).toContain("scale=960:-1");
    expect(RECORD).toContain("const GIF_LIMIT = 4 * 1024 * 1024");
    expect(RECORD).toContain('"scene.mp4"');
    expect(RECORD).toContain('"scene.gif"');
    expect(RECORD).toContain("/opt/homebrew/bin/ffmpeg");
  });

  it("is one command and needs the playwright devDependency", () => {
    expect(PKG.scripts["docs:record"]).toBe("node scripts/record-scene.mjs");
    expect(PKG.devDependencies.playwright).toBeDefined();
  });

  it("the committed media exist, the GIF under the limit", () => {
    expect(fs.statSync(path.join(ROOT, "docs/media/scene.gif")).size).toBeLessThan(4 * 1024 * 1024);
    expect(fs.statSync(path.join(ROOT, "docs/media/scene.mp4")).size).toBeGreaterThan(1000);
  });
});

describe("the Pages workflow", () => {
  it("builds the site on a push to master and deploys it with the Pages actions", () => {
    expect(PAGES).toContain("branches: [master]");
    expect(PAGES).toContain("npm run docs:build");
    expect(PAGES).toContain("path: docs/.vitepress/dist");
    expect(PAGES).toContain("actions/deploy-pages@v4");
    expect(PAGES).toContain("pages: write");
    expect(PAGES).toContain("id-token: write");
  });
});
