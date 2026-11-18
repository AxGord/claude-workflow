<script setup lang="ts">
// The use-case page's scene "the curator": the ledger's lands cut into windows of today's cadence (the lands
// between two curator runs), each window a bar of its median cost; the reader picks a window and sees what a run
// has in front of it against the window before (the before and after a change is judged on), and under it the
// calibration table by difficulty band, a band opening into its stages and the models that ran them. The windows
// are a cut of the ledger, not a record of the runs that happened: the cadence has changed over the project's life. Every number is the snapshot's (`stats.windows`,
// `stats.bands`). This file draws.
import { computed, ref } from "vue";
import snapshot from "../../use-case-anyparse.json";
import { DASH_TOKENS } from "./dash-tokens";

const stats = snapshot.stats;
const windows = stats.windows;
const bands = stats.bands;
const MODELS = ["haiku", "sonnet", "opus", "fable"];

/** The curator's three tasks, in the order of a run. */
const TASKS = [
  {
    name: "calibrate the table",
    says: "Per stage and difficulty band, from the ledger: the cost of a line, its review rounds, how often its score moved, on the model each stage ran on. Then at most one change to the model table, with the number it should move, that number today, the value predicted and the run that will judge it. No change is a valid answer.",
  },
  {
    name: "judge the last changes",
    says: "Before and after for every change applied in the last two runs: keep, revert, or too few events to say. A change with no effect is taken back.",
  },
  {
    name: "name the friction",
    says: "What slowed the lines down that was not their own doing. It becomes a proposal only above a measured cost in $ or in slot hours; anything smaller is one line in the report.",
  },
];

const run = ref(windows.rows.length);
const band = ref(bands[1]?.band ?? bands[0]?.band ?? "");

const now = computed(() => windows.rows[run.value - 1]);
const before = computed(() => (run.value > 1 ? windows.rows[run.value - 2] : undefined));
const top = Math.max(...windows.rows.map(r => r.median ?? 0), 1);
const open = computed(() => bands.find(b => b.band === band.value) ?? bands[0]);

