<script setup lang="ts">
// The use-case page's scene "worker, gate, review rounds, land": the lane of one line from its code to main. The
// reader chooses how the review goes (MERGE at once, FIXES one to three times, or the FIXES that rejects) and whether
// the gate fails once; the lane grows a row per round, and the meter beside it is the ledger's cost of a landed line
// by its review rounds and by stage. The lane is `roundsLane` (src/use-case-scenes.ts) over the facts of the
// project's workflow files; the numbers are the snapshot's. This file draws.
import { computed, ref } from "vue";
import snapshot from "../../use-case-anyparse.json";
import { maxFixes, roundsLane, type LaneStep } from "../../../src/use-case-scenes";
import { DASH_TOKENS } from "./dash-tokens";

const facts = snapshot.workflow;
const stats = snapshot.stats;
/** The line the lane is drawn for: a difficulty whose worker is the plan stage's own agent. */
const DIFFICULTY = 5;
const EFFORT_BARS: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };
const MODELS = ["haiku", "sonnet", "opus", "fable"];

const CHOICES = Array.from({ length: maxFixes(facts) + 1 }, (_, n) => ({
  fixes: n,
  label: n === 0 ? "MERGE at once" : n > facts.fix_rounds ? "one FIXES too many" : n === 1 ? "FIXES once" : `FIXES ${n} times`,
}));

const fixes = ref(1);
const gateFail = ref(false);
const picked = ref("");
const run = ref(0);

const lane = computed(() => roundsLane(facts, { difficulty: DIFFICULTY, fixes: fixes.value, gateFail: gateFail.value }));
const steps = computed(() => lane.value.rows.flatMap((row, r) => row.map((step, i) => ({ step, key: `${r}-${i}` }))));
/** The step whose words are shown: the one the reader tapped, else the last of the lane. */
const shown = computed(() => steps.value.find(s => s.key === picked.value) ?? steps.value[steps.value.length - 1]);

function choose(n: number): void {
  fixes.value = n;
  picked.value = "";
  run.value++;
}
function toggleGate(): void {
  gateFail.value = !gateFail.value;
  picked.value = "";
  run.value++;
}

const bars = (effort: string | undefined): string => {
  const n = EFFORT_BARS[(effort ?? "").toLowerCase()] ?? 0;
  return n === 0 ? "" : "▮".repeat(n) + "▯".repeat(4 - n);
};
const modelClass = (model: string | undefined): string => `m-${MODELS.find(name => (model ?? "").toLowerCase().includes(name)) ?? "script"}`;
const stageClass = (step: LaneStep): string =>
  step.id === "review" ? "s-review" : step.id === "gate" ? "s-gate" : step.id === "land" ? "s-land" : step.id === "reject" ? "s-reject" : step.id === "commit" ? "s-script" : "s-work";

const rounds = stats.rounds;
const top = Math.max(...rounds.map(r => r.median ?? 0), 1);
const usd = (n: number | null): string => (n === null ? "—" : `$${n.toFixed(2)}`);
const stages = stats.stages.rows.filter(r => r.usd > 0);
const share = (n: number): number => (n / stats.stages.usd) * 100;
const perLand = (n: number): string => `$${(n / stats.stages.lands).toFixed(2)}`;
</script>

