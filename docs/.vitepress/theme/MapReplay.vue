<script setup lang="ts">
// The live workflow map, replayed: a recorded window of real sessions (public/replay/anyparse.json,
// scripts/export-replay.mjs) is fed, on the scene's clock (replay-store.ts), to the SAME code the dashboard map
// runs: `fold` and `layout` of src/ lay the picture out and dashboard/scene-dom.js draws it, so lanes advance,
// branches open, lands fold, hover (a tooltip) and click (a folded group opens) work as on /map.
// The map fills the room the stage leaves it and never scrolls: it is scaled to the frame's width (`fitView`), and when its lanes are
// taller than the frame a camera follows the running lanes, easing from one frame to the next.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { reconcile } from "../../../dashboard/scene-dom.js";
import { DASH, useDashboardCss } from "./dashboard-css";
import { shared } from "./replay-store";
import { fold } from "../../../src/event-fold";
import { layout, scene } from "../../../src/map-layout";
import { cameraTop, expandReplay, fitView, poolWaiting, rowsUntil } from "../../../src/replay";

const RENDER_EVERY_MS = 90;
/** A step of the clock shorter than this eases the camera; a longer one (a scrub, the first frame) jumps it. */
const EASE_WITHIN_MS = 60_000;

const wrap = ref<HTMLElement | null>(null);
const svg = ref<SVGSVGElement | null>(null);
const status = ref("Loading the replay…");

let events: ReturnType<typeof expandReplay> = [];
let t0 = 0;
let lastRender = 0;
let lastAt = -1;
let top = 0;
let settle = 0;
const open = new Set<string>();

function render(): void {
  const file = shared.file;
  if (!file || !svg.value || !wrap.value) return;
  lastRender = performance.now();
  const width = wrap.value.clientWidth || 1920;
  const height = wrap.value.clientHeight || 1080;
  const map = layout(fold(events.slice(0, rowsUntil(file, shared.at))), file.workflows, {
    now: t0 + shared.at,
    width,
    kinds: file.taskKinds,
    // a lane whose exec waits for a pool lease carries the "waiting for the pool" mark, as on /map
    pool: poolWaiting(file, shared.at),
    open: [...open],
  });
  const view = fitView(map.width, map.height, width, height);
  const target = cameraTop(map, view.height);
  const step = shared.at - lastAt;
  top = lastAt >= 0 && step > 0 && step < EASE_WITHIN_MS ? top + (target - top) * 0.3 : target;
  if (Math.abs(target - top) < 1) top = target;
  lastAt = shared.at;
  svg.value.setAttribute("viewBox", `0 ${top.toFixed(1)} ${view.width} ${view.height}`);
  reconcile(svg.value, [scene(map)]);
  status.value = map.bands.length === 0 ? "No workflow session yet" : "";
  // paused short of its target (the recorder seeks frame by frame and never waits on it), the camera keeps easing
  cancelAnimationFrame(settle);
  if (top !== target && !shared.playing && !location.search.includes("record"))
    settle = requestAnimationFrame(() => {
      lastAt = shared.at - 1;
      render();
    });
}

watch(
  () => shared.at,
  () => {
    if (!shared.playing || performance.now() - lastRender >= RENDER_EVERY_MS) render();
  },
);
watch(
  () => shared.file,
  file => {
    if (!file) return;
    events = expandReplay(file);
    t0 = Date.parse(file.start);
    lastAt = -1;
    render();
  },
);
watch(() => shared.playing, render);

function onClick(e: MouseEvent): void {
  const el = e.target instanceof Element ? e.target.closest("[data-group]") : null;
  if (!el) return;
  const key = el.getAttribute("data-group") as string;
  if (open.has(key)) open.delete(key);
  else open.add(key);
  lastAt = -1;
  render();
}

onMounted(() => {
  useDashboardCss();
  if (shared.file) {
    events = expandReplay(shared.file);
    t0 = Date.parse(shared.file.start);
    render();
  }
});

onBeforeUnmount(() => cancelAnimationFrame(settle));
</script>

<template>
  <section class="map-replay" :class="DASH" aria-label="Replay of the live workflow map">
    <div ref="wrap" class="map-wrap mr-wrap" @click="onClick">
      <div v-if="status" class="map-status">{{ status }}</div>
      <svg ref="svg" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMinYMin meet"></svg>
    </div>
  </section>
</template>

<style scoped>
.map-replay {
  position: absolute;
  inset: 0;
  background: var(--panel);
  color: var(--text-2);
}
.mr-wrap {
  position: absolute;
  inset: 0;
  overflow: hidden;
  padding: 0;
}
.mr-wrap svg {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
