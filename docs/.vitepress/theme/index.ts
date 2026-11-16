import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import Install from "./Install.vue";
import Scene from "./Scene.vue";
import StatusLine from "./StatusLine.vue";
import WorkflowGraphs from "./WorkflowGraphs.vue";

// The landing page's visual is the scene (terminal plan pane + the replay of the live map), in the hero's
// after-slot, with the install steps right under it (above the features). The live graphs and the status line are
// components a page places in its markdown as an HTML block on a line of its own (`<WorkflowGraphs />`): the config marks every markdown block `v-pre`, which stops a
// component written inside a paragraph from rendering, an HTML block of its own is not marked.
export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "home-hero-after": () => [h(Scene), h(Install)] }),
  enhanceApp({ app }: { app: { component: (name: string, c: unknown) => void } }) {
    app.component("WorkflowGraphs", WorkflowGraphs);
    app.component("StatusLine", StatusLine);
  },
};
