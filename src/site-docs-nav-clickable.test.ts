import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// The nav's 'Docs' must navigate on a click (to /getting-started, the start of the docs), not only open its menu. Real browser, desktop width.

// Runs whenever a browser is installed (no opt-in variable): a skipped test would read as green on the unfixed tree.
const HAVE_BROWSER = browserInstalled();

/** The sidebar's pages: what the Docs list holds. */
const PAGES = 11;

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-docs-nav");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

describe.skipIf(!HAVE_BROWSER)("the nav's Docs item on desktop", () => {
  it("a click on Docs navigates to /getting-started", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(site?.url ?? "");
      await page.waitForSelector(".VPNavBar .VPNavBarMenu a");
      const docs = page
        .locator(".VPNavBar .VPNavBarMenu")
        .getByText("Docs", { exact: true })
        .first();
      await docs.click();
      await page.waitForTimeout(1000);
      expect(new URL(page.url()).pathname, "URL after clicking Docs").toBe(
        "/claude-workflow/getting-started",
      );
    } finally {
      await page.close();
    }
  });

  it("hovering Docs lists every page and the item is active on a docs page", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(site?.url ?? "");
      await page.waitForSelector(".VPNavBar .VPNavBarMenu a");
      const docs = page
        .locator(".VPNavBar .VPNavBarMenu")
        .getByText("Docs", { exact: true })
        .first();
      await docs.hover();
      const menu = page.locator(".VPNavBar .VPNavBarMenu .VPMenu a");
      await menu.first().waitFor({ state: "visible" });
      expect(await menu.count(), "pages in the list").toBe(PAGES);
      expect(
        await page.locator(".VPNavBar .VPNavBarMenu .DocsNav.active").count(),
        "active on the landing",
      ).toBe(0);
      await page.goto(`${site?.url ?? ""}faq`);
      await page.waitForSelector(".VPNavBar .VPNavBarMenu .DocsNav.active");
    } finally {
      await page.close();
    }
  });

  it("the mobile menu at 390 px shows every Docs page with no click on Docs", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(site?.url ?? "");
      await page.click(".VPNavBarHamburger");
      const items = page.locator(".DocsNavScreen a");
      await items.first().waitFor({ state: "visible" });
      expect(await items.count(), "Docs link plus the pages").toBe(PAGES + 1);
      expect(await page.locator(".DocsNavScreen a:visible").count(), "visible links").toBe(
        PAGES + 1,
      );
      expect(await page.locator(".VPNavScreenMenuGroup").count(), "no collapsible group").toBe(0);
      await items.first().click();
      await page.waitForURL(/\/claude-workflow\/getting-started$/);
    } finally {
      await page.close();
    }
  });

  it("a tap on the caret at 1024 px in a touch context opens the list", async () => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 800 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    try {
      await page.goto(site?.url ?? "");
      await page.waitForSelector(".DocsNav .docs-caret");
      await page.locator(".DocsNav .docs-caret").tap();
      await page.locator(".DocsNav .docs-menu a").first().waitFor({ state: "visible" });
      expect(
        await page.locator(".DocsNav .docs-menu a:visible").count(),
        "visible links after one tap",
      ).toBe(PAGES);
    } finally {
      await context.close();
    }
  });

  it("a click on the caret after hovering keeps the list open", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(site?.url ?? "");
      await page.waitForSelector(".DocsNav .docs-caret");
      await page.locator(".DocsNav .docs-link").hover();
      await page.locator(".DocsNav .docs-menu a").first().waitFor({ state: "visible" });
      await page.locator(".DocsNav .docs-caret").click();
      await page.waitForTimeout(500);
      expect(
        await page.locator(".DocsNav .docs-menu a:visible").count(),
        "visible links after hover then click",
      ).toBe(PAGES);
    } finally {
      await page.close();
    }
  });

  it("Enter on the focused caret keeps the list open, and Escape closes it", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(site?.url ?? "");
      await page.waitForSelector(".DocsNav .docs-caret");
      await page.locator(".DocsNav .docs-caret").focus();
      await page.locator(".DocsNav .docs-menu a").first().waitFor({ state: "visible" });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
      expect(
        await page.locator(".DocsNav .docs-menu a:visible").count(),
        "visible links after focus then Enter",
      ).toBe(PAGES);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      expect(
        await page.locator(".DocsNav .docs-menu a:visible").count(),
        "visible links after Escape",
      ).toBe(0);
    } finally {
      await page.close();
    }
  });
});
