import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// On the landing the bar stays pinned at the top below 960 px: after a scroll the nav's top is 0 and its bottom equals --vp-nav-height.

const HAVE_BROWSER = browserInstalled();
const WIDTHS = [390, 800];

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-mobile-nav-pinned");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

describe.skipIf(!HAVE_BROWSER)("the landing's bar stays pinned below 960 px", () => {
  it.each(WIDTHS.flatMap(w => [`${w}`, `${w} dark`]))(
    "at %s px after a scroll the bar's background is the theme's opaque colour",
    async label => {
      const width = Number.parseInt(label, 10);
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        await page.goto(site?.url ?? "");
        await page.waitForSelector(".hero");
        if (label.endsWith("dark"))
          await page.evaluate(() => document.documentElement.classList.add("dark"));
        // the bar's own background-color transition (0.25s) settles before it is read
        await page.waitForTimeout(600);
        await page.evaluate(() => window.scrollTo(0, 600));
        await page.evaluate(
          () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
        const m = await page.evaluate(() => {
          const probe = document.createElement("div");
          probe.style.backgroundColor = getComputedStyle(document.documentElement)
            .getPropertyValue("--vp-nav-bg-color")
            .trim();
          document.body.append(probe);
          const want = getComputedStyle(probe).backgroundColor;
          probe.remove();
          const bar = document.querySelector(".VPNavBar");
          return { have: bar ? getComputedStyle(bar).backgroundColor : "", want };
        });
        expect(m.have, `${label}: the bar's background`).toBe(m.want);
        expect(m.have, `${label}: opaque`).not.toMatch(/rgba\(.*, 0\)$/);
        expect(m.have, `${label}: set`).not.toBe("");
      } finally {
        await page.close();
      }
    },
    120_000,
  );

  it.each(WIDTHS)(
    "at %i px after a scroll the nav's top is 0 and its bottom is --vp-nav-height",
    async width => {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        await page.goto(site?.url ?? "");
        await page.waitForSelector(".hero");
        const heroTop = await page.evaluate(
          () => document.querySelector(".hero")?.getBoundingClientRect().top ?? -1,
        );
        const navH = await page.evaluate(
          () => document.querySelector(".VPNav")?.getBoundingClientRect().bottom ?? 0,
        );
        expect(heroTop, `${width}: the page's content starts below the bar`).toBeGreaterThanOrEqual(
          navH,
        );
        await page.evaluate(() => window.scrollTo(0, 600));
        await page.evaluate(
          () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
        const m = await page.evaluate(() => {
          const nav = document.querySelector(".VPNav")?.getBoundingClientRect();
          const h = parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue("--vp-nav-height"),
          );
          return { scrollY: window.scrollY, top: nav?.top, bottom: nav?.bottom, navHeight: h };
        });
        expect(m.scrollY, `${width}: the page scrolled`).toBeGreaterThan(300);
        expect(m.top, `${width}: nav top`).toBe(0);
        expect(m.bottom, `${width}: nav bottom`).toBe(m.navHeight);
      } finally {
        await page.close();
      }
    },
    120_000,
  );
});
