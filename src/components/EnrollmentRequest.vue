<script setup lang="ts">
import { ref, watch } from "vue"
const props = defineProps<{ conflict?: { currentPersonId: string; currentName: string; targetPersonId: string } | null }>()
const emit = defineEmits<{ (e: "request", replaceIdentity: boolean): void }>()
const confirmed = ref(false)
watch(() => props.conflict, () => { confirmed.value = false })
</script>
<template>
  <div>
    <p>Add this device to the identity of your other device. Existing boards stay saved here. The identity changes only after approval on your other device.</p>
    <section v-if="conflict" role="alert">
      <strong>Identity conflict</strong>
      <p>This device belongs to {{ conflict.currentName }} (<code>{{ conflict.currentPersonId }}</code>). The invitation belongs to <code>{{ conflict.targetPersonId }}</code>.</p>
      <p>These identities will not be merged. Switching identity can remove your access to existing boards. Use a workspace invitation to share boards while keeping your identity.</p>
      <label><input v-model="confirmed" type="checkbox" /> Replace this device's identity; keep a local backup of the previous identity.</label>
    </section>
    <button class="button button-primary" type="button" :disabled="Boolean(conflict) && !confirmed" @click="emit('request', confirmed)">Add this device</button>
  </div>
</template>
<style scoped>
p { margin: var(--space-3) 0; line-height: 1.5; overflow-wrap: anywhere; }
section { margin: var(--space-4) 0; padding: var(--space-4); border: 2px solid var(--line); }
label { display: block; }
.button { margin-top: var(--space-4); }
</style>
