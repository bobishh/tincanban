<script setup lang="ts">
import { ref, watch } from "vue"
const props = defineProps<{ signInAvailable?: boolean; conflict?: { currentPersonId: string; currentName: string; targetPersonId: string } | null }>()
const emit = defineEmits<{ (e: "request", replaceIdentity: boolean): void; (e: "signIn"): void }>()
const confirmed = ref(false)
watch(() => props.conflict, () => { confirmed.value = false })
</script>
<template>
  <div>
    <template v-if="signInAvailable && conflict">
      <p>Sign in to the same Identity as your other device to reconnect. Your local boards stay saved; after sign-in, return here to receive and merge the board.</p>
      <button class="button button-primary" type="button" @click="emit('signIn')">Sign in to reconnect</button>
    </template>
    <template v-else>
    <p>Connect this device to your other device. Existing boards and local changes stay saved here.</p>
    <section v-if="conflict" role="alert">
      <strong>Identity conflict</strong>
      <p>This device belongs to {{ conflict.currentName }} (<code>{{ conflict.currentPersonId }}</code>). The invitation belongs to <code>{{ conflict.targetPersonId }}</code>.</p>
      <p>These identities will not be merged. Switching identity can remove your access to existing boards. Use a workspace invitation to share boards while keeping your identity.</p>
      <label><input v-model="confirmed" type="checkbox" /> Replace this device's identity; keep a local backup of the previous identity.</label>
    </section>
    <button class="button button-primary" type="button" :disabled="Boolean(conflict) && !confirmed" @click="emit('request', confirmed)">Add this device</button>
    <button v-if="signInAvailable" class="button" type="button" @click="emit('signIn')">Refresh Identity and reconnect</button>
    </template>
  </div>
</template>
<style scoped>
p { margin: var(--space-3) 0; line-height: 1.5; overflow-wrap: anywhere; }
section { margin: var(--space-4) 0; padding: var(--space-4); border: 2px solid var(--line); }
label { display: block; }
.button { margin-top: var(--space-4); }
</style>
