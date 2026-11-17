import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// Below 960 px the bar's keyboard-focus reveal must follow :focus-visible, not :focus-within: a TAPPED control keeps
// focus without showing a focus ring, so it must not hold the bar open, and keyboard focus in either bar reveals both
// bars together. Real browser at 390 px.

const HAVE_BROWSER = browserInstalled();

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-mobile-nav-autohide-focus-visible");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

async function scrollTo(page: Page, y: number): Promise<void> {
  await page.evaluate(top => window.scrollTo(0, top), y);
  await page.evaluate(
    () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await page.waitForTimeout(450);
}

const bottomOf = (page: Page, selector: string): Promise<number> =>
  page.evaluate(
    sel => document.querySelector(sel)?.getBoundingClientRect().bottom ?? NaN,
    selector,
  );

describe.skipIf(!HAVE_BROWSER)("keyboard focus only reveals the bars", () => {
  it("/getting-started at 390 px: tap the hamburger, close the menu, scroll down: the bar hides again", async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const page = await ctx.newPage();
    try {
      await page.goto((site?.url ?? "") + "getting-started");
      await page.waitForSelector(".VPNavBarHamburger");
      // open and close the menu with real touch taps: the hamburger keeps focus after the second tap
      await page.tap(".VPNavBarHamburger");
      await page.waitForSelector(".VPNavScreen");
      await page.tap(".VPNavBarHamburger");
      await page.waitForFunction(() => document.querySelector(".VPNavScreen") === null);
      const state = await page.evaluate(() => {
        const el = document.activeElement;
        return {
          focused: el?.classList.contains("VPNavBarHamburger") ?? false,
          focusVisible: el?.matches(":focus-visible") ?? true,
        };
      });
      expect(state.focused, "the tapped hamburger holds focus").toBe(true);
      expect(state.focusVisible, "a tap shows no focus ring").toBe(false);
      await scrollTo(page, 300);
      await scrollTo(page, 600);
      expect(await bottomOf(page, ".VPNav"), "the scroll down hid the bar").toBeLessThanOrEqual(0);
    } finally {
      await ctx.close();
    }
  }, 120_000);

  it("/getting-started at 390 px: tap the theme switch, scroll down: the bar hides", async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const page = await ctx.newPage();
    try {
      await page.goto((site?.url ?? "") + "getting-started");
      await page.waitForSelector(".VPNavBarHamburger");
      await page.tap(".VPNavBarHamburger");
      await page.waitForSelector(".VPNavScreen .VPSwitch");
      await page.tap(".VPNavScreen .VPSwitch");
      await page.tap(".VPNavBarHamburger");
      await page.waitForFunction(() => document.querySelector(".VPNavScreen") === null);
      await scrollTo(page, 300);
      await scrollTo(page, 600);
      expect(await bottomOf(page, ".VPNav"), "the scroll down hid the bar").toBeLessThanOrEqual(0);
    } finally {
      await ctx.close();
    }
  }, 120_000);

  it("/getting-started at 390 px: Tab into the local nav, the bar and the local nav are both shown, no gap", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto((site?.url ?? "") + "getting-started");
      await page.waitForSelector(".VPLocalNav");
      await scrollTo(page, 600);
      expect(await bottomOf(page, ".VPNav"), "the scroll down hid the bar").toBeLessThanOrEqual(0);
      // a key press puts the page in keyboard modality, so the focus that follows matches :focus-visible, as a Tab does
      await page.keyboard.press("Shift");
      const focused = await page.evaluate(() => {
        const button = document.querySelector<HTMLElement>(".VPLocalNav button");
        button?.focus({ preventScroll: true });
        return (
          document.activeElement === button && button !== null && button.matches(":focus-visible")
        );
      });
      expect(focused, "a local nav button took keyboard focus").toBe(true);
      await page.waitForTimeout(450);
      const rects = await page.evaluate(() => {
        const nav = document.querySelector(".VPNav")?.getBoundingClientRect();
        const local = document.querySelector(".VPLocalNav")?.getBoundingClientRect();
        return {
          navTop: nav?.top ?? NaN,
          navBottom: nav?.bottom ?? NaN,
          localTop: local?.top ?? NaN,
        };
      });
      expect(rects.navTop, "the bar is shown with its local nav").toBe(0);
      expect(rects.localTop, "the local nav sits flush under the bar, no gap").toBe(
        rects.navBottom,
      );
    } finally {
      await page.close();
    }
  }, 120_000);
});
