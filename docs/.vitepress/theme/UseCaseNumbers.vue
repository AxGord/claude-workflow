<script setup lang="ts">
// The use-case page's closing scene "the numbers": the snapshot as one panel. Every figure is a button that says how
// it is counted and how many runs it stands on. Nothing here is typed: the figures are `stats` of the snapshot
// (docs/use-case-anyparse.json, scripts/export-use-case.mjs). This file draws.
import { computed, ref } from "vue";
import snapshot from "../../use-case-anyparse.json";
import { DASH_TOKENS } from "./dash-tokens";

const s = snapshot.stats;
const SNAPSHOT_URL = "https://github.com/AxGord/claude-workflow/blob/master/docs/use-case-anyparse.json";

const usd = (n: number | null): string => (n === null ? "—" : `$${n.toFixed(2)}`);
const day = (iso: string): string => iso.slice(0, 10);

const perDay = Math.max(...s.days.map(d => d.lands), 1);
const mostRounds = Math.max(...s.rounds.map(r => r.lands), 1);
const stages = s.stages.rows.filter(r => r.usd > 0);
const recon = [
  { name: "kept", n: s.recon.kept, says: "its score was the line's" },
  { name: "raised", n: s.recon.up, says: "it scored the work higher" },
  { name: "lowered", n: s.recon.down, says: "it scored the work lower" },
  { name: "split", n: s.recon.split, says: "too big: cut into lines" },
  { name: "closed", n: s.recon.closed, says: "a premise failed" },
  { name: "overridden", n: s.recon.overridden, says: "the parent ran it anyway" },
];
const reconSum = recon.reduce((sum, r) => sum + r.n, 0);
const hours = s.slots.reduce((sum, x) => sum + x.hours, 0);

const HOW: Record<string, string> = {
  lands: `A run landed when it went through the land and its bookkeeping. ${s.runs.total} runs of the pipeline ended in the window: ${s.runs.landed} landed, ${s.runs.split} were split into smaller lines, ${s.runs.closed} closed without landing (a refuted premise, a blocked worker, a rejected review), ${s.runs.other} were abandoned or released.`,
  cost: `The spend of a landed line's agents, read from their transcripts and priced turn by turn at API rates: ${s.cost.measured} of the ${s.cost.lands} landed lines carry it (the record began after the first days). Median ${usd(s.cost.median)}, mean ${usd(s.cost.mean)}. The top-level conversation's own turns are not in it.`,
  days: `Landed lines by the UTC day they ended, over the ${s.days.length} days of the window.`,
  rounds: `Entries into the review of a landed line: the first review, and one more for every fix round. All ${s.runs.landed} landed lines.`,
  stages: `Over the ${s.stages.lands} landed lines whose agents were recorded one by one: each agent's spend goes to the stage it was linked at. plan is the plan stage's agent, who also writes the code of a line it keeps; execute is a separate executor; driver is the cheap agent that moves the session; other is an agent no stage names.`,
  recon: `Of the ${s.recon.ran} runs a recon read: what became of the line. A run whose recon did not finish is in none of the parts.`,
  slots: `Every run's start opens a slot and its end frees one: the ${Math.round(hours)} hours of the window by the number of pipelines open at the same moment.`,
};
const chosen = ref("cost");
const how = computed(() => HOW[chosen.value]);
</script>

