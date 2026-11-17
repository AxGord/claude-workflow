<script setup lang="ts">
// The landing's hero: the GitHub banner (docs/banner.png) as live HTML and SVG, merged with the nav. The name and the
// logo are the NAV's own title (config.mts `siteTitle`), enlarged by CSS while the page is at its top and
// shrinking into the bar's left as the page scrolls, so nothing is drawn twice and the bar never jumps. The words (tagline, buttons) come from
// the hero of docs/index.md; the chips are the banner's, the workflow count derived from templates/ at build time
// (`__BUNDLED_WORKFLOWS__`, config.mts). The diagram is the banner's schematic of a task's life
// (scripts/render-banner.mjs `schematicSvg`), drawn here from the same words at two widths so it stays legible on a phone.
// ONE layout over the whole scroll range, shared by the hero and the bar (the numbers are the CSS variables of
// `.Layout.has-hero`): the left column is the text (and, in the bar, the title), the right column is the diagram, and the search
// sits on the bar over the diagram's left edge while the page is at its top, then shrinks and slides to the right
// cluster (docs, theme, GitHub) as the title condenses. The title scales down first, below the bar, and only then rises into it,
// so the big title never reaches the row of the search. The hero's content (text, buttons, chips, diagram) does not fade: it scrolls
// under the opaque bar as plain content. All of the merge is for the desktop layout, from 960px (where the hero is two columns); below
// it the hero stacks and the bar stays VitePress's own, so a phone's first screen has no enlarged title and nothing that dissolves.
// Scroll linkage: CSS scroll-driven animation where the browser has it and motion is allowed; otherwise a sentinel's
// IntersectionObserver toggles `hero-condensed` on the root, with a transition, or none under reduced motion.
import { VPButton } from "vitepress/theme";
import { useData } from "vitepress";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

declare const __BUNDLED_WORKFLOWS__: number;

interface Action {
  theme?: "brand" | "alt";
  text: string;
  link: string;
}
interface Chip {
  text: string;
  tone: Tone;
}
type Tone = "blue" | "green" | "purple" | "amber";

const { frontmatter } = useData();
const hero = computed(
  () =>
    (frontmatter.value.hero ?? {}) as {
      name?: string;
      text?: string;
      tagline?: string;
      actions?: Action[];
    },
);

/** The banner's chips (scripts/render-banner.mjs `bannerSpec`). */
const chips: Chip[] = [
  { text: "FSM engine", tone: "blue" },
  { text: `${__BUNDLED_WORKFLOWS__} workflows`, tone: "green" },
  { text: "Thread pool", tone: "purple" },
  { text: "Task queue", tone: "amber" },
  { text: "Live map", tone: "blue" },
];

type State = "done" | "active" | "review" | "pending";
interface Geo {
  W: number;
  H: number;
  qw: number;
  g1: number;
  g: number;
  bh: number;
  cy: number;
  arc: number;
  poolY: number;
  poolH: number;
  font: number;
  small: number;
  s: number;
}
/** The two sizes of one drawing: the banner's own, and one that keeps the labels readable at a phone's width. */
const WIDE: Geo = { W: 640, H: 224, qw: 78, g1: 34, g: 48, bh: 58, cy: 92, arc: 44, poolY: 186, poolH: 30, font: 20, small: 13, s: 1 };
const COMPACT: Geo = { W: 340, H: 160, qw: 48, g1: 16, g: 20, bh: 44, cy: 64, arc: 34, poolY: 122, poolH: 24, font: 14, small: 11, s: 0.68 };
const NAMES: [string, State][] = [
  ["think", "done"],
  ["code", "active"],
  ["review", "review"],
  ["land", "pending"],
];
const POOL_SLOTS: Tone[] = ["blue", "purple", "green", "blue", "amber", "purple", "green", "blue"];
const WAITING: Tone[] = ["green", "blue", "amber"];

