<script setup lang="ts">
// The install steps, right under the demo scene and above the features: the first thing a reader meets after seeing
// the product. A component in the hero's after-slot (the page's markdown comes below the features).
// The commands sit in the markup VitePress renders for a markdown code block (div.language-*, button.copy, span.lang,
// pre), inside a `.vp-doc` wrapper that scopes the theme's code-block styles: the copy button's look, hover and focus
// behaviour and its "Copied" feedback are the docs pages' own, and the click handler is the theme's (it copies the
// pre's text), so nothing here styles or scripts the button.
import { withBase } from "vitepress";
</script>

<template>
  <section class="install" aria-labelledby="install">
    <h2 id="install">Install</h2>
    <div class="vp-doc install-code">
      <div class="language-text vp-adaptive-theme">
        <button title="Copy Code" class="copy"></button>
        <span class="lang">text</span>
        <pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span>/plugin marketplace add https://github.com/anthropics/claude-plugins-community</span></span>
<span class="line"><span>/plugin install workflow</span></span></code></pre>
      </div>
    </div>
    <p>
      Then start a session: the plugin provisions its skills on first run.
      <a :href="withBase('/getting-started')">Get started</a> walks through the first workflow.
    </p>
  </section>
</template>

<style scoped>
.install {
  /* the hero's content width plus its gutters (24px, 32px from 768px, as Hero.vue's), so the block's edges are the hero's and the bar's (Hero.vue sets the feature grid to the same width and gutters) */
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
/* the theme gives a code block a 16px vertical margin, and -24px sideways on a phone: this block keeps the hero's edges */
.install-code :deep(div[class*="language-"]) {
  margin: 0 0 12px;
  border-radius: 8px;
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
