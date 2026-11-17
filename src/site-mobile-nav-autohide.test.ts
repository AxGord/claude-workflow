import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  ROOT,
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// Below 960 px the bar (and a doc page's local nav) hides on a scroll down and shows on a scroll up, on the landing and on
// the doc pages; from 960 px nothing moves.

const HAVE_BROWSER = browserInstalled();
const THEME = path.join(ROOT, "docs/.vitepress/theme");
const LAYOUT = fs.readFileSync(path.join(THEME, "Layout.vue"), "utf8");
const PAGES = ["", "getting-started"];

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-mobile-nav-autohide");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

/** Scrolls to `y`, then waits out the frame that reads it and the bars' transform transition. */
async function scrollTo(page: Page, y: number): Promise<void> {
  await page.evaluate(top => window.scrollTo(0, top), y);
  await page.evaluate(
    () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await page.waitForTimeout(450);
}

interface Bars {
  scrollY: number;
  navTop: number;
  navBottom: number;
  /** null on a page without a local nav */
  localTop: number | null;
  localBottom: number | null;
}

const bars = (page: Page): Promise<Bars> =>
  page.evaluate(() => {
    const nav = document.querySelector(".VPNav")?.getBoundingClientRect();
    const local = document.querySelector(".VPLocalNav")?.getBoundingClientRect();
    return {
      scrollY: window.scrollY,
      navTop: nav?.top ?? NaN,
      navBottom: nav?.bottom ?? NaN,
      localTop: local ? local.top : null,
      localBottom: local ? local.bottom : null,
    };
  });

/** The bars are in view: the nav at the top, the local nav (when the page has one) right under it. */
function expectShown(b: Bars, label: string): void {
  expect(b.navTop, `${label}: nav top`).toBe(0);
  if (b.localTop !== null)
    expect(b.localTop, `${label}: local nav under the nav`).toBe(b.navBottom);
}

function expectHidden(b: Bars, label: string): void {
  expect(b.navBottom, `${label}: nav off-screen`).toBeLessThanOrEqual(0);
  if (b.localBottom !== null)
    expect(b.localBottom, `${label}: local nav off-screen`).toBeLessThanOrEqual(0);
}

describe.skipIf(!HAVE_BROWSER)(
  "below 960 px the bar hides on a scroll down and shows on a scroll up",
  () => {
    it.each(PAGES)(
      "/%s at 390 px: hidden going down, back (nav and local nav) on a 30 px scroll up, shown at the top",
      async route => {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        try {
          await page.goto((site?.url ?? "") + route);
          await page.waitForSelector(".VPNavBar");
          expectShown(await bars(page), "at the top");
          await scrollTo(page, 600);
          const down = await bars(page);
          expect(down.scrollY).toBeGreaterThan(500);
          expectHidden(down, "after a scroll down");
          await scrollTo(page, 570);
          expectShown(await bars(page), "after a 30 px scroll up");
          await scrollTo(page, 800);
          expectHidden(await bars(page), "scrolled down again");
          await scrollTo(page, 0);
          expectShown(await bars(page), "back at the top");
        } finally {
          await page.close();
        }
      },
      120_000,
    );

    it("/getting-started has the local nav the doc pages are checked with", async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await page.goto(`${site?.url ?? ""}getting-started`);
        await page.waitForSelector(".VPNavBar");
        expect((await bars(page)).localTop, "a local nav").not.toBeNull();
      } finally {
        await page.close();
      }
    }, 120_000);

    it("a movement under the threshold decides nothing: a few px up keeps it hidden, a 30 px one shows it", async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await page.goto(`${site?.url ?? ""}getting-started`);
        await page.waitForSelector(".VPNavBar");
        await scrollTo(page, 600);
        expectHidden(await bars(page), "after a scroll down");
        await scrollTo(page, 595);
        expectHidden(await bars(page), "a 5 px scroll up");
        await scrollTo(page, 592);
        expectHidden(await bars(page), "8 px up in all is still under the threshold");
        await scrollTo(page, 570);
        expectShown(await bars(page), "a 30 px scroll up");
      } finally {
        await page.close();
      }
    }, 120_000);

    it("an open menu keeps the bar shown while the page scrolls down", async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await page.goto(`${site?.url ?? ""}getting-started`);
        await page.waitForSelector(".VPNavBar");
        await scrollTo(page, 600);
        await scrollTo(page, 570);
        expectShown(await bars(page), "shown before the menu");
        await page.click(".VPNavBarHamburger");
        await page.waitForSelector(".VPNavScreen");
        await page.evaluate(() => {
          for (const el of [document.documentElement, document.body]) el.style.overflow = "auto";
        });
        await scrollTo(page, 900);
        const open = await bars(page);
        expect(open.scrollY, "the page did scroll under the open menu").toBeGreaterThan(570);
        expect(open.navTop, "the bar stays shown with the menu open").toBe(0);
      } finally {
        await page.close();
      }
    }, 120_000);

    it("an anchor jump lands the heading below the bar's space", async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await page.goto(`${site?.url ?? ""}getting-started`);
        await page.waitForSelector(".VPNavBar");
        const space = await page.evaluate(() => {
          const nav = document.querySelector(".VPNav")?.getBoundingClientRect().bottom ?? 0;
          return nav + (document.querySelector(".VPLocalNav")?.getBoundingClientRect().height ?? 0);
        });
        const top = await page.evaluate(async () => {
          const h = [...document.querySelectorAll(".vp-doc h2")].find(e =>
            e.textContent?.includes("Mode 2"),
          );
          // the heading's own anchor link, the one VitePress scrolls on
          (h?.querySelector(".header-anchor") as HTMLElement | null)?.click();
          await new Promise(r => setTimeout(r, 800));
          if (!h) return -1;
          // the heading's text: below its own padding (the doc theme's rule above an h2), which VitePress's offset allows for
          return h.getBoundingClientRect().top + parseFloat(getComputedStyle(h).paddingTop);
        });
        expect(
          top,
          "the heading's text starts below the nav and the local nav",
        ).toBeGreaterThanOrEqual(space);
      } finally {
        await page.close();
      }
    }, 120_000);

    it("at 1280 px nothing moves", async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      try {
        for (const route of PAGES) {
          await page.goto((site?.url ?? "") + route);
          await page.waitForSelector(".VPNavBar");
          const before = await bars(page);
          await scrollTo(page, 800);
          await scrollTo(page, 700);
          await scrollTo(page, 1200);
          const after = await bars(page);
          expect(after.scrollY, `/${route}: the page scrolled`).toBeGreaterThan(500);
          expect(after.navTop, `/${route}: nav`).toBe(before.navTop);
          expect(after.localTop, `/${route}: local nav`).toBe(before.localTop);
          const state = await page.evaluate(() => ({
            hidden: document.documentElement.classList.contains("nav-autohide-hidden"),
            transform: getComputedStyle(document.querySelector(".VPNav") as Element).transform,
          }));
          expect(state, `/${route}: no hidden state, no transform`).toEqual({
            hidden: false,
            transform: "none",
          });
        }
      } finally {
        await page.close();
      }
    }, 120_000);

    it("the bars move with transform, animated, and without animation under prefers-reduced-motion", async () => {
      for (const reducedMotion of ["no-preference", "reduce"] as const) {
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
          reducedMotion,
        });
        try {
          await page.goto(`${site?.url ?? ""}getting-started`);
          await page.waitForSelector(".VPNavBar");
          await scrollTo(page, 600);
          const m = await page.evaluate(() => {
            const nav = getComputedStyle(document.querySelector(".VPNav") as Element);
            const local = getComputedStyle(document.querySelector(".VPLocalNav") as Element);
            return {
              transform: nav.transform,
              localTransform: local.transform,
              props: nav.transitionProperty,
              durations: [nav.transitionDuration, local.transitionDuration].join(" "),
            };
          });
          expect(m.transform, `${reducedMotion}: the nav is moved by a transform`).not.toBe("none");
          expect(m.localTransform, `${reducedMotion}: so is the local nav`).not.toBe("none");
          if (reducedMotion === "reduce") expect(m.durations).not.toMatch(/[1-9]/);
          else {
            expect(m.props).toContain("transform");
            expect(m.durations).toMatch(/0\.25s/);
          }
        } finally {
          await page.close();
        }
      }
    }, 120_000);
  },
);

