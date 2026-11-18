import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import "./terminal-palette.css";
import "./use-case.css";
import DocsNav from "./DocsNav.vue";
import Hero from "./Hero.vue";
import Install from "./Install.vue";
import Layout from "./Layout.vue";
import PoolDemo from "./PoolDemo.vue";
import Scene from "./Scene.vue";
import StatusLine from "./StatusLine.vue";
import UseCaseCurator from "./UseCaseCurator.vue";
import UseCaseFlow from "./UseCaseFlow.vue";
import UseCaseLessons from "./UseCaseLessons.vue";
import UseCaseLine from "./UseCaseLine.vue";
import UseCaseNumbers from "./UseCaseNumbers.vue";
import UseCasePick from "./UseCasePick.vue";
import UseCaseRounds from "./UseCaseRounds.vue";
import WorkflowGraphs from "./WorkflowGraphs.vue";

// The landing page opens with the hero (the GitHub banner as live HTML/SVG, merged with the nav: Hero.vue), in the
// hero's before-slot; its visual is the scene (terminal plan pane + the replay of the live map), in the hero's
// after-slot, with the install steps right under it (above the features). The live graphs and the status line are
// components a page places in its markdown as an HTML block on a line of its own (`<WorkflowGraphs />`, `<PoolDemo />` on the pool page, the `<UseCase… />` scenes on the use-case page): the config marks every markdown block `v-pre`, which stops a
// component written inside a paragraph from rendering, an HTML block of its own is not marked. `Layout.vue` wraps the default
// layout (the slots pass through) to provide the theme switch's cross-fade.
export default {
  extends: DefaultTheme,
  Layout: () => h(Layout, null, { "home-hero-before": () => h(Hero), "home-hero-after": () => [h(Scene), h(Install)] }),
  enhanceApp({ app }: { app: { component: (name: string, c: unknown) => void } }) {
    app.component("DocsNav", DocsNav);
    app.component("WorkflowGraphs", WorkflowGraphs);
    app.component("StatusLine", StatusLine);
    app.component("PoolDemo", PoolDemo);
    // the scenes of the use-case page, in the page's order
    app.component("UseCaseLine", UseCaseLine);
    app.component("UseCasePick", UseCasePick);
    app.component("UseCaseFlow", UseCaseFlow);
    app.component("UseCaseRounds", UseCaseRounds);
    app.component("UseCaseLessons", UseCaseLessons);
    app.component("UseCaseCurator", UseCaseCurator);
    app.component("UseCaseNumbers", UseCaseNumbers);
  },
};
