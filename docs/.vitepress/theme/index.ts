import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import MapReplay from "./MapReplay.vue";

// The landing page's visual is the replay of the live map, in the hero's after-slot (not in the page's
// markdown: the config marks every markdown block `v-pre`, which stops a component from rendering).
export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "home-hero-after": () => h(MapReplay) }),
};
