<script setup lang="ts">
import ParticipantAvatar from "./ParticipantAvatar.vue"
defineProps<{ portalEnabled: boolean; signedIn: boolean; personId?: string; name?: string; avatarData?: string | null }>()
defineEmits<{ signIn: []; settings: [] }>()
</script>

<template>
  <button v-if="portalEnabled && !signedIn" class="button button-quiet" type="button" :disabled="!personId" @click="$emit('signIn')">Sign in</button>
  <button v-else-if="portalEnabled && personId" class="button button-quiet identity-profile-control" type="button"
    :aria-label="`Open profile for ${name}`" :data-person-id="personId" @click="$emit('settings')">
    <ParticipantAvatar :person-id="personId" :avatar-data="avatarData ?? undefined" />
  </button>
  <button class="button button-quiet" type="button" aria-label="Settings" @click="$emit('settings')">Settings</button>
</template>
