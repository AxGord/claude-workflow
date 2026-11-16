#!/usr/bin/env node
// Re-renders the two images the repository shows about itself, from the site's own data instead of by hand:
// docs/banner.png (1200x400, the README's width) and docs/social-preview.png (1280x640, the size GitHub asks of a
// repository's social preview). One command:
//
//   npm run docs:banner [-- --at <replay s>]
//
// On the left, the site's name and tagline (docs/index.md's hero) and chips: the engine, the bundled workflows
// (counted from templates/, so the number is never typed), the thread pool, the task queue, the live map. On the
// right, a REAL frame of the landing's scene at a chosen moment of the replay: the stage scripts/scene-capture.mjs
// renders (map, plan pane and thread-pool strip), captured at 1920x1080 and placed as a picture.
//
// Needs: the `playwright` devDependency and its Chromium (`npx playwright install chromium`; or point CHROME at a
// Chrome / Chromium executable). It builds the site (see scene-capture.mjs).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { ROOT, openScene } from "./scene-capture.mjs";

/** The replay moment (seconds in) the scene is captured at: pool strip busy, the plan pane's lanes running. */
export const DEFAULT_AT = 5400;

/** The two outputs: size, and where the scene frame sits (it bleeds off the right edge). */
export const VARIANTS = [
  {
    file: "docs/banner.png",
    width: 1200,
    height: 400,
    scene: { left: 570, top: 23, width: 630 },
    text: { left: 56, width: 500, title: 50, tagline: 19, chips: 12 },
  },
  {
    file: "docs/social-preview.png",
    width: 1280,
    height: 640,
    scene: { left: 470, top: 95, width: 810 },
    text: { left: 64, width: 380, title: 60, tagline: 22, chips: 15 },
  },
];

/** Names of the bundled workflows: every `templates/*.yaml`, the files the loader's bundled tier reads. */
export function templateNames(root = ROOT) {
  return fs
    .readdirSync(path.join(root, "templates"))
    .filter(f => f.endsWith(".yaml"))
    .map(f => f.slice(0, -".yaml".length))
    .sort();
}

/** The hero of the landing page (docs/index.md frontmatter): `{ name, tagline }`. */
export function readHero(root = ROOT) {
  const text = fs.readFileSync(path.join(root, "docs/index.md"), "utf8");
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  const hero = front ? parse(front[1]).hero : undefined;
  if (!hero?.name || !hero?.tagline) throw new Error("docs/index.md has no hero name and tagline");
  return { name: String(hero.name), tagline: String(hero.tagline) };
}

