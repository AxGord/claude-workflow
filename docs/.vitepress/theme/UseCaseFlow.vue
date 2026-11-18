<script setup lang="ts">
// The use-case page's scene "difficulty picks the path": the reader sets what the queue line says (its difficulty)
// and what the code turns out to be (the score its first reader gives it, and whether its premise holds), and the
// flowchart lights the way that line takes through anyparse's slice pipeline, with the model and effort of every
// agent on it. Nothing here decides the path or holds a threshold: `slicePath` (src/use-case-path.ts) answers it
// over the facts of the project's workflow files, and the numbers beside it are the ledger's, both read from the
// snapshot (docs/use-case-anyparse.json, scripts/export-use-case.mjs). This file draws.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import snapshot from "../../use-case-anyparse.json";
import {
  PATH_SCENARIOS,
  slicePath,
  stageRow,
  type PathNode,
  type PathScenario,
  type StageRow,
} from "../../../src/use-case-path";
import { DASH_TOKENS } from "./dash-tokens";

const facts = snapshot.workflow;
const stats = snapshot.stats;

const DIFFICULTIES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const EFFORT_BARS: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };
const MODELS = ["haiku", "sonnet", "opus", "fable"];

const first = PATH_SCENARIOS.find(s => s.id === "harder") ?? PATH_SCENARIOS[0];
const line = ref(first.line);
const seen = ref(first.seen);
const premise = ref(first.premise);
/** Counts the reader's changes: the diagram is keyed by it, so every change replays the walk from the top. */
const run = ref(0);

const path = computed(() => slicePath(facts, { line: line.value, seen: seen.value, premise: premise.value }));
const scenario = computed(
  () => PATH_SCENARIOS.find(s => s.line === line.value && s.seen === seen.value && s.premise === premise.value)?.id ?? "",
);

// The walk plays when the page is drawn, which is before the reader has scrolled to it: it plays once more when the
// figure first comes into view.
const box = ref<HTMLElement | null>(null);
let seenOnce: IntersectionObserver | null = null;
onMounted(() => {
  if (!box.value || typeof IntersectionObserver === "undefined") return;
  seenOnce = new IntersectionObserver(
    entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      run.value++;
      seenOnce?.disconnect();
    },
    { threshold: 0.3 },
  );
  seenOnce.observe(box.value);
});
onBeforeUnmount(() => seenOnce?.disconnect());

function choose(s: PathScenario): void {
  line.value = s.line;
  seen.value = s.seen;
  premise.value = s.premise;
  run.value++;
}
function setLine(d: number): void {
  line.value = d;
  run.value++;
}
function setSeen(d: number): void {
  seen.value = d;
  run.value++;
}
function togglePremise(): void {
  premise.value = !premise.value;
  run.value++;
}

const bars = (effort: string): string => {
  const n = EFFORT_BARS[effort.toLowerCase()] ?? 0;
  return n === 0 ? "" : "▮".repeat(n) + "▯".repeat(4 - n);
};
const modelClass = (model: string | undefined): string => {
  const m = (model ?? "").toLowerCase();
  return `m-${MODELS.find(name => m.includes(name)) ?? "script"}`;
};
const chip = (row: StageRow | undefined): string => (row ? `${row.model} ${bars(row.effort)}` : "");

// ---- the flowchart: one column of stations, a rail on the left for the way round the recon, the two ways out on the right

const W = 360;
const H = 532;
/** The main column's centre, and a station's box. */
const CX = 112;
const NW = 172;
const NH = 42;
const NX = CX - NW / 2;
/** The rail a line without a recon takes round it. */
const RAIL = 10;
/** The vertical both readers' ways out share. */
const BUS = 210;
/** The ways out: closed and split. */
const TX = 222;
const TW = 130;
const Y = { line: 22, claim: 78, prepare: 136, gate: 194, recon: 254, verdict: 314, plan: 380, execute: 442, tail: 506 };
/** A decision's half width and half height. */
const DW = 66;
const DH = 21;
/** The walk's speed along the lit way, px of the drawing per second. */
const SPEED = 250;