/** One diagram's geometry: every box, link, arc and slot, as numbers the template draws. */
function layout(o: Geo) {
  const by = o.cy - o.bh / 2;
  const nw = (o.W - o.qw - o.g1 - 3 * o.g) / 4;
  const poolX = o.qw + o.g1;
  const nodes = NAMES.map(([name, state], k) => ({ name, state, x: poolX + k * (nw + o.g), y: by, w: nw, h: o.bh }));
  const links = [
    { x0: o.qw + 4, x1: poolX - 4 },
    ...nodes.slice(0, -1).map(n => ({ x0: n.x + n.w + 4, x1: n.x + n.w + o.g - 4 })),
  ].map(l => ({ ...l, mid: (l.x0 + l.x1) / 2 - 1 }));
  const code = nodes[1];
  const review = nodes[2];
  const rc = review.x + nw / 2;
  const cc = code.x + nw / 2;
  const top = by - o.arc;
  const pad = 16 * o.s;
  const slotsW = o.W - poolX;
  const sp = 5 * o.s;
  const sw = (slotsW - 2 * sp - 7 * sp) / 8;
  return {
    o,
    queue: { w: o.qw, y: by - pad, h: o.bh + 2 * pad, bars: [0, 1, 2].map(k => ({ y: by + pad + k * 15 * o.s - 4 * o.s, x: 0.15 * o.qw, w: 0.7 * o.qw, h: 9 * o.s })) },
    nodes,
    links,
    fix: { d: `M${rc} ${by - 6} C${rc} ${top} ${cc} ${top} ${cc} ${by - 12}`, ax: cc, ay: by - 5, lx: (rc + cc) / 2, ly: top + 4 * o.s },
    pool: {
      x: poolX,
      y: o.poolY,
      w: slotsW,
      h: o.poolH,
      sp,
      slots: POOL_SLOTS.map((tone, k) => ({ tone, x: poolX + sp + k * (sw + sp), y: o.poolY + sp, w: sw, h: o.poolH - 2 * sp })),
      waitingY: o.poolY + o.poolH / 2,
      waitingR: 8.5 * o.s,
      waiting: WAITING.map((tone, k) => ({ tone, x: 11 * o.s + k * 25 * o.s })),
      arrowFrom: 3 * 25 * o.s + 11 * o.s - 4,
      labelY: o.poolY - 12 * o.s,
    },
  };
}
const diagrams = [
  { id: "wide", g: layout(WIDE) },
  { id: "compact", g: layout(COMPACT) },
];

const sentinel = ref<HTMLElement | null>(null);
let watch: IntersectionObserver | null = null;
const root = (): HTMLElement => document.documentElement;

onMounted(() => {
  if (!sentinel.value) return;
  // the bar is condensed once the sentinel (as tall as the brand's travel) is scrolled out of view
  watch = new IntersectionObserver(entries => {
    const e = entries[entries.length - 1];
    if (e) root().classList.toggle("hero-condensed", !e.isIntersecting);
  });
  watch.observe(sentinel.value);
});
onBeforeUnmount(() => {
  watch?.disconnect();
  root().classList.remove("hero-condensed");
});
</script>

