import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// The hero's content (tagline, buttons, chips, diagram) scrolls as plain content on every layout, the stacked one and the desktop one alike: at every scroll offset its effective opacity is 1 while any part of it is in the viewport. There is no soft edge (EDGE is 0 px): the content scrolls under the opaque bar and is cut by it, never dissolved.

const HAVE_BROWSER = browserInstalled();
const EDGE = 0;
const WIDTHS = [375, 414, 768, 960, 1440];
const STEP = 16;

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-hero-no-fade");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

interface Faded {
  y: number;
  el: string;
  opacity: number;
}

function measure(edge: number): {
  seen: number;
  faded: { el: string; opacity: number }[];
} {
  const barBottom = document.querySelector(".VPNavBar")?.getBoundingClientRect().bottom ?? 0;
  const out: { el: string; opacity: number }[] = [];
  let seen = 0;
  const els = document.querySelectorAll(
    ".hero-tagline, .hero-actions a, .hero-chips li, .hero-diagram",
  );
  for (const e of els) {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.bottom <= barBottom + edge || r.top >= window.innerHeight) continue;
    seen++;
    let o = 1;
    for (let n: Element | null = e; n; n = n.parentElement)
      o *= Number(getComputedStyle(n).opacity);
    if (o < 0.999)
      out.push({
        el: String(e.className || e.tagName),
        opacity: Math.round(o * 100) / 100,
      });
  }
  return { seen, faded: out };
}

describe.skipIf(!HAVE_BROWSER)("the hero does not fade on scroll", () => {
  it.each(WIDTHS)(
    "at %i px every hero element has opacity 1 while any part of it is in view",
    async width => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(site?.url ?? "");
        await page.waitForSelector(".hero");
        const faded: Faded[] = [];
        let seen = 0;
        for (let y = 0; y <= 900; y += STEP) {
          await page.evaluate(top => window.scrollTo(0, top), y);
          await page.evaluate(
            () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
          );
          const m = await page.evaluate(measure, EDGE);
          seen += m.seen;
          for (const f of m.faded) faded.push({ y, ...f });
        }
        expect(seen, `${width}: the hero's elements were measured`).toBeGreaterThan(100);
        expect(faded.slice(0, 5), `${width}: faded elements`).toEqual([]);
      } finally {
        await page.close();
      }
    },
    120_000,
  );
});
