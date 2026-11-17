import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { browserInstalled, browserPath, ROOT } from "./site-browser-helpers.js";

const COMPONENT = path.join(ROOT, "docs/.vitepress/theme/WorkflowGraphs.vue");

/** The page the landing's "The workflows" section is: the real component, mounted in a real browser. */
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;padding:0 16px;background:#111;color:#ddd;font-family:sans-serif}</style></head>
<body><div id="app"></div><script type="module" src="/@entry"></script></body></html>`;

/** Opt-in like the dashboard's real-browser tests: a headless launch can raise a window on macOS and a CI image may hold no browser. */
const HAVE_BROWSER = process.env.WF_BROWSER_TESTS === "1" && browserInstalled();

let server: ViteDevServer;
let browser: Browser;
let url = "";

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: "silent",
    publicDir: path.join(ROOT, "docs/public"),
    server: { port: 0, host: "127.0.0.1", fs: { strict: false } },
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "wfg-vite-")),
    optimizeDeps: { noDiscovery: true, include: ["@dagrejs/dagre", "vue"] },
    plugins: [
      vue(),
      {
        name: "wfg-page",
        enforce: "pre",
        resolveId(id) {
          if (id === "/@entry") return "\0entry";
          if (id === "vitepress") return "\0vitepress";
          return null;
        },
        load(id) {
          if (id === "\0vitepress") return "export const withBase = p => p;";
          if (id === "\0entry")
            return `import { createApp } from "vue";
import WG from ${JSON.stringify(COMPONENT)};
createApp(WG, { workflow: "master" }).mount("#app");`;
          return null;
        },
        configureServer(s) {
          s.middlewares.use((req, res, next) => {
            if (req.url !== "/") return next();
            res.setHeader("content-type", "text/html");
            s.transformIndexHtml("/", PAGE).then(html => res.end(html), next);
          });
        },
      },
    ],
  });
  await server.listen();
  url = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/`;
  browser = await chromium.launch({ executablePath: browserPath() });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

interface Measure {
  overflowX: string;
  overflowY: string;
  maxHeight: string;
  boxH: number;
  scrollH: number;
  svgH: number;
  svgW: number;
  viewBox: number[];
  pageScrollW: number;
  innerW: number;
}

async function measure(width: number, pick?: string): Promise<Measure> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    const log: string[] = [];
    page.on("console", m => log.push(m.text()));
    page.on("pageerror", e => log.push(String(e)));
    await page.goto(url);
    await page.waitForSelector(".wfg-view svg", { timeout: 10_000 }).catch(e => {
      throw new Error(`${e}\n${log.join("\n")}`);
    });
    if (pick) {
      await page.click(`.wfg-pick:text-is("${pick}")`);
      await page.waitForSelector(`.wfg-view [data-wfview="${pick}"]`);
    }
    return await page.evaluate(() => {
      const box = document.querySelector(".wfg-view") as HTMLElement;
      const svg = box.querySelector("svg") as SVGSVGElement;
      const cs = getComputedStyle(box);
      return {
        overflowX: cs.overflowX,
        overflowY: cs.overflowY,
        maxHeight: cs.maxHeight,
        boxH: box.clientHeight,
        scrollH: box.scrollHeight,
        svgH: svg.getBoundingClientRect().height,
        svgW: svg.getBoundingClientRect().width,
        viewBox: svg.getAttribute("viewBox")!.split(" ").map(Number),
        pageScrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
      };
    });
  } finally {
    await page.close();
  }
}

const SCROLLS = /auto|scroll/;

describe("the landing's workflow graph takes its natural height; the page scrolls, not the graph", () => {
  it.skipIf(!HAVE_BROWSER)(
    "the view has no inner scroll: no overflow scroll, no max-height, nothing hidden below its box",
    async () => {
      const m = await measure(1100);
      expect(m.overflowY).not.toMatch(SCROLLS);
      expect(m.overflowX).not.toMatch(SCROLLS);
      expect(m.maxHeight).toBe("none");
      expect(m.scrollH).toBeLessThanOrEqual(m.boxH);
    },
    60_000,
  );

  it.skipIf(!HAVE_BROWSER)(
    "the box's height follows the SVG's viewBox aspect at the width the SVG is drawn",
    async () => {
      const m = await measure(1100, "coding");
      const [, , vw, vh] = m.viewBox;
      expect(m.boxH).toBeGreaterThanOrEqual(Math.floor((m.svgW * vh) / vw) - 2);
    },
    60_000,
  );

  it.skipIf(!HAVE_BROWSER)(
    "switching the workflow resizes the box to the new graph, still with no inner scroll",
    async () => {
      const m = await measure(1100, "coding");
      expect(m.overflowY).not.toMatch(SCROLLS);
      expect(m.scrollH).toBeLessThanOrEqual(m.boxH);
    },
    60_000,
  );

  it.skipIf(!HAVE_BROWSER)(
    "at phone width the page has no horizontal scroll and the graph has no inner scroll",
    async () => {
      const m = await measure(390);
      expect(m.pageScrollW).toBeLessThanOrEqual(m.innerW);
      expect(m.overflowX).not.toMatch(SCROLLS);
      expect(m.scrollH).toBeLessThanOrEqual(m.boxH);
    },
    60_000,
  );

  it("the component captures no plain wheel and sets no inner scroll box in its source", () => {
    const src = fs.readFileSync(COMPONENT, "utf8");
    expect(src).not.toMatch(/@wheel|addEventListener\(\s*["']wheel/);
    expect(src).not.toMatch(/max-height|overflow:\s*(auto|scroll)/);
  });
});