<template>
  <section class="hero" aria-labelledby="hero-title">
    <span ref="sentinel" class="hero-sentinel" aria-hidden="true"></span>
    <div class="hero-inner">
      <div class="hero-text">
        <h1 id="hero-title" class="hero-sr">{{ hero.name }}: {{ hero.text }}</h1>
        <p class="hero-tagline">{{ hero.tagline }}</p>
        <div class="hero-actions">
          <VPButton v-for="a in hero.actions" :key="a.link" tag="a" size="big" :theme="a.theme" :text="a.text" :href="a.link" />
        </div>
        <ul class="hero-chips">
          <li v-for="c in chips" :key="c.text"><i :class="`t-${c.tone}`"></i>{{ c.text }}</li>
        </ul>
      </div>
      <div class="hero-diagram">
        <svg
          v-for="d in diagrams"
          :key="d.id"
          :class="['dg', `dg-${d.id}`]"
          :viewBox="`0 0 ${d.g.o.W} ${d.g.o.H}`"
          role="img"
          aria-label="A task's life: queue, think, code, review, land, a gate between each, a fix loop from review back to code, and the thread pool its builds and tests share"
        >
          <g :stroke-width="2 * d.g.o.s" fill="none">
            <rect x="0" :y="d.g.queue.y" :width="d.g.queue.w" :height="d.g.queue.h" :rx="10 * d.g.o.s" class="dg-box dg-line" />
            <text :x="d.g.queue.w / 2" :y="d.g.queue.y + 21 * d.g.o.s" class="dg-label dg-muted" :font-size="d.g.o.small" text-anchor="middle">queue</text>
            <rect v-for="(b, k) in d.g.queue.bars" :key="k" :x="b.x" :y="b.y + 10 * d.g.o.s" :width="b.w" :height="b.h" :rx="b.h / 2" :class="['fl', ['t-blue', 't-purple', 't-dim'][k]]" :fill-opacity="k === 2 ? 0.55 : 0.9" stroke="none" />
            <template v-for="(l, k) in d.g.links" :key="k">
              <path :d="`M${l.x0} ${d.g.o.cy} H${l.x1 - 4 * d.g.o.s}`" class="dg-link" />
              <path :d="`M${l.x1 - 7 * d.g.o.s} ${d.g.o.cy - 5 * d.g.o.s} L${l.x1 + 1} ${d.g.o.cy} L${l.x1 - 7 * d.g.o.s} ${d.g.o.cy + 5 * d.g.o.s} Z`" class="fl t-dim" stroke="none" />
              <rect
                v-if="k > 0"
                :x="l.mid - 7 * d.g.o.s"
                :y="d.g.o.cy - 7 * d.g.o.s"
                :width="14 * d.g.o.s"
                :height="14 * d.g.o.s"
                :rx="2.5 * d.g.o.s"
                :transform="`rotate(45 ${l.mid} ${d.g.o.cy})`"
                class="dg-gate"
              />
            </template>
            <g v-for="n in d.g.nodes" :key="n.name" :class="`dg-node dg-${n.state}`">
              <rect v-if="n.state === 'active' || n.state === 'review'" :x="n.x - 4 * d.g.o.s" :y="n.y - 4 * d.g.o.s" :width="n.w + 8 * d.g.o.s" :height="n.h + 8 * d.g.o.s" :rx="15 * d.g.o.s" class="dg-halo st" :stroke-width="6 * d.g.o.s" />
              <rect :x="n.x" :y="n.y" :width="n.w" :height="n.h" :rx="11 * d.g.o.s" class="dg-box st" />
              <text :x="n.x + n.w / 2" :y="d.g.o.cy + 7 * d.g.o.s" class="dg-label dg-name" :font-size="d.g.o.font" text-anchor="middle">{{ n.name }}</text>
              <template v-if="n.state === 'done'">
                <circle :cx="n.x + n.w - 4" :cy="n.y + 2" :r="10 * d.g.o.s" class="fl t-green" stroke="none" />
                <path :d="`M${n.x + n.w - 4 - 4.5 * d.g.o.s} ${n.y + 2} l${3 * d.g.o.s} ${3.2 * d.g.o.s} l${6 * d.g.o.s} ${-6.4 * d.g.o.s}`" class="dg-tick" :stroke-width="2.6 * d.g.o.s" />
              </template>
              <template v-else-if="n.state !== 'pending'">
                <circle :cx="n.x + n.w - 4" :cy="n.y + 2" :r="10 * d.g.o.s" class="fl dg-dot" :stroke-width="3 * d.g.o.s" />
                <circle :cx="n.x + n.w - 4" :cy="n.y + 2" :r="3.4 * d.g.o.s" class="dg-dot-in" stroke="none" />
              </template>
            </g>
            <path :d="d.g.fix.d" class="dg-fix" :stroke-width="2.2 * d.g.o.s" :stroke-dasharray="`${5 * d.g.o.s} ${5 * d.g.o.s}`" />
            <path :d="`M${d.g.fix.ax - 4.5 * d.g.o.s} ${d.g.fix.ay - 6 * d.g.o.s} L${d.g.fix.ax} ${d.g.fix.ay} L${d.g.fix.ax + 4.5 * d.g.o.s} ${d.g.fix.ay - 6 * d.g.o.s} Z`" class="fl t-amber" stroke="none" />
            <text :x="d.g.fix.lx" :y="d.g.fix.ly - 2 * d.g.o.s" class="dg-label t-amber fl" :font-size="d.g.o.small + 1" text-anchor="middle" stroke="none">fix</text>
            <text :x="d.g.pool.x" :y="d.g.pool.labelY" class="dg-label dg-muted" :font-size="d.g.o.small + 1" stroke="none">thread pool</text>
            <text :x="d.g.o.W" :y="d.g.pool.labelY" class="dg-label dg-dim dg-note" :font-size="d.g.o.small" text-anchor="end" stroke="none">builds &amp; tests, one machine</text>
            <text x="0" :y="d.g.pool.labelY" class="dg-label dg-muted" :font-size="d.g.o.small + 1" stroke="none">waiting</text>
            <rect :x="d.g.pool.x" :y="d.g.pool.y" :width="d.g.pool.w" :height="d.g.pool.h" :rx="8 * d.g.o.s" class="dg-box dg-line" />
            <rect v-for="(s, k) in d.g.pool.slots" :key="k" :x="s.x" :y="s.y" :width="s.w" :height="s.h" :rx="4 * d.g.o.s" :class="['fl', 'dg-slot', `t-${s.tone}`]" stroke="none" />
            <circle v-for="w in d.g.pool.waiting" :key="w.x" :cx="w.x" :cy="d.g.pool.waitingY" :r="d.g.pool.waitingR" :class="['st', `t-${w.tone}`]" />
            <path :d="`M${d.g.pool.arrowFrom} ${d.g.pool.waitingY} H${d.g.pool.x - 12 * d.g.o.s}`" class="dg-link" />
            <path :d="`M${d.g.pool.x - 12 * d.g.o.s - 3} ${d.g.pool.waitingY - 5 * d.g.o.s} L${d.g.pool.x - 5 * d.g.o.s} ${d.g.pool.waitingY} L${d.g.pool.x - 12 * d.g.o.s - 3} ${d.g.pool.waitingY + 5 * d.g.o.s} Z`" class="fl t-dim" stroke="none" />
          </g>
        </svg>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hero {
  --d-bg: #ffffff;
  --d-fg: #1f2328;
  --d-muted: #59636e;
  --d-dim: #8c959f;
  --d-line: #d0d7de;
  --d-blue: #0969da;
  --d-green: #1a7f37;
  --d-amber: #9a6700;
  --d-purple: #8250df;
  --hero-glow-a: rgba(26, 127, 55, 0.07);
  --hero-glow-b: rgba(9, 105, 218, 0.08);
  position: relative;
  --hero-brand-h: calc(var(--vp-nav-logo-height) * var(--hero-brand-s));
  padding: 32px 24px 40px;
  background:
    radial-gradient(ellipse at 72% 60%, var(--hero-glow-a), transparent 55%),
    radial-gradient(ellipse at 92% 8%, var(--hero-glow-b), transparent 50%);
}
.dark .hero {
  --d-bg: #0d1117;
  --d-fg: #e6edf3;
  --d-muted: #8b949e;
  --d-dim: #6e7681;
  --d-line: #30363d;
  --d-blue: #58a6ff;
  --d-green: #3fb950;
  --d-amber: #d29922;
  --d-purple: #bc8cff;
  --hero-glow-a: rgba(63, 185, 80, 0.1);
  --hero-glow-b: rgba(88, 166, 255, 0.11);
}
.hero-sentinel {
  position: absolute;
  top: 0;
  left: 0;
  width: 1px;
  height: var(--hero-brand-y);
  pointer-events: none;
}
.hero-inner {
  display: flex;
  flex-direction: column;
  gap: 32px;
  margin: 0 auto;
  max-width: var(--hero-content-w);
}
.hero-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.hero-tagline {
  margin: 0;
  max-width: 460px;
  font-size: 18px;
  line-height: 1.4;
  color: var(--vp-c-text-2);
}
.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 24px;
}
.hero-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin: 20px 0 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  line-height: 1;
  color: var(--d-dim);
}
.hero-chips li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
}
.hero-chips i {
  display: block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--t);
}
.hero-diagram {
  min-width: 0;
}
.dg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}
.dg-compact {
  max-width: 420px;
}
.dg-wide {
  display: none;
}
.t-blue {
  --t: var(--d-blue);
}
.t-green {
  --t: var(--d-green);
}
.t-purple {
  --t: var(--d-purple);
}
.t-amber {
  --t: var(--d-amber);
}
.t-dim {
  --t: var(--d-dim);
}
.fl {
  fill: var(--t);
}
.st {
  stroke: var(--t);
}
.dg-box {
  fill: color-mix(in srgb, var(--d-bg) 88%, transparent);
}
.dg-line {
  stroke: var(--d-line);
}
.dg-label {
  font-family: var(--vp-font-family-base);
}
.dg-name {
  font-weight: 600;
  fill: var(--d-fg);
}
.dg-muted {
  font-weight: 600;
  letter-spacing: 0.04em;
  fill: var(--d-muted);
}
.dg-dim {
  fill: var(--d-dim);
}
.dg-fix {
  stroke: var(--d-amber);
}
.dg-link {
  stroke: var(--d-dim);
}
.dg-gate {
  fill: var(--d-bg);
  stroke: var(--d-amber);
}
.dg-tick {
  stroke: var(--d-bg);
  stroke-linecap: round;
  stroke-linejoin: round;
}
.dg-done .dg-box {
  stroke: var(--d-green);
}
.dg-active {
  --t: var(--d-blue);
}
.dg-review {
  --t: var(--d-purple);
}
.dg-active .dg-box,
.dg-review .dg-box {
  stroke: var(--t);
}
.dg-halo {
  fill: none;
  stroke-opacity: 0.18;
}
.dg-dot {
  fill: var(--t);
  stroke: var(--d-bg);
}
.dg-dot-in {
  fill: var(--d-bg);
}
.dg-pending .dg-box {
  stroke: var(--d-line);
}
.dg-pending .dg-name {
  fill: var(--d-muted);
}
.dg-slot {
  fill-opacity: 0.8;
}
@media (prefers-reduced-motion: no-preference) {
  .dg-dot {
    animation: dg-pulse 2.4s ease-in-out infinite;
    transform-box: fill-box;
    transform-origin: center;
  }
  .dg-halo {
    animation: dg-halo 2.4s ease-in-out infinite;
  }
}
@keyframes dg-pulse {
  50% {
    transform: scale(1.12);
  }
}
@keyframes dg-halo {
  50% {
    stroke-opacity: 0.32;
  }
}
@media (min-width: 640px) {
  .hero-tagline {
    font-size: 20px;
  }
}
/* VitePress's nav wrapper goes from 24 to 32px gutters at 768px: the hero's must change at the same width, or the
   brand's x would differ from the bar's by 8px between 640 and 767 */
