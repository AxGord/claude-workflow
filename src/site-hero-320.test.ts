import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// The landing's enlarged hero title (the nav's own title at scale 2 below 640 px, scroll top) must fit a 320 px phone:
// nothing of it past the viewport, no horizontal overflow of the page. Real browser.

// Runs whenever a browser is installed (no opt-in variable): a skipped test would read as green on the unfixed tree.
const HAVE_BROWSER = browserInstalled();

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-hero-320");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

describe.skipIf(!HAVE_BROWSER)("the hero title at 320 px, scroll top", () => {
  for (const reduced of [false, true]) {
    it(`fits the viewport with no horizontal overflow${reduced ? ", reduced motion" : ""}`, async () => {
      const page = await browser.newPage({
        viewport: { width: 320, height: 900 },
        reducedMotion: reduced ? "reduce" : "no-preference",
      });
      try {
        await page.goto(site?.url ?? "");
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
