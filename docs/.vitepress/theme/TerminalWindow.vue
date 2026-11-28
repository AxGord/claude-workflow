<script setup lang="ts">
// The Claude Code window drawn over the map, translucent with a backdrop blur, dark in the site's dark theme and white in its light one: the parent conversation's lines on
// the left and the workflow plan pane docked on the right, both at the scene's clock (replay-store.ts). The pane
// IS the mod's: `snapshotAt` (src/replay.ts) turns the replay's events into the Snapshot the mod builds from the
// engine, and `paneTree` (hooks/pane-view.ts, the code the mod draws with) turns it into the pane; the
// conversation lines are the mod's own line builders over `conversationTail`. Folds, tabs and cards work as in the mod;
// the Pool tab reads the pool the replay recorded (`poolStateAt`, drawn by the mod's own `poolBody`).
import { computed, reactive } from "vue";
import {
  age,
  awaitRowToggled,
  endLine,
  foldFlipped,
  handBackLine,
  landDayToggled,
  movesLine,
  PANE_TITLE,
  paneTree,
  spawnLine,
  type PaneAction,
  type PaneEl,
} from "../../../hooks/pane-view";
import type { View } from "../../../types";
import { conversationTail, poolCountsAt, poolStateAt, snapshotAt, type ConversationLine } from "../../../src/replay";
import PaneView from "./PaneView.vue";
import { setTerminal, shared, toggleZoom } from "./replay-store";

/** The pane's body in cells and rows (the CSS sizes the dock to them). */
const COLUMNS = 80;
const ROWS = 30;
const LINES_SHOWN = 26;

const ui = reactive<{ tab: View; expanded: string; folded: string[] }>({ tab: "plan", expanded: "", folded: [] });

const t0 = computed(() => (shared.file ? Date.parse(shared.file.start) : 0));
const pane = computed(() => {
  if (!shared.file) return null;
  const now = t0.value + shared.at;
  return paneTree({
    snapshot: snapshotAt(shared.file, shared.at),
    tab: ui.tab,
    expanded: ui.expanded,
    folded: ui.folded,
    now,
    columns: COLUMNS,
    rows: ROWS,
    poolCounts: poolCountsAt(shared.file, shared.at),
    pool: poolStateAt(shared.file, shared.at),
  });
});

function lineOf(l: ConversationLine): PaneEl {
  switch (l.kind) {
    case "spawn":
      return spawnLine(l.label, l.role, l.model);
    case "move":
      return movesLine([{ label: l.label, name: l.name, to: l.to }], []);
    case "needs":
      return handBackLine(l.label, { kind: "needs", reason: `asks at ${l.reason}` });
    case "landed":
      return handBackLine(l.label, { kind: "landed", sha: "" });
    case "ended":
      return endLine(l.label, "driver", age(l.duration) || "<1m", { kind: l.failed ? "failed" : "ended", state: l.state });
  }
}

const lines = computed(() =>
  shared.file ? conversationTail(shared.file, shared.at, LINES_SHOWN).map(({ key, line }) => ({ key, node: lineOf(line) })) : [],
);

function act(a: PaneAction): void {
  if (a.kind === "fold") ui.folded = foldFlipped(ui.folded, a.key);
  else if (a.kind === "landDay") ui.folded = landDayToggled(ui.folded, a.key, a.today);
  else if (a.kind === "awaitRow") ui.folded = awaitRowToggled(ui.folded, a.key, a.answered);
  else if (a.kind === "tab") ui.tab = a.id;
  else if (a.kind === "expand") ui.expanded = ui.expanded === a.id ? "" : a.id;
}
</script>