<template>
  <figure class="ucn uc-box" :class="DASH_TOKENS" aria-label="The snapshot's numbers: lands, cost, review rounds, the recon, slot occupancy">
    <div class="ucn-tiles">
      <button type="button" class="ucn-tile" :class="{ on: chosen === 'lands' }" :aria-pressed="chosen === 'lands'" data-figure="lands" @click="chosen = 'lands'">
        <span class="ucn-big">{{ s.runs.landed }}</span>
        <span class="ucn-name">lines landed</span>
        <span class="ucn-sub">of {{ s.runs.total }} runs, in {{ s.days.length }} days</span>
      </button>
      <button type="button" class="ucn-tile" :class="{ on: chosen === 'cost' }" :aria-pressed="chosen === 'cost'" data-figure="cost" @click="chosen = 'cost'">
        <span class="ucn-big">{{ usd(s.cost.median) }}</span>
        <span class="ucn-name">per landed line, median</span>
        <span class="ucn-sub">mean {{ usd(s.cost.mean) }}</span>
      </button>
      <button type="button" class="ucn-tile" :class="{ on: chosen === 'recon' }" :aria-pressed="chosen === 'recon'" data-figure="recon" @click="chosen = 'recon'">
        <span class="ucn-big">{{ usd(s.recon.stopped.median) }}</span>
        <span class="ucn-name">a run the recon stopped</span>
        <span class="ucn-sub">{{ s.recon.split + s.recon.closed }} lines never reached a worker</span>
      </button>
    </div>

    <div class="ucn-grid">
      <button type="button" class="ucn-block" :class="{ on: chosen === 'days' }" :aria-pressed="chosen === 'days'" data-figure="days" @click="chosen = 'days'">
        <span class="uc-lead">Lands per day</span>
        <span class="ucn-cols">
          <span v-for="d in s.days" :key="d.day" class="ucn-col" :title="`${d.day}: ${d.lands} landed`" :data-day="d.day">
            <span class="ucn-col-n">{{ d.lands }}</span>
            <span class="ucn-col-fill" :style="{ height: `${(d.lands / perDay) * 100}%` }"></span>
          </span>
        </span>
        <span class="ucn-axis"><span>{{ day(s.from) }}</span><span>{{ day(s.to) }}</span></span>
      </button>

      <button type="button" class="ucn-block" :class="{ on: chosen === 'rounds' }" :aria-pressed="chosen === 'rounds'" data-figure="rounds" @click="chosen = 'rounds'">
        <span class="uc-lead">Review rounds of a landed line</span>
        <span v-for="r in s.rounds" :key="r.rounds" class="ucn-bar t-review" :data-rounds="r.rounds">
          <span class="ucn-bar-name">{{ r.rounds }}</span>
          <span class="ucn-track"><span class="ucn-fill" :style="{ width: `${(r.lands / mostRounds) * 100}%` }"></span></span>
          <span class="ucn-bar-n">{{ r.lands }}</span>
          <span class="ucn-bar-x">{{ usd(r.median) }}</span>
        </span>
      </button>

      <button type="button" class="ucn-block" :class="{ on: chosen === 'stages' }" :aria-pressed="chosen === 'stages'" data-figure="stages" @click="chosen = 'stages'">
        <span class="uc-lead">A landed line's cost by stage</span>
        <span class="ucn-stack">
          <span v-for="p in stages" :key="p.stage" class="ucn-part" :class="`t-${p.stage}`" :style="{ width: `${(p.usd / s.stages.usd) * 100}%` }"></span>
        </span>
        <span class="ucn-legend">
          <span v-for="p in stages" :key="p.stage" :class="`t-${p.stage}`" :data-stage="p.stage"><i></i>{{ p.stage }} <b>{{ Math.round((p.usd / s.stages.usd) * 100) }}%</b></span>
        </span>
      </button>

      <button type="button" class="ucn-block" :class="{ on: chosen === 'recon' }" :aria-pressed="chosen === 'recon'" data-figure="recon-parts" @click="chosen = 'recon'">
        <span class="uc-lead">What the recon did with {{ s.recon.ran }} lines</span>
        <span class="ucn-stack">
          <span v-for="(r, i) in recon" :key="r.name" class="ucn-part" :class="`r-${i}`" :style="{ width: `${(r.n / reconSum) * 100}%` }"></span>
        </span>
        <span class="ucn-legend">
          <span v-for="(r, i) in recon" :key="r.name" :class="`r-${i}`" :title="r.says" :data-recon="r.name"><i></i>{{ r.name }} <b>{{ r.n }}</b></span>
        </span>
      </button>

      <button type="button" class="ucn-block ucn-wide" :class="{ on: chosen === 'slots' }" :aria-pressed="chosen === 'slots'" data-figure="slots" @click="chosen = 'slots'">
        <span class="uc-lead">Hours by pipelines open at once</span>
        <span class="ucn-stack ucn-tall">
          <span v-for="x in s.slots" :key="x.open" class="ucn-part ucn-slot" :style="{ width: `${(x.hours / hours) * 100}%`, '--k': x.open }" :title="`${x.open} open: ${x.hours} h`" :data-open="x.open">
            <span v-if="x.hours / hours > 0.05">{{ x.open }}</span>
          </span>
        </span>
        <span class="ucn-axis"><span>the number is how many were open; the width, for how long</span><span>{{ Math.round(hours) }} h</span></span>
      </button>
    </div>

    <p class="uc-note" data-how><span class="uc-lead">How it is counted</span> {{ how }}</p>
    <p class="ucn-yard" data-yardstick>
      The $ is what the same tokens cost at API prices. On a subscription no such bill arrives: read it as a yardstick of how much of the limit a task used. Exact limit accounting is not published.
    </p>
    <figcaption class="uc-cap">
      anyparse's ledger from {{ day(s.from) }} to {{ day(s.to) }}, one project's task pipeline, no task or session named. The file itself: <a :href="SNAPSHOT_URL">use-case-anyparse.json</a>.
    </figcaption>
  </figure>