@media (min-width: 768px) {
  .hero {
    padding-left: 32px;
    padding-right: 32px;
  }
}
@media (min-width: 960px) {
  .hero {
    /* the page's first screen starts where the enlarged brand's top edge sits; the text column leaves that room under it */
    padding-top: calc(var(--vp-nav-height) / 2 + var(--hero-brand-y) - var(--hero-brand-h) / 2);
    padding-bottom: 64px;
  }
  .hero-inner {
    display: grid;
    grid-template-columns: max(var(--hero-text-min), calc(100% - var(--hero-dg-max))) minmax(0, 1fr);
    align-items: center;
    gap: 0;
  }
  .hero-text {
    padding-top: calc(var(--hero-brand-h) + 28px);
    padding-right: 24px;
  }
  .dg-compact {
    display: none;
  }
  .dg-wide {
    display: block;
  }
}
</style>

<style>
/* On the landing (the page's `pageClass: has-hero`) from 960px, the nav and the hero are one band: the nav is fixed over the
   hero and transparent at the top, its title (logo and name) is the hero's brand at several times its size, and the scroll
   shrinks it into the bar's left while the bar's own background comes in. The bar's geometry is the hero's (same width, same
   gutters), so the brand's only travel is vertical and the sizes are CSS numbers: nothing is measured. Below 960px the hero
   stacks and the bar is VitePress's own, opaque and fixed at the top, hiding on a scroll down and showing on a scroll up (`Layout.vue`; no enlarged title). The hero's content never fades: it scrolls under the
   opaque bar as plain content, with no soft edge.
   The grid both share from 960px: a left column of `--hero-text-min` at least (the text; in the bar, the title) and a
   right column of `--hero-dg-max` at most (the diagram; in the bar, the search's left edge while the page is at its top). */
