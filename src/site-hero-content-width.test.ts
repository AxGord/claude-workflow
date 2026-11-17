import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// On a wide screen the landing's hero must be one centred block of the site's content width, not spread to the layout's edges: its
// left edge is the nav logo's and the feature grid's, its right edge the bar's. Real browser, desktop widths.

// Runs whenever a browser is installed (no opt-in variable): a skipped test would read as green on the unfixed tree.
const HAVE_BROWSER = browserInstalled();

/** VitePress's home container: the feature grid's width. */
const CONTENT = 1152;

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-hero-width");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

describe.skipIf(!HAVE_BROWSER)("the hero's width on a wide screen", () => {
  it.each([1280, 1440, 1920, 2560])(
    "at %i px the hero is the content width, centred, on the bar's and the feature grid's edges",
    async width => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(site?.url ?? "");
        await page.waitForSelector(".hero-inner");
        const edges = await page.evaluate(() => {
          const x = (s: string): [number, number] => {
            const r = (document.querySelector(s) as Element).getBoundingClientRect();
            return [Math.round(r.left), Math.round(r.right)];
          };
          return {
            hero: x(".hero-inner"),
            bar: x(".VPNavBar .container"),
            feature: x(".VPFeature"),
          };
        });
        const [left, right] = edges.hero;
        expect(right - left, "hero width").toBeLessThanOrEqual(CONTENT);
        expect(left, "hero is centred").toBe(width - right);
        expect(edges.bar, "the bar's container is the hero's").toEqual(edges.hero);
        expect(edges.feature[0], "the first feature card starts on the hero's left edge").toBe(
          left,
        );
      } finally {
        await page.close();
      }
    },
  );
});
