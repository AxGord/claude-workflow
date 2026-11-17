import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// The landing reads as one aligned block: the replay stage (Scene) and the install section (Install) share the hero's left and right edges. Real browser: a phone, a tablet (the hero's gutter is 24 px below 768 px, 32 px from there) and desktop widths.

const HAVE_BROWSER = browserInstalled();

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-scene-align");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

describe.skipIf(!HAVE_BROWSER)("the scene's and the install section's edges", () => {
  it.each([375, 768, 1024, 1280, 1440, 1920, 2560])(
    "at %i px the scene stage and the install block sit on the hero's left and right edges",
    async width => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(site?.url ?? "");
        await page.waitForSelector(".hero-inner");
        await page.waitForSelector(".stage-frame");
        await page.waitForSelector(".install pre");
        const edges = await page.evaluate(() => {
          const x = (s: string): [number, number] => {
            const r = (document.querySelector(s) as Element).getBoundingClientRect();
            return [Math.round(r.left), Math.round(r.right)];
          };
          return {
            hero: x(".hero-inner"),
            stage: x(".stage-frame"),
            install: x(".install pre"),
          };
        });
        console.log(JSON.stringify({ width, ...edges }));
        expect(edges.stage, "the scene stage is the hero's width").toEqual(edges.hero);
        expect(edges.install, "the install block is the hero's width").toEqual(edges.hero);
      } finally {
        await page.close();
      }
    },
    120_000,
  );
});