type Point = readonly [number, number];
const d = (points: readonly Point[]): string => points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y}`).join(" ");
const top = (y: number): number => y - NH / 2;
const bottom = (y: number): number => y + NH / 2;

/** Every connection of the chart, drawn dim; the lit ones are drawn again over them. */
const EDGES: Record<string, readonly Point[]> = {
  claim: [[CX, Y.line + 14], [CX, top(Y.claim)]],
  prepare: [[CX, bottom(Y.claim)], [CX, top(Y.prepare)]],
  gate: [[CX, bottom(Y.prepare)], [CX, Y.gate - DH]],
  recon: [[CX, Y.gate + DH], [CX, top(Y.recon)]],
  around: [[CX - DW, Y.gate], [RAIL, Y.gate], [RAIL, Y.plan - 33], [CX, Y.plan - 33], [CX, top(Y.plan)]],
  verdict: [[CX, bottom(Y.recon)], [CX, Y.verdict - DH]],
  plan: [[CX, Y.verdict + DH], [CX, top(Y.plan)]],
  reconClosed: [[CX + DW, Y.verdict], [TX, Y.verdict]],
  reconSplit: [[CX + DW, Y.verdict], [BUS, Y.verdict], [BUS, Y.plan], [TX, Y.plan]],
  planSplit: [[NX + NW, Y.plan], [TX, Y.plan]],
  planClosed: [[NX + NW, Y.plan], [BUS, Y.plan], [BUS, Y.verdict], [TX, Y.verdict]],
  execute: [[CX, bottom(Y.plan)], [CX, top(Y.execute)]],
  tail: [[CX, bottom(Y.execute)], [CX, Y.tail - 18]],
};
/** The connections drawn as the dim base: the shared vertical once, not once per way out. */
const BASE = ["claim", "prepare", "gate", "recon", "around", "verdict", "plan", "reconClosed", "planSplit", "execute", "tail"];

interface Lit {
  /** The lit connections, in the order the line walks them. */
  readonly edges: readonly string[];
  /** The stations and ways out the line reaches, with the second each is reached at. */
  readonly at: Readonly<Partial<Record<PathNode | "tail", number>>>;
  /** The whole lit way as one path, for the walking dot, and how long the walk takes. */
  readonly way: string;
  readonly seconds: number;
}

const lit = computed<Lit>(() => {
  const p = path.value;
  const edges = ["claim", "prepare", "gate"];
  const stops: [PathNode | "tail", Point][] = [
    ["claim", [CX, Y.claim]],
    ["prepare", [CX, Y.prepare]],
    ["route", [CX, Y.gate]],
  ];
  const points: Point[] = [[CX, Y.line], [CX, Y.gate]];
  const out = (node: "closed" | "split", via: readonly Point[]): void => {
    points.push(...via, [TX + 14, node === "closed" ? Y.verdict : Y.plan]);
    stops.push([node, [TX + 14, node === "closed" ? Y.verdict : Y.plan]]);
  };
  if (p.recon) {
    edges.push("recon", "verdict");
    points.push([CX, Y.verdict]);
    stops.push(["recon", [CX, Y.recon]], ["verdict", [CX, Y.verdict]]);
  } else {
    edges.push("around");
    points.push([RAIL, Y.gate], [RAIL, Y.plan - 33], [CX, Y.plan - 33]);
  }
  if (p.stoppedBy === "recon") {
    edges.push(p.outcome === "closed" ? "reconClosed" : "reconSplit");
    out(p.outcome === "closed" ? "closed" : "split", p.outcome === "closed" ? [] : [[BUS, Y.verdict], [BUS, Y.plan]]);
  } else {
    if (p.recon) edges.push("plan");
    points.push([CX, Y.plan]);
    stops.push(["plan", [CX, Y.plan]]);
    if (p.stoppedBy === "plan") {
      edges.push(p.outcome === "closed" ? "planClosed" : "planSplit");
      out(p.outcome === "closed" ? "closed" : "split", p.outcome === "closed" ? [[BUS, Y.plan], [BUS, Y.verdict]] : []);
    } else {
      edges.push("execute", "tail");
      points.push([CX, Y.tail]);
      stops.push(["execute", [CX, Y.execute]], ["tail", [CX, Y.tail]]);
    }
  }
  // the second each stop is reached at: the length of the way up to the point nearest to it, at the walk's speed
  let length = 0;
  const reached: Partial<Record<PathNode | "tail", number>> = {};
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    for (const [node, [x, y]] of stops) {
      const on = ax === bx ? x === ax && y > Math.min(ay, by) && y <= Math.max(ay, by) : y === ay && x > Math.min(ax, bx) && x <= Math.max(ax, bx);
      if (on && reached[node] === undefined) reached[node] = +((length + Math.abs(x - ax) + Math.abs(y - ay)) / SPEED).toFixed(2);
    }
    length += Math.abs(bx - ax) + Math.abs(by - ay);
  }
  return { edges, at: reached, way: d(points), seconds: +(length / SPEED).toFixed(2) };
});

/** A station's look: `run` lit, `skip` passed without running, `off` not on this line's way. */
function look(node: PathNode | "tail"): string {
  const p = path.value;
  if (node === "recon") return p.recon ? "run" : "skip";
  if (node === "plan") return p.plan === "run" ? "run" : lit.value.at.plan !== undefined ? "skip" : "off";
  return lit.value.at[node] === undefined ? "off" : "run";
}
const delay = (node: PathNode | "tail"): string => `${lit.value.at[node] ?? 0}s`;

const rows = computed(() => {
  const p = path.value;
  return {
    recon: stageRow(facts.table, "recon", line.value),
    plan: stageRow(facts.table, "plan", p.recon ? p.difficulty : line.value),
    execute: stageRow(facts.table, p.execute === "executor" ? "execute" : "plan", p.difficulty),
  };
});

/** The note where the difficulty changes on the way: under the recon's verdict, or under the plan that hands off. */
const rescore = computed(() => {
  const p = path.value;
  if (p.outcome !== "review" || p.rescored === "kept") return null;
  return { y: p.scoredBy === "recon" ? Y.plan - 33 : Y.execute - 31, at: p.scoredBy === "recon" ? delay("verdict") : delay("plan") };
});

// ---- the model table: a stage per row, a difficulty per column, a run of equal cells drawn as one bar

const table = computed(() =>
  Object.entries(facts.table).map(([stage, tableRows]) => ({
    stage,
    runs: tableRows.map((r, i) => ({ from: (tableRows[i - 1]?.upto ?? 0) + 1, to: r.upto, model: r.model, effort: r.effort })),
  })),
);
const medians = computed(() => DIFFICULTIES.map(n => stats.difficulty.find(x => x.difficulty === n)?.median ?? null));
const money = (usd: number | null): string => (usd === null ? "·" : usd < 10 ? usd.toFixed(1) : String(Math.round(usd)));

// ---- what the ledger says about the way this line takes

const scored = stats.recon.kept + stats.recon.up + stats.recon.down;
const note = computed(() => {
  const p = path.value;
  const r = stats.recon;
  if (p.stoppedBy === "recon")
    return (
      (p.outcome === "split"
        ? `The recon split ${r.split} lines this way.`
        : `The recon closed ${r.closed} lines on a refuted premise.`) +
      ` A run it stopped cost a median $${r.stopped.median?.toFixed(2)}; a landed line, $${stats.cost.median?.toFixed(2)}.`
    );
  if (p.stoppedBy === "plan")
    return p.outcome === "split"
      ? `${stats.plan.splits} lines were split by a worker, after the recon or without one.`
      : `${stats.runs.closed} runs closed without landing: a refuted premise, a blocked worker or a rejected review.`;
  if (!p.recon)
    return p.execute === "executor"
      ? `${stats.plan.handoffs} plans were handed to an executor.`
      : `${stats.runs.total - r.ran} of ${stats.runs.total} runs took no recon.`;
  const share = (n: number): string => `${n} of ${scored} recon scores`;
  return p.rescored === "up"
    ? `${share(r.up)} were higher than the line's.`
    : p.rescored === "down"
      ? `${share(r.down)} were lower than the line's.`
      : `${share(r.kept)} agreed with the line.`;
});

