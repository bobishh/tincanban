<script setup lang="ts">
defineProps<{ name: string; personId: string; avatarData?: string; portalOrigin: string }>()
defineEmits<{ refresh: []; connect: [] }>()
</script>

<template>
  <section class="connected-profile" aria-label="Your profile" :data-person-id="personId">
    <img v-if="avatarData" :src="avatarData" :alt="name" class="connected-profile-photo" />
    <span v-else class="connected-profile-placeholder" aria-hidden="true">{{ name.slice(0, 1) }}</span>
    <div class="connected-profile-copy">
      <strong>{{ name }}</strong>
      <p class="dialog-copy">Connected to your Identity</p>
      <div class="dialog-actions">
        <a class="button button-quiet" :href="`${portalOrigin}/profile`">Edit profile in Identity</a>
        <button class="button button-quiet" type="button" @click="$emit('refresh')">Refresh profile</button>
        <button class="button button-quiet" type="button" @click="$emit('connect')">Add another device</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.connected-profile { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
.connected-profile-photo, .connected-profile-placeholder { width: 72px; height: 72px; object-fit: cover; border-radius: 50%; }
.connected-profile-placeholder { display: grid; place-items: center; background: var(--paper); font-size: 2rem; }
.connected-profile-copy { display: grid; gap: var(--space-2); }
.connected-profile-copy p { margin: 0; }
</style>
