import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// The footer's author link points at the deployed site's own origin (axgord.github.io), so VitePress's client router
// treats a click as an in-site route and does not navigate: the page only scrolls to the top. The built site is served
// to the browser AS https://axgord.github.io/claude-workflow/ (requests fulfilled from the local build), and the click
// must land on https://axgord.github.io/, which the test answers with a stub page.

const ORIGIN = "https://axgord.github.io";
const AUTHOR_URL = `${ORIGIN}/`;
const SITE_URL = `${ORIGIN}/claude-workflow/`;
const HAVE_BROWSER = browserInstalled();

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-footer-navigates");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

describe.skipIf(!HAVE_BROWSER)("the built site's footer link on its deployed origin", () => {
  it("a click on the author link navigates to the author's home page", async () => {
    const local = new URL(site?.url ?? "");
    const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
    const hits: string[] = [];
    try {
      await context.route(`${ORIGIN}/**`, async route => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith("/claude-workflow/")) {
          const res = await fetch(`${local.origin}${url.pathname}${url.search}`);
          await route.fulfill({
            status: res.status,
            headers: {
              "content-type": res.headers.get("content-type") ?? "application/octet-stream",
            },
            body: Buffer.from(await res.arrayBuffer()),
          });
          return;
        }
        hits.push(url.href);
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>home</title><h1>home</h1>",
        });
      });
      const page = await context.newPage();
      await page.goto(SITE_URL);
      await page.waitForSelector(".hero");
      // wait until the client router has taken over the page (hydration), as a visitor's click would find it
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);
      const link = page.locator(`.VPFooter .copyright a[href="${AUTHOR_URL}"]`);
      await link.scrollIntoViewIfNeeded();
      await link.click();
      await page.waitForTimeout(1500);
      expect(page.url(), "the click left the site for the author's home page").toBe(AUTHOR_URL);
      expect(hits, "the author's home page was requested").toContain(AUTHOR_URL);
    } finally {
      await context.close();
    }
  }, 120_000);
});