const STEP_NAMES: Record<PathNode, string> = {
  claim: "claim",
  prepare: "worktree",
  route: "route",
  recon: "recon",
  verdict: "score",
  plan: "plan",
  execute: "execute",
  closed: "closed",
  split: "split",
  next: "next",
};
const day = (iso: string): string => iso.slice(0, 10);
</script>

<template>
  <figure class="ucf-box uc-box" :class="DASH_TOKENS" aria-label="The path a queue line takes through anyparse's slice pipeline, by its difficulty">
    <div class="ucf">
    <div class="ucf-pick">
      <div class="ucf-scenarios uc-chips" role="group" aria-label="Scenario">
        <button
          v-for="s in PATH_SCENARIOS"
          :key="s.id"
          type="button"
          class="uc-chip"
          :class="{ on: s.id === scenario }"
          :aria-pressed="s.id === scenario"
          :data-scenario="s.id"
          @click="choose(s)"
        >
          {{ s.label }}
        </button>
      </div>
      <div class="ucf-dial">
        <span id="ucf-line" class="ucf-dial-name">The line says</span>
        <div class="ucf-steps" role="group" aria-labelledby="ucf-line">
          <button
            v-for="n in DIFFICULTIES"
            :key="n"
            type="button"
            class="ucf-step"
            :class="{ on: n === line }"
            :style="{ '--c': `var(--diff-${n})` }"
            :aria-pressed="n === line"
            :aria-label="`Line difficulty ${n}`"
            :data-line="n"
            @click="setLine(n)"
          >
            {{ n }}
          </button>
        </div>
      </div>
      <div class="ucf-dial">
        <span id="ucf-seen" class="ucf-dial-name">The code says</span>
        <div class="ucf-steps" role="group" aria-labelledby="ucf-seen">
          <button
            v-for="n in DIFFICULTIES"
            :key="n"
            type="button"
            class="ucf-step"
            :class="{ on: n === seen }"
            :style="{ '--c': `var(--diff-${n})` }"
            :aria-pressed="n === seen"
            :aria-label="`Score found in the code ${n}`"
            :data-seen="n"
            @click="setSeen(n)"
          >
            {{ n }}
          </button>
        </div>
      </div>
      <div class="ucf-dial">
        <span class="ucf-dial-name">Its premise</span>
        <button type="button" class="uc-chip ucf-premise" :class="{ bad: !premise }" :aria-pressed="!premise" data-premise @click="togglePremise">
          {{ premise ? "holds" : "fails" }}
        </button>
        <span class="ucf-by">scored by the {{ path.scoredBy === "recon" ? "recon" : "plan stage" }}</span>
      </div>
    </div>

    <div ref="box" class="ucf-flow">
      <svg :key="run" :viewBox="`0 0 ${W} ${H}`" role="img" :aria-label="`The way of a line of difficulty ${line} whose code scores ${seen}: ${path.outcome === 'review' ? 'it reaches the review' : path.outcome}`" :style="{ '--walk': `${lit.seconds}s` }">
        <g class="e-base">
          <path v-for="name in BASE" :key="name" :d="d(EDGES[name])" />
          <path :d="d([[BUS, Y.verdict], [BUS, Y.plan]])" />
        </g>
        <g class="e-lit">
          <path v-for="name in lit.edges" :key="name" :d="d(EDGES[name])" :data-edge="name" />
        </g>

        <g class="n n-line" :style="{ '--c': `var(--diff-${line})` }">
          <rect :x="NX" :y="Y.line - 14" :width="NW" height="28" rx="14" />
          <text :x="CX" :y="Y.line + 4" text-anchor="middle" class="t-line">queue line · difficulty {{ line }}</text>
        </g>

        <g class="n s-driver" :class="`is-${look('claim')}`" :style="{ '--at': delay('claim') }" data-node="claim">
          <rect :x="NX" :y="top(Y.claim)" :width="NW" :height="NH" rx="10" />
          <text :x="NX + 12" :y="Y.claim - 3" class="t-name">claim</text>
          <text :x="NX + NW - 10" :y="Y.claim - 3" text-anchor="end" class="t-chip" :class="modelClass(facts.driver.model)">{{ chip(facts.driver) }}</text>
          <text :x="NX + 12" :y="Y.claim + 13" class="t-sub">a driver takes the line</text>
        </g>

        <g class="n s-script" :class="`is-${look('prepare')}`" :style="{ '--at': delay('prepare') }" data-node="prepare">
          <rect :x="NX" :y="top(Y.prepare)" :width="NW" :height="NH" rx="3" />
          <text :x="NX + 12" :y="Y.prepare - 3" class="t-name">worktree</text>
          <text :x="NX + NW - 10" :y="Y.prepare - 3" text-anchor="end" class="t-chip m-script">script</text>
          <text :x="NX + 12" :y="Y.prepare + 13" class="t-sub">a branch off main · no tokens</text>
        </g>

        <g class="n s-gate" :class="`is-${look('route')}`" :style="{ '--at': delay('route') }" data-node="route">
          <path :d="`M${CX - DW} ${Y.gate} L${CX} ${Y.gate - DH} L${CX + DW} ${Y.gate} L${CX} ${Y.gate + DH} Z`" />
          <text :x="CX" :y="Y.gate + 4" text-anchor="middle" class="t-ask">difficulty ≥ {{ facts.recon_from }} ?</text>
          <text :x="CX - DW - 16" :y="Y.gate - 6" text-anchor="middle" class="t-way" :class="{ on: !path.recon }">no</text>
          <text :x="CX + 9" :y="Y.gate + DH + 13" class="t-way" :class="{ on: path.recon }">yes</text>
        </g>

        <g class="n s-recon" :class="`is-${look('recon')}`" :style="{ '--at': delay('recon') }" data-node="recon">
          <rect :x="NX" :y="top(Y.recon)" :width="NW" :height="NH" rx="10" />
          <text :x="NX + 12" :y="Y.recon - 3" class="t-name">recon</text>
          <text :x="NX + NW - 10" :y="Y.recon - 3" text-anchor="end" class="t-chip" :class="modelClass(rows.recon?.model)">{{ chip(rows.recon) }}</text>
          <text :x="NX + 12" :y="Y.recon + 13" class="t-sub">{{ path.recon ? "read-only · scores the work" : "not run for this line" }}</text>
        </g>

        <g class="n s-gate" :class="`is-${look('verdict')}`" :style="{ '--at': delay('verdict') }" data-node="verdict">
          <path :d="`M${CX - DW} ${Y.verdict} L${CX} ${Y.verdict - DH} L${CX + DW} ${Y.verdict} L${CX} ${Y.verdict + DH} Z`" />
          <text :x="CX" :y="Y.verdict + 4" text-anchor="middle" class="t-ask">its verdict</text>
        </g>

        <g class="n s-closed" :class="`is-${look('closed')}`" :style="{ '--at': delay('closed') }" data-node="closed">
          <rect :x="TX" :y="Y.verdict - 20" :width="TW" height="40" rx="20" />
          <text :x="TX + 16" :y="Y.verdict - 2" class="t-name">closed</text>
          <text :x="TX + 16" :y="Y.verdict + 12" class="t-sub">a premise fails</text>
        </g>

        <g class="n s-split" :class="`is-${look('split')}`" :style="{ '--at': delay('split') }" data-node="split">
          <rect :x="TX" :y="Y.plan - 20" :width="TW" height="40" rx="20" />
          <text :x="TX + 16" :y="Y.plan - 2" class="t-name">split</text>
          <text :x="TX + 16" :y="Y.plan + 12" class="t-sub">score ≥ {{ facts.split_from }} · new lines</text>
        </g>

        <g class="n s-plan" :class="`is-${look('plan')}`" :style="{ '--at': delay('plan') }" data-node="plan">
          <rect :x="NX" :y="top(Y.plan)" :width="NW" :height="NH" rx="10" />
          <text :x="NX + 12" :y="Y.plan - 3" class="t-name">plan</text>
          <text v-if="path.plan !== 'skipped'" :x="NX + NW - 10" :y="Y.plan - 3" text-anchor="end" class="t-chip" :class="modelClass(rows.plan?.model)">{{ chip(rows.plan) }}</text>
          <text :x="NX + 12" :y="Y.plan + 13" class="t-sub">{{ path.plan === "skipped" ? "skipped · the recon is the plan" : "finds the owner · scores it" }}</text>
        </g>

        <g class="n s-work" :class="`is-${look('execute')}`" :style="{ '--at': delay('execute') }" data-node="execute">
          <rect :x="NX" :y="top(Y.execute)" :width="NW" :height="NH" rx="10" />
          <text :x="NX + 12" :y="Y.execute - 3" class="t-name">execute</text>
          <text :x="NX + NW - 10" :y="Y.execute - 3" text-anchor="end" class="t-chip" :class="modelClass(rows.execute?.model)">{{ chip(rows.execute) }}</text>
          <text :x="NX + 12" :y="Y.execute + 13" class="t-sub">{{ path.execute === "executor" ? "a new agent runs the plan" : "the plan's agent carries on" }}</text>
        </g>

        <g class="n n-tail" :class="`is-${look('tail')}`" :style="{ '--at': delay('tail') }" data-node="tail">
          <g v-for="(name, i) in ['gate', 'review', 'land']" :key="name" :class="`s-${name}`">
            <rect :x="NX + i * 60" :y="Y.tail - 18" width="52" height="36" :rx="name === 'review' ? 10 : 3" />
            <text :x="NX + i * 60 + 26" :y="Y.tail + 4" text-anchor="middle" class="t-sub">{{ name }}</text>
          </g>
        </g>

        <g v-if="rescore" class="n n-rescore is-run" :style="{ '--c': `var(--diff-${path.difficulty})`, '--at': rescore.at }" data-node="rescore">
          <rect :x="CX + 8" :y="rescore.y - 9" width="62" height="18" rx="9" />
          <text :x="CX + 39" :y="rescore.y + 4" text-anchor="middle" class="t-chip">{{ line }} → {{ path.difficulty }}</text>
        </g>

        <circle class="walker" r="5" :style="{ offsetPath: `path('${lit.way}')`, '--c': `var(--diff-${line})` }" />
      </svg>
    </div>

    <div class="ucf-table" aria-label="The model table: the model and effort of every stage, by difficulty">
      <div class="ucf-grid" :style="{ gridTemplateRows: `repeat(${table.length * 2 + 4}, auto)` }">
        <span class="ucf-band" :style="{ '--from': path.difficulty }" data-band="runs"></span>
        <span class="ucf-th" :style="{ '--u': 0 }">difficulty</span>
        <span
          v-for="n in DIFFICULTIES"
          :key="n"
          class="ucf-cell ucf-col"
          :class="{ on: n === path.difficulty, was: n === line && line !== path.difficulty }"
          :style="{ '--u': 0, '--from': n, '--to': n }"
          >{{ n }}</span
        >
        <template v-for="(row, i) in table" :key="row.stage">
          <span class="ucf-th" :style="{ '--u': i + 1 }">{{ row.stage }}</span>
          <span
            v-for="r in row.runs"
            :key="r.from"
            class="ucf-cell ucf-run"
            :class="modelClass(r.model)"
            :style="{ '--u': i + 1, '--from': r.from, '--to': r.to }"
            :title="`${row.stage}, difficulty ${r.from} to ${r.to}: ${r.model}, ${r.effort}`"
            :data-stage="row.stage"
          >
            {{ r.model }} <span class="uc-bars">{{ bars(r.effort) }}</span>
          </span>
        </template>
        <span class="ucf-th ucf-money" :style="{ '--u': table.length + 1 }">$ per land</span>
        <span
          v-for="(usd, i) in medians"
          :key="i"
          class="ucf-cell ucf-usd ucf-money"
          :class="{ on: i + 1 === path.difficulty && path.outcome === 'review' }"
          :style="{ '--u': table.length + 1, '--from': i + 1, '--to': i + 1 }"
          >{{ money(usd) }}</span
        >
      </div>
      <p class="ucf-legend">
        <span class="uc-bars">▮▮▯▯</span> effort medium, <span class="uc-bars">▮▮▮▯</span> high. The tinted column is the difficulty the stages run on{{ line !== path.difficulty ? ", the dashed number what the line said" : "" }}. The last row is the ledger's median cost of a landed line at that difficulty.
      </p>
    </div>

    <div class="ucf-story">
      <ol :key="run" class="ucf-list">
        <li v-for="(s, i) in path.steps" :key="i" class="ucf-li" :class="`a-${s.actor}`" :style="{ '--i': i }" :data-step="s.node">
          <span class="ucf-li-name">{{ STEP_NAMES[s.node] }}</span>
          <span v-if="s.model" class="ucf-li-chip" :class="modelClass(s.model)">{{ s.model }} <span class="uc-bars">{{ bars(s.effort ?? "") }}</span> {{ s.effort }}</span>
          <span v-else class="ucf-li-chip m-script">{{ s.actor === "parent" ? "parent" : "script" }}</span>
          <span class="ucf-li-text">{{ s.text }}</span>
        </li>
      </ol>
      <p class="uc-note" data-note><span class="uc-lead">From the ledger</span> {{ note }}</p>
    </div>

    </div>
    <figcaption class="uc-cap">
      The thresholds are read from anyparse's workflow files; the model table is {{ snapshot.table_of === "window" ? "the one in force while these runs were made" : "its pipeline's own" }}; the counts are its ledger from {{ day(stats.from) }} to {{ day(stats.to) }}: {{ stats.runs.total }} runs of the pipeline, {{ stats.runs.landed }} landed.
    </figcaption>
  </figure>
