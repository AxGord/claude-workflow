<script setup lang="ts">
// The thread pool of the recorded hours, live: the strip of the whole window (PoolStrip.vue) with a cursor, and under
// it the Pool tab of the plan pane at that moment, drawn by the mod's own code (`paneTree` of hooks/pane-view.ts, fed
// `poolStateAt` of src/replay.ts). Play it, or drag the slider; it opens on the busiest moment (the most waiters).
import { withBase } from "vitepress";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { awaitRowToggled, foldFlipped, landDayToggled, paneTree, type PaneAction } from "../../../hooks/pane-view";
import type { View } from "../../../types";
import { advance, elapsed, poolCountsAt, poolStateAt, snapshotAt, type ReplayFile } from "../../../src/replay";
import PaneView from "./PaneView.vue";
import PoolStrip from "./PoolStrip.vue";

const SPEED = 30;
const COLUMNS = 80;

const file = ref<ReplayFile | null>(null);
const at = ref(0);
const playing = ref(false);
const failed = ref(false);
const ui = reactive<{ tab: View; expanded: string; folded: string[] }>({ tab: "pool", expanded: "", folded: [] });
let raf = 0;
let last = 0;

/** The moment of the replay with the most waiters: the one where the pool has something to show. */
function busiest(f: ReplayFile): number {
  let best = 0;
  let most = -1;
  for (const frame of f.pool?.frames ?? [])
    if (frame[6] > most) {
      most = frame[6];
      best = frame[0];
    }
  return best;
}

const pane = computed(() => {
  const f = file.value;
  if (!f) return null;
  return paneTree({
    snapshot: snapshotAt(f, at.value),
    tab: ui.tab,
    expanded: ui.expanded,
    folded: ui.folded,
    now: Date.parse(f.start) + at.value,
    columns: COLUMNS,
    rows: 30,
    poolCounts: poolCountsAt(f, at.value),
    pool: poolStateAt(f, at.value),
  });
});

function frame(now: number): void {
  const f = file.value;
  if (!playing.value || !f) return;
  const clock = advance(at.value, last === 0 ? 0 : now - last, SPEED, f.durationMs);
  last = now;
  at.value = clock.at;
  if (clock.ended) playing.value = false;
  else raf = requestAnimationFrame(frame);
}

function toggle(): void {
  const f = file.value;
  if (!f) return;
  if (playing.value) {
    playing.value = false;
    cancelAnimationFrame(raf);
    return;
  }
  if (at.value >= f.durationMs) at.value = 0;
  playing.value = true;
  last = 0;
  raf = requestAnimationFrame(frame);
}

function act(a: PaneAction): void {
  if (a.kind === "fold") ui.folded = foldFlipped(ui.folded, a.key);
  else if (a.kind === "landDay") ui.folded = landDayToggled(ui.folded, a.key, a.today);
  else if (a.kind === "awaitRow") ui.folded = awaitRowToggled(ui.folded, a.key, a.answered);
  else if (a.kind === "tab") ui.tab = a.id;
  else if (a.kind === "expand") ui.expanded = ui.expanded === a.id ? "" : a.id;
}

onMounted(async () => {
  try {
    const f = (await (await fetch(withBase("/replay/anyparse.json"))).json()) as ReplayFile;
    at.value = busiest(f);
    file.value = f;
  } catch {
    failed.value = true;
  }
});

onBeforeUnmount(() => cancelAnimationFrame(raf));
</script>

<template>
  <section class="pd" aria-label="The thread pool of a recorded window, live">
    <div v-if="file && file.pool" class="pd-box term-surface term-follows-site">
      <div class="pd-strip"><PoolStrip :file="file" :at="at" narrow /></div>
      <PaneView class="pd-pane" :node="pane" @act="act" />
    </div>
    <div v-else class="pd-box pd-status term-surface term-follows-site">{{ failed ? "The replay could not be loaded." : file ? "This replay carries no pool." : "Loading the replay…" }}</div>
    <div v-if="file && file.pool" class="pd-controls">
      <button type="button" class="pd-play" :aria-label="playing ? 'Pause' : 'Play'" @click="toggle">{{ playing ? "❚❚" : "▶" }}</button>
      <input
        type="range"
        min="0"
        :max="file.durationMs"
        step="30000"
        :value="at"
        aria-label="Moment of the recorded window"
        @input="at = Number(($event.target as HTMLInputElement).value)"
      />
      <span class="pd-time">{{ elapsed(at) }} / {{ elapsed(file.durationMs) }} · {{ SPEED }}×</span>
    </div>
  </section>
</template>

<style scoped>
.pd {
  margin: 24px 0;
}
.pd-box {
  border: 1px solid var(--cc-border);
  border-radius: 12px;
  background: var(--cc-panel);
  color: var(--cc-text);
  font: 15px/20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow: hidden;
}
.pd-strip {
  aspect-ratio: 960 / 150;
  border-bottom: 1px solid var(--cc-rule);
}
.pd-pane {
  padding: 12px 16px;
  overflow-x: auto;
}
.pd-status {
  padding: 16px;
  color: var(--cc-dim);
}
.pd-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}
.pd-controls input {
  flex: 1;
  min-width: 0;
}
.pd-play {
  width: 32px;
  height: 28px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  cursor: pointer;
}
.pd-time {
  color: var(--vp-c-text-2);
  font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: nowrap;
}
</style>
