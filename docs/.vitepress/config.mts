import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { NAME } from "../../scripts/brand.mjs";
import { DASH_TOKENS, scopedTokens } from "./theme/dash-tokens";

/** The bundled workflows, counted from templates/ (the files the loader's bundled tier reads), for the hero's chip: never typed. */
const bundledWorkflows = fs
  .readdirSync(fileURLToPath(new URL("../../templates", import.meta.url)))
  .filter(f => f.endsWith(".yaml")).length;

/**
 * The dashboard's tokens on `.dash-tokens`, in every page's head: a diagram rendered into the page's HTML at build time
 * (the use-case page's) has its colours at the first paint, in both themes, with no stylesheet to wait for.
 */
const dashTokens = scopedTokens(
  fs.readFileSync(fileURLToPath(new URL("../../dashboard/tokens.css", import.meta.url)), "utf8"),
  DASH_TOKENS,
);

// A GitHub project page: https://axgord.github.io/claude-workflow/
const SITE = "https://axgord.github.io/claude-workflow/";
const DESCRIPTION = "Workflows for Claude Code agents: states, gates, a machine-wide thread pool, a live map";
/** The card image: docs/public/og.png, the 1280x640 social preview written by scripts/render-banner.mjs (a link in a post needs an absolute URL). */
const OG_IMAGE = { url: `${SITE}og.png`, width: "1280", height: "640", alt: `${NAME}: a task's life from the queue to land, over the live map` };

const meta = (key: "property" | "name", name: string, content: string): [string, Record<string, string>] => [
  "meta",
  { [key]: name, content },
];

export default defineConfig({
  title: NAME,
  description: DESCRIPTION,
  base: "/claude-workflow/",
  cleanUrls: true,
  lastUpdated: false,
  // A dead link fails the build; `src/...` and `scripts/...` mentions in the text are code paths,
  // not pages, and are written as code, not as links.
  ignoreDeadLinks: false,
  // The brand's logo 2 as the tab icon (docs/public/favicon.svg, written by scripts/render-banner.mjs); `head` hrefs take the base by hand.
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/claude-workflow/favicon.svg" }],
    ["style", { id: DASH_TOKENS }, dashTokens],
    // What a link to the site shows in a post: Open Graph (most networks and messengers) and the Twitter card; each page adds its own title, description and url in transformHead.
    meta("property", "og:type", "website"),
    meta("property", "og:site_name", NAME),
    meta("property", "og:image", OG_IMAGE.url),
    meta("property", "og:image:width", OG_IMAGE.width),
    meta("property", "og:image:height", OG_IMAGE.height),
    meta("property", "og:image:alt", OG_IMAGE.alt),
    meta("name", "twitter:card", "summary_large_image"),
    meta("name", "twitter:image", OG_IMAGE.url),
    meta("name", "twitter:image:alt", OG_IMAGE.alt),
  ],
  transformHead({ pageData }) {
    const fm = pageData.frontmatter as { description?: string; hero?: { text?: string; tagline?: string } };
    const title = pageData.title === NAME || pageData.title === "" ? NAME : `${pageData.title} | ${NAME}`;
    // a page's own description; the landing's is its hero; anything else the site's
    const description =
      fm.description ?? (fm.hero?.text ? `${fm.hero.text}. ${fm.hero.tagline ?? ""}`.trim() : DESCRIPTION);
    const route = pageData.relativePath.replace(/\.md$/, "").replace(/(^|\/)index$/, "$1");
    const url = `${SITE}${route}`;
    return [
      meta("property", "og:title", title),
      meta("property", "og:description", description),
      meta("property", "og:url", url),
      meta("name", "twitter:title", title),
      meta("name", "twitter:description", description),
    ];
  },
  srcExclude: ["**/*.test.*"],
  markdown: {
    // The text is full of `{{mustache}}` examples; Vue must not read them as interpolations.
    config(md) {
      md.core.ruler.push("v-pre-blocks", state => {
        for (const token of state.tokens) {
          if (token.nesting === 1 && token.block) token.attrSet("v-pre", "");
        }
      });
    },
  },
  vite: {
    define: { __BUNDLED_WORKFLOWS__: JSON.stringify(bundledWorkflows) },
    // The landing's replay imports the live map's own code (src/, dashboard/), outside the docs root.
    server: { fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
  },
  themeConfig: {
    // Logo 2 in the nav, one file per colour scheme (docs/public/logo.svg for dark, logo-light.svg for light).
    // The name is the hero's brand on the landing (enlarged by the scroll-linked CSS in Hero.vue, its first word in the banner's gradient).
    siteTitle: `<span class="brand-a">${NAME.split(" ")[0]}</span> ${NAME.split(" ").slice(1).join(" ")}`,
    logo: { light: "/logo-light.svg", dark: "/logo.svg", alt: "Claude Workflow" },
    nav: [
      // One entry, the docs index: the landing has no sidebar, so this menu is where its reader finds every page. "Get started"
      // is the hero's button and GitHub is the icon beside the theme switch: each appears once. A click on "Docs" goes to the start
      // of the docs: VitePress's dropdown cannot be a link, so this is a custom item (theme/DocsNav.vue, registered in theme/index.ts).
      {
        component: "DocsNav",
        props: {
          link: "/getting-started",
          text: "Docs",
          items: [
            { text: "Getting started", link: "/getting-started" },
            { text: "Concepts", link: "/concepts" },
            { text: "Use case: anyparse", link: "/use-case-anyparse" },
            { text: "Workflow YAML", link: "/workflow-yaml" },
            { text: "Action states", link: "/action-states" },
            { text: "Thread pool", link: "/pool" },
            { text: "Task queue and dispatch", link: "/queue" },
            { text: "Dashboard and plan pane", link: "/dashboard" },
            { text: "FAQ", link: "/faq" },
            { text: "Development", link: "/development" },
          ],
        },
      },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/getting-started" },
          { text: "Concepts", link: "/concepts" },
        ],
      },
      {
        text: "Use cases",
        items: [{ text: "anyparse", link: "/use-case-anyparse" }],
      },
      {
        text: "Reference",
        items: [
          { text: "Workflow YAML", link: "/workflow-yaml" },
          { text: "Action states", link: "/action-states" },
          { text: "Thread pool", link: "/pool" },
          { text: "Task queue and dispatch", link: "/queue" },
          { text: "Dashboard and plan pane", link: "/dashboard" },
        ],
      },
      { text: "FAQ", link: "/faq" },
      { text: "Development", link: "/development" },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/AxGord/claude-workflow" }],
    search: { provider: "local" },
    outline: [2, 3],
    // VitePress renders `copyright` as HTML; its default rule keeps the footer on pages without a sidebar only.
    footer: {
      message: "Released under the MIT License.",
      copyright: '© 2026 <a href="https://axgord.github.io/" target="_self">Alexander Gordeyko</a>',
    },
  },
});