<template>
  <figure class="ucr uc-box" :class="DASH_TOKENS" aria-label="The lane of a line from its code to main: gate, review rounds, land, and what a round costs">
    <div class="ucr-pick">
      <span class="ucr-label">The review says</span>
      <div class="uc-chips" role="group" aria-label="How the review goes">
        <button v-for="c in CHOICES" :key="c.fixes" type="button" class="uc-chip" :class="{ on: c.fixes === fixes }" :aria-pressed="c.fixes === fixes" :data-fixes="c.fixes" @click="choose(c.fixes)">
          {{ c.label }}
        </button>
      </div>
      <span class="ucr-label">The gate</span>
      <button type="button" class="uc-chip ucr-gate" :class="{ bad: gateFail }" :aria-pressed="gateFail" data-gate @click="toggleGate">
        {{ gateFail ? "fails once" : "green at once" }}
      </button>
    </div>

    <div class="ucr-cols">
      <div class="ucr-lane">
        <ol :key="run" class="ucr-rows" aria-label="The lane, a row per round">
          <li v-for="(row, r) in lane.rows" :key="r" class="ucr-row" :style="{ '--r': r }" :data-row="r">
            <template v-for="(step, i) in row" :key="i">
              <span v-if="i > 0" class="ucr-arrow" aria-hidden="true">→</span>
              <button
                type="button"
                class="ucr-step"
                :class="[stageClass(step), `a-${step.actor}`, { on: shown?.key === `${r}-${i}` }]"
                :aria-pressed="shown?.key === `${r}-${i}`"
                :data-step="step.id"
                @click="picked = `${r}-${i}`"
              >
                <span class="ucr-name">{{ step.name }}</span>
                <span v-if="step.verdict" class="ucr-verdict" :class="step.verdict === 'MERGE' ? 'ok' : 'fix'">{{ step.verdict }}</span>
                <span v-if="step.model" class="uc-model" :class="modelClass(step.model)">{{ step.model }} <span class="uc-bars">{{ bars(step.effort) }}</span></span>
                <span v-else class="uc-model m-script">{{ step.actor === "parent" ? "parent" : "script" }}</span>
              </button>
            </template>
          </li>
        </ol>
        <p v-if="shown" class="ucr-says" data-says><b>{{ shown.step.name }}</b> {{ shown.step.says }}</p>
      </div>

      <div class="ucr-meter">
        <p class="uc-lead">From the ledger · a landed line by its review rounds</p>
        <div v-for="r in rounds" :key="r.rounds" class="ucr-bar" :class="{ on: lane.outcome === 'landed' && r.rounds === lane.reviews }" :data-rounds="r.rounds">
          <span class="ucr-n">{{ r.rounds }} {{ r.rounds === 1 ? "review" : "reviews" }}</span>
          <span class="ucr-track"><span class="ucr-fill" :style="{ width: `${((r.median ?? 0) / top) * 100}%` }"></span></span>
          <span class="ucr-usd">{{ usd(r.median) }}</span>
          <span class="ucr-lands">{{ r.lands }} lines</span>
        </div>
        <p class="ucr-sum" data-sum>
          <template v-if="lane.outcome === 'landed'">This lane lands after {{ lane.reviews }} {{ lane.reviews === 1 ? "review" : "reviews" }}: the median such line cost {{ usd(rounds.find(r => r.rounds === lane.reviews)?.median ?? null) }}.</template>
          <template v-else>This lane does not land: after {{ facts.fix_rounds }} fix rounds one more FIXES rejects the line.</template>
        </p>

        <p class="uc-lead ucr-split-lead">Where a landed line's cost goes</p>
        <div class="ucr-split" role="img" :aria-label="`The cost of a landed line by stage: ${stages.map(s => `${s.stage} ${share(s.usd).toFixed(0)}%`).join(', ')}`">
          <span v-for="s in stages" :key="s.stage" class="ucr-part" :class="`t-${s.stage}`" :style="{ width: `${share(s.usd)}%` }" :title="`${s.stage}: ${perLand(s.usd)} per landed line`"></span>
        </div>
        <ul class="ucr-legend">
          <li v-for="s in stages" :key="s.stage" :class="`t-${s.stage}`" :data-stage="s.stage"><i></i>{{ s.stage }} <b>{{ share(s.usd).toFixed(0) }}%</b> <span>{{ perLand(s.usd) }}</span></li>
        </ul>
      </div>
    </div>
    <figcaption class="uc-cap">
      A line of difficulty {{ DIFFICULTY }}. The lane's bounds are read from anyparse's workflow files: {{ facts.fix_rounds }} fix rounds before a reject, {{ facts.gate_fix_rounds }} gate fixes before the worker is blocked. The stage split stands on {{ stats.stages.lands }} landed lines whose agents were recorded one by one; plan is the plan stage's agent, who also writes the code of a line it keeps.
    </figcaption>
  </figure>
</template>

