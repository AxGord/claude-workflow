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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, ffmpeg, openScene, requireFfmpeg, run } from "./scene-capture.mjs";

const GIF_LIMIT = 4 * 1024 * 1024;

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}
const from = option("from", 5400) * 1000; // ms into the replay
const seconds = option("seconds", 15);
const speed = option("speed", 120); // times real time
const fps = option("fps", 30);

requireFfmpeg();
const frames = fs.mkdtempSync(path.join(os.tmpdir(), "scene-frames-"));
let scene;
try {
  scene = await openScene();
  const { page } = scene;
  const total = Math.round(seconds * fps);
  const end = scene.durationMs;
  if (from + total * (speed * 1000 / fps) > end) throw new Error(`the window runs past the replay's end (${end} ms)`);
  for (let i = 0; i < total; i++) {
    await page.evaluate(ms => window.__replay.seek(ms), from + i * (speed * 1000 / fps));
    await page.screenshot({ path: path.join(frames, `f${String(i).padStart(5, "0")}.png`), clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  }
  await scene.close();
  scene = undefined;

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
  await scene?.close();
  fs.rmSync(frames, { recursive: true, force: true });
}
