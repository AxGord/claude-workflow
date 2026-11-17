import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

const NAME = "Claude Workflow";

/** The bundled workflows, counted from templates/ (the files the loader's bundled tier reads), for the hero's chip: never typed. */
const bundledWorkflows = fs
  .readdirSync(fileURLToPath(new URL("../../templates", import.meta.url)))
  .filter(f => f.endsWith(".yaml")).length;

// A GitHub project page: https://axgord.github.io/claude-workflow/
export default defineConfig({
  title: NAME,
  description: "Workflows for Claude Code agents: states, gates, a machine-wide thread pool, a live map",
  base: "/claude-workflow/",
  cleanUrls: true,
  lastUpdated: false,
  // A dead link fails the build; `src/...` and `scripts/...` mentions in the text are code paths,
  // not pages, and are written as code, not as links.
  ignoreDeadLinks: false,
  // The brand's logo 2 as the tab icon (docs/public/favicon.svg, written by scripts/render-banner.mjs); `head` hrefs take the base by hand.
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/claude-workflow/favicon.svg" }]],
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
    footer: { message: "Released under the MIT License.", copyright: "Claude Workflow" },
  },
});
