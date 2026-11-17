import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// The landing reads as one aligned block: VitePress's own feature grid (the cards under the hero) sits on the hero's, the stage's and the install block's left and right edges. Real browser, every width the line names.

const HAVE_BROWSER = browserInstalled();

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-feature-grid-align");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

describe.skipIf(!HAVE_BROWSER)("the feature grid's edges", () => {
  it.each([375, 640, 768, 960, 1215, 1280, 1440, 1920])(
    "at %i px the feature cards' left and right edges are the hero's",
    async width => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(site?.url ?? "");
        await page.waitForSelector(".hero-inner");
        await page.waitForSelector(".stage-frame");
        await page.waitForSelector(".install pre");
        await page.waitForSelector(".VPFeatures .VPFeature");
        const edges = await page.evaluate(() => {
          const x = (s: string): [number, number] => {
            const r = (document.querySelector(s) as Element).getBoundingClientRect();
            return [Math.round(r.left), Math.round(r.right)];
          };
          const cards = [...document.querySelectorAll(".VPFeatures .VPFeature")].map(e => {
            const r = e.getBoundingClientRect();
            return [r.left, r.right];
          });
          return {
            hero: x(".hero-inner"),
            stage: x(".stage-frame"),
            install: x(".install pre"),
            features: [
              Math.round(Math.min(...cards.map(c => c[0] ?? 0))),
              Math.round(Math.max(...cards.map(c => c[1] ?? 0))),
            ],
          };
        });
        console.log(JSON.stringify({ width, ...edges }));
        expect(edges.features, "the feature grid is the hero's width").toEqual(edges.hero);
      } finally {
        await page.close();
      }
    },
    120_000,
  );
});