</template>

<style scoped>
.ucf {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "pick" "flow" "table" "story";
  gap: 20px;
}
.ucf-pick {
  grid-area: pick;
}
.ucf-flow {
  grid-area: flow;
}
.ucf-table {
  grid-area: table;
}
.ucf-story {
  grid-area: story;
}
@container (min-width: 760px) {
  .ucf {
    grid-template-columns: 360px minmax(0, 1fr);
    grid-template-areas: "flow pick" "flow table" "flow story";
    grid-template-rows: auto auto 1fr;
    column-gap: 32px;
  }
  .ucf-flow {
    position: sticky;
    top: 88px;
    align-self: start;
  }
}

/* ---- the choices */
.ucf-scenarios {
  margin-bottom: 14px;
}
.ucf-dial {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  margin-top: 8px;
}
.ucf-dial-name {
  flex: 0 0 96px;
  color: var(--text-3);
  font: 12px/1.5 var(--mono);
}
.ucf-steps {
  flex: 1 1 240px;
  display: grid;
  grid-template-columns: repeat(10, minmax(0, 1fr));
  gap: 3px;
}
.ucf-step {
  height: 28px;
  padding: 0;
  border: 1px solid var(--panel-border);
  border-radius: 7px;
  background: transparent;
  color: var(--text-3);
  font: 600 12px/1 var(--mono);
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s,
    background-color 0.15s;
}
.ucf-step:hover {
  border-color: var(--c);
  color: var(--text);
}
.ucf-step.on {
  border-color: var(--c);
  background: color-mix(in srgb, var(--c) 22%, transparent);
  color: var(--text);
  box-shadow: 0 0 10px -3px var(--c);
}
.ucf-premise {
  min-width: 64px;
  border-color: var(--ok);
  color: var(--ok-text);
}
.ucf-premise.bad {
  border-color: var(--bad);
  color: var(--bad-text);
  background: var(--bad-bg);
}
.ucf-by {
  color: var(--text-4);
  font: 12px/1.5 var(--mono);
}
/* ---- the flowchart */
.ucf-flow svg {
  display: block;
  width: 100%;
  max-width: 400px;
  height: auto;
  margin: 0 auto;
  overflow: visible;
}
.ucf-flow text {
  font-family: var(--vp-font-family-base);
  user-select: none;
}
.e-base path {
  fill: none;
  stroke: var(--panel-border);
  stroke-width: 1.5;
}
.e-lit path {
  fill: none;
  stroke: var(--text-3);
  stroke-width: 2;
  stroke-linejoin: round;
}
.n rect,
.n > path {
  fill: var(--panel);
  stroke: var(--c);
  stroke-width: 2;
}
.t-name {
  fill: var(--text);
  font-size: 13px;
  font-weight: 600;
}
.t-line {
  fill: var(--text);
  font-size: 12px;
  font-weight: 600;
}
.t-sub {
  fill: var(--text-3);
  font-size: 10.5px;
}
.t-ask {
  fill: var(--text);
  font-size: 11.5px;
  font-weight: 600;
}
.t-way {
  fill: var(--text-4);
  font-size: 10.5px;
}
.t-way.on {
  fill: var(--text);
  font-weight: 600;
}
.ucf-flow .t-chip {
  fill: var(--m, var(--text-2));
  font-family: var(--mono);
  font-size: 10.5px;
}
.s-driver {
  --c: var(--model-haiku);
}
.s-script {
  --c: var(--model-script);
}
.s-gate {
  --c: var(--warn);
}
.s-recon {
  --c: var(--stage-recon);
}
.s-plan {
  --c: var(--stage-plan);
}
.s-work {
  --c: var(--stage-work);
}
.s-review {
  --c: var(--stage-review);
}
.s-land {
  --c: var(--stage-land);
}
.s-closed {
  --c: var(--bad);
}
.s-split {
  --c: var(--sub);
}
.n-tail .s-gate {
  --c: var(--stage-gate);
}
.n-line rect {
  fill: color-mix(in srgb, var(--c) 16%, var(--panel));
}
.n-rescore rect {
  fill: color-mix(in srgb, var(--c) 22%, var(--panel));
  stroke-width: 1.5;
}
.n-rescore .t-chip {
  fill: var(--text);
  font-weight: 600;
}
.n.is-run rect,
.n.is-run > path {
  fill: color-mix(in srgb, var(--c) 11%, var(--panel));
  filter: drop-shadow(0 0 5px color-mix(in srgb, var(--c) 45%, transparent));
}
.n.is-skip rect {
  stroke-dasharray: 5 4;
}
.n.is-skip {
  opacity: 0.6;
}
.n.is-off {
  opacity: 0.38;
}
.n.is-off rect,
.n.is-off > path {
  stroke: var(--text-4);
}
.walker {
  display: none;
  fill: var(--c);
  stroke: var(--panel);
  stroke-width: 2;
}

