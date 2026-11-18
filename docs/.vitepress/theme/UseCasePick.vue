<script setup lang="ts">
// The use-case page's scene "the pick": a small queue under a window of slots. The dispatcher's pick has already run
// when the scene opens; the reader lands a running line (its slot frees and the pick runs again), changes the window
// or promotes the backlog line, and every line says in the pick's own words why it runs or waits. The pick is
// `toyPick` (src/use-case-scenes.ts), held equal to the engine's `planPick` by a test; the hours under it are the
// ledger's. This file draws.
import { computed, ref } from "vue";
import snapshot from "../../use-case-anyparse.json";
import { TOY_WINDOWS, toyStart, toyStep, type ToyLine } from "../../../src/use-case-scenes";
import { DASH_TOKENS } from "./dash-tokens";

const START_WINDOW = 3;
const state = ref(toyStart(START_WINDOW, snapshot.exclusive_hold));
/** Counts the picks, so the lines of a new pick replay their arrival. */
const picks = ref(0);

const running = computed(() => state.value.lines.filter(l => l.status === "running"));
const slots = computed(() => Array.from({ length: Math.max(state.value.window, running.value.length) }, (_, i) => running.value[i]));
const left = computed(() => state.value.lines.filter(l => l.status === "pending" || l.status === "running").length);

function act(action: Parameters<typeof toyStep>[1]): void {
  state.value = toyStep(state.value, action);
  picks.value++;
}
function restart(): void {
  state.value = toyStart(START_WINDOW, snapshot.exclusive_hold);
  picks.value++;
}
function tap(l: ToyLine): void {
  if (l.status === "running") act({ land: l.id });
  else if (l.status === "backlog") act({ promote: l.id });
}

/** What the scene says about a line: the pick's own reason for a waiting one. */
function verdict(l: ToyLine): string {
  if (l.status === "running") return state.value.admitted.includes(l.id) ? "admitted" : "running";
  if (l.status === "done") return "landed";
  if (l.status === "backlog") return "backlog: never picked until promoted";
  return state.value.reasons[l.id] ?? "";
}
const hint = (l: ToyLine): string => (l.status === "running" ? "land it" : l.status === "backlog" ? "promote" : "");

const hours = snapshot.stats.slots;
const most = Math.max(...hours.map(s => s.hours), 1);
const total = hours.reduce((sum, s) => sum + s.hours, 0);
</script>

