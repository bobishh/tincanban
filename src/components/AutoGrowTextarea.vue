<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const input = ref<HTMLTextAreaElement>()
let observer: ResizeObserver | undefined
let width = 0
function resize() {
  if (!input.value) return
  input.value.style.height = "auto"
  input.value.style.height = `${input.value.scrollHeight + 4}px`
}
watch(() => props.modelValue, () => { void nextTick(resize) })
onMounted(() => {
  resize()
  observer = new ResizeObserver(entries => {
    const nextWidth = entries[0]?.contentRect.width ?? 0
    if (nextWidth !== width) { width = nextWidth; resize() }
  })
  if (input.value) observer.observe(input.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>
<template>
  <textarea ref="input" :value="modelValue" @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)" />
</template>
<style scoped>
textarea { overflow: hidden; resize: none; width: 100%; box-sizing: border-box; }
</style>