.Layout.has-hero {
  --hero-brand-y: 96px;
  --hero-brand-s: 3;
  --hero-text-min: 520px;
  --hero-dg-max: 594px;
  /* the landing's content width, the bar's and the hero's alike: VitePress's home container (1152px, the feature grid's own cap) inside the layout's
     width, so on a wide screen the logo, the hero's text and diagram and the feature cards share their left and right edges */
  --hero-content-w: min(1152px, calc(var(--vp-layout-max-width) - 64px));
  --hero-search-w0: 300px;
  --hero-search-w1: 150px;
  /* scroll distances of the phases: the title scales down below the bar first, then rises into it; the search condenses
     with the scale; the bar's surface is solid before the title reaches it and its divider comes in last */
  --hero-scale-end: calc(var(--hero-brand-y) * 0.55);
  --hero-rise-start: calc(var(--hero-brand-y) * 0.45);
  --hero-bar-end: calc(var(--hero-brand-y) * 0.5);
  --hero-line-start: calc(var(--hero-brand-y) * 0.85);
}
/* VitePress's feature grid (the cards under the install block) takes the hero's content width and gutters (24px, 32px from 768px, the
   same as `.hero`'s) instead of its own 24/48/64px steps and 1152px cap, so its cards' edges are the hero's at every width; the
   selectors are the page class plus VitePress's own, which outweigh its scoped rules. */
