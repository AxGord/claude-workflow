<script setup lang="ts">
// The use-case page's scene "a line enters the queue": one queue line as the queue file writes it, every field a
// button that says who reads it later, and under it the project's difficulty ruler over the ledger's lands by
// difficulty. The fields, the anchors and the example lines are `LINE_FIELDS`, `ANCHORS` and `EXAMPLE_LINES`
// (src/use-case-scenes.ts); the thresholds and the counts are the snapshot's. This file draws.
import { computed, ref } from "vue";
import snapshot from "../../use-case-anyparse.json";
import { ANCHORS, EXAMPLE_LINES, LINE_FIELDS, READER_NAMES, READERS } from "../../../src/use-case-scenes";
import { DASH_TOKENS } from "./dash-tokens";

const facts = snapshot.workflow;
const lands = snapshot.stats.difficulty;

const DIFFICULTIES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const difficulty = ref(5);
const field = ref("difficulty");

const anchor = computed(() => ANCHORS.find(a => difficulty.value >= a.from && difficulty.value <= a.to));
const example = computed(() => EXAMPLE_LINES[anchor.value?.example ?? 0]);
const chosen = computed(() => LINE_FIELDS.find(f => f.key === field.value) ?? LINE_FIELDS[0]);

const list = (items: readonly string[] | undefined): string => (items && items.length > 0 ? `[${items.join(", ")}]` : "");
/** A field's value on the example line; empty when the line does not carry it. */
function value(key: string): string {
  const e = example.value;
  if (key === "id") return e.id;
  if (key === "status") return "pending";
  if (key === "difficulty") return String(difficulty.value);
  if (key === "kind") return e.kind;
  if (key === "priority") return e.priority;
  if (key === "after") return list(e.after);
  if (key === "touches") return list(e.touches);
  if (key === "owner") return e.owner ?? "";
  if (key === "exclusive") return e.exclusive ? "true" : "";
  return e.text;
}

const most = Math.max(...lands.map(d => d.lands), 1);
const landed = (n: number): number => lands.find(d => d.difficulty === n)?.lands ?? 0;
const where = computed(() =>
  difficulty.value >= facts.split_from
    ? "cut into smaller lines by its first reader, never run as one"
    : difficulty.value >= facts.recon_from
      ? "read by a recon before any worker"
      : "taken straight to the plan stage",
);
</script>

<template>
  <figure class="ucl uc-box" :class="DASH_TOKENS" aria-label="A queue line, field by field, and the project's difficulty ruler">
    <div class="ucl-cols">
      <div class="ucl-card" role="group" aria-label="The line's fields">
        <button
          v-for="f in LINE_FIELDS"
          :key="f.key"
          type="button"
          class="ucl-field"
          :class="{ on: f.key === field, none: value(f.key) === '', text: f.key === 'text' }"
          :aria-pressed="f.key === field"
          :data-field="f.key"
          @click="field = f.key"
        >
          <span class="ucl-key">{{ f.key }}:</span>
          <span class="ucl-value" :style="f.key === 'difficulty' ? { '--c': `var(--diff-${difficulty})` } : undefined" :class="{ diff: f.key === 'difficulty' }">{{ value(f.key) || "—" }}</span>
        </button>
      </div>

      <div class="ucl-side">
        <div class="ucl-says" data-says>
          <p class="uc-lead">{{ chosen.key }} is read by</p>
          <ol class="ucl-readers" aria-label="Who reads the field">
            <li v-for="r in READERS" :key="r" class="ucl-reader" :class="{ on: chosen.readers.includes(r) }" :data-reader="r">{{ READER_NAMES[r] }}</li>
          </ol>
          <p class="ucl-text">{{ chosen.says }}</p>
        </div>

        <div class="ucl-ruler">
          <p class="uc-lead">The difficulty ruler</p>
          <div class="ucl-bars" role="group" aria-label="Difficulty">
            <button
              v-for="n in DIFFICULTIES"
              :key="n"
              type="button"
              class="ucl-bar"
              :class="{ on: n === difficulty }"
              :style="{ '--c': `var(--diff-${n})`, '--h': `${Math.round((landed(n) / most) * 100)}%` }"
              :aria-pressed="n === difficulty"
              :aria-label="`Difficulty ${n}: ${landed(n)} landed lines`"
              :title="`${landed(n)} landed lines ran at difficulty ${n}`"
              :data-anchor="n"
              @click="difficulty = n"
            >
              <span class="ucl-count">{{ landed(n) || "" }}</span>
              <span class="ucl-fill"></span>
              <span class="ucl-n">{{ n }}</span>
            </button>
          </div>
          <p class="ucl-anchor" data-anchor-says>
            <b :style="{ color: `var(--diff-${difficulty})` }">{{ difficulty }}</b>
            {{ anchor ? anchor.says : "below the project's first anchor" }}.
            <span class="ucl-where">A line scored {{ difficulty }} is {{ where }}.</span>
          </p>
        </div>
      </div>
    </div>
    <figcaption class="uc-cap">
      An example line in the queue's shape: the fields are the engine's, the names are made up. The bars are the ledger's landed lines by the difficulty their stages ran on.
    </figcaption>
  </figure>
