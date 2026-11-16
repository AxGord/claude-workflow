<script setup lang="ts">
// The scene's one transport bar, under the whole stage: play / pause, the speed, the scrub and the time drive the
// map and the terminal window together (one clock, replay-store.ts); the last button (and the `T` key) hides or
// shows the Claude Code window over the map.
import { elapsed, SPEEDS } from "../../../src/replay";
import { seekTo, shared, toggle } from "./replay-store";

const speeds = SPEEDS;

function scrub(e: Event): void {
  seekTo(Number((e.target as HTMLInputElement).value));
}
</script>

<template>
  <div class="transport" role="group" aria-label="Replay controls">
    <button type="button" class="tr-play" :aria-label="shared.playing ? 'Pause' : 'Play'" @click="toggle">
      {{ shared.playing ? "❚❚" : shared.at >= shared.duration && shared.duration > 0 ? "↻" : "▶" }}
    </button>
    <div class="tr-speeds" role="group" aria-label="Speed">
      <button v-for="s in speeds" :key="s" type="button" class="tr-speed" :class="{ on: s === shared.speed }" @click="shared.speed = s">
        {{ s }}×
      </button>
    </div>
    <input
      class="tr-scrub"
      type="range"
      min="0"
      :max="shared.duration"
      step="1000"
      :value="shared.at"
      aria-label="Position"
      @input="scrub"
    />
    <span class="tr-time">{{ elapsed(shared.at) }} / {{ elapsed(shared.duration) }}</span>
    <button
      type="button"
      class="tr-term"
      :class="{ on: shared.terminal }"
      :aria-pressed="shared.terminal"
      title="Show or hide the Claude Code window (T)"
      @click="shared.terminal = !shared.terminal"
    >
      Terminal <kbd>T</kbd>
    </button>
  </div>
</template>

<style scoped>
.transport {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
  padding: 10px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  font-size: 12px;
}
.tr-play {
  width: 32px;
  height: 28px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  cursor: pointer;
}
.tr-speeds {
  display: flex;
  gap: 4px;
}
.tr-speed,
.tr-term {
  padding: 2px 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-3);
  font: inherit;
  cursor: pointer;
}
.tr-speed.on,
.tr-term.on {
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-brand-1);
}
.tr-scrub {
  flex: 1;
  min-width: 140px;
  accent-color: var(--vp-c-brand-1);
}
.tr-time {
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  white-space: nowrap;
}
kbd {
  font-family: var(--vp-font-family-mono);
  opacity: 0.7;
}
</style>
