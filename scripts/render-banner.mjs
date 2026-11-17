#!/usr/bin/env node
// Re-renders what the repository shows about itself, from the site's own data instead of by hand: the brand
// (logo 2, the live map: a dispatcher fanning out into three lanes) as docs/public/logo.svg, logo-light.svg and
// favicon.svg, and the two images docs/banner.png (1200x400, the README's width) and docs/social-preview.png
// (1280x640, the size GitHub asks of a repository's social preview). One command:
//
//   npm run docs:banner [-- --at <replay s>]   (default: the first moment with three priced Landed rows)
//
// The banner: the logo, the site's name and tagline (docs/index.md's hero) and one line of what the product is made of
// (the bundled workflows counted from templates/, so the number is never typed) on the left; a schematic of a task's
// life (queue, think, code, review, land, the gates between them, the fix loop, the thread pool with its waiting
// agents) on the right; behind both, a blurred, dimmed crop of a REAL frame of the landing's scene at a chosen
// moment of the replay (the stage scripts/scene-capture.mjs renders: map, plan pane, thread-pool strip), weaker in
// the README's size so the schematic reads first. The SVG drawings below are this script's own templates.
//
// Needs: the `playwright` devDependency and its Chromium (`npx playwright install chromium`; or point CHROME at a
// Chrome / Chromium executable). It builds the site (see scene-capture.mjs).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { ROOT, openScene } from "./scene-capture.mjs";
import { DARK, LIGHT, logoMark, logoSvg, faviconSvg } from "./brand.mjs";

export { DARK, LIGHT, logoMark, logoSvg, faviconSvg };

/** How many Landed rows (each with its spend) the default moment shows: enough to read as a plan pane that has been working. */
export const DEFAULT_LANDED_ROWS = 3;

/** The replay the site plays, as `npm run docs:replay` exports it. */
export const REPLAY_FILE = "docs/public/replay/anyparse.json";

/**
 * The replay moment (seconds in) the scene is captured at: the first second at which the plan pane shows at least
 * `rows` Landed rows that carry a price (a root session with a task that moved through `land`, ended completed, and
 * has an entry in the file's `spend`, as `snapshotAt` in src/replay.ts counts them). Read from the replay itself, so a
 * re-export that moves the lands moves the banner with it; throws when the replay never gets that far.
 */
export function defaultAt(file, rows = DEFAULT_LANDED_ROWS) {
  const ids = new Set(file.sessions);
  const seen = new Map();
  const ends = [];
  for (const [ts, kind, s, data] of file.events) {
    if (kind === "session_start") {
      const root = !(typeof data?.parent === "string" && ids.has(data.parent));
      seen.set(s, { task: root && typeof data?.task === "string" ? data.task : "", landed: false });
      continue;
    }
    const r = seen.get(s);
    if (r === undefined || r.task === "") continue;
    if (kind === "transition" && data?.to === "land") r.landed = true;
    else if (kind === "session_end" && data?.outcome === "completed" && r.landed && typeof file.spend?.[r.task] === "number") ends.push(ts);
  }
  if (ends.length < rows) throw new Error(`the replay lands ${ends.length} priced tasks, fewer than the ${rows} the banner's default moment needs`);
  ends.sort((a, b) => a - b);
  return Math.ceil(ends[rows - 1] / 1000);
}

/** The look of the brand: bump it when the drawing changes, so an image rendered by the old one reads as stale. */
export const DESIGN = "schematic-over-scene-logo-2";

/**
 * The two outputs. `bg` is the scene crop behind them: its box, its blur and its opacity (the README's size is the
 * weaker one, its schematic sits right over the picture); `fade` is the direction it dissolves into the page
 * colour. `head` is the logo, the name, the tagline and the chips; `schematic` the drawing's box (it is 660x240
 * in its own units).
 */
