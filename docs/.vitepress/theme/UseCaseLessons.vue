<script setup lang="ts">
// The use-case page's scene "lessons become new queue lines": what a landed line left behind, row by row, and the
// place the project's rule sends each row to: the queue at one of three priorities, the backlog, a memory note, or
// nowhere. The rows and their rules are `LESSONS` (src/use-case-scenes.ts). This file draws.
import { computed, ref } from "vue";
import { LESSON_PLACE_NAMES, LESSON_PLACES, LESSONS, type LessonPlace } from "../../../src/use-case-scenes";
import { DASH_TOKENS } from "./dash-tokens";

const chosen = ref(0);
/** The rows the reader has sent on. */
const sent = ref<number[]>([0]);

const lesson = computed(() => LESSONS[chosen.value]);
const arrived = (place: LessonPlace): number => sent.value.filter(i => LESSONS[i].to === place).length;
const queued = computed(() => sent.value.filter(i => ["high", "normal", "low"].includes(LESSONS[i].to)).length);

function send(i: number): void {
  chosen.value = i;
  if (!sent.value.includes(i)) sent.value = [...sent.value, i];
}
</script>

<template>
  <figure class="ucs uc-box" :class="DASH_TOKENS" aria-label="What a landed line leaves behind, and where the project's rule sends each row">
    <div class="ucs-cols">
      <div class="ucs-left">
        <p class="uc-lead">A landed line left behind</p>
        <ol class="ucs-rows">
          <li v-for="(l, i) in LESSONS" :key="i">
            <button type="button" class="ucs-row" :class="{ on: i === chosen, sent: sent.includes(i) }" :aria-pressed="i === chosen" :data-lesson="i" @click="send(i)">
              <span class="ucs-from">{{ l.from }}</span>
              <span class="ucs-text">{{ l.says }}</span>
              <span class="ucs-to" :class="`p-${l.to}`">{{ sent.includes(i) ? `→ ${LESSON_PLACE_NAMES[l.to]}` : "send it ›" }}</span>
            </button>
          </li>
        </ol>
      </div>

      <div class="ucs-right">
        <p class="uc-lead">Where the rule sends it</p>
        <ul class="ucs-places">
          <li v-for="p in LESSON_PLACES" :key="p" class="ucs-place" :class="[`p-${p}`, { on: lesson.to === p }]" :data-place="p">
            <span class="ucs-name">{{ LESSON_PLACE_NAMES[p] }}</span>
            <span class="ucs-count" :data-count="arrived(p)">{{ arrived(p) || "" }}</span>
          </li>
        </ul>
        <p class="ucs-rule" data-rule>{{ lesson.rule }}</p>
        <p class="ucs-loop" data-loop>
          {{ queued === 0 ? "Nothing queued yet." : `${queued} new ${queued === 1 ? "line" : "lines"} in the queue.` }}
          A line queued here carries its difficulty and the files it touches like any other, and the next pick may admit it:
          <a href="#a-line-enters-the-queue">back to the top of the loop</a>.
        </p>
      </div>
    </div>
    <figcaption class="uc-cap">Example rows; the rule is the one anyparse's dispatcher applies after every land, to the worker's open items and the reviewer's non-blocking notes.</figcaption>
  </figure>
</template>

<style scoped>
.ucs-cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 20px;
}
@container (min-width: 760px) {
  .ucs-cols {
    grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
    column-gap: 32px;
  }
}
.ucs-rows {
  margin-top: 6px;
}
.ucs-row {
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr);
  grid-template-areas: "from text" "from to";
  column-gap: 10px;
  width: 100%;
  margin-bottom: 5px;
  padding: 8px 10px;
  border: 1px solid var(--panel-border);
  border-radius: 10px;
  background: transparent;
  color: var(--text-2);
  font: 13px/1.5 var(--vp-font-family-base);
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background-color 0.15s;
}
.ucs-row:hover {
  border-color: var(--text-4);
}
.ucs-row.on {
  border-color: var(--model-sonnet);
  background: color-mix(in srgb, var(--model-sonnet) 10%, transparent);
}
.ucs-from {
  grid-area: from;
  color: var(--text-4);
  font: 11px/1.8 var(--mono);
}
.ucs-text {
  grid-area: text;
}
.ucs-to {
  grid-area: to;
  margin-top: 2px;
  color: var(--link);
  font: 11px/1.6 var(--mono);
}
.ucs-row.sent .ucs-to {
  color: var(--c);
  font-weight: 700;
}
.p-high {
  --c: var(--prio-high);
}
.p-normal {
  --c: var(--model-sonnet);
}
.p-low {
  --c: var(--prio-low);
}
.p-backlog {
  --c: var(--warn);
}
.p-note {
  --c: var(--skill);
}
.p-none {
  --c: var(--text-4);
}
.ucs-places {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
  margin-top: 6px;
}
.ucs-place {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border: 2px solid var(--panel-border);
  border-radius: 10px;
  color: var(--text-3);
  font: 600 12px/1.5 var(--mono);
  transition:
    border-color 0.25s,
    background-color 0.25s,
    box-shadow 0.25s;
}
.ucs-place.on {
  border-color: var(--c);
  background: color-mix(in srgb, var(--c) 12%, transparent);
  color: var(--text);
  box-shadow: 0 0 10px -3px var(--c);
}
.ucs-count {
  min-width: 16px;
  color: var(--c);
  text-align: right;
}
.ucs-rule {
  margin-top: 12px;
  min-height: 62px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--inset);
  color: var(--text-2);
}
.ucs-loop {
  margin-top: 10px;
  color: var(--text-3);
}
.ucs-loop a {
  color: var(--link);
}
</style>