</template>

<style scoped>
.ucn-tiles {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.ucn-tile,
.ucn-block {
  display: grid;
  align-content: start;
  padding: 12px;
  border: 1px solid var(--panel-border);
  border-radius: 12px;
  background: transparent;
  color: var(--text-2);
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background-color 0.15s;
}
.ucn-tile:hover,
.ucn-block:hover {
  border-color: var(--text-4);
}
.ucn-tile.on,
.ucn-block.on {
  border-color: var(--model-sonnet);
  background: color-mix(in srgb, var(--model-sonnet) 8%, transparent);
}
.ucn-big {
  color: var(--text);
  font: 700 26px/1.2 var(--mono);
}
.ucn-name {
  color: var(--text-2);
  font-size: 12.5px;
}
.ucn-sub {
  color: var(--text-4);
  font: 11px/1.5 var(--mono);
}
.ucn-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  margin-top: 8px;
}
@container (min-width: 760px) {
  .ucn-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .ucn-wide {
    grid-column: 1 / -1;
  }
}
@container (max-width: 480px) {
  .ucn-tiles {
    grid-template-columns: minmax(0, 1fr);
  }
}
.ucn-cols {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: 3px;
  height: 86px;
  margin-top: 8px;
}
.ucn-col {
  display: grid;
  grid-template-rows: 14px minmax(0, 1fr);
}
.ucn-col-n {
  color: var(--text-4);
  font: 9.5px/14px var(--mono);
  text-align: center;
}
.ucn-col-fill {
  align-self: end;
  min-height: 2px;
  border-radius: 3px 3px 0 0;
  background: var(--stage-land);
  opacity: 0.8;
}
.ucn-axis {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
  color: var(--text-4);
  font: 10.5px/1.5 var(--mono);
}
.ucn-bar {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) 34px 52px;
  align-items: center;
  column-gap: 8px;
  margin-top: 6px;
  font: 11px/1.5 var(--mono);
}
.ucn-bar-name {
  color: var(--text);
  font-weight: 700;
}
.ucn-track {
  height: 10px;
  border-radius: 5px;
  background: var(--grid);
}
.ucn-fill {
  display: block;
  height: 100%;
  border-radius: 5px;
  background: var(--stage-review);
  opacity: 0.85;
}
.ucn-bar-n {
  color: var(--text-2);
  text-align: right;
}
.ucn-bar-x {
  color: var(--text-4);
  text-align: right;
}
.ucn-stack {
  display: flex;
  height: 14px;
  margin-top: 10px;
  overflow: hidden;
  border-radius: 7px;
  background: var(--grid);
}
.ucn-tall {
  height: 26px;
}
.ucn-part {
  background: var(--c);
}
.ucn-part + .ucn-part {
  border-left: 2px solid var(--panel);
}
.ucn-slot {
  --c: color-mix(in srgb, var(--model-sonnet) calc(var(--k) * 18% + 10%), var(--grid));
  overflow: hidden;
  color: var(--text);
  font: 700 11px/26px var(--mono);
  text-align: center;
}
.ucn-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 14px;
  margin-top: 8px;
  color: var(--text-3);
  font: 11px/1.6 var(--mono);
}
.ucn-legend i {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 5px;
  border-radius: 2px;
  background: var(--c);
}
.ucn-legend b {
  color: var(--text);
}
.t-recon {
  --c: var(--stage-recon);
}
.t-plan {
  --c: var(--stage-plan);
}
.t-execute {
  --c: var(--stage-work);
}
.t-fix {
  --c: var(--stage-gate);
}
.t-review {
  --c: var(--stage-review);
}
.t-driver {
  --c: var(--model-haiku);
}
.t-other {
  --c: var(--text-4);
}
.r-0 {
  --c: var(--text-4);
}
.r-1 {
  --c: var(--prio-high);
}
.r-2 {
  --c: var(--ok);
}
.r-3 {
  --c: var(--sub);
}
.r-4 {
  --c: var(--bad);
}
.r-5 {
  --c: var(--warn);
}
.ucn-yard {
  margin-top: 12px;
  padding-left: 12px;
  border-left: 3px solid var(--warn);
  color: var(--text-2);
}
.uc-cap a {
  color: var(--link);
}
</style>
