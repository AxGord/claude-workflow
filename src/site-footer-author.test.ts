import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  ROOT,
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// The site's footer names the author with a link to his site; VitePress renders `copyright` as HTML and shows the footer
// only on pages without a sidebar (its default rule, kept): the landing has it, a doc page with a sidebar has it in the DOM, hidden.

const AUTHOR_URL = "https://axgord.github.io/";
const HAVE_BROWSER = browserInstalled();
const CASES = [1280, 390].flatMap(w => [`${w}`, `${w} dark`]);

describe("the footer's source", () => {
  const config = fs.readFileSync(path.join(ROOT, "docs/.vitepress/config.mts"), "utf8");

  it("names the author in the copyright, linked to his site", () => {
    expect(config).toContain(
      `copyright: '© 2026 <a href="${AUTHOR_URL}" target="_self">Alexander Gordeyko</a>'`,
    );
    expect(config).toContain('message: "Released under the MIT License."');
  });
});

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-footer-author");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

describe.skipIf(!HAVE_BROWSER)("the built site's footer", () => {
  it.each(CASES)(
    "at %s px the landing's author link is visible and clickable",
    async label => {
      const width = Number.parseInt(label, 10);
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        await page.goto(site?.url ?? "");
        await page.waitForSelector(".hero");
        if (label.endsWith("dark"))
          await page.evaluate(() => document.documentElement.classList.add("dark"));
        const link = page.locator(`.VPFooter .copyright a[href="${AUTHOR_URL}"]`);
        await link.scrollIntoViewIfNeeded();
        await page.waitForTimeout(400);
        expect(await link.count(), `${label}: one author link`).toBe(1);
        expect(await link.innerText(), `${label}: the author's name`).toBe("Alexander Gordeyko");
        const m = await link.evaluate(a => {
          const r = a.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          const cs = getComputedStyle(a);
          const footer = a.closest(".VPFooter");
          const bg = footer ? getComputedStyle(footer).backgroundColor : "";
          return {
            w: r.width,
            h: r.height,
            inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
            hitIsLink: !!hit && (hit === a || a.contains(hit)),
            visibility: cs.visibility,
            opacity: cs.opacity,
            color: cs.color,
            bg,
          };
        });
        expect(m.w, `${label}: width`).toBeGreaterThan(20);
        expect(m.h, `${label}: height`).toBeGreaterThan(8);
        expect(m.inView, `${label}: inside the viewport`).toBe(true);
        expect(m.hitIsLink, `${label}: the top element at its centre is the link`).toBe(true);
        expect(m.visibility, `${label}: visibility`).toBe("visible");
        expect(m.opacity, `${label}: opacity`).toBe("1");
        expect(m.color, `${label}: link colour differs from the page background`).not.toBe(m.bg);
        const href = await link.getAttribute("href");
        expect(href).toBe(AUTHOR_URL);
      } finally {
        await page.close();
      }
    },
    120_000,
  );

  it("a doc page with a sidebar hides the footer (VitePress's default rule)", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 844 } });
    try {
      await page.goto(`${site?.url ?? ""}getting-started`);
      await page.waitForSelector(".VPSidebar");
      const footer = page.locator(".VPFooter");
      expect(await footer.getAttribute("class"), "marked as a page with a sidebar").toContain(
        "has-sidebar",
      );
      expect(await footer.evaluate(f => getComputedStyle(f).display)).toBe("none");
      expect(await footer.locator("a").isVisible()).toBe(false);
    } finally {
      await page.close();
    }
  }, 120_000);
});