describe("one passive, frame-throttled scroll listener owned by the layout", () => {
  const files = fs.readdirSync(THEME).filter(f => /\.(vue|ts)$/.test(f));
  const scrollListeners = (src: string): number =>
    (src.match(/addEventListener\(\s*"scroll"/g) ?? []).length;

  it("Layout.vue adds exactly one, passive and throttled with requestAnimationFrame, and removes it", () => {
    expect(scrollListeners(LAYOUT)).toBe(1);
    expect(LAYOUT).toMatch(/addEventListener\("scroll", onScroll, \{ passive: true \}\)/);
    expect(LAYOUT).toContain("requestAnimationFrame(update)");
    expect(LAYOUT).toContain('removeEventListener("scroll", onScroll)');
  });

  it("no other theme file listens to scroll for the bar", () => {
    for (const f of files.filter(f => f !== "Layout.vue")) {
      const src = fs.readFileSync(path.join(THEME, f), "utf8");
      expect(src, f).not.toContain("nav-autohide-hidden");
    }
  });

  it("the rules sit below 960 px only, move by transform, hold at the top, at the threshold and with an open menu", () => {
    expect(LAYOUT).toContain("@media (max-width: 959.98px) {");
    expect(LAYOUT).toMatch(
      /:root\.nav-autohide-hidden \.Layout \.VPNav \{\s*transform: translateY\(/,
    );
    expect(LAYOUT).toMatch(
      /:root\.nav-autohide-hidden \.Layout \.VPLocalNav \{\s*transform: translateY\(/,
    );
    expect(LAYOUT).toMatch(/:root \.Layout \.VPLocalNav \{\s*top: var\(--vp-nav-height\);/);
    expect(LAYOUT).toMatch(/NAV_SCROLL_THRESHOLD = 10;/);
    expect(LAYOUT).toContain("y === 0");
    expect(LAYOUT).toContain('".VPNavScreen, .VPSidebar.open"');
    expect(LAYOUT).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^}]*\{\s*transition: none;/,
    );
    // the hidden state is never written outside the below-960px block
    const at = LAYOUT.indexOf("@media (max-width: 959.98px) {");
    expect(LAYOUT.slice(0, at)).not.toContain(":root.nav-autohide-hidden");
  });
});
