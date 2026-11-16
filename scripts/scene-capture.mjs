// The landing page's scene as a headless page the recorders step by hand: builds the VitePress site, serves
// the build, opens `/?record` in headless Chromium (the page then hands over a `seek(ms)` hook instead of
// playing on its own clock) and restyles it so the scene fills a 1920x1080 frame. Shared by
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
    // the page chrome goes; the scene fills the frame at 1.5x (a 1280x720 layout drawn at 1920x1080)
    await page.addStyleTag({
      content: `
      .VPNav, .VPLocalNav, .VPHero, .VPFeatures, .VPFooter, .vp-doc, .mr-note, .mr-bar { display: none !important; }
      .VPContent, .VPHome { padding: 0 !important; margin: 0 !important; }
      html, body { overflow: hidden !important; }
      .scene { zoom: 1.5; width: 1280px !important; max-width: none !important; height: 720px; margin: 0 !important; padding: 16px !important; box-sizing: border-box; }
      .scene .mr-wrap { max-height: 688px !important; height: 688px; }
      .scene { grid-template-columns: 400px 1fr !important; }
      .scene .term-body { min-height: 650px; }
    `,
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    const durationMs = await page.evaluate(() => window.__replay.durationMs);
    return { page, durationMs, browser, close };
  } catch (e) {
    await close();
    throw e;
  }
}
