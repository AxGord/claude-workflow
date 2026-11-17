<script setup lang="ts">
// The status line, drawn by the mod's own code: hooks/pane-view.ts `statusBandTree` turns a Snapshot into the band
// above Claude Code's prompt (the root session with its workflow and state, the other sessions' count, the queue's
// running / ready / landed, the [plan] button), and PaneView.vue draws the tree. The Snapshot is `snapshotAt` of the
// recorded replay (public/replay/anyparse.json) at a moment the reader chooses; it opens on the busiest one.
import { withBase } from "vitepress";
import { computed, onMounted, ref } from "vue";
import { statusBandTree } from "../../../hooks/pane-view";
import { elapsed, snapshotAt, type ReplayFile } from "../../../src/replay";
import PaneView from "./PaneView.vue";

/** How many moments of the replay are looked at to open on the busiest one. */
const SAMPLES = 24;

const file = ref<ReplayFile | null>(null);
const at = ref(0);
const failed = ref(false);

/** The moment of the replay with the most live sessions: the one where the band has something to say. */
function busiest(f: ReplayFile): number {
  let best = 0;
  let most = -1;
  for (let i = 0; i < SAMPLES; i++) {
    const t = Math.floor((f.durationMs * (i + 0.5)) / SAMPLES);
    const n = snapshotAt(f, t).sessions.length;
    if (n > most) {
      most = n;
      best = t;
    }
  }
  return best;
}

const band = computed(() => (file.value ? statusBandTree(snapshotAt(file.value, at.value)) : null));

onMounted(async () => {
  try {
    const f = (await (await fetch(withBase("/replay/anyparse.json"))).json()) as ReplayFile;
    at.value = busiest(f);
    file.value = f;
  } catch {
    failed.value = true;
  }
});
</script>

<template>
  <section class="sl" aria-label="The status line, drawn by the Claude Code mod's own code">
    <div class="sl-term term-surface term-follows-site">
      <PaneView v-if="band" class="sl-band" :node="band" />
      <div v-else class="sl-status">{{ failed ? "The replay could not be loaded." : "Loading the replay…" }}</div>
      <div class="sl-prompt"><span class="sl-caret">&gt;</span></div>
    </div>
    <div v-if="file" class="sl-scrub">
      <input
        type="range"
        min="0"
        :max="file.durationMs"
        step="60000"
        :value="at"
        aria-label="Moment of the recorded session"
        @input="at = Number(($event.target as HTMLInputElement).value)"
      />
      <span class="sl-time">{{ elapsed(at) }} / {{ elapsed(file.durationMs) }}</span>
    </div>
  </section>
</template>

<style scoped>
.sl {
  margin: 24px 0;
}
.sl-term {
  padding: 12px 16px;
  border: 1px solid var(--cc-border);
  border-radius: 12px;
  background: var(--cc-panel);
  color: var(--cc-text);
  font: 15px/22px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow-x: auto;
}
.sl-band,
.sl-status {
  margin-bottom: 10px;
}
.sl-prompt {
  padding: 6px 10px;
  border: 1px solid var(--cc-input);
  border-radius: 8px;
}
.sl-caret {
  color: var(--cc-muted);
}
.sl-status {
  color: var(--cc-dim);
}
.sl-scrub {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}
.sl-scrub input {
  flex: 1;
  min-width: 0;
}
.sl-time {
  color: var(--vp-c-text-2);
  font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
