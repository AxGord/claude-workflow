<script setup lang="ts">
import { useData } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { nextTick, provide } from "vue";

// The theme switch cross-fades (View Transitions API, VitePress's documented `toggle-appearance` recipe, without its
// circular reveal): the browser snapshots the page, the `html.dark` flip happens under the snapshot, and the old
// picture fades into the live new one over TRANSITION_MS, the travel time of the switch's own knob (0.25 s in
// VitePress's VPSwitch), so the page changes while the knob moves. Every demo follows `html.dark` in CSS, so they flip in
// the same frame of the same transition. Without `startViewTransition`, or under `prefers-reduced-motion`, the flip is
// the plain one VitePress does without a provider.
const TRANSITION_MS = 300;

const { isDark } = useData();

const animated = (): boolean =>
  "startViewTransition" in document && matchMedia("(prefers-reduced-motion: no-preference)").matches;

provide("toggle-appearance", () => {
  if (!animated()) {
    isDark.value = !isDark.value;
    return;
  }
  document.documentElement.style.setProperty("--theme-fade", `${TRANSITION_MS}ms`);
  const transition = document.startViewTransition(async () => {
    isDark.value = !isDark.value;
    await nextTick();
  });
  // a skipped transition (a second click, a hidden tab) rejects `ready`; the flip itself still ran
  transition.ready.catch(() => undefined);
});
</script>

<template>
  <DefaultTheme.Layout>
    <template v-for="(_, name) in $slots" #[name]="slotData">
      <slot :name="name" v-bind="slotData || {}" />
    </template>
  </DefaultTheme.Layout>
</template>

<style>
::view-transition-group(root) {
  animation-duration: var(--theme-fade);
  animation-timing-function: ease;
}

@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*),
  ::view-transition-old(*),
  ::view-transition-new(*) {
    animation: none;
  }
}
</style>
