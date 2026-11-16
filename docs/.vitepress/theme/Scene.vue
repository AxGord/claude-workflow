<script setup lang="ts">
// The landing's scene: the terminal plan pane on the left, the live map on the right, one replay clock.
import MapReplay from "./MapReplay.vue";
import TerminalPane from "./TerminalPane.vue";
</script>

<template>
  <div class="scene">
    <TerminalPane />
    <MapReplay />
  </div>
</template>

<style>
.scene {
  display: grid;
  grid-template-columns: minmax(300px, 2fr) 3fr;
  gap: 16px;
  align-items: start;
  max-width: 1280px;
  margin: 0 auto 56px;
  padding: 0 24px;
}
@media (max-width: 860px) {
  .scene {
    grid-template-columns: 1fr;
  }
}
</style>
