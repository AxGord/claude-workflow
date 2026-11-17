import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// The landing's hero and nav as ONE layout over the whole scroll range, in a real browser: the built site is served
// and the page is scrolled in 8 px steps. Opt-in like the other real-browser tests (WF_BROWSER_TESTS=1): a headless
// launch can raise a window on macOS and a CI image may hold no browser. The source of the same rules is pinned,
// browser or not, in src/site-hero.test.ts.

const WIDTHS = [1440, 1024, 960, 768, 375, 320];
const STEP = 8;
/** The least gap a bar box keeps from the viewport's right edge. */
const GUTTER = 8;
/** The scroll at which the bar is fully condensed (`--hero-brand-y`, 96 px, 88 below 640 px), and a little past it. */
const CONDENSED = 120;

const HAVE_BROWSER = process.env.WF_BROWSER_TESTS === "1" && browserInstalled();

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-hero-layout");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

type Box = [number, number, number, number];
interface Sample {
  y: number;
  boxes: Record<string, Box>;
  /** the hero's text boxes still visible (effective opacity above 0.1) that straddle the bar's bottom edge */
  straddling: string[];
  barBottom: number;
  /** the bar's container, and the viewport's width: every box of the bar lies inside both */
  container: Box;
  viewW: number;
}

/** Everything one scroll offset is measured by, read in the page. */
function measureInPage(): Omit<Sample, "y"> {
  const box = (e: Element | null): Box | null => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? [r.left, r.top, r.right, r.bottom] : null;
  };
  const visible = (sel: string): Element | null =>
    [...document.querySelectorAll(sel)].find(e => box(e) !== null) ?? null;
  const named: Record<string, Element | null> = {
    logo: visible(".VPNavBarTitle img.logo"),
    title: visible(".VPNavBarTitle .title > span"),
    search: visible(".VPNavBarSearch .DocSearch-Button"),
    links: visible(".VPNavBarMenu"),
    toggle: visible(".VPNavBarAppearance"),
    github: visible(".VPNavBarSocialLinks"),
    extra: visible(".VPNavBarExtra"),
    hamburger: visible(".VPNavBarHamburger"),
  };
  const boxes: Record<string, Box> = {};
  for (const [k, e] of Object.entries(named)) {
    const b = box(e);
    if (b) boxes[k] = b;
  }
  const barBottom = document.querySelector(".VPNavBar")?.getBoundingClientRect().bottom ?? 0;
  const opacity = (e: Element): number => {
    let o = 1;
    for (let n: Element | null = e; n; n = n.parentElement)
      o *= Number(getComputedStyle(n).opacity);
    return o;
  };
  const straddling: string[] = [];
  const texts = [
    ...document.querySelectorAll(
      ".hero-tagline, .hero-actions a, .hero-chips, .hero-chips li, .hero-diagram",
    ),
  ];
  for (const e of texts) {
    const b = box(e);
    if (b && b[1] < barBottom && b[3] > barBottom && opacity(e) > 0.1)
      straddling.push(`${e.className || e.tagName} opacity ${opacity(e).toFixed(2)}`);
  }
  const c = (document.querySelector(".VPNavBar .container") as Element).getBoundingClientRect();
  return {
    boxes,
    straddling,
    barBottom,
    container: [c.left, c.top, c.right, c.bottom],
    viewW: document.documentElement.clientWidth,
  };
}

async function sweep(
  width: number,
  reduced: boolean,
  to: number,
  scheme: "dark" | "light" = "dark",
): Promise<Sample[]> {
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    reducedMotion: reduced ? "reduce" : "no-preference",
    colorScheme: scheme,
  });
  try {
    await page.goto(site?.url ?? "");
    await page.waitForSelector(".hero");
    const samples: Sample[] = [];
    for (let y = 0; y <= to; y += STEP) {
      await page.evaluate(top => window.scrollTo(0, top), y);
      // a scroll-driven animation updates on a frame; the fallback's observer and class on the next task
      await page.evaluate(
        () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      await page.waitForTimeout(reduced ? 60 : 0);
      samples.push({ y, ...(await page.evaluate(measureInPage)) });
    }
    return samples;
  } finally {
    await page.close();
  }
}

const overlap = (a: Box, b: Box): boolean =>
  a[0] < b[2] - 0.5 && b[0] < a[2] - 0.5 && a[1] < b[3] - 0.5 && b[1] < a[3] - 0.5;

function overlaps(samples: Sample[]): string[] {
  const found: string[] = [];
  for (const s of samples) {
    const names = Object.keys(s.boxes);
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++) {
        const a = names[i];
        const b = names[j];
        if (overlap(s.boxes[a], s.boxes[b]))
          found.push(
            `y=${s.y}: ${a} ${JSON.stringify(s.boxes[a])} x ${b} ${JSON.stringify(s.boxes[b])}`,
          );
      }
  }
  return found;
}

/**
 * The boxes of the bar that stick out of the viewport or leave it no right gutter (VitePress's own icons carry 8 to 12 px
 * of padding past the container, so the container's right edge is not the limit; the viewport's is, with a gutter),
 * or start left of the container.
 */
function outside(samples: Sample[]): string[] {
  const found: string[] = [];
  for (const s of samples)
    for (const [name, b] of Object.entries(s.boxes))
      if (b[0] < s.container[0] - 0.5 || b[2] > s.viewW - GUTTER)
        found.push(
          `y=${s.y}: ${name} ${JSON.stringify(b)} outside container ${JSON.stringify(s.container)} / viewport ${s.viewW}`,
        );
  return found;
}