.Layout.has-hero .VPFeatures {
  padding: 0 24px;
}
@media (min-width: 768px) {
  .Layout.has-hero .VPFeatures {
    padding: 0 32px;
  }
}
.Layout.has-hero .VPFeatures .container {
  max-width: var(--hero-content-w);
}
/* the default text hero stays in the markup (its data feeds this one) and is not shown */
.Layout.has-hero .VPHomeHero {
  display: none;
}

.VPNavBarTitle .title {
  font-weight: 700;
}
.VPNavBarTitle .title .brand-a {
  background: linear-gradient(90deg, #0969da, #1a7f37);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.dark .VPNavBarTitle .title .brand-a {
  background: linear-gradient(90deg, #58a6ff, #3fb950);
  -webkit-background-clip: text;
  background-clip: text;
}

/* Below 960px the bar is VitePress's own opaque one, but pinned (it auto-hides on a scroll down, Layout.vue): fixed at the top at every width, the content under it
   (`.VPContent` gets the bar's height as top padding, which VitePress itself gives only from 960px, so the first screen
   starts below it). From 960px the hero pads under the bar itself. */
.Layout.has-hero .VPNav {
  position: fixed;
}
.Layout.has-hero .VPContent {
  padding-top: var(--vp-nav-height);
}
/* The landing is `layout: home`, so VitePress classes its bar `home` and paints a background only for the other pages (and
   from 960px once scrolled): below 960px the pinned bar would be see-through. It gets the theme's opaque bar colour and
   divider; from 960px the transparent overrides in the desktop block win (they are `!important`). */
.Layout.has-hero .VPNavBar {
  background-color: var(--vp-nav-bg-color);
}
.Layout.has-hero .VPNavBar .divider-line {
  background-color: var(--vp-c-gutter);
}
@media (min-width: 960px) {
  .Layout.has-hero .VPContent {
    padding-top: 0;
  }

  /* the bar's own background, replaced by one that comes in with the scroll (!important: VitePress switches its own
     on at the first pixel, in selectors that outrank a theme override); the surface is opaque, and so is complete
     before the brand reaches the bar, with the divider last */
  .Layout.has-hero .VPNavBar:not(.screen-open),
  .Layout.has-hero .VPNavBar .content-body,
  .Layout.has-hero .VPNavBar .divider,
  .Layout.has-hero .VPNavBar .divider-line {
    background-color: transparent !important;
  }
  .Layout.has-hero .VPNavBar::before,
  .Layout.has-hero .VPNavBar::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s;
  }
  .Layout.has-hero .VPNavBar::before {
    background: var(--vp-nav-bg-color);
  }
  .Layout.has-hero .VPNavBar::after {
    border-bottom: 1px solid var(--vp-c-divider);
  }
  .hero-condensed .Layout.has-hero .VPNavBar::before,
  .hero-condensed .Layout.has-hero .VPNavBar::after {
    opacity: 1;
  }

  .Layout.has-hero .VPNavBar .container {
    max-width: var(--hero-content-w);
  }
  .Layout.has-hero .VPNavBarTitle .title {
    transform-origin: 0 50%;
    translate: 0 var(--hero-brand-y);
    scale: var(--hero-brand-s);
    transition:
      scale 0.25s ease,
      translate 0.3s ease,
      opacity 0.25s;
  }
  .hero-condensed .Layout.has-hero .VPNavBarTitle .title {
    translate: none;
    scale: none;
  }
  /* the enlarged title's box covers the hero's first lines: only its logo and name take the pointer, so the text under
     the box stays selectable (a click on either still follows the link) */
  .Layout.has-hero .VPNavBarTitle .title {
    pointer-events: none;
  }
  .Layout.has-hero .VPNavBarTitle .title > * {
    pointer-events: auto;
  }

  /* The search: on the bar's row, `--hero-search-w0` wide with its left edge on the diagram's, then `--hero-search-w1` wide
     and next to the right cluster (docs, theme, GitHub). The bar's content row is [free space] [search] [free space]
     [cluster]: the two pseudo-elements are the free spaces and share it by flex-grow, 0 and 1 at the top, 1 and 0 once
     condensed, so the search never overlaps a neighbour at any point of the way. */
  .Layout.has-hero .VPNavBar .content-body {
    column-gap: 0;
  }
  .Layout.has-hero .VPNavBar .content-body::before,
  .Layout.has-hero .VPNavBar .content-body::after {
    content: "";
    flex: 0 0 0;
  }
  .Layout.has-hero .VPNavBar .content-body::before {
    order: 0;
    flex-grow: 0;
    transition: flex-grow 0.3s ease;
  }
  .Layout.has-hero .VPNavBar .content-body::after {
    order: 2;
    flex-grow: 1;
    transition: flex-grow 0.3s ease;
  }
  .Layout.has-hero .VPNavBar .content-body > * {
    order: 3;
  }
  .Layout.has-hero .VPNavBar .content-body > .VPNavBarSearch {
    order: 1;
    /* it gives way to the cluster where the row is short (960px: the left column leaves 376px for it, Docs and the menu),
       never below its condensed width */
    flex: 0 1 auto;
    min-width: var(--hero-search-w1);
    padding-left: 0;
    width: var(--hero-search-w0);
    transition: width 0.3s ease;
  }
  .Layout.has-hero .VPNavBar .VPNavBarSearch #local-search {
    flex: 1 1 auto;
    min-width: 0;
  }
  .hero-condensed .Layout.has-hero .VPNavBar .content-body > .VPNavBarSearch {
    width: var(--hero-search-w1);
  }
  .hero-condensed .Layout.has-hero .VPNavBar .content-body::before {
    flex-grow: 1;
  }
  .hero-condensed .Layout.has-hero .VPNavBar .content-body::after {
    flex-grow: 0;
  }
  /* the left column of the bar is the hero's: the content row, and so the search, starts on the diagram's left edge */
  .Layout.has-hero .VPNavBar .container > .title {
    flex: 0 0 max(var(--hero-text-min), calc(100% - var(--hero-dg-max)));
  }
  /* the content row may be narrower than what it holds (its automatic minimum would be the search at its full width) */
  .Layout.has-hero .VPNavBar .container > .content {
    min-width: 0;
  }
}