const usd = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`);
const moved = (a: number | null | undefined, b: number | null | undefined): string => {
  if (a === null || a === undefined || b === null || b === undefined) return "";
  const d = a - b;
  return Math.abs(d) < 0.005 ? "no change" : `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(2)}`;
};
const modelClass = (model: string): string => `m-${MODELS.find(name => model.includes(name)) ?? "script"}`;
const pct = (n: number, of: number): string => (of === 0 ? "—" : `${Math.round((n / of) * 100)}%`);
</script>

<template>
  <figure class="ucc uc-box" :class="DASH_TOKENS" aria-label="The curator: the lands between two runs, and the calibration table it reads">
    <ol class="ucc-tasks">
      <li v-for="(t, i) in TASKS" :key="t.name" class="ucc-task">
        <span class="ucc-num">{{ i + 1 }}</span>
        <span class="ucc-task-name">{{ t.name }}</span>
        <span class="ucc-task-says">{{ t.says }}</span>
      </li>
    </ol>

    <p class="uc-lead ucc-lead">From the ledger · windows of {{ windows.every }} lands, today's cadence · the median cost of a line in each</p>
    <div class="ucc-strip" role="group" aria-label="Windows of the ledger" :style="{ '--n': windows.rows.length }">
      <button
        v-for="(w, i) in windows.rows"
        :key="i"
        type="button"
        class="ucc-win"
        :class="{ on: i + 1 === run, before: i + 2 === run }"
        :style="{ '--h': `${((w.median ?? 0) / top) * 100}%` }"
        :aria-pressed="i + 1 === run"
        :aria-label="`Window ${i + 1}: lands ${i * windows.every + 1} to ${(i + 1) * windows.every}, median ${usd(w.median)}`"
        :data-run="i + 1"
        @click="run = i + 1"
      >
        <span class="ucc-fill"></span>
        <span class="ucc-k">{{ i + 1 }}</span>
      </button>
    </div>

    <div class="ucc-read" data-read>
      <p>
        <b>Window {{ run }}</b>: lands {{ (run - 1) * windows.every + 1 }} to {{ run * windows.every }}, what a run at today's cadence of {{ windows.every }} lands has in front of it.
        <span v-if="windows.rest > 0" class="ucc-dim">{{ windows.rest }} more have landed after the last full window.</span>
      </p>
      <div class="ucc-pair">
        <div class="ucc-fig">
          <span class="ucc-fig-name">median cost of a line</span>
          <span class="ucc-fig-now" data-now-usd>{{ usd(now?.median) }}</span>
          <span class="ucc-fig-was">{{ now?.measured === 0 ? "this window's spend was not recorded yet" : before ? `the window before ${usd(before.median)}${moved(now?.median, before.median) ? ` · ${moved(now?.median, before.median)}` : ""}` : "the first window: nothing before it" }}</span>
        </div>
        <div class="ucc-fig">
          <span class="ucc-fig-name">review rounds per line</span>
          <span class="ucc-fig-now" data-now-rounds>{{ now?.rounds.toFixed(2) }}</span>
          <span class="ucc-fig-was">{{ before ? `the window before ${before.rounds.toFixed(2)} · ${moved(now?.rounds, before.rounds)}` : "the first window: nothing before it" }}</span>
        </div>
      </div>
      <p class="ucc-dim">Two neighbouring windows are the before and the after a change is judged on. {{ windows.every }} lines is a small sample: a difference this size is often "too few events", which is why a verdict may wait a run.</p>
    </div>

    <p class="uc-lead ucc-lead">The calibration table · by the difficulty the stages ran on</p>
    <div class="ucc-table" role="group" aria-label="Difficulty bands">
      <div class="ucc-tr ucc-head"><span>band</span><span>lines</span><span>median</span><span>rounds</span><span>score moved</span></div>
      <button v-for="b in bands" :key="b.band" type="button" class="ucc-tr" :class="{ on: b.band === band }" :aria-pressed="b.band === band" :data-band="b.band" @click="band = b.band">
        <span class="ucc-band">{{ b.band }}</span><span>{{ b.lands }}</span><span>{{ usd(b.median) }}</span><span>{{ b.rounds.toFixed(2) }}</span><span>{{ pct(b.moved, b.lands) }}</span>
      </button>
    </div>
    <div class="ucc-stages" data-stages>
      <p class="ucc-dim">Band {{ open.band }}, per landed line, by stage:</p>
      <div v-for="s in open.stages" :key="s.stage" class="ucc-stage" :data-stage="s.stage">
        <span class="ucc-stage-name">{{ s.stage }}</span>
        <span class="ucc-stage-usd">{{ usd(s.usd) }}</span>
        <span class="ucc-models"><span v-for="m in s.models" :key="m" class="uc-model" :class="modelClass(m)">{{ m }}</span></span>
      </div>
    </div>
    <figcaption class="uc-cap">
      {{ stats.runs.landed }} landed lines in the order they ended, cut into {{ windows.rows.length }} full windows of {{ windows.every }}: a cut of the ledger at today's cadence, not the runs that happened (the cadence has changed over the project's life). The bands count every landed line; a band's stages count the {{ stats.stages.lands }} lines whose agents were recorded one by one, with the models that ran each stage, the costliest first.
    </figcaption>
  </figure>
</template>

<style scoped>
.ucc-tasks {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}
@container (min-width: 760px) {
  .ucc-tasks {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }
}
.ucc-task {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  column-gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--panel-border);
  border-radius: 12px;
}
.ucc-num {
  grid-row: 1 / span 2;
  width: 22px;
  height: 22px;
  border: 2px solid var(--stage-plan);
  border-radius: 50%;
  color: var(--text);
  font: 700 11px/18px var(--mono);
  text-align: center;
}
.ucc-task-name {
  color: var(--text);
  font: 600 12.5px/22px var(--mono);
}
.ucc-task-says {
  color: var(--text-3);
  font-size: 12.5px;
}
.ucc-lead {
  margin-top: 20px;
}
.ucc-strip {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(26px, 1fr));
  gap: 3px;
  margin-top: 8px;
}
@container (min-width: 760px) {
  .ucc-strip {
    grid-template-columns: repeat(var(--n), minmax(0, 1fr));
  }
}
.ucc-win {
  display: grid;
  grid-template-rows: 54px 18px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--text-4);
  font: 10px/18px var(--mono);
  cursor: pointer;
}
.ucc-win:hover {
  border-color: var(--panel-border);
  color: var(--text);
}
.ucc-fill {
  align-self: end;
  justify-self: center;
  width: 64%;
  height: var(--h);
  min-height: 2px;
  border-radius: 3px 3px 0 0;
  background: var(--stage-plan);
  opacity: 0.45;
}
.ucc-win.before {
  border: 1px dashed var(--text-4);
  color: var(--text-2);
}
.ucc-win.before .ucc-fill {
  opacity: 0.7;
}
.ucc-win.on {
  border: 1px solid var(--stage-plan);
  background: color-mix(in srgb, var(--stage-plan) 12%, transparent);
  color: var(--text);
  font-weight: 700;
}
.ucc-win.on .ucc-fill {
  opacity: 1;
}
.ucc-read {
  margin-top: 12px;
  padding: 12px;
  border-radius: 10px;
  background: var(--inset);
}
.ucc-read b {
  color: var(--text);
}
.ucc-dim {
  color: var(--text-3);
  font-size: 12.5px;
}
.ucc-pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 10px 0;
}
.ucc-fig {
  display: grid;
}
.ucc-fig-name {
  color: var(--text-3);
  font: 11px/1.5 var(--mono);
}
.ucc-fig-now {
  color: var(--text);
  font: 700 22px/1.3 var(--mono);
}
.ucc-fig-was {
  color: var(--text-3);
  font: 11px/1.5 var(--mono);
}
.ucc-table {
  margin-top: 8px;
}
.ucc-tr {
  display: grid;
  grid-template-columns: 52px repeat(4, minmax(0, 1fr));
  width: 100%;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  font: 12px/1.5 var(--mono);
  text-align: right;
}
button.ucc-tr {
  cursor: pointer;
}
button.ucc-tr:hover {
  border-color: var(--panel-border);
}
.ucc-tr.on {
  border-color: var(--stage-plan);
  background: color-mix(in srgb, var(--stage-plan) 10%, transparent);
  color: var(--text);
}
.ucc-tr > span:first-child {
  text-align: left;
}
.ucc-head {
  color: var(--text-4);
  font-size: 11px;
}
.ucc-band {
  font-weight: 700;
}
.ucc-stages {
  margin-top: 8px;
  padding: 10px 12px;
  border-left: 3px solid var(--stage-plan);
  border-radius: 0 8px 8px 0;
  background: var(--raised);
}
.ucc-stage {
  display: grid;
  grid-template-columns: 72px 58px minmax(0, 1fr);
  align-items: baseline;
  column-gap: 8px;
  margin-top: 3px;
  font: 12px/1.6 var(--mono);
}
.ucc-stage-name {
  color: var(--text-2);
}
.ucc-stage-usd {
  color: var(--text);
  font-weight: 700;
  text-align: right;
}
.ucc-models {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
}
</style>
