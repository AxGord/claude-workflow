import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";

// The landing's enlarged hero title (the nav's own title at scale 2 below 640 px, scroll top) must fit a 320 px phone:
// nothing of it past the viewport, no horizontal overflow of the page. Real browser.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "/claude-workflow/";

function browserPath(): string | undefined {
  if (fs.existsSync(chromium.executablePath())) return undefined;
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  for (const d of fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : []) {
    if (!d.startsWith("chromium_headless_shell-")) continue;
    for (const sub of fs.readdirSync(path.join(cache, d))) {
      const exe = path.join(cache, d, sub, "chrome-headless-shell");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}

// Runs whenever a browser is installed (no opt-in variable): a skipped test would read as green on the unfixed tree.
const HAVE_BROWSER = fs.existsSync(chromium.executablePath()) || browserPath() !== undefined;

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

let out = "";
let server: Server;
let browser: Browser;
let url = "";

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  out = fs.mkdtempSync(path.join(os.tmpdir(), "wf-hero-320-"));
  execFileSync(
    "node",
    ["node_modules/vitepress/bin/vitepress.js", "build", "docs", "--outDir", out],
    { cwd: ROOT, stdio: "pipe" },
  );
  server = http.createServer((req, res) => {
    let rel = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    if (!rel.startsWith(BASE)) rel = BASE;
    rel = rel.slice(BASE.length);
    const file = path.join(out, rel === "" ? "index.html" : rel);
    const found = [file, `${file}.html`].find(
      f => f.startsWith(out) && fs.existsSync(f) && fs.statSync(f).isFile(),
    );
    if (!found) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("content-type", TYPES[path.extname(found)] ?? "application/octet-stream");
    res.end(fs.readFileSync(found));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}${BASE}`;
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
  if (out) fs.rmSync(out, { recursive: true, force: true });
});

describe.skipIf(!HAVE_BROWSER)("the hero title at 320 px, scroll top", () => {
  for (const reduced of [false, true]) {
    it(`fits the viewport with no horizontal overflow${reduced ? ", reduced motion" : ""}`, async () => {
      const page = await browser.newPage({
        viewport: { width: 320, height: 900 },
        reducedMotion: reduced ? "reduce" : "no-preference",
      });
      try {
        await page.goto(url);
        await page.waitForSelector(".hero");
        await page.evaluate(
          () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
        const m = await page.evaluate(() => {
          const r = (s: string): number[] => {
            const e = [...document.querySelectorAll(s)].find(
              x => x.getBoundingClientRect().width > 0,
            ) as Element;
            const b = e.getBoundingClientRect();
            return [b.left, b.top, b.right, b.bottom];
          };
          return {
            title: r(".VPNavBarTitle .title"),
            name: r(".VPNavBarTitle .title > span"),
            scrollW: document.documentElement.scrollWidth,
            viewW: document.documentElement.clientWidth,
          };
        });
        console.log(JSON.stringify(m));
        expect(m.scrollW, "no horizontal scroll").toBeLessThanOrEqual(m.viewW);
        expect(m.name[2], "the name's right edge is inside the viewport").toBeLessThanOrEqual(
          m.viewW,
        );
        expect(m.title[2], "the title's right edge is inside the viewport").toBeLessThanOrEqual(
          m.viewW,
        );
      } finally {
        await page.close();
      }
    }, 120_000);
  }
});
