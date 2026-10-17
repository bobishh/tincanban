<script setup lang="ts">
import { computed } from "vue"
import { MarkdownContent } from "../ui/markdownContent"
import { previewCardNote } from "../ui/cardNotePreview"
import type { Item } from "../domain/entitySchemas"

type CardField = { id: string; title: string; value: string }
type ItemDiscussion = { count: number; messageId?: string }
type CardItem = Item

const props = defineProps<{
  item: CardItem
  notes: string
  searchQuery?: string
  searchMatchIndex?: number
  summaryFields?: CardField[]
  fields: CardField[]
  hasFilters: boolean
  showFields?: boolean
  discussion?: ItemDiscussion
  canEditItems: boolean
  moved: boolean
  ageLevel?: string
  ageLabel?: string
}>()

const notePreview = computed(() => previewCardNote(props.notes, props.searchQuery ?? "", props.searchMatchIndex ?? -1))

function selectCard(event: MouseEvent) {
  (event.currentTarget as HTMLButtonElement).focus()
  emit("select", props.item)
}

const emit = defineEmits<{
  open: [item: CardItem, event: MouseEvent]
  select: [item: CardItem]
  discuss: [itemId: string]
  taskToggle: [item: CardItem, markdown: string]
}>()
</script>

<template>
  <article
    class="lead-card item-card"
    :class="[{ 'card-moved': moved, 'lead-card-expanded': hasFilters || showFields }, ageLevel ? `card-aging-${ageLevel}` : '']"
    :data-item-id="item.id"
    @click="emit('open', item, $event)"
  >
    <button class="card-open-button" type="button" :aria-label="`Open ${item.title}${ageLevel && ageLevel !== 'fresh' ? `. ${ageLabel}` : ''}`" @click="selectCard"></button>
    <div class="card-layout">
      <div class="card-main">
          <strong>{{ item.title }}</strong>
          <MarkdownContent v-if="item.body" v-show="!hasFilters" class="item-card-body" :source="item.body" compact :editable-tasks="canEditItems" @task-toggle="emit('taskToggle', item, $event)" />
        <dl v-if="summaryFields?.length" class="card-fields card-summary"><div v-for="field in summaryFields" :key="field.id"><dt>{{ field.title }}</dt><dd>{{ field.value }}</dd></div></dl>
      </div>
      <div v-if="(hasFilters && notes) || (showFields && fields.length)" class="card-context">
        <MarkdownContent v-if="hasFilters && notes" class="card-notes" :source="notePreview" compact :editable-tasks="canEditItems" @task-toggle="emit('taskToggle', item, $event)" />
        <dl v-if="showFields && fields.length" class="card-fields">
          <div v-for="field in fields" :key="field.id"><dt>{{ field.title }}</dt><dd>{{ field.value }}</dd></div>
        </dl>
      </div>
    </div>
    <button v-if="canEditItems || discussion" class="card-chat-action" :class="{ 'has-discussion': discussion }" type="button" :aria-label="discussion ? `Open discussion for ${item.title}. ${discussion.count} ${discussion.count === 1 ? 'message' : 'messages'}` : `Discuss ${item.title}`" :title="discussion ? 'Open discussion' : 'Discuss card'" @click.stop="emit('discuss', item.id)">
      <span v-if="discussion && discussion.count > 0" class="card-discussion-count" aria-hidden="true">{{ discussion.count }}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-6 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" /><path d="M7 9h10M7 13h7" /></svg>
    </button>
    <span v-if="ageLevel && ageLevel !== 'fresh'" class="card-activity-age">{{ ageLabel }}</span>
  </article>
</template>
