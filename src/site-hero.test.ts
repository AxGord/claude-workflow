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
  it("scroll-driven where the browser has it and motion is allowed, with the title shrinking to the bar's left", () => {
    expect(NAV_CSS).toContain("@supports (animation-timeline: scroll())");
    expect(NAV_CSS).toContain("@media (prefers-reduced-motion: no-preference)");
    expect(NAV_CSS).toMatch(/animation-timeline: scroll\(root block\);/);
    expect(NAV_CSS).toMatch(
      /@keyframes hero-brand-shrink \{\s*from \{\s*transform: translateY\(var\(--hero-brand-y\)\) scale\(var\(--hero-brand-s\)\);\s*\}\s*to \{\s*transform: none;/,
    );
    // the travel is vertical only: the hero shares the bar's width and gutters, so no x is measured
    expect(HERO).toContain("max-width: calc(var(--vp-layout-max-width) - 64px)");
  });

  it("falls back to a class toggled by an IntersectionObserver, which is a plain switch under reduced motion", () => {
    expect(HERO).toContain("new IntersectionObserver");
    expect(HERO).toContain('classList.toggle("hero-condensed", !e.isIntersecting)');
    expect(HERO).toContain('classList.remove("hero-condensed")');
    expect(NAV_CSS).toMatch(
      /\.hero-condensed \.Layout\.has-hero \.VPNavBarTitle \.title \{\s*transform: none;/,
    );
    expect(NAV_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.Layout\.has-hero \.VPNavBarTitle \.title,\s*\.Layout\.has-hero \.VPNavBar::before \{\s*transition: none;/,
    );
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
  it("GitHub is the icon beside the search only; the nav has no text link and the hero no button for it", () => {
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