</template>

<style scoped>
.ucl-cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 20px;
}
@container (min-width: 760px) {
  .ucl-cols {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    column-gap: 32px;
  }
}
.ucl-card {
  align-self: start;
  padding: 8px;
  border: 1px solid var(--panel-border);
  border-radius: 12px;
  background: var(--inset);
}
.ucl-field {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  width: 100%;
  padding: 4px 8px;
  border: 0;
  border-left: 3px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font: 12px/1.6 var(--mono);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s;
}
.ucl-field:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
}
.ucl-field.on {
  border-left-color: var(--model-sonnet);
  background: color-mix(in srgb, var(--model-sonnet) 12%, transparent);
}
.ucl-key {
  color: var(--warn-text);
}
.ucl-value {
  overflow-wrap: anywhere;
}
.ucl-field.none .ucl-value {
  color: var(--text-4);
}
.ucl-field.text .ucl-value {
  font-family: var(--vp-font-family-base);
  font-size: 12.5px;
}
.ucl-value.diff {
  justify-self: start;
  padding: 0 9px;
  border: 2px solid var(--c);
  border-radius: 10px;
  color: var(--text);
  font-weight: 700;
}
.ucl-readers {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 6px 0 10px;
}
.ucl-reader {
  padding: 2px 9px;
  border: 1px solid var(--panel-border);
  border-radius: 999px;
  color: var(--text-4);
  font: 11px/1.6 var(--mono);
  transition:
    color 0.2s,
    border-color 0.2s,
    background-color 0.2s;
}
.ucl-reader.on {
  border-color: var(--model-sonnet);
  background: color-mix(in srgb, var(--model-sonnet) 14%, transparent);
  color: var(--text);
}
.ucl-text {
  min-height: 78px;
  color: var(--text-2);
}
.ucl-ruler {
  margin-top: 18px;
}
.ucl-bars {
  display: grid;
  grid-template-columns: repeat(10, minmax(0, 1fr));
  gap: 3px;
  height: 104px;
  margin-top: 6px;
}
.ucl-bar {
  display: grid;
  grid-template-rows: 14px minmax(0, 1fr) 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--text-3);
  font: 600 11px/1 var(--mono);
  cursor: pointer;
}
.ucl-bar:hover {
  border-color: var(--panel-border);
}
.ucl-bar.on {
  border-color: var(--c);
  background: color-mix(in srgb, var(--c) 14%, transparent);
  color: var(--text);
}
.ucl-count {
  align-self: end;
  font-size: 9.5px;
  font-weight: 400;
  color: var(--text-4);
}
.ucl-fill {
  align-self: end;
  justify-self: center;
  width: 62%;
  height: var(--h);
  min-height: 2px;
  border-radius: 3px 3px 0 0;
  background: var(--c);
  opacity: 0.75;
  transition: height 0.3s ease-out;
}
.ucl-n {
  align-self: center;
}
.ucl-anchor {
  margin-top: 8px;
  min-height: 60px;
  color: var(--text-2);
}
.ucl-anchor b {
  margin-right: 4px;
  font-family: var(--mono);
}
.ucl-where {
  color: var(--text-3);
}
</style>
