<script setup lang="ts">
// The install steps, right under the demo scene and above the features: the first thing a reader meets after seeing
// the product. A component in the hero's after-slot (the page's markdown comes below the features).
import { withBase } from "vitepress";
</script>

<template>
  <section class="install" aria-labelledby="install">
    <h2 id="install">Install</h2>
    <pre><code>/plugin marketplace add https://github.com/anthropics/claude-plugins-community
/plugin install workflow</code></pre>
    <p>
      Then start a session: the plugin provisions its skills on first run.
      <a :href="withBase('/getting-started')">Get started</a> walks through the first workflow.
    </p>
  </section>
</template>

<style scoped>
.install {
  /* the hero's content width plus its gutters (24px, 32px from 768px, as Hero.vue's), so the block's edges are the hero's, the bar's and the feature grid's */
  max-width: calc(var(--hero-content-w) + 48px);
  margin: 0 auto 40px;
  padding: 0 24px;
}
@media (min-width: 768px) {
  .install {
    max-width: calc(var(--hero-content-w) + 64px);
    padding: 0 32px;
  }
}
.install h2 {
  margin: 0 0 12px;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.install pre {
  margin: 0 0 12px;
  padding: 16px 20px;
  overflow-x: auto;
  border-radius: 8px;
  background: var(--vp-code-block-bg);
  font: 14px/1.7 var(--vp-font-family-mono);
}
.install p {
  margin: 0;
  color: var(--vp-c-text-2);
}
.install a {
  color: var(--vp-c-brand-1);
  font-weight: 500;
}
</style>
