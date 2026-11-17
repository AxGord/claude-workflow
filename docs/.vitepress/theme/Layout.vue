<script setup lang="ts">
import { useData } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { nextTick, onBeforeUnmount, onMounted, provide } from "vue";

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

// Below 960px the bar (and, on a doc page, VitePress's second bar, the local nav) hides on a scroll down and shows on any
// scroll up; from 960px nothing moves. This is the one scroll listener for every page (passive, throttled to a frame): it
// only flips `nav-autohide-hidden` on <html>, the rules below move the bars with `transform`. The bar is always shown at the
// page top, a movement under NAV_SCROLL_THRESHOLD px decides nothing (a jittering finger), and an open menu (the nav screen
// or the sidebar) keeps it shown; a bar with keyboard focus inside it is shown too (`:focus-within`, in the rules below).
const NAV_SCROLL_THRESHOLD = 10;
const NAV_HIDDEN = "nav-autohide-hidden";

let stopAutohide = (): void => undefined;

onMounted(() => {
  const mobile = matchMedia("(max-width: 959.98px)");
  const root = document.documentElement;
  let lastY = Math.max(0, window.scrollY);
  let queued = false;

  const menuOpen = (): boolean => document.querySelector(".VPNavScreen, .VPSidebar.open") !== null;

  const update = (): void => {
    queued = false;
    const y = Math.max(0, window.scrollY);
    if (!mobile.matches || y === 0 || menuOpen()) {
      root.classList.remove(NAV_HIDDEN);
      lastY = y;
      return;
    }
    const moved = y - lastY;
    if (Math.abs(moved) < NAV_SCROLL_THRESHOLD) return;
    root.classList.toggle(NAV_HIDDEN, moved > 0);
    lastY = y;
  };

  const onScroll = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  mobile.addEventListener("change", update);
  stopAutohide = () => {
    window.removeEventListener("scroll", onScroll);
    mobile.removeEventListener("change", update);
    root.classList.remove(NAV_HIDDEN);
  };
});

onBeforeUnmount(() => stopAutohide());
</script>

<template>
  <DefaultTheme.Layout>
    <template v-for="(_, name) in $slots" #[name]="slotData">
      <slot :name="name" v-bind="slotData || {}" />
    </template>
  </DefaultTheme.Layout>
</template>

<style>
/* Below 960px the bar is fixed on every page (VitePress's own is in flow there), the layout pads under it, and the local nav
   (doc pages) sticks right under it; hidden, each moves up by its own height with `transform`, never `top`. From 960px
   VitePress's own fixed bar stays untouched. */
@media (max-width: 959.98px) {
  :root .Layout .VPNav {
    position: fixed;
  }
  :root .Layout:not(.has-hero) {
    padding-top: var(--vp-nav-height);
  }
  :root .Layout .VPLocalNav {
    top: var(--vp-nav-height);
  }
  :root .Layout .VPNav {
    transition:
      transform 0.25s ease,
      background-color 0.5s;
  }
  :root .Layout .VPLocalNav {
    transition: transform 0.25s ease;
  }
  :root.nav-autohide-hidden .Layout .VPNav {
    transform: translateY(calc(-1 * var(--vp-nav-height)));
  }
  :root.nav-autohide-hidden .Layout .VPLocalNav {
    transform: translateY(calc(-100% - var(--vp-nav-height)));
  }
  /* a bar holding keyboard focus is shown, whatever the scroll said: the focused element may not sit off-screen */
  :root.nav-autohide-hidden .Layout .VPNav:focus-within,
  :root.nav-autohide-hidden .Layout .VPLocalNav:focus-within {
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  :root .Layout .VPNav,
  :root .Layout .VPLocalNav {
    transition: none;
  }
}

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
