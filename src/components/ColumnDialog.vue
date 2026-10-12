<script setup lang="ts">
import ModalLayer from "./ModalLayer.vue"
import { ref } from "vue"

const props = defineProps<{
  columnId: string
  initialTitle: string
  initialCollapsible?: boolean
  initialArchive?: boolean
}>()

const emit = defineEmits<{
  (e: "close"): void
  (e: "save", title: string, collapsible: boolean, archive: boolean): void
  (e: "archive"): void
}>()
const removing = ref(false)
const error = ref("")

const title = ref(props.initialTitle)
const collapsible = ref(props.initialCollapsible ?? false)
const archive = ref(props.initialArchive ?? false)

function handleSave() {
  if (!title.value.trim()) { error.value = "Column title is required"; return }
  emit("save", title.value.trim(), collapsible.value, archive.value)
}
</script>

<template>
  <ModalLayer protect-draft class="overlay" @close="emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="Edit column">
      <form novalidate @submit.prevent="handleSave">
        <div class="dialog-head">
          <div>
            <h2>Edit column</h2>
          </div>
          <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">×</button>
        </div>

        <div class="dialog-body">
          <label>
            <span>Column title</span>
            <input v-model="title" autofocus required @input="error = ''" />
          </label>
          <label class="check-row"><input v-model="archive" type="checkbox" /> Designate as Archive column</label>
          <label class="check-row"><input v-model="collapsible" type="checkbox" /> Allow this column to collapse</label>

        </div>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <section v-if="removing" aria-label="Confirm column removal">
          <p>Remove “{{ title }}” from this board? Its cards and documents remain saved.</p>
          <button class="button button-danger" type="button" @click="emit('archive')">Confirm removal</button>
          <button class="button button-quiet" type="button" @click="removing = false">Keep column</button>
        </section>

        <div class="dialog-actions dialog-actions-split">
          <button v-if="!removing" class="button button-danger" type="button" @click="removing = true">Remove column</button>
          <div class="dialog-action-group">
            <button class="button button-quiet" type="button" @click="emit('close')">Cancel</button>
            <button class="button button-primary" type="submit">Save</button>
          </div>
        </div>
      </form>
    </section>
  </ModalLayer>
</template>
