// The brand's own data and drawings, free of any dependency so the site (docs/.vitepress/config.mts), the dashboard
// (src/dashboard.ts serves the favicon and the title from here) and scripts/render-banner.mjs all read ONE source.

/** The product's name as the site and the dashboard show it. */
export const NAME = "Claude Workflow";

/** The two palettes of the brand: for a dark page and for a light one (the GitHub palette the site's theme uses). */
export const DARK = {
  bg: "#0d1117", panel: "#161b22", fg: "#e6edf3", muted: "#8b949e", dim: "#6e7681", line: "#30363d",
  blue: "#58a6ff", green: "#3fb950", amber: "#d29922", purple: "#bc8cff",
};
export const LIGHT = {
  bg: "#ffffff", panel: "#f6f8fa", fg: "#1f2328", muted: "#59636e", dim: "#8c959f", line: "#d0d7de",
  blue: "#0969da", green: "#1a7f37", amber: "#9a6700", purple: "#8250df",
};

/** Logo 2, the live map: a dispatcher node fanning out into three lanes, each at its own progress (viewBox 64x64). */
export function logoMark(c) {
  return `
  <path d="M12 32 C22 32 20 13 31 13 H53" fill="none" stroke="${c.blue}" stroke-width="5.5" stroke-linecap="round"/>
  <path d="M12 32 H53" fill="none" stroke="${c.green}" stroke-width="5.5" stroke-linecap="round"/>
  <path d="M12 32 C22 32 20 51 31 51 H35" fill="none" stroke="${c.dim}" stroke-width="5.5" stroke-linecap="round"/>
  <circle cx="53" cy="13" r="6.5" fill="${c.blue}"/>
  <circle cx="53" cy="32" r="6.5" fill="${c.green}"/>
  <circle cx="44.5" cy="51" r="5" fill="none" stroke="${c.dim}" stroke-width="3.5"/>
  <circle cx="12" cy="32" r="9" fill="${c.fg}"/>`;
}

/** The logo as a standalone SVG file in one palette (the site's nav logo: dark and light). */
export function logoSvg(c) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">${logoMark(c)}\n</svg>\n`;
}

/** The favicon: the logo in both palettes in one file, the browser picks by the tab's colour scheme. */
export function faviconSvg() {
  const rule = (cls, prop, c) => `.${cls}{${prop}:${c}}`;
  const sheet = pal =>
    [rule("b", "stroke", pal.blue), rule("g", "stroke", pal.green), rule("d", "stroke", pal.dim), rule("bf", "fill", pal.blue), rule("gf", "fill", pal.green), rule("f", "fill", pal.fg)].join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
<style>${sheet(DARK)}@media (prefers-color-scheme: light){${sheet(LIGHT)}}</style>
  <path class="b" d="M12 32 C22 32 20 13 31 13 H53" fill="none" stroke-width="5.5" stroke-linecap="round"/>
  <path class="g" d="M12 32 H53" fill="none" stroke-width="5.5" stroke-linecap="round"/>
  <path class="d" d="M12 32 C22 32 20 51 31 51 H35" fill="none" stroke-width="5.5" stroke-linecap="round"/>
  <circle class="bf" cx="53" cy="13" r="6.5"/>
  <circle class="gf" cx="53" cy="32" r="6.5"/>
  <circle class="d" cx="44.5" cy="51" r="5" fill="none" stroke-width="3.5"/>
  <circle class="f" cx="12" cy="32" r="9"/>
</svg>
`;
}
