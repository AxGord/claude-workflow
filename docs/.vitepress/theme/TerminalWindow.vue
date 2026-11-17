<script setup lang="ts">
// The Claude Code window drawn over the map, translucent with a backdrop blur: the parent conversation's lines on
// the left and the workflow plan pane docked on the right, both at the scene's clock (replay-store.ts). The pane
// IS the mod's: `snapshotAt` (src/replay.ts) turns the replay's events into the Snapshot the mod builds from the
// engine, and `paneTree` (hooks/pane-view.ts, the code the mod draws with) turns it into the pane; the
// conversation lines are the mod's own line builders over `conversationTail`. Folds, tabs and cards work as in the mod;
// the Pool tab reads the pool the replay recorded (`poolStateAt`, drawn by the mod's own `poolBody`).
import { computed, reactive } from "vue";
import {
  age,
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
import { shared } from "./replay-store";

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
  else if (a.kind === "tab") ui.tab = a.id;
  else if (a.kind === "expand") ui.expanded = ui.expanded === a.id ? "" : a.id;
}
</script>

<template>
  <section class="cc-window" aria-label="The Claude Code window: the conversation and the workflow plan pane">
    <div class="cc-title"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>claude — anyparse</div>
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
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 14px;
  background: rgba(13, 17, 23, 0.72);
  backdrop-filter: blur(14px) saturate(1.2);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
  color: #d6dde6;
  font: 15px/20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow: hidden;
}
.cc-title {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  color: #9aa4ae;
  font-size: 13px;
}
.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}
.r {
  background: #ff5f56;
}
.y {
  background: #ffbd2e;
}
.g {
  background: #27c93f;
  margin-right: 10px;
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
  color: #7d8590;
  white-space: pre;
}
.cc-prompt {
  margin-top: 10px;
  padding: 6px 10px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px;
}
.cc-caret {
  color: #9aa4ae;
}
.cc-dock {
  width: calc(80ch + 28px);
  flex: none;
  display: flex;
  flex-direction: column;
  padding: 10px 14px;
  border-left: 1px solid rgba(255, 255, 255, 0.12);
  overflow: hidden;
}
.cc-dock-title {
  margin-bottom: 6px;
  color: #9aa4ae;
  font-weight: 700;
}
.cc-pane {
  overflow: hidden;
}
</style>

<style>
/* the window is dark in both site themes; its see-through glass over a light map would turn it grey and its text
   hard to read, so in the light theme the glass is nearly opaque */
html:not(.dark) .cc-window {
  background: rgba(13, 17, 23, 0.94);
}
</style>
