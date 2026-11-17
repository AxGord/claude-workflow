<script setup lang="ts">
// The nav's Docs: a link to the start of the docs with the page list beside it. VitePress's own dropdown is a button that only
// opens its menu (a click goes nowhere), and it has no link-plus-menu item, so this is a custom nav item (config.mts: `component:
// "DocsNav"`). On the bar the title is a link and the caret opens the list (hover and keyboard focus open it too; the caret only
// opens, so a click or Enter on it while hover or focus already opened it keeps it open, and a tap on touch opens it); in the mobile menu (`screenMenu`) it is always expanded: the "Docs" link (to the start of the docs) with every page's link under it, no toggle.
import { useData } from "vitepress";
import { VPLink } from "vitepress/theme";
import VPMenu from "vitepress/dist/client/theme-default/components/VPMenu.vue";
import VPNavScreenMenuGroupLink from "vitepress/dist/client/theme-default/components/VPNavScreenMenuGroupLink.vue";
import VPNavScreenMenuLink from "vitepress/dist/client/theme-default/components/VPNavScreenMenuLink.vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

interface Item {
  text: string;
  link: string;
}

const props = defineProps<{ text: string; link: string; items: Item[]; screenMenu?: boolean }>();

const { page } = useData();
const open = ref(false);
const root = ref<HTMLElement>();

/** Active on every docs page: the page's path is one of the list's links (the landing is not). */
const active = computed(() => {
  const path = `/${page.value.relativePath.replace(/\.md$/, "")}`;
  return props.items.some(i => i.link === path);
});

/** A tap outside closes the list: a touch browser may never move focus off the caret, so focusout alone would leave it open. */
function onPointerDown(e: PointerEvent): void {
  if (!root.value?.contains(e.target as Node | null)) open.value = false;
}
onMounted(() => document.addEventListener("pointerdown", onPointerDown));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onPointerDown));

function onFocusOut(e: FocusEvent): void {
  if (!root.value?.contains(e.relatedTarget as Node | null)) open.value = false;
}
</script>

<template>
  <div v-if="screenMenu" class="DocsNavScreen">
    <VPNavScreenMenuLink :item="{ text, link }" />
    <VPNavScreenMenuGroupLink v-for="item in items" :key="item.link" :item="item" />
  </div>
  <div
    v-else
    ref="root"
    :class="['DocsNav', { active }]"
    @mouseenter="open = true"
    @mouseleave="open = false"
    @focusin="open = true"
    @focusout="onFocusOut"
    @keydown.esc="open = false"
  >
    <VPLink class="docs-link" :href="link">{{ text }}</VPLink>
    <button type="button" class="docs-caret" aria-haspopup="true" :aria-expanded="open" aria-label="Docs pages" @click="open = true">
      <span class="vpi-chevron-down"></span>
    </button>
    <div class="docs-menu">
      <VPMenu :items="items" />
    </div>
  </div>
</template>

<style scoped>
.DocsNavScreen {
  border-bottom: 1px solid var(--vp-c-divider);
  padding-bottom: 8px;
}
.DocsNavScreen :deep(.VPNavScreenMenuLink) {
  border-bottom: 0;
  padding-bottom: 4px;
}
.DocsNav {
  position: relative;
  display: flex;
  align-items: center;
  height: var(--vp-nav-height);
}
.docs-link {
  padding: 0 0 0 12px;
  line-height: var(--vp-nav-height);
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-1);
  transition: color 0.25s;
}
.docs-caret {
  display: flex;
  align-items: center;
  height: var(--vp-nav-height);
  padding: 0 12px 0 4px;
  font-size: 14px;
  color: var(--vp-c-text-1);
  transition: color 0.25s;
}
.DocsNav:hover .docs-link,
.DocsNav:hover .docs-caret {
  color: var(--vp-c-brand-1);
}
.DocsNav.active .docs-link,
.DocsNav.active .docs-caret {
  color: var(--vp-c-brand-1);
}
.docs-menu {
  position: absolute;
  top: calc(var(--vp-nav-height) / 2 + 20px);
  right: 0;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity 0.25s,
    visibility 0.25s;
}
.docs-caret[aria-expanded="true"] + .docs-menu {
  opacity: 1;
  visibility: visible;
}
</style>
