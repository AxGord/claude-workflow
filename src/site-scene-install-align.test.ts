import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// The landing reads as one aligned block: the replay stage (Scene), the install section (Install) and VitePress's feature grid share the hero's left and right edges, each asserted within 1 px. Real browser: a phone, a tablet (the hero's gutter is 24 px below 768 px, 32 px from there) and desktop widths, the stacked and the two-column layout both.

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
  it.each([375, 640, 768, 960, 1215, 1280, 1440, 1920])(
    "at %i px the scene stage and the install block sit on the hero's left and right edges",
    async width => {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
      });
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
              Math.min(...cards.map(c => c[0] ?? 0)),
              Math.max(...cards.map(c => c[1] ?? 0)),
            ],
          };
        });
        for (const [name, e] of [
          ["the scene stage", edges.stage],
          ["the install block", edges.install],
          ["the feature grid", edges.features],
        ] as const) {
          expect(
            Math.abs((e[0] ?? 0) - (edges.hero[0] ?? 0)),
            `${name}'s left edge, ${JSON.stringify(edges)}`,
          ).toBeLessThanOrEqual(1);
          expect(
            Math.abs((e[1] ?? 0) - (edges.hero[1] ?? 0)),
            `${name}'s right edge, ${JSON.stringify(edges)}`,
          ).toBeLessThanOrEqual(1);
        }
      } finally {
        await page.close();
      }
    },
    120_000,
  );
});
