import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// The state names of a band on the landing's replay map, at the end of the replay (every band drawn), must not
// touch one another in the browser's own glyph metrics, on a desktop and on a phone. Real browser.

// Runs whenever a browser is installed (no opt-in variable): a skipped test would read as green on the unfixed tree.
const HAVE_BROWSER = browserInstalled();

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-map-label-overlap");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

describe.skipIf(!HAVE_BROWSER)("state names of the replay map in a real browser", () => {
  for (const width of [1280, 390])
    it(`no two names of a band overlap at ${width} px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(site?.url ?? "");
        await page.waitForSelector(".tr-scrub");
        await page.evaluate(() => {
          const r = document.querySelector(".tr-scrub") as HTMLInputElement;
          r.value = r.max;
          r.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.waitForSelector("text.m-station");
        await page.evaluate(
          () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
        const found = await page.evaluate(() => {
          const bands = new Map<Element, { name: string; l: number; r: number }[]>();
          for (const t of document.querySelectorAll("text.m-station")) {
            const b = t.getBoundingClientRect();
            const g = t.parentElement as Element;
            const list = bands.get(g) ?? [];
            list.push({ name: t.textContent ?? "", l: b.left, r: b.right });
            bands.set(g, list);
          }
          const out: string[] = [];
          let names = 0;
          for (const list of bands.values()) {
            names += list.length;
            list.sort((a, b) => a.l - b.l);
            for (let i = 1; i < list.length; i++)
              if (list[i].l < list[i - 1].r - 0.5)
                out.push(`${list[i - 1].name} / ${list[i].name}`);
          }
          return { out, names };
        });
        expect(found.names, "state names were drawn").toBeGreaterThan(5);
        expect(found.out).toEqual([]);
      } finally {
        await page.close();
      }
    }, 120_000);
});