<template>
  <figure class="ucp uc-box" :class="DASH_TOKENS" aria-label="The pick over a small queue: which lines run together and why the others wait">
    <div class="ucp-top">
      <div class="ucp-window" role="group" aria-label="The window: lines that may run at once">
        <span class="ucp-label">window</span>
        <button
          v-for="n in TOY_WINDOWS"
          :key="n"
          type="button"
          class="ucp-step"
          :class="{ on: n === state.window }"
          :aria-pressed="n === state.window"
          :aria-label="`A window of ${n}`"
          :data-window="n"
          @click="act({ window: n })"
        >
          {{ n }}
        </button>
      </div>
      <button type="button" class="uc-chip" data-restart @click="restart">start over</button>
    </div>

    <div class="ucp-slots" aria-label="The window's slots">
      <span v-for="(l, i) in slots" :key="i" class="ucp-slot" :class="{ busy: l, over: i >= state.window }" :data-slot="l?.id ?? ''">{{ l ? l.id : "free" }}</span>
    </div>

    <ol :key="picks" class="ucp-lines">
      <li v-for="(l, i) in state.lines" :key="l.id" class="ucp-line" :class="`is-${l.status}`" :style="{ '--i': i }" :data-line="l.id" :data-status="l.status">
        <component
          :is="hint(l) ? 'button' : 'div'"
          class="ucp-row"
          :type="hint(l) ? 'button' : undefined"
          :aria-label="hint(l) ? `${l.id}: ${hint(l)}` : undefined"
          @click="tap(l)"
        >
          <span class="ucp-mark" aria-hidden="true"></span>
          <span class="ucp-id">{{ l.id }}</span>
          <span class="ucp-meta">
            <span class="ucp-diff" :style="{ '--c': `var(--diff-${l.difficulty})` }">{{ l.difficulty }}</span>
            <span v-if="l.priority !== 'normal'" class="ucp-prio" :class="`p-${l.priority}`">{{ l.priority }}</span>
            <span v-if="l.exclusive" class="ucp-flag">exclusive</span>
            <span v-if="l.after" class="ucp-flag ucp-after">after {{ l.after.join(", ") }}</span>
          </span>
          <span class="ucp-touches">{{ l.touches.join(", ") }}</span>
          <span class="ucp-why" data-why>{{ verdict(l) }}</span>
          <span v-if="hint(l)" class="ucp-hint">{{ hint(l) }} ›</span>
        </component>
      </li>
    </ol>

    <p class="ucp-help" data-help>
      {{ left === 0 ? "Nothing is pending and nothing runs: the campaign is over. A backlog line waits until someone promotes it." : "Tap a running line to land it: its slot frees and the pick runs again." }}
    </p>

    <div class="ucp-hours">
      <p class="uc-lead">From the ledger · hours by pipelines open at once</p>
      <div v-for="s in hours" :key="s.open" class="ucp-hour" :data-open="s.open">
        <span class="ucp-open">{{ s.open }}</span>
        <span class="ucp-track"><span class="ucp-fill" :style="{ width: `${(s.hours / most) * 100}%` }"></span></span>
        <span class="ucp-h">{{ s.hours }} h</span>
      </div>
    </div>
    <figcaption class="uc-cap">
      An example queue; the verdicts are the pick's own words.
      <span data-hold>{{ snapshot.exclusive_hold ? "A waiting exclusive line holds the lines behind it, the engine's default, which anyparse's queue keeps." : "By the engine's default a waiting exclusive line holds the lines behind it; anyparse's queue header turns that hold off, so here it simply waits for an empty repository." }}</span>
      The hours are anyparse's ledger: {{ Math.round(total) }} hours of the snapshot's window by the number of its pipelines open at the same moment.
    </figcaption>
  </figure>
</template>

