<script setup lang="ts">
// The workflow graphs, live: the dashboard's own renderer (dashboard/graph.js: dagre layout, the state kinds, the
// edge routes) drawn from the engine's bundled workflow definitions (public/workflows.json, scripts/export-workflows.mjs),
// as SVG, so it stays sharp at any size. A click on a node or a row of the list opens that state's prompt and its
// transitions, as on the dashboard's Workflows tab; a sub-workflow node opens that workflow. No server.
import dagre from "@dagrejs/dagre";
import { withBase } from "vitepress";
import { computed, onMounted, ref } from "vue";
import { workflowClick, workflowViewHtml } from "../../../dashboard/graph.js";
import { DASH, useDashboardCss } from "./dashboard-css";

const props = withDefaults(defineProps<{ workflow?: string; picker?: boolean }>(), { workflow: "master", picker: true });

type Definitions = Record<string, { description?: string; states: Record<string, unknown> }>;

/** The workflows a reader meets first come first; the rest follow by name. */
const FIRST = ["master", "coding"];

const definitions = ref<Definitions | null>(null);
const current = ref(props.workflow);
const failed = ref(false);

const names = computed(() => {
  const all = Object.keys(definitions.value ?? {}).sort();
  return [...FIRST.filter(n => all.includes(n)), ...all.filter(n => !FIRST.includes(n))];
});
const html = computed(() => {
  const wf = definitions.value?.[current.value];
  return wf ? workflowViewHtml(dagre, current.value, wf, false) : "";
});
const description = computed(() => definitions.value?.[current.value]?.description ?? "");

function onClick(e: MouseEvent): void {
  if (definitions.value) workflowClick(e, definitions.value, name => (current.value = name));
}

onMounted(async () => {
  useDashboardCss();
  try {
    definitions.value = (await (await fetch(withBase("/workflows.json"))).json()) as Definitions;
  } catch {
    failed.value = true;
  }
});
</script>

<template>
  <section class="wfg" :class="DASH" aria-label="The bundled workflows, drawn as the dashboard draws them">
    <div v-if="picker && names.length" class="wfg-picker" role="group" aria-label="Workflow">
      <button
        v-for="n in names"
        :key="n"
        type="button"
        class="wfg-pick"
        :class="{ on: n === current }"
        :aria-pressed="n === current"
        @click="current = n"
      >
        {{ n }}
      </button>
    </div>
    <button v-if="current !== workflow" type="button" class="wfg-back" @click="current = workflow">← {{ workflow }}</button>
    <p v-if="description" class="wfg-desc">{{ description }}</p>
    <div v-if="html" class="wfg-view" @click="onClick" v-html="html"></div>
    <p v-else class="wfg-status">{{ failed ? "The workflows could not be loaded." : "Loading the workflows…" }}</p>
  </section>
</template>

<style scoped>
.wfg {
  margin: 24px 0;
  padding: 16px;
  border: 1px solid var(--panel-border);
  border-radius: var(--panel-radius);
  background: var(--panel);
  color: var(--text-2);
}
.wfg-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.wfg-pick {
  padding: 3px 10px;
  border: 1px solid var(--panel-border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-3);
  font: 12px var(--mono);
  cursor: pointer;
}
.wfg-pick:hover {
  color: var(--text);
  border-color: var(--text-4);
}
.wfg-pick.on {
  color: var(--text);
  border-color: var(--model-sonnet);
}
.wfg-back {
  margin-bottom: 8px;
  padding: 3px 10px;
  border: 1px solid var(--panel-border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-3);
  font: 12px var(--mono);
  cursor: pointer;
}
.wfg-back:hover {
  color: var(--text);
  border-color: var(--text-4);
}
.wfg-desc {
  margin: 0 0 4px;
  color: var(--text-3);
  font-size: 13px;
}
.wfg-view {
  overflow: visible;
}
/* the graph takes the width it has and the height its viewBox gives at that width: the PAGE scrolls through it, never a box of its own */
.wfg-view :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
}
/* the page's prose styles (.vp-doc h2: a rule, a margin, a size) must not reach the section label of the view */
.wfg :deep(h2.label) {
  margin: 0 0 10px;
  padding: 0;
  border: 0;
  font-size: 10px;
  line-height: normal;
  letter-spacing: 0.12em;
}
.wfg :deep(h2.label.gap) {
  margin-top: 18px;
}
.wfg-status {
  margin: 0;
  padding: 36px;
  text-align: center;
  color: var(--text-4);
}
</style>