<style scoped>
.ucr-pick {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  align-items: center;
  gap: 8px 10px;
}
.ucr-label {
  color: var(--text-3);
  font: 12px/1.5 var(--mono);
}
.ucr-gate {
  justify-self: start;
  border-color: var(--ok);
  color: var(--ok-text);
}
.ucr-gate.bad {
  border-color: var(--bad);
  background: var(--bad-bg);
  color: var(--bad-text);
}
.ucr-cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 20px;
  margin-top: 18px;
}
@container (min-width: 760px) {
  .ucr-cols {
    grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
    column-gap: 32px;
  }
}
@container (max-width: 480px) {
  .ucr-pick {
    grid-template-columns: minmax(0, 1fr);
  }
}
.ucr-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 4px;
  padding: 8px 0 8px 12px;
  border-left: 2px solid var(--panel-border);
}
.ucr-arrow {
  color: var(--text-4);
  font: 12px/1 var(--mono);
}
.ucr-step {
  --c: var(--stage-work);
  display: grid;
  justify-items: start;
  padding: 5px 10px;
  border: 2px solid var(--c);
  border-radius: 10px;
  background: color-mix(in srgb, var(--c) 9%, var(--panel));
  color: var(--text);
  font: 600 12.5px/1.4 var(--vp-font-family-base);
  text-align: left;
  cursor: pointer;
}
.ucr-step.a-script {
  border-radius: 3px;
}
.ucr-step:hover,
.ucr-step.on {
  box-shadow: 0 0 10px -2px var(--c);
}
.ucr-step.on {
  background: color-mix(in srgb, var(--c) 20%, var(--panel));
}
.s-script {
  --c: var(--model-script);
}
.s-gate {
  --c: var(--stage-gate);
}
.s-review {
  --c: var(--stage-review);
}
.s-land {
  --c: var(--stage-land);
}
.s-reject {
  --c: var(--bad);
}
.ucr-verdict {
  font: 700 10px/1.5 var(--mono);
  letter-spacing: 0.06em;
}
.ucr-verdict.ok {
  color: var(--ok-text);
}
.ucr-verdict.fix {
  color: var(--warn-text);
}
.ucr-says {
  margin-top: 12px;
  padding: 10px 12px;
  min-height: 84px;
  border-radius: 10px;
  background: var(--inset);
  color: var(--text-2);
}
.ucr-says b {
  margin-right: 6px;
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
}
.ucr-bar {
  display: grid;
  grid-template-columns: 70px minmax(0, 1fr) 52px 62px;
  align-items: center;
  column-gap: 8px;
  margin-top: 4px;
  padding: 3px 6px;
  border: 1px solid transparent;
  border-radius: 8px;
  font: 11px/1.5 var(--mono);
  color: var(--text-3);
}
.ucr-bar.on {
  border-color: var(--stage-review);
  background: color-mix(in srgb, var(--stage-review) 10%, transparent);
  color: var(--text);
}
.ucr-track {
  height: 10px;
  border-radius: 5px;
  background: var(--grid);
}
.ucr-fill {
  display: block;
  height: 100%;
  border-radius: 5px;
  background: var(--stage-review);
  opacity: 0.85;
}
.ucr-usd {
  color: var(--text);
  font-weight: 700;
  text-align: right;
}
.ucr-lands {
  text-align: right;
}
.ucr-sum {
  margin-top: 8px;
  color: var(--text-2);
}
.ucr-split-lead {
  margin-top: 18px;
}
.ucr-split {
  display: flex;
  height: 14px;
  margin-top: 6px;
  overflow: hidden;
  border-radius: 7px;
  background: var(--grid);
}
.ucr-part {
  background: var(--c);
}
.ucr-part + .ucr-part {
  border-left: 2px solid var(--panel);
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
.ucr-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-top: 8px;
  font: 11px/1.6 var(--mono);
  color: var(--text-3);
}
.ucr-legend i {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 5px;
  border-radius: 2px;
  background: var(--c);
}
.ucr-legend b {
  color: var(--text);
}
.ucr-legend span {
  color: var(--text-4);
}
@media (prefers-reduced-motion: no-preference) {
  .ucr-row {
    animation: ucr-in 0.3s ease-out both;
    animation-delay: calc(var(--r) * 140ms);
  }
}
@keyframes ucr-in {
  from {
    opacity: 0;
    transform: translateX(-6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
