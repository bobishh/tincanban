<script setup lang="ts">
defineProps<{ portalEnabled: boolean; signedIn: boolean; personId?: string }>()
defineEmits<{ signIn: []; settings: [] }>()
</script>

<template>
  <button v-if="portalEnabled && !signedIn" class="button button-quiet" type="button" :disabled="!personId" @click="$emit('signIn')">Sign in</button>
  <button class="button button-quiet" type="button" aria-label="Settings" @click="$emit('settings')">Settings</button>
</template>
