// The dashboard's design tokens (dashboard/tokens.css) put on a class instead of the page root, following VitePress's
// own `html.dark` instead of the system's colour preference: the light set on `.<cls>`, the dark set on
// `html.dark .<cls>`. Pure text in, text out, with no import: the theme's demos take it over the file read by Vite
// (dashboard-css.ts) and the site's config over the file read from disk, for the copy it writes into every page's head.

/** The class of an element that carries the dashboard's tokens and nothing else of its stylesheet: its own rules stay its own. */
export const DASH_TOKENS = "dash-tokens";

/** The tokens file rewritten so that `.cls` carries them: the media block dropped, the two sets kept one rule each. */
export function scopedTokens(tokens: string, cls: string): string {
  return tokens
    .replace(/@media \(prefers-color-scheme: dark\) \{[\s\S]*?\n\}\n/, "")
    .replace(':root, :root[data-theme="light"]', `.${cls}`)
    .replace(':root[data-theme="dark"]', `html.dark .${cls}`)
    .replace(/^:root\s*\{/m, `.${cls} {`);
}
