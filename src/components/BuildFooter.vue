<script setup lang="ts">
/* global __TINCANBAN_BUILD_COMMIT__ */
const commit = __TINCANBAN_BUILD_COMMIT__
const hasCommit = /^[0-9a-f]{40}$/i.test(commit)
const shortCommit = hasCommit ? commit.slice(0, 7) : commit
const commitUrl = hasCommit ? `https://github.com/bobishh/tincanban/commit/${commit}` : undefined
</script>

<template>
  <footer class="site-footer" aria-label="tincanban build information">
    <berlin-tower class="tower-mark"></berlin-tower>
    <span class="footer-copy">Berlin · 2026 · <a v-if="commitUrl" :href="commitUrl" target="_blank" rel="noreferrer">{{ shortCommit }}</a><template v-else>{{ shortCommit }}</template></span>
  </footer>
</template>

<style scoped>
.site-footer { min-height: 152px; padding: var(--space-5) clamp(var(--space-4), 4vw, var(--space-7)); padding-bottom: max(var(--space-5), var(--safe-bottom)); border-top: 2px solid var(--line); display: flex; flex-direction: column; justify-content: center; align-items: center; gap: var(--space-2); color: var(--ink); text-align: center; font: 700 .8rem/1.4 var(--site-font-sans); }
.tower-mark { --tower-ball-color: var(--red); width: 36px; height: 54px; overflow: visible; fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: square; stroke-linejoin: miter; }
.footer-copy { font-size: .8rem; }
.footer-copy a { color: inherit; text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 3px; }
.footer-copy a:hover { color: var(--red); }
</style>
