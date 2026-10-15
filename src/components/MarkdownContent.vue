<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { renderMarkdown, toggleMarkdownTask } from "../ui/markdown"

const props = defineProps<{ source: string; compact?: boolean; editableTasks?: boolean }>()
const emit = defineEmits<{ taskToggle: [source: string] }>()
const displayedSource = ref(props.source)
watch(() => props.source, source => { displayedSource.value = source })
const html = computed(() => renderMarkdown(displayedSource.value, props.compact, props.editableTasks))

function handleChange(event: Event) {
  const checkbox = event.target instanceof HTMLInputElement
    ? event.target.closest<HTMLInputElement>("input[data-task-index]")
    : null
  if (!checkbox || !props.editableTasks) return
  event.stopPropagation()
  const taskIndex = Number(checkbox.dataset.taskIndex)
  if (!Number.isInteger(taskIndex)) return
  displayedSource.value = toggleMarkdownTask(displayedSource.value, taskIndex, checkbox.checked)
  emit("taskToggle", displayedSource.value)
}

function stopTaskClick(event: MouseEvent) {
  if (event.target instanceof HTMLInputElement && event.target.matches("input[data-task-index]")) event.stopPropagation()
}
</script>

<template>
  <!-- Raw HTML is disabled in the shared parser; only parser-generated markup reaches this sink. -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="markdown-content" :class="{ 'markdown-compact': compact, 'markdown-tasks-editable': editableTasks }" @click="stopTaskClick" @change="handleChange" v-html="html"></div>
</template>

<style>
.markdown-content.markdown-content { min-width: 0; white-space: normal; overflow-wrap: anywhere; line-height: 1.55; }
.detail-copy.markdown-content { width: 100%; max-inline-size: min(70ch, 100%); }
.markdown-content > :first-child { margin-top: 0; }
.markdown-content > :last-child { margin-bottom: 0; }
.markdown-content p, .markdown-content ul, .markdown-content ol, .markdown-content blockquote { margin: .6em 0; }
.markdown-content ul, .markdown-content ol { padding-left: 1.5em; }
.markdown-content .task-list-item { list-style: none; }
.markdown-content input[type="checkbox"] { width: 1em; height: 1em; min-height: 0; margin: 0 .4em 0 0; accent-color: var(--ink); }
.markdown-tasks-editable input[type="checkbox"] { cursor: pointer; }
.markdown-content strong { display: inline; min-height: 0; font-size: inherit; }
.markdown-content h1, .markdown-content h2, .markdown-content h3 { margin: .8em 0 .4em; font-size: 1.2em; }
.markdown-content pre { overflow-x: auto; padding: .7em; background: var(--soft); white-space: pre; }
.markdown-content code { font-size: .9em; background: var(--soft); }
.markdown-content blockquote { padding-left: .8em; border-left: 3px solid var(--muted); }
.markdown-content a, .markdown-link { color: var(--blue); text-decoration: underline; }
.markdown-content img { max-width: 100%; height: auto; }
.markdown-content table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.markdown-content th, .markdown-content td { padding: .4em .6em; border: 1px solid var(--muted); }
.markdown-compact { font-size: 1rem; }
.document-preview-markdown { max-height: 65dvh; overflow: auto; padding: var(--space-4); }
</style>
