<script setup lang="ts">
// The thin strip under the map: the machine's thread pool over the whole replay (public/replay/anyparse.json, cut from
// the pool's own log by scripts/export-replay.mjs). Threads held against the budget (the leases the log does not name, this
// project's or another's, under the ones it names), the waiters as a band along the top, a cursor at the replay's clock, and the reading at
// that moment. The paths are `poolStrip` of src/replay.ts; this file only draws them.
import { computed } from "vue";
import { poolCountsAt, poolStrip, type ReplayFile } from "../../../src/replay";

// `narrow` is the strip on a page column: the labels sit above the plot instead of beside it.
const props = defineProps<{ file: ReplayFile; at: number; narrow?: boolean }>();

const W = props.narrow ? 960 : 1920;
const H = props.narrow ? 150 : 96;
const LEFT = props.narrow ? 16 : 490;
const RIGHT = 16;
const TOP = props.narrow ? 54 : 20;
const PLOT_W = W - LEFT - RIGHT;
const PLOT_H = 64;

const strip = computed(() => poolStrip(props.file, PLOT_W, PLOT_H));
const cursor = computed(() => +((props.at / Math.max(1, props.file.durationMs)) * PLOT_W).toFixed(1));
const reading = computed(() => {
  const c = poolCountsAt(props.file, props.at);
  return c && c.held > 0 ? `${c.held}/${c.budget} threads held · ${c.waiting} waiting` : "idle";
});
</script>

<template>
  <svg class="pool-strip" :viewBox="`0 0 ${W} ${H}`" role="img" aria-label="The machine's thread pool over the replay: threads held against the budget (leases the log does not name, and leases it names), and the waiters">
    <text x="16" y="34" class="ps-title">Thread pool</text>
    <text :x="narrow ? 200 : 16" :y="narrow ? 34 : 58" class="ps-read">{{ strip ? reading : "no pool log in this replay" }}</text>
    <text x="16" :y="narrow ? 142 : 80" class="ps-legend"><tspan class="ps-other">■</tspan> leases the log does not name  <tspan class="ps-named">■</tspan> named  <tspan class="ps-wait">■</tspan> waiting</text>
    <g v-if="strip" :transform="`translate(${LEFT} ${TOP})`">
      <rect x="0" y="0" :width="PLOT_W" :height="PLOT_H" class="ps-bed" />
      <path :d="strip.other" class="ps-other-fill" />
      <path :d="strip.named" class="ps-named-fill" />
      <path :d="strip.waiting" class="ps-wait-fill" />
      <line x1="0" :x2="PLOT_W" :y1="strip.budgetY" :y2="strip.budgetY" class="ps-budget" />
      <line :x1="cursor" :x2="cursor" y1="-4" :y2="PLOT_H + 4" class="ps-cursor" />
    </g>
  </svg>
</template>

<style scoped>
.pool-strip {
  display: block;
  width: 100%;
  height: 100%;
  background: #0f1117;
  font: 600 18px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.ps-title {
  fill: #e6e6e6;
  font-size: 22px;
}
.ps-read {
  fill: #9aa4ae;
  font-size: 18px;
  font-weight: 400;
}
.ps-legend {
  fill: #7d8590;
  font-size: 14px;
  font-weight: 400;
  white-space: pre;
}
.ps-other {
  fill: #5b6b86;
}
.ps-named {
  fill: #4fc1d9;
}
.ps-wait {
  fill: #e5c07b;
}
.ps-bed {
  fill: rgba(255, 255, 255, 0.04);
}
.ps-other-fill {
  fill: #5b6b86;
}
.ps-named-fill {
  fill: #4fc1d9;
}
.ps-wait-fill {
  fill: #e5c07b;
  opacity: 0.85;
}
.ps-budget {
  stroke: #8b949e;
  stroke-width: 1.5;
  stroke-dasharray: 6 5;
}
.ps-cursor {
  stroke: #e6e6e6;
  stroke-width: 2;
}
</style>