export const VARIANTS = [
  {
    file: "docs/banner.png",
    width: 1200,
    height: 400,
    bg: { left: 280, top: -60, width: 980, blur: 5, opacity: 0.24, fade: "to right" },
    head: { align: "left", left: 60, width: 420, logo: 72, title: 46, tagline: 18, chips: 12 },
    schematic: { left: 500, top: 76, scale: 1 },
  },
  {
    file: "docs/social-preview.png",
    width: 1280,
    height: 640,
    bg: { left: -40, top: 150, width: 1360, blur: 1.5, opacity: 0.17, fade: "to bottom" },
    head: { align: "center", left: 0, width: 1280, logo: 80, title: 60, tagline: 23, chips: 16, top: 46 },
    schematic: { left: 217, top: 300, scale: 1.28 },
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
  const json = JSON.stringify({ design: DESIGN, name: spec.name, tagline: spec.tagline, chips: spec.chips.map(c => c.text) });
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

const FONT = `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Helvetica, Arial, sans-serif`;

/** The brand's own files, as `{ file, svg }`: written beside the images, so the site's logo and favicon are never drawn by hand. */
export function brandFiles() {
  return [
    { file: "docs/public/logo.svg", svg: logoSvg(DARK) },
    { file: "docs/public/logo-light.svg", svg: logoSvg(LIGHT) },
    { file: "docs/public/favicon.svg", svg: faviconSvg() },
  ];
}

const c = DARK;
const arrowHead = (x, y, col, dir = "right", s = 7) =>
  dir === "right"
    ? `<path d="M${x - s} ${y - s * 0.75} L${x} ${y} L${x - s} ${y + s * 0.75} Z" fill="${col}"/>`
    : `<path d="M${x - s * 0.75} ${y - s} L${x} ${y} L${x + s * 0.75} ${y - s} Z" fill="${col}"/>`;
const gate = (x, y) =>
  `<rect x="${x - 7}" y="${y - 7}" width="14" height="14" rx="2.5" transform="rotate(45 ${x} ${y})" fill="${c.bg}" stroke="${c.amber}" stroke-width="2.6"/>`;
const label = (x, y, s, size, col, extra = "") =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${col}" ${extra}>${s}</text>`;
const check = (x, y) =>
  `<circle cx="${x}" cy="${y}" r="10" fill="${c.green}"/><path d="M${x - 4.5} ${y} l3 3.2 l6 -6.4" fill="none" stroke="${c.bg}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
const agentDot = (x, y, col) =>
  `<circle cx="${x}" cy="${y}" r="10" fill="${col}" stroke="${c.bg}" stroke-width="3"/><circle cx="${x}" cy="${y}" r="3.4" fill="${c.bg}"/>`;

/** The schematic (box 660x240): queue, think, code, review, land with a gate between each, the fix loop from review back to code, the thread pool under them and the agents waiting for it. */
export function schematicSvg() {
  const parts = [];
  const cy = 92, bh = 58, by = cy - bh / 2, fill = `fill="${c.bg}" fill-opacity=".88"`;
  parts.push(`<rect x="0" y="${by - 16}" width="78" height="${bh + 32}" rx="10" ${fill} stroke="${c.line}" stroke-width="2"/>`);
  parts.push(label(39, by + 4, "queue", 13, c.muted, `text-anchor="middle" font-weight="600" letter-spacing=".04em"`));
  [c.blue, c.purple, c.dim].forEach((col, k) =>
    parts.push(`<rect x="12" y="${by + 16 + k * 15}" width="54" height="9" rx="4.5" fill="${col}" fill-opacity="${k === 2 ? 0.55 : 0.9}"/>`));
  parts.push(`<path d="M82 ${cy} H104" stroke="${c.dim}" stroke-width="2.4"/>`, arrowHead(111, cy, c.dim));
  const names = ["think", "code", "review", "land"];
  const xs = [112, 256, 400, 544], bw = 96;
  xs.forEach((x, k) => {
    const state = ["done", "active", "active2", "pending"][k];
    const stroke = { done: c.green, active: c.blue, active2: c.purple, pending: c.line }[state];
    if (state === "active" || state === "active2")
      parts.push(`<rect x="${x - 4}" y="${by - 4}" width="${bw + 8}" height="${bh + 8}" rx="15" fill="none" stroke="${stroke}" stroke-opacity=".18" stroke-width="6"/>`);
    parts.push(`<rect x="${x}" y="${by}" width="${bw}" height="${bh}" rx="11" ${fill} stroke="${stroke}" stroke-width="2.4"/>`);
    parts.push(label(x + bw / 2, cy + 7, names[k], 20, state === "pending" ? c.muted : c.fg, `text-anchor="middle" font-weight="600"`));
    if (state === "done") parts.push(check(x + bw - 4, by + 2));
    if (state === "active") parts.push(agentDot(x + bw - 4, by + 2, c.blue));
    if (state === "active2") parts.push(agentDot(x + bw - 4, by + 2, c.purple));
    if (k < 3) {
      const x0 = x + bw + 4, x1 = xs[k + 1] - 4;
      parts.push(`<path d="M${x0} ${cy} H${x1 - 6}" stroke="${c.dim}" stroke-width="2.4"/>`, arrowHead(x1 + 1, cy, c.dim), gate((x0 + x1) / 2 - 1, cy));
    }
  });
  parts.push(`<path d="M448 ${by - 6} C448 ${by - 44} 304 ${by - 44} 304 ${by - 12}" fill="none" stroke="${c.amber}" stroke-width="2.2" stroke-dasharray="5 5"/>`);
  parts.push(arrowHead(304, by - 5, c.amber, "down", 6), label(376, by - 40, "fix", 14, c.amber, `text-anchor="middle" font-weight="600"`));
  const py = 186, ph = 30;
  parts.push(label(112, py - 12, "thread pool", 14, c.muted, `font-weight="600" letter-spacing=".04em"`));
  parts.push(label(640, py - 12, "builds &amp; tests, one machine", 13, c.dim, `text-anchor="end"`));
  parts.push(`<rect x="112" y="${py}" width="528" height="${ph}" rx="8" ${fill} stroke="${c.line}" stroke-width="2"/>`);
  const slots = 8, pad = 5, gap = 5, sw = (528 - 2 * pad - (slots - 1) * gap) / slots;
  const cols = [c.blue, c.purple, c.green, c.blue, c.amber, c.purple, c.green, c.blue];
  cols.forEach((col, k) =>
    parts.push(`<rect x="${(112 + pad + k * (sw + gap)).toFixed(1)}" y="${py + pad}" width="${sw.toFixed(1)}" height="${ph - 2 * pad}" rx="4" fill="${col}" fill-opacity=".8"/>`));
  parts.push(label(0, py - 12, "waiting", 14, c.muted, `font-weight="600" letter-spacing=".04em"`));
  [c.green, c.blue, c.amber].forEach((col, k) =>
    parts.push(`<circle cx="${11 + k * 25}" cy="${py + ph / 2}" r="8.5" fill="none" stroke="${col}" stroke-width="2.6"/>`));
  parts.push(`<path d="M86 ${py + ph / 2} H100" stroke="${c.dim}" stroke-width="2.4"/>`, arrowHead(107, py + ph / 2, c.dim));
  return parts.join("\n");
}

const TONES = { blue: c.blue, green: c.green, purple: c.purple, amber: c.amber };

/** The page of one variant; `sceneUri` is the captured stage frame as a data URI (the blurred crop behind the drawing). */
export function bannerHtml(spec, variant, sceneUri) {
  const { width, height, bg, head, schematic } = variant;
  const [first, ...rest] = spec.name.split(" ");
  const chips = spec.chips
    .map(ch => `<span><i style="background:${TONES[ch.tone] ?? c.dim}"></i>${escapeHtml(ch.text)}</span>`)
    .join("");
  const centered = head.align === "center";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${width}px;height:${height}px;overflow:hidden}
body{position:relative;background:${c.bg};color:${c.fg};font-family:${FONT}}
.glow{position:absolute;inset:0;background:radial-gradient(ellipse at 72% 55%,rgba(63,185,80,.10),transparent 55%),radial-gradient(ellipse at 92% 8%,rgba(88,166,255,.11),transparent 50%)}
.scene{position:absolute;inset:0;-webkit-mask-image:linear-gradient(${bg.fade},transparent 0%,rgba(0,0,0,.25) 30%,#000 58%);mask-image:linear-gradient(${bg.fade},transparent 0%,rgba(0,0,0,.25) 30%,#000 58%)}
.scene img{position:absolute;left:${bg.left}px;top:${bg.top}px;width:${bg.width}px;display:block;filter:blur(${bg.blur}px);opacity:${bg.opacity}}
.head{position:absolute;left:${head.left}px;width:${head.width}px;${head.top === undefined ? "top:0;bottom:0;justify-content:center;" : `top:${head.top}px;`}display:flex;flex-direction:column;align-items:${centered ? "center" : "flex-start"};text-align:${centered ? "center" : "left"}}
.head .pad{padding:0 ${centered ? 100 : 0}px}
svg.logo{width:${head.logo}px;height:${head.logo}px;display:block;margin-left:${centered ? 0 : -4}px}
h1{margin-top:${Math.round(head.title * 0.45)}px;font-size:${head.title}px;line-height:1.1;font-weight:800;letter-spacing:-.02em}
h1 .a{background:linear-gradient(90deg,#58a6ff,#3fb950);-webkit-background-clip:text;background-clip:text;color:transparent}
p{margin-top:${Math.round(head.tagline * 0.6)}px;font-size:${head.tagline}px;line-height:1.4;color:${c.muted}}
.chips{display:flex;flex-wrap:nowrap;white-space:nowrap;gap:${Math.round(head.chips * 0.4)}px ${Math.round(head.chips * 0.9)}px;margin-top:${Math.round(head.chips * 0.9)}px;font-size:${head.chips}px;line-height:1;color:${c.dim};${centered ? "justify-content:center;" : ""}}
.chips span{display:inline-flex;align-items:center;gap:${Math.round(head.chips * 0.45)}px}
.chips i{width:${Math.round(head.chips * 0.5)}px;height:${Math.round(head.chips * 0.5)}px;border-radius:50%;display:block}
svg.schematic{position:absolute;left:${schematic.left}px;top:${schematic.top}px;width:${Math.round(660 * schematic.scale)}px;height:${Math.round(240 * schematic.scale)}px;overflow:visible}
</style></head><body><div class="glow"></div>
<div class="scene"><img src="${sceneUri}" alt=""></div>
<div class="head"><svg class="logo" viewBox="0 0 64 64">${logoMark(c)}</svg><h1><span class="a">${escapeHtml(first)}</span> ${escapeHtml(rest.join(" "))}</h1><div class="pad"><p>${escapeHtml(spec.tagline)}</p></div><div class="chips">${chips}</div></div>
<svg class="schematic" viewBox="0 0 660 240">${schematicSvg()}</svg>
</body></html>`;
}

async function main() {
  const i = process.argv.indexOf("--at");
  const replay = JSON.parse(fs.readFileSync(path.join(ROOT, REPLAY_FILE), "utf8"));
  const at = (i === -1 ? defaultAt(replay) : Number(process.argv[i + 1])) * 1000;
  if (!Number.isFinite(at)) throw new Error("--at takes a number of replay seconds");
  const spec = bannerSpec();
  // the logo and favicon go first: the site the scene is captured from serves docs/public
  for (const { file, svg } of brandFiles()) {
    fs.writeFileSync(path.join(ROOT, file), svg);
    console.log(file);
  }
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