describe.skipIf(!HAVE_BROWSER)("the hero and the nav are one layout in a real browser", () => {
  for (const reduced of [false, true]) {
    for (const width of WIDTHS) {
      it(`no two boxes of the bar overlap at any scroll offset, ${width} px${reduced ? ", reduced motion" : ""}`, async () => {
        const samples = await sweep(width, reduced, CONDENSED);
        expect(samples).toHaveLength(Math.floor(CONDENSED / STEP) + 1);
        // the bar's own parts are all there: the title (logo and name), the search, and a right cluster
        const last = samples[samples.length - 1];
        for (const k of ["logo", "title", "search"])
          expect(Object.keys(last.boxes), k).toContain(k);
        expect(overlaps(samples)).toEqual([]);
        expect(outside(samples)).toEqual([]);
      }, 120_000);

      it(`no hero text still visible straddles the bar's bottom edge, ${width} px${reduced ? ", reduced motion" : ""}`, async () => {
        const samples = await sweep(width, reduced, 700);
        expect(samples.flatMap(s => s.straddling.map(t => `y=${s.y}: ${t}`))).toEqual([]);
      }, 120_000);
    }
  }

  it("the search's left edge is the diagram's left edge at the top, and sits beside the cluster, narrower, once condensed", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    try {
      await page.goto(site?.url ?? "");
      await page.waitForSelector(".hero");
      const read = (): Promise<{
        search: Box;
        diagram: Box;
        toggle: Box;
        links: Box;
      }> =>
        page.evaluate(() => {
          const b = (s: string): Box => {
            const r = (document.querySelector(s) as Element).getBoundingClientRect();
            return [r.left, r.top, r.right, r.bottom];
          };
          return {
            search: b(".VPNavBarSearch .DocSearch-Button"),
            diagram: b(".hero-diagram"),
            toggle: b(".VPNavBarAppearance"),
            links: b(".VPNavBarMenu"),
          };
        });
      const top = await read();
      expect(Math.abs(top.search[0] - top.diagram[0])).toBeLessThan(1.5);
      await page.evaluate(() => window.scrollTo(0, 400));
      await page.evaluate(
        () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      const bottom = await read();
      const widthTop = top.search[2] - top.search[0];
      const widthBottom = bottom.search[2] - bottom.search[0];
      expect(widthBottom).toBeLessThan(widthTop - 100);
      // next to the links, with only the gap between
      expect(bottom.links[0] - bottom.search[2]).toBeLessThan(24);
      expect(bottom.links[0] - bottom.search[2]).toBeGreaterThanOrEqual(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("the diagram does not exceed the text block, and the chips and buttons wrap instead of overflowing, at every width", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    try {
      await page.goto(site?.url ?? "");
      await page.waitForSelector(".hero");
      for (const width of [
        320, 360, 375, 414, 480, 600, 700, 768, 900, 959, 960, 1024, 1180, 1280, 1440, 1920,
      ]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(50);
        const m = await page.evaluate(() => {
          const r = (e: Element): Box => {
            const b = e.getBoundingClientRect();
            return [b.left, b.top, b.right, b.bottom];
          };
          const text = r(document.querySelector(".hero-text") as Element);
          const inner = r(document.querySelector(".hero-inner") as Element);
          const kids = [
            ...document.querySelectorAll(".hero-tagline, .hero-actions a, .hero-chips li"),
          ].map(e => ({
            name: (e.textContent ?? "").trim().slice(0, 12),
            box: r(e),
          }));
          const diagram = r(document.querySelector(".hero-diagram") as Element);
          const wide =
            getComputedStyle(document.querySelector(".hero-inner") as Element).display === "grid";
          return {
            scrollW: document.documentElement.scrollWidth,
            innerW: window.innerWidth,
            text,
            inner,
            kids,
            diagram,
            wide,
          };
        });
        expect(m.scrollW, `${width}: no horizontal scroll`).toBeLessThanOrEqual(m.innerW);
        for (const k of m.kids) {
          expect(k.box[2], `${width}: ${k.name} inside the hero`).toBeLessThanOrEqual(
            m.inner[2] + 0.5,
          );
          expect(k.box[0], `${width}: ${k.name} inside the hero`).toBeGreaterThanOrEqual(
            m.inner[0] - 0.5,
          );
        }
        if (m.wide)
          expect(
            m.diagram[3] - m.diagram[1],
            `${width}: the diagram is no taller than the text`,
          ).toBeLessThanOrEqual(m.text[3] - m.text[1]);
      }
    } finally {
      await page.close();
    }
  }, 60_000);

  it("the hero's own colours and the bar's surface follow the site's theme, and the bar is opaque once condensed", async () => {
    for (const scheme of ["dark", "light"] as const) {
      const page = await browser.newPage({
        viewport: { width: 1024, height: 700 },
        colorScheme: scheme,
      });
      try {
        await page.goto(site?.url ?? "");
        await page.waitForSelector(".hero");
        await page.evaluate(() => window.scrollTo(0, 300));
        await page.evaluate(
          () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
        const bar = await page.evaluate(() => {
          const bar = document.querySelector(".VPNavBar") as Element;
          const before = getComputedStyle(bar, "::before");
          return {
            opacity: Number(before.opacity),
            bg: before.backgroundColor,
            dark: document.documentElement.classList.contains("dark"),
          };
        });
        expect(bar.dark).toBe(scheme === "dark");
        expect(bar.opacity).toBe(1);
        // an opaque colour: rgb(), or rgba() with alpha 1
        expect(bar.bg).toMatch(/^rgb\(|, 1\)$/);
      } finally {
        await page.close();
      }
    }
  }, 60_000);
});
