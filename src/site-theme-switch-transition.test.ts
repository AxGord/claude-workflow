import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";
import {
  browserInstalled,
  browserPath,
  ROOT,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// ENG-SITE-THEME-SWITCH-TRANSITION: the site's light/dark switch cross-fades over TRANSITION_MS with the View Transitions
// API (Layout.vue provides VitePress's `toggle-appearance`), and flips plainly where the API is missing or motion is reduced.

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const LAYOUT = read("docs/.vitepress/theme/Layout.vue");
const INDEX = read("docs/.vitepress/theme/index.ts");
const TRANSITION_MS = 300;

describe("the theme switch's source", () => {
  it("index.ts mounts Layout.vue, which wraps the default layout and passes every slot through", () => {
    expect(INDEX).toContain('import Layout from "./Layout.vue"');
    expect(INDEX).toContain("Layout: () => h(Layout, null,");
    expect(LAYOUT).toContain("<DefaultTheme.Layout>");
    expect(LAYOUT).toContain('v-for="(_, name) in $slots"');
  });

  it("provides toggle-appearance and flips isDark inside document.startViewTransition, after a nextTick", () => {
    expect(LAYOUT).toContain('provide("toggle-appearance"');
    expect(LAYOUT).toMatch(
      /document\.startViewTransition\(async \(\) => \{\s*isDark\.value = !isDark\.value;\s*await nextTick\(\);/,
    );
  });

  it("falls back to the plain flip without the API and under prefers-reduced-motion", () => {
    expect(LAYOUT).toContain('"startViewTransition" in document');
    expect(LAYOUT).toContain("(prefers-reduced-motion: no-preference)");
    expect(LAYOUT).toMatch(/if \(!animated\(\)\) \{\s*isDark\.value = !isDark\.value;\s*return;/);
    expect(LAYOUT).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it(`the cross-fade lasts ${TRANSITION_MS} ms, the knob's travel time (VitePress's switch moves in 0.25 s)`, () => {
    expect(LAYOUT).toContain(`const TRANSITION_MS = ${TRANSITION_MS};`);
    expect(LAYOUT).toContain("::view-transition-group(root)");
    expect(LAYOUT).toContain("animation-duration: var(--theme-fade");
  });

  it("the demos follow html.dark in CSS only: none reads isDark in script, so they flip inside the same transition", () => {
    const dir = path.join(ROOT, "docs/.vitepress/theme");
    for (const f of fs.readdirSync(dir)) {
      if (f === "Layout.vue") continue;
      if (/\.(vue|ts)$/.test(f))
        expect(read(`docs/.vitepress/theme/${f}`), f).not.toContain("isDark");
    }
  });
});

const HAVE_BROWSER = browserInstalled();
let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-theme-switch");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

const SWITCH = ".VPNavBar .VPSwitchAppearance";
/** Animations of the view transition's pseudo-elements still running (the page's own endless ones are not counted). */
const transitionRuns = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      document.documentElement
        .getAnimations({ subtree: true })
        .filter(a =>
          (a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith("::view-transition"),
        ).length,
  );
const isDark = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.classList.contains("dark"));

/** Opens the landing under a light colour scheme, with the page's own count of startViewTransition calls. */
async function open(
  b: Browser,
  init?: string,
  reducedMotion: "reduce" | "no-preference" = "no-preference",
): Promise<Page> {
  const page = await b.newPage({
    viewport: { width: 1280, height: 900 },
    colorScheme: "light",
    reducedMotion,
  });
  await page.addInitScript(`window.__svt = 0;${init ?? ""}
    if (document.startViewTransition) { const o = document.startViewTransition.bind(document);
      document.startViewTransition = (cb) => { window.__svt++; return o(cb); }; }`);
  await page.goto(site?.url ?? "");
  await page.waitForSelector(SWITCH);
  expect(await isDark(page), "starts light").toBe(false);
  return page;
}

/** The mean luminance (0 to 255) of a clip of a screenshot of the page's lower right (x 900, y 600), which holds the demos' text. */
async function luminance(page: Page): Promise<{ png: Buffer; lum: number }> {
  const png = await page.screenshot({ clip: { x: 900, y: 600, width: 300, height: 200 } });
  const lum = await page.evaluate(async b64 => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d");
    if (!ctx) return -1;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4)
      sum += 0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0);
    return sum / (d.length / 4);
  }, png.toString("base64"));
  return { png, lum };
}

describe.skipIf(!HAVE_BROWSER)("the switch in Chromium", () => {
  it(`a click runs one view transition whose root cross-fade lasts ${TRANSITION_MS} ms; at 0, 100, 200 and ${TRANSITION_MS} ms the page is between the two themes, in order`, async () => {
    const page = await open(browser);
    try {
      const before = await luminance(page);
      const beforeFull = page.screenshot();
      await page.click(SWITCH);
      await page.waitForFunction(() =>
        document.documentElement
          .getAnimations({ subtree: true })
          .some(a =>
            (a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith("::view-transition"),
          ),
      );
      expect(
        await page.evaluate(() => (window as unknown as { __svt: number }).__svt),
        "calls",
      ).toBe(1);
      const durations = await page.evaluate(() =>
        document.documentElement
          .getAnimations({ subtree: true })
          .filter(a =>
            (a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith("::view-transition-"),
          )
          .map(a => a.effect?.getComputedTiming().duration),
      );
      expect(durations.length).toBeGreaterThan(0);
      for (const d of durations) expect(d).toBe(TRANSITION_MS);
      // pause every animation of the transition and look at it frame by frame
      const frames: { t: number; lum: number }[] = [];
      const dir = process.env["WF_THEME_FRAMES"];
      if (dir) fs.mkdirSync(dir, { recursive: true });
      if (dir) fs.writeFileSync(path.join(dir, "frame-before.png"), await beforeFull);
      for (const t of [0, 100, 200, TRANSITION_MS]) {
        await page.evaluate(
          ([ms, end]) => {
            for (const a of document.documentElement.getAnimations({ subtree: true })) {
              if (
                !(a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith("::view-transition")
              )
                continue;
              a.pause();
              a.currentTime = Math.min(ms, end);
            }
          },
          [t, TRANSITION_MS - 0.1] as const,
        );
        const f = await luminance(page);
        frames.push({ t, lum: f.lum });
        if (dir)
          fs.writeFileSync(
            path.join(dir, `frame-${String(t).padStart(3, "0")}ms.png`),
            await page.screenshot(),
          );
      }
      const l = frames.map(f => f.lum);
      expect(before.lum, "the light page is bright").toBeGreaterThan(200);
      expect(l[0], "at 0 ms still the old theme").toBeGreaterThan(200);
      expect(l[3], `at ${TRANSITION_MS} ms the new theme`).toBeLessThan(60);
      expect(l[1], "100 ms is between").toBeLessThan(l[0] ?? 0);
      expect(l[2], "200 ms is darker than 100 ms").toBeLessThan(l[1] ?? 0);
      expect(l[3], "300 ms is darker than 200 ms").toBeLessThan(l[2] ?? 0);
      expect(await isDark(page), "the class flipped once").toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("the demos switch inside the same transition: the dashboard map, the terminal window and the pool strip change with the page, with no second change after it ends", async () => {
    const page = await open(browser);
    try {
      const colours = (): Promise<string[]> =>
        page.evaluate(() =>
          [".cc-window", ".dash", ".pool-strip"].map(s => {
            const el = document.querySelector(s);
            return el
              ? getComputedStyle(el).backgroundColor + getComputedStyle(el).color
              : "missing";
          }),
        );
      const light = await colours();
      for (const c of light) expect(c).not.toBe("missing");
      await page.click(SWITCH);
      await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
      await expect.poll(() => transitionRuns(page), { timeout: 5000 }).toBe(0);
      const settled = await colours();
      await page.waitForTimeout(800);
      expect(await colours(), "nothing moves after the transition ended").toEqual(settled);
      // the demos changed, and the dark values are the ones a page loaded dark has
      expect(settled).not.toEqual(light);
      const fresh = await browser.newPage({
        viewport: { width: 1280, height: 900 },
        colorScheme: "dark",
      });
      try {
        await fresh.goto(site?.url ?? "");
        await fresh.waitForSelector(SWITCH);
        await fresh.waitForTimeout(500);
        const dark = await fresh.evaluate(() =>
          [".cc-window", ".dash", ".pool-strip"].map(s => {
            const el = document.querySelector(s);
            return el
              ? getComputedStyle(el).backgroundColor + getComputedStyle(el).color
              : "missing";
          }),
        );
        expect(settled).toEqual(dark);
      } finally {
        await fresh.close();
      }
    } finally {
      await page.close();
    }
  }, 60_000);

  it("under prefers-reduced-motion the flip is plain: no view transition starts and the class flips at once", async () => {
    const page = await open(browser, undefined, "reduce");
    try {
      await page.click(SWITCH);
      expect(await isDark(page)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { __svt: number }).__svt)).toBe(0);
      expect(await transitionRuns(page)).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("a browser without startViewTransition flips plainly and throws nothing", async () => {
    const errors: string[] = [];
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      colorScheme: "light",
    });
    page.on("pageerror", e => errors.push(String(e)));
    try {
      await page.addInitScript("delete Document.prototype.startViewTransition;");
      await page.goto(site?.url ?? "");
      await page.waitForSelector(SWITCH);
      expect(await page.evaluate(() => "startViewTransition" in document)).toBe(false);
      await page.click(SWITCH);
      expect(await isDark(page)).toBe(true);
      await page.click(SWITCH);
      expect(await isDark(page)).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("a second click during the transition (the page ignores input while it runs) leaves the switch and the page in the same state, with no error", async () => {
    const errors: string[] = [];
    const page = await open(browser);
    page.on("pageerror", e => errors.push(String(e)));
    try {
      await page.click(SWITCH);
      await page.click(SWITCH, { force: true }).catch(() => undefined);
      // settled: a transition started, none still runs, and the switch shows the page's state
      const settled = async (): Promise<boolean> =>
        (await page.evaluate(() => (window as unknown as { __svt: number }).__svt)) > 0 &&
        (await transitionRuns(page)) === 0 &&
        (await page.getAttribute(SWITCH, "aria-checked")) === String(await isDark(page));
      await expect.poll(settled, { timeout: 5000 }).toBe(true);
      const checked = await page.getAttribute(SWITCH, "aria-checked");
      // and a click once it ended flips again, with a transition
      await page.click(SWITCH);
      await expect.poll(() => isDark(page)).toBe(checked !== "true");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});

/** Firefox and WebKit: whatever they support of the API, the switch flips and throws nothing (skipped when the browser is not installed). */
describe.skipIf(!HAVE_BROWSER)("the switch in Firefox and WebKit", () => {
  for (const [name, type] of [
    ["firefox", firefox],
    ["webkit", webkit],
  ] as [string, BrowserType][]) {
    it(`${name}: the switch flips both ways and throws nothing`, async ctx => {
      let b: Browser;
      try {
        b = await type.launch();
      } catch {
        ctx.skip();
        return;
      }
      const errors: string[] = [];
      try {
        const page = await b.newPage({
          viewport: { width: 1280, height: 900 },
          colorScheme: "light",
        });
        page.on("pageerror", e => errors.push(String(e)));
        await page.goto(site?.url ?? "");
        await page.waitForSelector(SWITCH);
        await page.click(SWITCH);
        await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
        await page.waitForTimeout(600);
        await page.click(SWITCH);
        await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
        expect(errors).toEqual([]);
      } finally {
        await b.close();
      }
    }, 90_000);
  }
});