<style scoped>
.ucp-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ucp-window {
  display: flex;
  align-items: center;
  gap: 4px;
}
.ucp-label {
  margin-right: 6px;
  color: var(--text-3);
  font: 12px/1.5 var(--mono);
}
.ucp-step {
  width: 30px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--panel-border);
  border-radius: 7px;
  background: transparent;
  color: var(--text-3);
  font: 600 12px/1 var(--mono);
  cursor: pointer;
}
.ucp-step:hover {
  border-color: var(--text-4);
  color: var(--text);
}
.ucp-step.on {
  border-color: var(--model-sonnet);
  background: color-mix(in srgb, var(--model-sonnet) 16%, transparent);
  color: var(--text);
}
.ucp-slots {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0;
}
.ucp-slot {
  flex: 1 1 150px;
  overflow: hidden;
  padding: 6px 10px;
  border: 1px dashed var(--panel-border);
  border-radius: 9px;
  color: var(--text-4);
  font: 11px/1.5 var(--mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ucp-slot.busy {
  border: 1px solid var(--model-sonnet);
  background: color-mix(in srgb, var(--model-sonnet) 12%, transparent);
  color: var(--text);
  box-shadow: 0 0 10px -4px var(--model-sonnet);
}
/* a window made smaller than what already runs: the lines over it finish, nothing new starts */
.ucp-slot.over {
  border-style: dashed;
}
.ucp-line {
  --c: var(--text-4);
}
.ucp-line.is-running {
  --c: var(--model-sonnet);
}
.ucp-line.is-done {
  --c: var(--ok);
}
.ucp-line.is-pending {
  --c: var(--warn);
}
.ucp-row {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) auto;
  grid-template-areas: "mark id meta" "mark touches hint" "mark why why";
  column-gap: 8px;
  width: 100%;
  margin-bottom: 4px;
  padding: 7px 10px;
  border: 1px solid var(--panel-border);
  border-left: 3px solid var(--c);
  border-radius: 9px;
  background: transparent;
  color: var(--text-2);
  font: 12px/1.5 var(--mono);
  text-align: left;
}
button.ucp-row {
  cursor: pointer;
}
button.ucp-row:hover {
  border-color: var(--c);
  background: color-mix(in srgb, var(--c) 8%, transparent);
}
.ucp-mark {
  grid-area: mark;
  align-self: start;
  width: 9px;
  height: 9px;
  margin-top: 5px;
  border: 2px solid var(--c);
  border-radius: 50%;
}
.is-running .ucp-mark {
  background: var(--c);
  box-shadow: 0 0 8px var(--c);
}
.is-done .ucp-mark {
  background: var(--c);
}
.is-done .ucp-row,
.is-backlog .ucp-row {
  opacity: 0.6;
}
.ucp-id {
  grid-area: id;
  overflow: hidden;
  color: var(--text);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ucp-meta {
  grid-area: meta;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 5px;
  font-size: 11px;
}
.ucp-diff {
  padding: 0 7px;
  border: 2px solid var(--c);
  border-radius: 9px;
  color: var(--text);
  font-weight: 700;
}
.ucp-prio.p-urgent {
  color: var(--prio-urgent);
}
.ucp-prio.p-high {
  color: var(--prio-high);
}
.ucp-prio.p-low {
  color: var(--prio-low);
}
.ucp-prio {
  font-weight: 700;
}
.ucp-flag {
  color: var(--text-3);
}
/* in a narrow frame the line's name keeps the row: what it waits for is in its verdict below */
.ucp-after {
  display: none;
}
.ucp-touches {
  grid-area: touches;
  overflow: hidden;
  color: var(--text-4);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ucp-hint {
  grid-area: hint;
  color: var(--link);
  font-size: 11px;
  white-space: nowrap;
}
.ucp-why {
  grid-area: why;
  color: var(--c);
  overflow-wrap: anywhere;
}
.is-backlog .ucp-why {
  color: var(--text-3);
}
.ucp-help {
  margin-top: 8px;
  color: var(--text-3);
}
.ucp-hours {
  margin-top: 18px;
}
.ucp-hour {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 62px;
  align-items: center;
  column-gap: 8px;
  margin-top: 3px;
  font: 11px/1.5 var(--mono);
}
.ucp-open {
  color: var(--text);
  font-weight: 700;
  text-align: right;
}
.ucp-track {
  height: 10px;
  border-radius: 5px;
  background: var(--grid);
}
.ucp-fill {
  display: block;
  height: 100%;
  min-width: 2px;
  border-radius: 5px;
  background: var(--model-sonnet);
  opacity: 0.8;
}
.ucp-h {
  color: var(--text-3);
  text-align: right;
}
@container (min-width: 760px) {
  .ucp-row {
    grid-template-columns: 14px minmax(180px, 1.1fr) minmax(0, 1fr) minmax(0, 1.6fr) 64px;
    grid-template-areas: "mark id meta why hint";
    align-items: center;
  }
  .ucp-touches {
    display: none;
  }
  .ucp-after {
    display: inline;
  }
  .ucp-meta {
    justify-content: flex-start;
  }
  .ucp-mark {
    align-self: center;
    margin-top: 0;
  }
  .ucp-hint {
    text-align: right;
  }
}
@media (prefers-reduced-motion: no-preference) {
  .ucp-line {
    animation: ucp-in 0.3s ease-out both;
    animation-delay: calc(var(--i) * 45ms);
  }
}
@keyframes ucp-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
