<script setup lang="ts">
// The live workflow map, replayed: a recorded window of real sessions (public/replay/anyparse.json,
// scripts/export-replay.mjs) is fed, on a clock, to the SAME code the dashboard map runs: `fold` and `layout`
// of src/ lay the picture out and dashboard/scene-dom.js draws it, so lanes advance, branches open, lands fold,
// hover (a tooltip) and click (a folded group opens) work as on /map. No server: the page fetches one JSON file.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { withBase } from "vitepress";
import { reconcile } from "../../../dashboard/scene-dom.js";
import tokens from "../../../dashboard/tokens.css?raw";
import components from "../../../dashboard/components.css?raw";
import { shared } from "./replay-store";
import { fold } from "../../../src/event-fold";
import { layout, scene } from "../../../src/map-layout";
import {
  advance,
  DEFAULT_SPEED,
  elapsed,
  expandReplay,
  followsBottom,
  rowsUntil,
  SPEEDS,
  type ReplayFile,
} from "../../../src/replay";

// The dashboard's own stylesheets, scoped to this block: the tokens on its root, the rules inside an
// `@scope`, so nothing of the dashboard's page-wide rules (body, a, *) reaches the site around it.
const STYLE_ID = "map-replay-css";
const css = `${tokens.replace(/^:root\s*\{/m, ".map-replay {")}\n@scope (.map-replay) {\n${components}\n}`;
const RENDER_EVERY_MS = 90;

const wrap = ref<HTMLElement | null>(null);
const svg = ref<SVGSVGElement | null>(null);
const status = ref("Loading the replay…");
const duration = ref(0);
const at = ref(0);
const playing = ref(false);
const speed = ref(DEFAULT_SPEED);
const speeds = SPEEDS;

let file: ReplayFile | null = null;
let events: ReturnType<typeof expandReplay> = [];
let t0 = 0;
let last = 0; // the last frame's timestamp while playing
let lastRender = 0;
let raf = 0;
let follow = true;
const open = new Set<string>();
let resize: ResizeObserver | null = null;
let seen: IntersectionObserver | null = null;
let started = false;

watch(at, v => {
  shared.at = v;
});

/** The recorder's hook (`?record`): jump to a position and draw it before the promise settles. */
async function seek(ms: number): Promise<void> {
  pause();
  at.value = Math.max(0, Math.min(duration.value, ms));
  follow = true;
  render();
  await nextTick();
}

function render(): void {
  if (!file || !svg.value || !wrap.value) return;
  lastRender = performance.now();
  const folded = fold(events.slice(0, rowsUntil(file, at.value)));
  const map = layout(folded, file.workflows, {
    now: t0 + at.value,
    width: wrap.value.clientWidth || 1000,
    kinds: file.taskKinds,
    open: [...open],
  });
  const height = Math.max(80, map.height);
  svg.value.setAttribute("width", String(map.width));
  svg.value.setAttribute("height", String(height));
  svg.value.setAttribute("viewBox", `0 0 ${map.width} ${height}`);
  reconcile(svg.value, [scene(map)]);
  status.value = map.bands.length === 0 ? "No workflow session yet" : "";
  // an instant jump ends at the bottom, so the scroll event it raises keeps follow mode; a reader's scroll upward does not
  if (follow) wrap.value.scrollTop = wrap.value.scrollHeight;
}

function frame(now: number): void {
  if (!playing.value || !file) return;
  const clock = advance(at.value, last === 0 ? 0 : now - last, speed.value, duration.value);
  last = now;
  at.value = clock.at;
  if (clock.ended) playing.value = false;
  if (now - lastRender >= RENDER_EVERY_MS || clock.ended) render();
  if (playing.value) raf = requestAnimationFrame(frame);
}

function play(): void {
  if (!file) return;
  if (at.value >= duration.value) {
    at.value = 0;
    follow = true;
  }
  playing.value = true;
  last = 0;
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(frame);
}

function pause(): void {
  playing.value = false;
  cancelAnimationFrame(raf);
}

function toggle(): void {
  if (playing.value) pause();
  else play();
}

function scrub(e: Event): void {
  at.value = Number((e.target as HTMLInputElement).value);
  last = 0;
  render();
}