<template>
  <section class="cc-window term-follows-site" :class="{ zoomed: shared.zoom }" aria-label="The Claude Code window: the conversation and the workflow plan pane">
    <div class="cc-title" @dblclick="toggleZoom">
      <span class="lights" @dblclick.stop>
        <button type="button" class="dot r" aria-label="Close: hide the window into the Terminal button" @click="setTerminal(false)"><span class="glyph" aria-hidden="true">×</span></button>
        <button type="button" class="dot y" aria-label="Minimise: hide the window into the Terminal button" @click="setTerminal(false)"><span class="glyph" aria-hidden="true">−</span></button>
        <button type="button" class="dot g" :aria-label="shared.zoom ? 'Leave full stage (Esc)' : 'Fill the stage'" @click="toggleZoom"><span class="glyph" aria-hidden="true">{{ shared.zoom ? "⤡" : "⤢" }}</span></button>
      </span>
      claude — anyparse
    </div>
    <div class="cc-body">
      <div class="cc-convo">
        <div class="cc-lines">
          <div v-for="l in lines" :key="l.key" class="cc-line"><span class="cc-bullet">⏺ </span><PaneView :node="l.node" /></div>
        </div>
        <div class="cc-prompt"><span class="cc-caret">&gt;</span></div>
      </div>
      <div class="cc-dock">
        <div class="cc-dock-title">{{ PANE_TITLE }}</div>
        <PaneView class="cc-pane" :node="pane" @act="act" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.cc-window {
  position: absolute;
  right: 40px;
  bottom: 136px;
  width: 1340px;
  height: 700px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--cc-border);
  border-radius: 14px;
  background: var(--cc-bg);
  backdrop-filter: blur(14px) saturate(1.2);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  box-shadow: var(--cc-shadow);
  color: var(--cc-text);
  font: 15px/20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow: hidden;
  transform-origin: 100% 100%;
  transition:
    right 0.25s ease,
    bottom 0.25s ease,
    width 0.25s ease,
    height 0.25s ease,
    border-radius 0.25s ease;
}
/* in this scoped block so it ties the base rule's specificity and, coming later, wins: no zoom animation under reduced motion */
@media (prefers-reduced-motion: reduce) {
  .cc-window {
    transition: none;
  }
}
/* zoomed: the window fills the whole stage (the stage is 1920x1080, drawn scaled) */
.cc-window.zoomed {
  right: 0;
  bottom: 0;
  width: 1920px;
  height: 1080px;
  border-radius: 0;
}
.cc-title {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--cc-rule);
  color: var(--cc-muted);
  font-size: 13px;
  user-select: none;
}
.lights {
  display: flex;
  gap: 8px;
  margin-right: 4px;
}
.dot {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
  font: inherit;
}
.dot:focus-visible {
  outline: 2px solid var(--cc-text);
  outline-offset: 2px;
}
/* the macOS affordance: the glyphs show while the pointer is over the group (or a button has the keyboard) */
.glyph {
  color: black;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  opacity: 0;
}
.lights:hover .glyph,
.lights:focus-within .glyph {
  opacity: 1;
}
.r {
  background: #ff5f56;
}
.y {
  background: #ffbd2e;
}
.g {
  background: #27c93f;
}
.cc-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.cc-convo {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 10px 14px;
}
.cc-lines {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  overflow: hidden;
}
.cc-line {
  display: flex;
  overflow: hidden;
}
.cc-bullet {
  color: var(--cc-dim);
  white-space: pre;
}
.cc-prompt {
  margin-top: 10px;
  padding: 6px 10px;
  border: 1px solid var(--cc-input);
  border-radius: 8px;
}
.cc-caret {
  color: var(--cc-muted);
}
.cc-dock {
  width: calc(80ch + 28px);
  flex: none;
  display: flex;
  flex-direction: column;
  padding: 10px 14px;
  border-left: 1px solid var(--cc-rule);
  overflow: hidden;
}
.cc-dock-title {
  margin-bottom: 6px;
  color: var(--cc-muted);
  font-weight: 700;
}
.cc-pane {
  overflow: hidden;
}
</style>

<style>
/* minimising into the Terminal button under the stage (and back out of it): the window shrinks toward its bottom-right
   corner as it fades; plain under reduced motion */
.cc-window.cc-minimise-enter-active,
.cc-window.cc-minimise-leave-active {
  transition:
    transform 0.25s ease,
    opacity 0.25s ease;
}
.cc-window.cc-minimise-enter-from,
.cc-window.cc-minimise-leave-to {
  opacity: 0;
  transform: translate(60px, 120px) scale(0.2);
}
@media (prefers-reduced-motion: reduce) {
  .cc-window.cc-minimise-enter-active,
  .cc-window.cc-minimise-leave-active {
    transition: none;
  }
}
</style>
