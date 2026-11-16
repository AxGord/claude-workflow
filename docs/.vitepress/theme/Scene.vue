<script setup lang="ts">
// The landing's scene: one 16:9 stage (drawn at 1920x1080 and scaled to the page's width) that the live map fills
// above a thin strip of the machine's thread pool, the Claude Code window drawn over the map (hidden and shown by the
// transport's button or `T`), and one transport bar under the stage that drives them all. The recorders (scripts/scene-capture.mjs) capture this same stage at scale 1,
// through the `?record` hook: the page then hands over `seek(ms)` instead of playing on its own clock.
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { withBase } from "vitepress";
import type { ReplayFile } from "../../../src/replay";
import MapReplay from "./MapReplay.vue";
import PoolStrip from "./PoolStrip.vue";
import TerminalWindow from "./TerminalWindow.vue";
import Transport from "./Transport.vue";
import { load, pause, play, seekTo, shared } from "./replay-store";

const STAGE_W = 1920;
const STAGE_H = 1080;
/** The pool strip's height at the stage's foot: the map fills what is above it. */
const STRIP_H = 96;

const frame = ref<HTMLElement | null>(null);
const scale = ref(1);
const status = ref("Loading the replay…");
let resize: ResizeObserver | null = null;
let seen: IntersectionObserver | null = null;
let started = false;

/** The recorder's hook (`?record`): jump to a position and draw it before the promise settles. */
async function seek(ms: number): Promise<void> {
  pause();
  seekTo(ms);
  await nextTick();
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== "t" && e.key !== "T") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  shared.terminal = !shared.terminal;
}

onMounted(async () => {
  if (frame.value) {
    resize = new ResizeObserver(() => {
      if (frame.value) scale.value = frame.value.clientWidth / STAGE_W;
    });
    resize.observe(frame.value);
    scale.value = frame.value.clientWidth / STAGE_W;
  }
  window.addEventListener("keydown", onKey);
  try {
    const res = await fetch(withBase("/replay/anyparse.json"));
    load((await res.json()) as ReplayFile);
    status.value = "";
  } catch {
    status.value = "The replay could not be loaded.";
    return;
  }
  if (location.search.includes("record")) {
    (window as unknown as { __replay: unknown }).__replay = { seek, durationMs: shared.duration };
    return;
  }
  // plays when it comes into view, unless the reader asks for less motion
  seen = new IntersectionObserver(entries => {
    if (started || !entries.some(e => e.isIntersecting)) return;
    started = true;
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) play();
  });
  if (frame.value) seen.observe(frame.value);
});

onBeforeUnmount(() => {
  pause();
  resize?.disconnect();
  seen?.disconnect();
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div class="scene">
    <div ref="frame" class="stage-frame">
      <div class="stage" :style="{ width: `${STAGE_W}px`, height: `${STAGE_H}px`, transform: `scale(${scale})` }">
        <div class="stage-map" :style="{ bottom: `${STRIP_H}px` }"><MapReplay /></div>
        <div v-if="shared.file && shared.file.pool" class="stage-strip" :style="{ height: `${STRIP_H}px` }">
          <PoolStrip :file="shared.file" :at="shared.at" />
        </div>
        <TerminalWindow v-show="shared.terminal" />
        <div v-if="status" class="stage-status">{{ status }}</div>
      </div>
    </div>
    <Transport />
    <p class="scene-note">
      A replay of real sessions of the open-source anyparse project, as the engine recorded them: the dashboard's
      live map and the plan pane of the Claude Code mod, drawn by their own code, running in your browser. The strip
      under the map is the machine's thread pool over the same hours, as its own log recorded it.
    </p>
  </div>
</template>

<style>
.scene {
  max-width: 1280px;
  margin: 0 auto 56px;
  padding: 0 24px;
}
.stage-frame {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: #0f1117;
}
.stage {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  overflow: hidden;
}
.stage-map {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
}
.stage-strip {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
}
.stage-status {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #8b949e;
  font-size: 28px;
}
.scene-note {
  margin-top: 10px;
  color: var(--vp-c-text-2);
  font-size: 13px;
  text-align: center;
}
@media (max-width: 640px) {
  .scene {
    padding: 0 16px;
  }
}
</style>
