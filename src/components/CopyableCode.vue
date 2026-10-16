<script setup lang="ts">
import { computed } from "vue"
import { copyableCodeHtml, copyCodeBlock } from "../ui/copyableCode"
const props = defineProps<{ value: string; label: string }>()
const html = computed(() => copyableCodeHtml(props.value, props.label))
</script>

<template>
  <!-- Application values are escaped by copyableCodeHtml. -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div @click="copyCodeBlock" v-html="html"></div>
</template>
