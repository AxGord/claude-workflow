import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// The landing's Install block carries the copy button of the docs pages' code blocks (VitePress's own markup and
// styles, its click handler): focusable, shown on keyboard focus, copies both commands, says "Copied", in both themes
// and on a phone. Real browser, the built site.

const HAVE_BROWSER = browserInstalled();
const COMMANDS =
  "/plugin marketplace add https://github.com/anthropics/claude-plugins-community\n/plugin install workflow";

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-install-copy");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

describe.skipIf(!HAVE_BROWSER)("the install block's copy button", () => {
  it.each([
    ["light", 1280],
    ["dark", 1280],
    ["light", 390],
    ["dark", 390],
  ] as const)(
    "%s theme at %i px: the button is keyboard reachable, shown on focus, copies both commands and says Copied",
    async (theme, width) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        permissions: ["clipboard-read", "clipboard-write"],
      });
      try {
        const page = await context.newPage();
        await page.addInitScript(t => {
          localStorage.setItem("vitepress-theme-appearance", t);
        }, theme);
        await page.goto(site?.url ?? "");
        await page.waitForSelector(".install button.copy");
        expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(
          theme === "dark",
        );
        const button = page.locator(".install button.copy");
        // the docs pages' markup: the button is a child of a div.language-*, the pre two siblings on
        expect(
          await page.evaluate(() => {
            const b = document.querySelector(".install button.copy") as HTMLElement;
            return {
              parent: /language-/.test(b.parentElement?.className ?? ""),
              pre: b.nextElementSibling?.nextElementSibling?.tagName,
              title: b.title,
            };
          }),
        ).toEqual({ parent: true, pre: "PRE", title: "Copy Code" });
        // hidden until the block is hovered or the button focused, as in the docs
        expect(Number(await button.evaluate(e => getComputedStyle(e).opacity))).toBe(0);
        await page.locator(".install").scrollIntoViewIfNeeded();
        let focused = false;
        for (let i = 0; i < 40 && !focused; i++) {
          await page.keyboard.press("Tab");
          focused = await button.evaluate(e => e === document.activeElement);
        }
        expect(focused, "Tab reaches the copy button").toBe(true);
        await page.waitForFunction(
          () =>
            Number(
              getComputedStyle(document.querySelector(".install button.copy") as Element).opacity,
            ) === 1,
        );
        await page.keyboard.press("Enter");
        await page.waitForSelector(".install button.copy.copied");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(COMMANDS);
        const feedback = await button.evaluate(e => getComputedStyle(e, "::before").content);
        expect(feedback).toBe('"Copied"');
        // the button stays inside the page's width (no horizontal scroll) and inside the block
        const box = await page.evaluate(() => {
          const b = (
            document.querySelector(".install button.copy") as Element
          ).getBoundingClientRect();
          const d = (
            document.querySelector(".install .language-text") as Element
          ).getBoundingClientRect();
          return {
            inside:
              b.left >= d.left && b.right <= d.right && b.top >= d.top && b.bottom <= d.bottom,
            scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });
        expect(box).toEqual({ inside: true, scroll: 0 });
      } finally {
        await context.close();
      }
    },
    120_000,
  );
});
