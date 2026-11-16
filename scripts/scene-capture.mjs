// The landing page's scene as a headless page the recorders step by hand: builds the VitePress site, serves
// the build, opens `/?record` in headless Chromium (the page then hands over a `seek(ms)` hook instead of
// playing on its own clock) and restyles it so the scene's stage — the SAME 16:9 stage the landing shows, the map
// with the Claude Code window over it, drawn at 1920x1080 — fills the frame at scale 1. Shared by
// scripts/record-scene.mjs (the GIF / mp4) and video/render.mjs (the voiced video): one owner of "draw the scene".
//
// Needs: the `playwright` devDependency and its Chromium (`npx playwright install chromium`; or point
// CHROME at a Chrome / Chromium executable), and ffmpeg (FFMPEG, default /opt/homebrew/bin/ffmpeg, else PATH).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = process.env.RECORD_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4173;

export const ffmpeg = process.env.FFMPEG ?? (fs.existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");

/** Runs a command to completion in the repo root; throws with the tail of its output when it fails. */
export function run(cmd, args, what) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${what} failed:\n${(r.stderr || r.stdout || r.error?.message || "").slice(-2000)}`);
  return r;
}

/** Exits with a message when ffmpeg is missing. */
export function requireFfmpeg() {
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) {
    console.error(`ffmpeg not found at ${ffmpeg} (set FFMPEG)`);
    process.exit(1);
  }
}

/** Builds and serves the site and opens the scene: `{ page, durationMs, playwright, browser, close }`. */
export async function openScene() {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    console.error("playwright is not installed: npm install, then npx playwright install chromium (or set CHROME)");
    process.exit(1);
  }
  console.log("building the site");
  const vitepress = path.join(ROOT, "node_modules/vitepress/bin/vitepress.js");
  run("node", [vitepress, "build", "docs"], "docs build");
  const server = spawn("node", [vitepress, "preview", "docs", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "ignore" });
  let browser;
  const close = async () => {
    await browser?.close();
    server.kill();
  };
  try {
    const url = `http://127.0.0.1:${PORT}/claude-workflow/?record`;
    for (let i = 0; i < 60; i++) {
      if (await fetch(url).then(r => r.ok, () => false)) break;
      await new Promise(r => setTimeout(r, 250));
    }
    browser = await playwright.chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
    await page.goto(url);
    await page.waitForFunction(() => window.__replay !== undefined, null, { timeout: 30000 });
    // the page chrome and the transport bar go; the stage is pinned to the frame at its own 1920x1080 (scale 1)
    await page.addStyleTag({
      content: `
      .VPNav, .VPLocalNav, .VPHero, .VPFeatures, .VPFooter, .vp-doc, .transport, .scene-note { display: none !important; }
      html, body { overflow: hidden !important; }
      .stage-frame { position: fixed !important; left: 0 !important; top: 0 !important; width: 1920px !important; height: 1080px !important; border: 0 !important; border-radius: 0 !important; z-index: 1000; }
    `,
    });
    await page.waitForFunction(() => document.querySelector(".stage")?.style.transform === "scale(1)", null, { timeout: 10000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const durationMs = await page.evaluate(() => window.__replay.durationMs);
    return { page, durationMs, browser, close };
  } catch (e) {
    await close();
    throw e;
  }
}