/* ---- the model table: every row is a unit of two grid rows, its label beside its cells in a wide frame and over
   them in a narrow one */
.ucf-grid {
  --o: 1;
  display: grid;
  grid-template-columns: 96px repeat(10, minmax(0, 1fr));
  align-items: center;
  column-gap: 2px;
  font: 11px/1.4 var(--mono);
}
.ucf-th {
  grid-column: 1;
  grid-row: calc(var(--u) * 2 + 1) / span 2;
  padding-right: 8px;
  color: var(--text-3);
  white-space: nowrap;
}
.ucf-cell {
  position: relative;
  grid-column: calc(var(--from) + var(--o)) / calc(var(--to) + var(--o) + 1);
  grid-row: calc(var(--u) * 2 + 1) / span 2;
  margin: 1.5px 0;
}
.ucf-col {
  padding: 2px 0;
  border: 1px solid transparent;
  border-radius: 6px;
  text-align: center;
  color: var(--text-4);
}
.ucf-col.on {
  color: var(--text);
  font-weight: 700;
}
.ucf-col.was {
  border: 1px dashed var(--text-4);
  color: var(--text-2);
}
.ucf-run {
  overflow: hidden;
  padding: 2px 8px;
  border-left: 3px solid var(--m);
  border-radius: 4px;
  background: color-mix(in srgb, var(--m) 14%, transparent);
  color: var(--text-2);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ucf-money {
  margin-top: 6px;
}
.ucf-usd {
  text-align: center;
  color: var(--text-3);
}
.ucf-usd.on {
  color: var(--text);
  font-weight: 700;
}
/* the difficulty the stages run on: a tint down the whole table, with no edge to cut a bar's label */
.ucf-band {
  grid-column: calc(var(--from) + var(--o));
  grid-row: 1 / -1;
  align-self: stretch;
  border-radius: 7px;
  background: color-mix(in srgb, var(--text) 10%, transparent);
  pointer-events: none;
}
.ucf-box .ucf-legend {
  margin-top: 10px;
  color: var(--text-4);
  font-size: 12px;
}
@container (max-width: 480px) {
  .ucf-grid {
    --o: 0;
    grid-template-columns: repeat(10, minmax(0, 1fr));
  }
  .ucf-th {
    grid-column: 1 / -1;
    grid-row: calc(var(--u) * 2 + 1);
    margin-top: 7px;
  }
  .ucf-cell {
    grid-row: calc(var(--u) * 2 + 2);
  }
  .ucf-money {
    margin-top: 0;
  }
  .ucf-th.ucf-money {
    margin-top: 9px;
  }
}

/* ---- the walk in words */
.ucf-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.ucf-li {
  position: relative;
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  column-gap: 10px;
  margin: 0;
  padding: 7px 0 7px 14px;
  border-left: 2px solid var(--panel-border);
}
.ucf-li + .ucf-li {
  margin-top: 0;
}
.ucf-li::before {
  content: "";
  position: absolute;
  left: -6px;
  top: 12px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid var(--text-4);
  background: var(--panel);
}
.ucf-li.a-script::before {
  border-radius: 2px;
}
.ucf-li.a-agent::before,
.ucf-li.a-driver::before {
  border-color: var(--model-sonnet);
}
.ucf-li.a-parent::before {
  border-color: var(--warn);
  transform: rotate(45deg);
  border-radius: 2px;
}
.ucf-li-name {
  grid-row: 1 / span 2;
  color: var(--text);
  font: 600 12px/1.6 var(--mono);
}
.ucf-li-chip {
  color: var(--m, var(--text-3));
  font: 11px/1.6 var(--mono);
}
.ucf-li-text {
  color: var(--text-2);
}
/* ---- motion: the line walks its way, each station lights as it is reached */
@media (prefers-reduced-motion: no-preference) {
  .e-lit path {
    animation: ucf-fade 0.4s ease-out both;
  }
  .n.is-run,
  .n.is-skip {
    animation: ucf-arrive 0.35s ease-out both;
    animation-delay: var(--at, 0s);
  }
  .n.is-skip {
    animation-name: ucf-pass;
  }
  .ucf-li {
    animation: ucf-fade 0.3s ease-out both;
    animation-delay: calc(var(--i) * 70ms);
  }
  @supports (offset-path: path("M0 0 L1 1")) {
    .walker {
      display: block;
      offset-rotate: 0deg;
      animation: ucf-walk var(--walk, 2s) linear both;
    }
  }
}
@keyframes ucf-arrive {
  from {
    opacity: 0.3;
  }
  to {
    opacity: 1;
  }
}
@keyframes ucf-pass {
  from {
    opacity: 0.3;
  }
  to {
    opacity: 0.6;
  }
}
@keyframes ucf-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes ucf-walk {
  from {
    offset-distance: 0%;
    opacity: 1;
  }
  92% {
    opacity: 1;
  }
  to {
    offset-distance: 100%;
    opacity: 0;
  }
}
</style>
