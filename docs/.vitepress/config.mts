import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

// A GitHub project page: https://axgord.github.io/claude-workflow/
export default defineConfig({
  title: "Claude Workflow",
  description: "Workflows for Claude Code agents: states, gates, a machine-wide thread pool, a live map",
  base: "/claude-workflow/",
  cleanUrls: true,
  lastUpdated: false,
  // A dead link fails the build; `src/...` and `scripts/...` mentions in the text are code paths,
  // not pages, and are written as code, not as links.
  ignoreDeadLinks: false,
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
    // The landing's replay imports the live map's own code (src/, dashboard/), outside the docs root.
    server: { fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
  },
  themeConfig: {
    nav: [
      { text: "Get started", link: "/getting-started" },
      { text: "Docs", link: "/concepts" },
      { text: "GitHub", link: "https://github.com/AxGord/claude-workflow" },
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
          { text: "Task queue and dispatch", link: "/queue" },
          { text: "Dashboard and plan pane", link: "/dashboard" },
        ],
      },
      { text: "FAQ", link: "/faq" },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/AxGord/claude-workflow" }],
    search: { provider: "local" },
    outline: [2, 3],
    footer: { message: "Released under the MIT License.", copyright: "Claude Workflow" },
  },
});