/** What the banner says: the hero and the chips (the workflow count is the count of templates/). */
export function bannerSpec(root = ROOT) {
  const { name, tagline } = readHero(root);
  const workflows = templateNames(root).length;
  return {
    name,
    tagline,
    chips: [
      { text: "FSM engine", tone: "blue" },
      { text: `${workflows} workflows`, tone: "green" },
      { text: "Thread pool", tone: "purple" },
      { text: "Task queue", tone: "amber" },
      { text: "Live map", tone: "blue" },
    ],
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** What the image says, as the text chunk it carries: a test reads it back to tell a stale image from a current one. */
export function stampText(spec) {
  const json = JSON.stringify({ name: spec.name, tagline: spec.tagline, chips: spec.chips.map(c => c.text) });
  return json.replace(/[^\x00-\x7f]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`); // latin1-safe
}

/** The PNG with a `Description` text chunk (the stamp) inserted before its first IDAT. */
export function stampPng(png, text) {
  const body = Buffer.concat([Buffer.from("Description\0", "latin1"), Buffer.from(text, "latin1")]);
  const chunk = Buffer.alloc(12 + body.length);
  chunk.writeUInt32BE(body.length, 0);
  chunk.write("tEXt", 4, "latin1");
  body.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + body.length)), 8 + body.length);
  const at = png.indexOf("IDAT") - 4;
  return Buffer.concat([png.subarray(0, at), chunk, png.subarray(at)]);
}

/** The size and the stamp of a PNG written by this script (`text` is undefined when it has none). */
export function readPng(png) {
  let text;
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    if (type === "tEXt") {
      const data = png.toString("latin1", at + 8, at + 8 + len);
      if (data.startsWith("Description\0")) text = data.slice("Description\0".length);
    }
    at += 12 + len;
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), text };
}

const escapeHtml = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The page of one variant; `sceneUri` is the captured stage frame as a data URI. */
export function bannerHtml(spec, variant, sceneUri) {
  const { width, height, scene, text } = variant;
  const [first, ...rest] = spec.name.split(" ");
  const sceneH = Math.round((scene.width * 9) / 16);
  const chips = spec.chips.map(c => `<span class="chip ${c.tone}">${escapeHtml(c.text)}</span>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${width}px;height:${height}px;overflow:hidden}
body{position:relative;background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Helvetica,Arial,sans-serif}
.glow{position:absolute;inset:0;background:radial-gradient(ellipse at 72% 55%,rgba(63,185,80,.13),transparent 55%),radial-gradient(ellipse at 90% 10%,rgba(88,166,255,.12),transparent 50%)}
.text{position:absolute;left:${text.left}px;width:${text.width}px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center}
h1{font-size:${text.title}px;line-height:1.08;font-weight:800;letter-spacing:-.02em}
h1 .a{background:linear-gradient(90deg,#58a6ff,#3fb950);-webkit-background-clip:text;background-clip:text;color:transparent}
p{margin-top:${Math.round(text.tagline * 0.7)}px;font-size:${text.tagline}px;line-height:1.4;color:#8b949e}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:${Math.round(text.tagline * 1.1)}px}
.chip{font-size:${text.chips}px;line-height:1;padding:${Math.round(text.chips * 0.5)}px ${Math.round(text.chips * 0.9)}px;border-radius:999px;border:1px solid}
.blue{color:#58a6ff;background:rgba(88,166,255,.1);border-color:rgba(88,166,255,.35)}
.green{color:#3fb950;background:rgba(63,185,80,.1);border-color:rgba(63,185,80,.35)}
.purple{color:#bc8cff;background:rgba(188,140,255,.1);border-color:rgba(188,140,255,.35)}
.amber{color:#d29922;background:rgba(210,153,34,.1);border-color:rgba(210,153,34,.35)}
.scene{position:absolute;left:${scene.left}px;top:${scene.top}px;width:${scene.width}px;height:${sceneH}px;border-radius:12px 0 0 12px;border:1px solid #30363d;border-right:0;box-shadow:0 12px 48px rgba(0,0,0,.55);display:block}
</style></head><body><div class="glow"></div>
<div class="text"><h1><span class="a">${escapeHtml(first)}</span> ${escapeHtml(rest.join(" "))}</h1><p>${escapeHtml(spec.tagline)}</p><div class="chips">${chips}</div></div>
<img class="scene" src="${sceneUri}" alt="">
</body></html>`;
}

async function main() {
  const i = process.argv.indexOf("--at");
  const at = (i === -1 ? DEFAULT_AT : Number(process.argv[i + 1])) * 1000;
  if (!Number.isFinite(at)) throw new Error("--at takes a number of replay seconds");
  const spec = bannerSpec();
  let scene;
  try {
    scene = await openScene();
    if (at > scene.durationMs) throw new Error(`--at runs past the replay's end (${scene.durationMs} ms)`);
    await scene.page.evaluate(ms => window.__replay.seek(ms), at);
    const frame = await scene.page.screenshot({ clip: { x: 0, y: 0, width: 1920, height: 1080 } });
    const sceneUri = `data:image/png;base64,${frame.toString("base64")}`;
    for (const variant of VARIANTS) {
      const page = await scene.browser.newPage({ viewport: { width: variant.width, height: variant.height }, colorScheme: "dark" });
      await page.setContent(bannerHtml(spec, variant, sceneUri));
      const png = await page.screenshot({ clip: { x: 0, y: 0, width: variant.width, height: variant.height } });
      fs.writeFileSync(path.join(ROOT, variant.file), stampPng(png, stampText(spec)));
      await page.close();
      const kb = Math.round(fs.statSync(path.join(ROOT, variant.file)).size / 1024);
      console.log(`${variant.file} ${variant.width}x${variant.height} ${kb} KB`);
    }
  } finally {
    await scene?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(`render-banner: ${err.message}`);
    process.exit(1);
  });
}
