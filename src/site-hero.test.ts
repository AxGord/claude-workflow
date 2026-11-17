import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const HERO = read("docs/.vitepress/theme/Hero.vue");
const THEME = read("docs/.vitepress/theme/index.ts");
const CONFIG = read("docs/.vitepress/config.mts");
const LANDING = read("docs/index.md");
const FRONT = /^---\n([\s\S]*?)\n---/.exec(LANDING)?.[1] ?? "";

interface Banner {
  bannerSpec(): { name: string; tagline: string; chips: { text: string; tone: string }[] };
  schematicSvg(): string;
}
const B = (await import(
  pathToFileURL(path.join(ROOT, "scripts/render-banner.mjs")).href
)) as Banner;

const TEMPLATES = fs
  .readdirSync(path.join(ROOT, "templates"))
  .filter(f => f.endsWith(".yaml")).length;

/** The unscoped style block of Hero.vue: the nav's side of the merge. */
const NAV_CSS = HERO.split("<style>")[1] ?? "";

describe("the landing's hero is the banner as live HTML, merged with the nav", () => {
  it("mounts in the hero's before-slot, and the landing opts into the merged header by its page class", () => {
    expect(THEME).toContain('import Hero from "./Hero.vue"');
    expect(THEME).toContain('"home-hero-before": () => h(Hero)');
    expect(FRONT).toMatch(/^pageClass: has-hero$/m);
    // every nav rule is gated by that class: the other pages keep VitePress's own bar
    for (const rule of NAV_CSS.matchAll(/^([^\n{}@/]+)\{/gm)) {
      const selector = rule[1] ?? "";
      if (/VPNav|VPContent|VPHomeHero/.test(selector) && !/^\s*(from|to)\b/.test(selector))
        expect(selector, selector).toMatch(/has-hero|\.VPNavBarTitle \.title( \.brand-a)?\s*$/);
    }
  });

  it("the words are the hero of docs/index.md; the default text hero is hidden, not duplicated", () => {
    expect(HERO).toContain("frontmatter.value.hero");
    expect(HERO).toContain("{{ hero.tagline }}");
    expect(HERO).toContain('v-for="a in hero.actions"');
    expect(NAV_CSS).toMatch(/\.Layout\.has-hero \.VPHomeHero \{\s*display: none;/);
  });

  it("the chips are the banner's, and the workflow count is derived from templates/, never typed", () => {
    const chips = [...HERO.matchAll(/\{ text: ("[^"]+"|`[^`]+`), tone: "(\w+)" \}/g)].map(m => ({
      text: (m[1] ?? "").slice(1, -1).replace("${__BUNDLED_WORKFLOWS__}", String(TEMPLATES)),
      tone: m[2],
    }));
    expect(chips).toEqual(B.bannerSpec().chips);
    expect(HERO).not.toMatch(/\b\d+ workflows/);
    expect(CONFIG).toContain("define: { __BUNDLED_WORKFLOWS__: JSON.stringify(bundledWorkflows) }");
    expect(CONFIG).toMatch(/readdirSync\(fileURLToPath\(new URL\("\.\.\/\.\.\/templates"/);
  });

  it("the diagram says what the banner's schematic says, in live SVG", () => {
    const banner = B.schematicSvg();
    for (const word of [
      "queue",
      "think",
      "code",
      "review",
      "land",
      "fix",
      "thread pool",
      "waiting",
    ]) {
      expect(banner, word).toContain(`>${word}</text>`);
      expect(HERO.includes(`>${word}</text>`) || HERO.includes(`["${word}"`), word).toBe(true);
    }
    expect(HERO).toContain("builds &amp; tests, one machine");
    const markup = /<template>([\s\S]*?)<\/template>\s*<style/.exec(HERO)?.[1] ?? "";
    expect(markup).toContain("<svg");
    expect(markup).not.toContain("<img");
  });
});

describe("the nav condenses the hero as the page scrolls", () => {
  it("scroll-driven where the browser has it and motion is allowed: the title scales down below the bar first, then rises into it", () => {
    expect(NAV_CSS).toContain("@supports (animation-timeline: scroll())");
    expect(NAV_CSS).toContain("@media (prefers-reduced-motion: no-preference)");
    expect(NAV_CSS).toMatch(/animation-timeline: scroll\(root block\), scroll\(root block\);/);
    expect(NAV_CSS).toMatch(
      /@keyframes hero-brand-scale \{\s*from \{\s*scale: var\(--hero-brand-s\);\s*\}\s*to \{\s*scale: 1;/,
    );
    expect(NAV_CSS).toMatch(
      /@keyframes hero-brand-rise \{\s*from \{\s*translate: 0 var\(--hero-brand-y\);\s*\}\s*to \{\s*translate: 0 0;/,
    );
    expect(NAV_CSS).toMatch(
      /animation-range:\s*0px var\(--hero-scale-end\),\s*var\(--hero-rise-start\) var\(--hero-brand-y\);/,
    );
    // the two phases follow each other (the scale ends about where the rise starts), so the big title is never in the bar's row
    expect(NAV_CSS).toContain("--hero-scale-end: calc(var(--hero-brand-y) * 0.55);");
    expect(NAV_CSS).toContain("--hero-rise-start: calc(var(--hero-brand-y) * 0.45);");
    // the travel is vertical only: the hero shares the bar's width and gutters, so no x is measured
    expect(HERO).toMatch(/\.hero-inner \{[^}]*max-width: var\(--hero-content-w\);/);
    expect(NAV_CSS).toMatch(/\.VPNavBar \.container \{\s*max-width: var\(--hero-content-w\);/);
  });

  it("falls back to a class toggled by an IntersectionObserver, which is a plain switch under reduced motion", () => {
    expect(HERO).toContain("new IntersectionObserver");
    expect(HERO).toContain('classList.toggle("hero-condensed", !e.isIntersecting)');
    expect(HERO).toContain('classList.remove("hero-condensed")');
    expect(NAV_CSS).toMatch(
      /\.hero-condensed \.Layout\.has-hero \.VPNavBarTitle \.title \{\s*translate: none;\s*scale: none;/,
    );
    expect(NAV_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.Layout\.has-hero \.VPNavBarTitle \.title,[^}]*\.hero-fade \{\s*transition: none;/,
    );
  });

  it("the bar's surface is opaque and complete before the title reaches it, its divider last, in both themes", () => {
    expect(NAV_CSS).toMatch(
      /\.Layout\.has-hero \.VPNavBar::before \{\s*background: var\(--vp-nav-bg-color\);/,
    );
    expect(NAV_CSS).toMatch(
      /\.Layout\.has-hero \.VPNavBar::after \{\s*border-bottom: 1px solid var\(--vp-c-divider\);/,
    );
    expect(NAV_CSS).toMatch(/animation-range: 0px var\(--hero-bar-end\);/);
    expect(NAV_CSS).toMatch(/animation-range: var\(--hero-line-start\) var\(--hero-brand-y\);/);
    expect(NAV_CSS).toContain("--hero-bar-end: calc(var(--hero-brand-y) * 0.5);");
    expect(NAV_CSS).toContain("--hero-line-start: calc(var(--hero-brand-y) * 0.85);");
    // no translucent mix: the surface is VitePress's own colour of the current theme
    expect(NAV_CSS).not.toMatch(/--vp-nav-bg-color\) \d+%/);
  });

  it("reserves the room: the bar is fixed at every width over a hero that pads under it, the content has no top padding of its own", () => {
    expect(NAV_CSS).toMatch(/\.Layout\.has-hero \.VPNav \{\s*position: fixed;/);
    expect(NAV_CSS).toMatch(/\.Layout\.has-hero \.VPContent \{\s*padding-top: 0;/);
    expect(HERO).toContain(
      "padding: calc(var(--vp-nav-height) / 2 + var(--hero-brand-y) - var(--hero-brand-h) / 2)",
    );
    expect(HERO).toContain("padding-top: calc(var(--hero-brand-h) + 28px)");
  });

  it("the hero's gutters change at the nav wrapper's 768px, so the brand has no x travel in between", () => {
    expect(HERO).toMatch(
      /@media \(min-width: 768px\) \{\s*\.hero \{\s*padding-left: 32px;\s*padding-right: 32px;/,
    );
    expect(HERO).not.toMatch(/@media \(min-width: 640px\) \{\s*\.hero \{/);
    // VitePress's own wrapper: 24px, 32px from 768px
    const wrapper = fs.readFileSync(
      path.join(ROOT, "node_modules/vitepress/dist/client/theme-default/components/VPNavBar.vue"),
      "utf8",
    );
    expect(wrapper).toMatch(/@media \(min-width: 768px\) \{\s*\.wrapper \{\s*padding: 0 32px;/);
  });

  it("the enlarged title's box takes no pointer over the hero text: only its logo and name do", () => {
    expect(NAV_CSS).toMatch(
      /\.Layout\.has-hero \.VPNavBarTitle \.title \{\s*pointer-events: none;/,
    );
    expect(NAV_CSS).toMatch(
      /\.Layout\.has-hero \.VPNavBarTitle \.title > \* \{\s*pointer-events: auto;/,
    );
  });

  it("the bar's name is the site title with its first word in the banner's gradient, derived from one name", () => {
    expect(CONFIG).toContain('const NAME = "Claude Workflow";');
    expect(CONFIG).toContain("title: NAME,");
    expect(CONFIG).toContain('siteTitle: `<span class="brand-a">');
    expect(FRONT).toContain(`name: Claude Workflow`);
  });
});

describe("one of each: GitHub and Get started", () => {
  it("GitHub is the icon beside the theme switch only; the nav has no text link and the hero no button for it", () => {
    const navBlock = (/nav: \[([\s\S]*?)\],\s*sidebar/.exec(CONFIG)?.[1] ?? "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    expect(navBlock).toContain('"Docs"');
    expect(navBlock).not.toMatch(/github/i);
    expect(navBlock).not.toContain("Get started");
    expect(CONFIG).toContain('socialLinks: [{ icon: "github"');
    expect(FRONT).not.toMatch(/github/i);
    expect(FRONT.match(/text: Get started/g)).toHaveLength(1);
  });
});

describe("one layout for the hero and the bar over the whole scroll range", () => {
  it("the grid is one pair of numbers, used by the hero and by the bar: the search starts on the diagram's left edge", () => {
    expect(NAV_CSS).toMatch(/--hero-text-min: 520px;/);
    expect(NAV_CSS).toMatch(/--hero-dg-max: \d+px;/);
    const grid = "max(var(--hero-text-min), calc(100% - var(--hero-dg-max)))";
    // the hero: a left column of the text and a right column of the diagram
    expect(HERO).toContain(`grid-template-columns: ${grid} minmax(0, 1fr);`);
    // the bar: the title's wrapper is the same left column, so the content row (the search first) starts where the diagram does
    expect(NAV_CSS).toMatch(
      new RegExp(
        `\\.Layout\\.has-hero \\.VPNavBar \\.container > \\.title \\{\\s*flex: 0 0 ${grid.replaceAll(/[()]/g, "\\$&")};`,
      ),
    );
  });

  it("the search is wider at the top and shrinks next to the right cluster: two free spaces share the row by flex-grow", () => {
    expect(NAV_CSS).toMatch(/--hero-search-w0: 300px;/);
    expect(NAV_CSS).toMatch(/--hero-search-w1: 150px;/);
    // where the row is short (960 px) the search gives way to the cluster, down to its condensed width, and the content row
    // may be narrower than what it holds, so nothing leaves the viewport
    expect(NAV_CSS).toMatch(
      /> \.VPNavBarSearch \{\s*order: 1;[^}]*flex: 0 1 auto;\s*min-width: var\(--hero-search-w1\);/,
    );
    expect(NAV_CSS).toMatch(/\.container > \.content \{\s*min-width: 0;/);
    expect(NAV_CSS).toMatch(
      /\.VPNavBar \.content-body::before,\s*\.Layout\.has-hero \.VPNavBar \.content-body::after \{\s*content: "";\s*flex: 0 0 0;/,
    );
    expect(NAV_CSS).toMatch(
      /@keyframes hero-space-open \{\s*from \{\s*flex-grow: 0;\s*\}\s*to \{\s*flex-grow: 1;/,
    );
    expect(NAV_CSS).toMatch(
      /@keyframes hero-space-close \{\s*from \{\s*flex-grow: 1;\s*\}\s*to \{\s*flex-grow: 0;/,
    );
    expect(NAV_CSS).toMatch(
      /@keyframes hero-search-in \{\s*from \{\s*width: var\(--hero-search-w0\);\s*\}\s*to \{\s*width: var\(--hero-search-w1\);/,
    );
    expect(NAV_CSS).toMatch(
      /\.hero-condensed \.Layout\.has-hero \.VPNavBar \.content-body > \.VPNavBarSearch \{\s*width: var\(--hero-search-w1\);/,
    );
  });

  it("what the hero holds fades before the bar's edge: the tagline, buttons, chips and the diagram as one unit", () => {
    for (const cls of ["hero-tagline", "hero-actions", "hero-chips", "hero-diagram"])
      expect(HERO, cls).toMatch(new RegExp(`class="${cls} hero-fade"`));
    expect(NAV_CSS).toContain("--hero-fade: 48px;");
    expect(NAV_CSS).toMatch(
      /\.hero-fade \{\s*animation: hero-fade-out linear both;\s*animation-timeline: view\(block calc\(var\(--vp-nav-height\) \+ var\(--hero-fade\)\) 0px\);\s*animation-range: exit 0px exit var\(--hero-fade\);/,
    );
    // the fallback: the same line, an element is faded once any of it is above it
    expect(HERO).toContain('getPropertyValue("--hero-fade")');
    expect(HERO).toContain("rootMargin: `-${bar + fade}px 0px 0px 0px`");
    expect(HERO).toContain('classList.toggle("hero-faded"');
    expect(NAV_CSS).toMatch(/\.hero-faded \{\s*opacity: 0;/);
  });

  it("the diagram is drawn smaller than the text block is tall, and the buttons and chips wrap", () => {
    // 594 px is 70% of the 848 px it filled before; its height (594 x 224/640) stays under the text column's
    const width = Number(/--hero-dg-max: (\d+)px;/.exec(NAV_CSS)?.[1]);
    expect(width).toBeLessThan(848 * 0.8);
    expect(width).toBeGreaterThan(848 * 0.6);
    expect(HERO).toMatch(/\.hero-actions \{\s*display: flex;\s*flex-wrap: wrap;/);
    expect(HERO).toMatch(/\.hero-chips \{\s*display: flex;\s*flex-wrap: wrap;/);
  });

  it("the nav is one Docs menu holding every page of the sidebar, so the landing (no sidebar) has an index and no link stands alone", () => {
    const navBlock = (/nav: \[([\s\S]*?)\],\s*sidebar/.exec(CONFIG)?.[1] ?? "").replaceAll(
      /^\s*\/\/.*$/gm,
      "",
    );
    expect(navBlock).toMatch(/component: "DocsNav"/);
    expect(navBlock).toMatch(/text: "Docs",\s*items: \[/);
    const sidebar = /sidebar: \[([\s\S]*?)\],\s*socialLinks/.exec(CONFIG)?.[1] ?? "";
    const pages = [...sidebar.matchAll(/link: "([^"]+)"/g)].map(m => m[1]);
    expect(pages.length).toBeGreaterThanOrEqual(9);
    for (const page of pages) expect(navBlock, String(page)).toContain(`link: "${page}"`);
  });
});
