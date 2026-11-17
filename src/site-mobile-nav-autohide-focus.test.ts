import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// Below 960 px, once a scroll down has hidden the bar, Tab-focusing a link inside it must reveal the bar: the focused
// element may not sit off-screen. Real browser at 390 px.

const HAVE_BROWSER = browserInstalled();

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-mobile-nav-autohide-focus");
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

describe("the reveal rule", () => {
  const layout = fs.readFileSync(
    path.join(import.meta.dirname, "..", "docs", ".vitepress", "theme", "Layout.vue"),
    "utf8",
  );
  const media = layout.slice(layout.indexOf("@media (max-width: 959.98px)"));

  it("cancels the hidden transform of both bars while focus is inside them, below 960 px only", () => {
    const rule =
      /nav-autohide-hidden \.Layout \.VPNav:focus-within,\s*:root\.nav-autohide-hidden \.Layout \.VPLocalNav:focus-within\s*\{\s*transform:\s*none;/;
    expect(media).toMatch(rule);
    expect(media.search(rule), "inside the below-960 px block").toBeLessThan(
      media.indexOf("\n}\n"),
    );
  });
});

describe.skipIf(!HAVE_BROWSER)("a focused link inside the hidden bar reveals it", () => {
  it.each(["", "getting-started"])(
    "/%s at 390 px: scroll down, focus a nav link, the nav's top is 0",
    async route => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await page.goto((site?.url ?? "") + route);
        await page.waitForSelector(".VPNavBar");
        await scrollTo(page, 600);
        const hidden = await page.evaluate(
          () => document.querySelector(".VPNav")?.getBoundingClientRect().bottom ?? NaN,
        );
        expect(hidden, "the scroll down hid the nav").toBeLessThanOrEqual(0);
        // a link inside the bar takes focus, as a Tab from the keyboard does (focus() moves no scroll position itself here)
        const focused = await page.evaluate(() => {
          const link = document.querySelector<HTMLElement>(".VPNav a[href]");
          link?.focus({ preventScroll: true });
          return document.activeElement === link && link !== null;
        });
        expect(focused, "a nav link took focus").toBe(true);
        await page.waitForTimeout(450);
        const nav = await page.evaluate(() => {
          const r = document.querySelector(".VPNav")?.getBoundingClientRect();
          const a = document.activeElement?.getBoundingClientRect();
          return { navTop: r?.top ?? NaN, focusBottom: a?.bottom ?? NaN };
        });
        expect(nav.navTop, "the nav's top while a link inside it has focus").toBe(0);
        expect(nav.focusBottom, "the focused link is on-screen").toBeGreaterThan(0);
      } finally {
        await page.close();
      }
    },
    120_000,
  );

  it("/getting-started at 390 px: focus the local nav's button, the local nav is under the bar", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto((site?.url ?? "") + "getting-started");
      await page.waitForSelector(".VPLocalNav");
      await scrollTo(page, 600);
      const hidden = await page.evaluate(
        () => document.querySelector(".VPLocalNav")?.getBoundingClientRect().bottom ?? NaN,
      );
      expect(hidden, "the scroll down hid the local nav").toBeLessThanOrEqual(0);
      const focused = await page.evaluate(() => {
        const button = document.querySelector<HTMLElement>(".VPLocalNav button");
        button?.focus({ preventScroll: true });
        return document.activeElement === button && button !== null;
      });
      expect(focused, "a local nav button took focus").toBe(true);
      await page.waitForTimeout(450);
      const top = await page.evaluate(
        () => document.querySelector(".VPLocalNav")?.getBoundingClientRect().top ?? NaN,
      );
      const navHeight = await page.evaluate(() =>
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--vp-nav-height")),
      );
      expect(top, "the local nav's top while a button inside it has focus").toBe(navHeight);
    } finally {
      await page.close();
    }
  }, 120_000);
});
