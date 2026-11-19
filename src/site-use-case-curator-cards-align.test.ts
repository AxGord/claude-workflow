import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// The use-case page's curator scene: its three step cards align their body text the same way. In the built page, in a real browser at 1280 px, in both themes, each card's name and body text start at the same offset from the card's top in all three cards (the deployed site showed card 1 from the top and cards 2 and 3 centred vertically).

const HAVE_BROWSER = browserInstalled();

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-curator-cards");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

describe.skipIf(!HAVE_BROWSER)("the curator scene's three step cards", () => {
  it.each(["light", "dark"] as const)(
    "at 1280 px (%s theme) the body text of all three cards starts at the same offset from the card's top",
    async theme => {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
        colorScheme: theme,
      });
      try {
        await page.addInitScript(t => localStorage.setItem("vitepress-theme-appearance", t), theme);
        await page.goto(`${site?.url ?? ""}use-case-anyparse`);
        await page.waitForSelector(".ucc-task");
        const cards = await page.evaluate(() =>
          [...document.querySelectorAll(".ucc-task")].map(li => {
            const top = li.getBoundingClientRect().top;
            const off = (s: string): number =>
              Math.round((li.querySelector(s) as Element).getBoundingClientRect().top - top);
            return { name: off(".ucc-task-name"), says: off(".ucc-task-says") };
          }),
        );
        expect(cards).toHaveLength(3);
        const [first, ...rest] = cards;
        for (const c of rest) {
          expect(c.says, `the body text's offset, ${JSON.stringify(cards)}`).toBe(first?.says);
          expect(c.name, `the name's offset, ${JSON.stringify(cards)}`).toBe(first?.name);
        }
      } finally {
        await page.close();
      }
    },
    120_000,
  );
});
