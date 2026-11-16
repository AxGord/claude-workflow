<script setup lang="ts">
// The Claude Code plan pane, as a terminal-style imitation: Running / Next / Landed rows with difficulty bars
// and states, as hooks/plan-pane.tsx draws them, computed from the SAME replay and clock as the map beside it
// (`planAt` of src/replay.ts, the shared position in replay-store.ts). No cost column: the replay carries none.
import { computed } from "vue";
import { difficultyCells, elapsed, planAt, type PlanRow } from "../../../src/replay";
import { shared } from "./replay-store";

const NEXT_SHOWN = 4;
const LANDED_SHOWN = 6;

const view = computed(() => (shared.file ? planAt(shared.file, shared.at) : null));
const lands = computed(() => (view.value ? [...view.value.landed, ...view.value.closed].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)) : []));

function bar(row: PlanRow): { on: string; off: string } {
  const n = difficultyCells(row.difficulty);
  return { on: "█".repeat(n), off: "░".repeat(5 - n) };
}
const age = (row: PlanRow): string => elapsed(Math.max(0, shared.at - row.startedAt)).replace(/^0:/, "");
const took = (row: PlanRow): string => elapsed(Math.max(0, (row.endedAt ?? 0) - row.startedAt)).replace(/^0:/, "");
const isLanded = (row: PlanRow): boolean => view.value?.landed.includes(row) ?? false;
</script>

<template>
  <section class="term" aria-label="Terminal plan pane, imitated">
    <div class="term-title"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>claude · workflow plan</div>
    <div v-if="view" class="term-body">
      <div class="term-h run">▶ Running {{ view.running.length }}</div>
      <div v-for="r in view.running" :key="r.task" class="term-row">
        <span class="bar"><span class="on">{{ bar(r).on }}</span>{{ bar(r).off }}</span>
        <span class="id">{{ r.task }}</span>
        <span class="dim">{{ r.state || "starting" }}<template v-if="r.model"> · {{ r.model }}</template><template v-if="r.rounds > 0"> · r{{ r.rounds }}</template></span>
        <span class="dim age">{{ age(r) }}</span>
      </div>
      <div v-if="view.running.length === 0" class="term-row dim">idle</div>
      <div class="term-h next">⏭ Next ({{ view.next.length }})</div>
      <div v-for="r in view.next.slice(0, NEXT_SHOWN)" :key="r.task" class="term-row">
        <span class="bar"><span class="on">{{ bar(r).on }}</span>{{ bar(r).off }}</span>
        <span class="id">{{ r.task }}</span>
      </div>
      <div v-if="view.next.length > NEXT_SHOWN" class="term-row dim">+{{ view.next.length - NEXT_SHOWN }} more</div>
      <div v-if="view.next.length === 0" class="term-row dim">nothing queued</div>
      <div class="term-h land">✓ Landed ({{ view.landed.length }})</div>
      <div v-for="r in lands.slice(0, LANDED_SHOWN)" :key="r.task" class="term-row">
        <span class="bar"><span class="on">{{ bar(r).on }}</span>{{ bar(r).off }}</span>
        <span class="id">{{ r.task }}</span>
        <span class="dim">{{ isLanded(r) ? "landed" : "closed" }}<template v-if="r.rounds > 0"> · {{ r.rounds }} review{{ r.rounds > 1 ? "s" : "" }}</template></span>
        <span class="dim age">{{ took(r) }}</span>
      </div>
      <div v-if="lands.length === 0" class="term-row dim">nothing yet</div>
    </div>
    <div v-else class="term-body dim">Loading…</div>
  </section>
</template>

<style scoped>
.term {
  min-width: 0;
  border: 1px solid #30363d;
  border-radius: 10px;
  background: #0d1117;
  color: #c9d1d9;
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow: hidden;
}
.term-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid #30363d;
  color: #8b949e;
  font-size: 12px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.r {
  background: #ff5f56;
}
.y {
  background: #ffbd2e;
}
.g {
  background: #27c93f;
  margin-right: 8px;
}
.term-body {
  padding: 10px 14px 14px;
  min-height: 400px;
}
.term-h {
  margin-top: 10px;
  font-weight: 700;
}
.term-h:first-child {
  margin-top: 0;
}
.run {
  color: #3fb950;
}
.next {
  color: #58a6ff;
}
.land {
  color: #3fb950;
}
.term-row {
  display: flex;
  gap: 10px;
  padding-left: 12px;
  white-space: nowrap;
  overflow: hidden;
}
.bar {
  color: #30363d;
}
.on {
  color: #d29922;
}
.id {
  color: #e6edf3;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dim {
  color: #8b949e;
}
.age {
  margin-left: auto;
}
</style>