function setSpeed(v: number): void {
  speed.value = v;
}

function onClick(e: MouseEvent): void {
  const el = e.target instanceof Element ? e.target.closest("[data-group]") : null;
  if (!el) return;
  const key = el.getAttribute("data-group") as string;
  if (open.has(key)) open.delete(key);
  else open.add(key);
  render();
}

function onScroll(): void {
  const el = wrap.value;
  if (el) follow = followsBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
}

onMounted(async () => {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }
  try {
    const res = await fetch(withBase("/replay/anyparse.json"));
    file = (await res.json()) as ReplayFile;
  } catch {
    status.value = "The replay could not be loaded.";
    return;
  }
  shared.file = file;
  events = expandReplay(file);
  t0 = Date.parse(file.start);
  duration.value = file.durationMs;
  render();
  if (location.search.includes("record")) {
    (window as unknown as { __replay: unknown }).__replay = { seek, durationMs: file.durationMs };
    return;
  }
  if (wrap.value) {
    resize = new ResizeObserver(() => render());
    resize.observe(wrap.value);
    // plays when it comes into view, unless the reader asks for less motion
    seen = new IntersectionObserver(entries => {
      if (started || !entries.some(e => e.isIntersecting)) return;
      started = true;
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) play();
    });
    seen.observe(wrap.value);
  }
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  resize?.disconnect();
  seen?.disconnect();
});
</script>

<template>
  <section class="map-replay" aria-label="Replay of the live workflow map">
    <div class="mr-frame">
      <div class="mr-bar">
        <button type="button" class="mr-play" :aria-label="playing ? 'Pause' : 'Play'" @click="toggle">
          {{ playing ? "❚❚" : at >= duration && duration > 0 ? "↻" : "▶" }}
        </button>
        <div class="mr-speeds" role="group" aria-label="Speed">
          <button
            v-for="s in speeds"
            :key="s"
            type="button"
            class="mr-speed"
            :class="{ on: s === speed }"
            @click="setSpeed(s)"
          >
            {{ s }}×
          </button>
        </div>
        <input
          class="mr-scrub"
          type="range"
          min="0"
          :max="duration"
          step="1000"
          :value="at"
          aria-label="Position"
          @input="scrub"
        />
        <span class="mr-time">{{ elapsed(at) }} / {{ elapsed(duration) }}</span>
      </div>
      <div ref="wrap" class="map-wrap mr-wrap" @scroll="onScroll" @click="onClick">
        <div v-if="status" class="map-status">{{ status }}</div>
        <svg ref="svg" xmlns="http://www.w3.org/2000/svg"></svg>
      </div>
    </div>
    <p class="mr-note">
      A replay of real sessions of the open-source anyparse project, as the engine recorded them: the same layout code
      as the dashboard's live map, running in your browser.
    </p>
  </section>
</template>

<style scoped>
.map-replay {
  min-width: 0;
}
.mr-frame {
  border: 1px solid var(--panel-border);
  border-radius: var(--panel-radius);
  background: var(--panel);
  color: var(--text-2);
  overflow: hidden;
}
.mr-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--panel-border);
  font: 12px var(--font);
}
.mr-play {
  width: 32px;
  height: 28px;
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  background: var(--raised);
  color: var(--text);
  cursor: pointer;
}
.mr-speeds {
  display: flex;
  gap: 4px;
}
.mr-speed {
  padding: 2px 8px;
  border: 1px solid var(--panel-border);
  border-radius: 10px;
  background: var(--inset);
  color: var(--text-3);
  font: inherit;
  cursor: pointer;
}
.mr-speed.on {
  color: var(--text);
  border-color: var(--link);
}
.mr-scrub {
  flex: 1;
  min-width: 140px;
  accent-color: var(--model-sonnet);
}
.mr-time {
  color: var(--text-3);
  font-family: var(--mono);
  white-space: nowrap;
}
.mr-wrap {
  max-height: 540px;
  overflow: auto;
  padding: 8px 0;
}
.mr-note {
  margin-top: 10px;
  color: var(--vp-c-text-2);
  font-size: 13px;
  text-align: center;
}
</style>
