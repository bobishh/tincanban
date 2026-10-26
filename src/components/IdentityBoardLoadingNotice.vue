<script setup lang="ts">
defineProps<{ error: string }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <aside class="notice-overlay" aria-live="polite">
    <div class="notice" :role="error ? 'alert' : 'status'">
      <span>{{ error || 'Signed in. Loading your boards…' }}</span>
      <button v-if="error" class="button button-small" type="button" @click="$emit('retry')">Retry loading boards</button>
    </div>
  </aside>
</template>