@keyframes hero-brand-scale {
  from {
    scale: var(--hero-brand-s);
  }
  to {
    scale: 1;
  }
}
@keyframes hero-brand-rise {
  from {
    translate: 0 var(--hero-brand-y);
  }
  to {
    translate: 0 0;
  }
}
@keyframes hero-bar-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes hero-search-in {
  from {
    width: var(--hero-search-w0);
  }
  to {
    width: var(--hero-search-w1);
  }
}
@keyframes hero-space-open {
  from {
    flex-grow: 0;
  }
  to {
    flex-grow: 1;
  }
}
@keyframes hero-space-close {
  from {
    flex-grow: 1;
  }
  to {
    flex-grow: 0;
  }
}
@supports (animation-timeline: scroll()) {
  @media (prefers-reduced-motion: no-preference) and (min-width: 960px) {
    .Layout.has-hero .VPNavBarTitle .title {
      animation:
        hero-brand-scale linear both,
        hero-brand-rise linear both;
      animation-timeline: scroll(root block), scroll(root block);
      animation-range:
        0px var(--hero-scale-end),
        var(--hero-rise-start) var(--hero-brand-y);
      transition: opacity 0.25s;
    }
    .Layout.has-hero .VPNavBar::before {
      animation: hero-bar-in linear both;
      animation-timeline: scroll(root block);
      animation-range: 0px var(--hero-bar-end);
      transition: none;
    }
    .Layout.has-hero .VPNavBar::after {
      animation: hero-bar-in linear both;
      animation-timeline: scroll(root block);
      animation-range: var(--hero-line-start) var(--hero-brand-y);
      transition: none;
    }
    .Layout.has-hero .VPNavBar .content-body > .VPNavBarSearch {
      animation: hero-search-in linear both;
      animation-timeline: scroll(root block);
      animation-range: 0px var(--hero-scale-end);
      transition: none;
    }
    .Layout.has-hero .VPNavBar .content-body::before {
      animation: hero-space-open linear both;
      animation-timeline: scroll(root block);
      animation-range: 0px var(--hero-scale-end);
      transition: none;
    }
    .Layout.has-hero .VPNavBar .content-body::after {
      animation: hero-space-close linear both;
      animation-timeline: scroll(root block);
      animation-range: 0px var(--hero-scale-end);
      transition: none;
    }
  }
}
@media (prefers-reduced-motion: reduce) {
  .Layout.has-hero .VPNavBarTitle .title,
  .Layout.has-hero .VPNavBar::before,
  .Layout.has-hero .VPNavBar::after,
  .Layout.has-hero .VPNavBar .content-body > .VPNavBarSearch,
  .Layout.has-hero .VPNavBar .content-body::before,
  .Layout.has-hero .VPNavBar .content-body::after {
    transition: none;
  }
}
</style>
