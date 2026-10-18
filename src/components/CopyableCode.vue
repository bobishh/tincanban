<script setup lang="ts">
import { copyCodeBlock } from "../ui/copyableCode"
defineProps<{ value: string; label: string }>()
</script>

<template>
  <div @click="copyCodeBlock">
    <span class="copyable-code" data-code-block role="group" :aria-label="label">
      <code>{{ value }}</code>
      <button class="button button-small button-quiet" type="button" data-copy-code :aria-label="`Copy ${label}`">Copy</button>
      <span class="reading-explanation" role="status" aria-live="polite"></span>
    </span>
  </div>
</template>
