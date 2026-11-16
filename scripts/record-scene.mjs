#!/usr/bin/env node
// Re-records the landing page's scene (the terminal plan pane beside the live map, both driven by the replay
// of docs/public/replay/anyparse.json) into docs/media/scene.mp4 (1920x1080, for the voiced video) and
// docs/media/scene.gif (960 px wide, under 4 MB, for the README and social posts). One command:
//
//   npm run docs:record [-- --from <replay s> --seconds 15 --speed 120 --fps 30]
//
// It builds the site, serves the build, opens `/?record` in headless Chromium (the page then hands over a
// `seek(ms)` hook instead of playing on its own clock), steps the replay one frame at a time, so the result
// does not depend on how fast the machine renders, and encodes the frames with ffmpeg.
//
// Needs: the `playwright` devDependency and its Chromium (`npx playwright install chromium`; or point
// CHROME at a Chrome / Chromium executable), and ffmpeg (FFMPEG, default /opt/homebrew/bin/ffmpeg, else PATH).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.RECORD_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4173;
const GIF_LIMIT = 4 * 1024 * 1024;

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}
const from = option("from", 5400) * 1000; // ms into the replay
const seconds = option("seconds", 15);
const speed = option("speed", 120); // times real time
const fps = option("fps", 30);
const ffmpeg = process.env.FFMPEG ?? (fs.existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");

function run(cmd, args, what) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${what} failed:\n${(r.stderr || r.stdout || r.error?.message || "").slice(-2000)}`);
  return r;
}

let playwright;
try {
  playwright = await import("playwright");
} catch {
  console.error("playwright is not installed: npm install, then npx playwright install chromium (or set CHROME)");
  process.exit(1);
}
if (spawnSync(ffmpeg, ["-version"]).status !== 0) {
  console.error(`ffmpeg not found at ${ffmpeg} (set FFMPEG)`);
  process.exit(1);
}

console.log("building the site");
run("node", [path.join(ROOT, "node_modules/vitepress/bin/vitepress.js"), "build", "docs"], "docs build");
const server = spawn("node", [path.join(ROOT, "node_modules/vitepress/bin/vitepress.js"), "preview", "docs", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "ignore" });
const frames = fs.mkdtempSync(path.join(os.tmpdir(), "scene-frames-"));
let browser;
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
  const total = Math.round(seconds * fps);
  const end = await page.evaluate(() => window.__replay.durationMs);
  if (from + total * (speed * 1000 / fps) > end) throw new Error(`the window runs past the replay's end (${end} ms)`);
  for (let i = 0; i < total; i++) {
    await page.evaluate(ms => window.__replay.seek(ms), from + i * (speed * 1000 / fps));
    await page.screenshot({ path: path.join(frames, `f${String(i).padStart(5, "0")}.png`), clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  }
  await browser.close();
  browser = undefined;

  const out = path.join(ROOT, "docs/media");
  fs.mkdirSync(out, { recursive: true });
  const input = ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", path.join(frames, "f%05d.png")];
  run(ffmpeg, [...input, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", path.join(out, "scene.mp4")], "mp4 encode");
  // the GIF: 10 fps at 960 px, a palette of fewer colors until it fits under the limit
  let size = 0;
  for (const colors of [128, 64, 32, 16]) {
    const filter = `fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
    run(ffmpeg, [...input, "-vf", filter, "-loop", "0", path.join(out, "scene.gif")], "gif encode");
    size = fs.statSync(path.join(out, "scene.gif")).size;
    if (size < GIF_LIMIT) break;
  }
  const kb = f => `${Math.round(fs.statSync(path.join(out, f)).size / 1024)} KB`;
  console.log(`scene.mp4 ${kb("scene.mp4")} (${seconds} s, 1920x1080, ${fps} fps)  scene.gif ${kb("scene.gif")} (960 px)`);
  if (size >= GIF_LIMIT) {
    console.error("the GIF is over 4 MB at 16 colors: shorten --seconds");
    process.exitCode = 1;
  }
} finally {
  await browser?.close();
  server.kill();
  fs.rmSync(frames, { recursive: true, force: true });
}
