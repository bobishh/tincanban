<script setup lang="ts">
import type { SyncStep, OwnerReconnectReview } from "../app/syncTypes"

defineProps<{
  step: SyncStep
  inviteUrl: string
  qrCode: string
  copyNotice: string
  error: string
  review: OwnerReconnectReview | null
}>()

const emit = defineEmits<{
  (event: "copy", url: string): void
  (event: "approve"): void
  (event: "cancel"): void
  (event: "dismiss"): void
}>()
</script>

<template>
  <section v-if="step === 'owner-reconnect-preparing' || step === 'owner-reconnect-host'" class="owner-reconnect-panel">
    <template v-if="step === 'owner-reconnect-preparing'">
      <p class="dialog-copy" role="status">Preparing a secure owner link…</p>
      <p class="dialog-copy">Only the current owner Identity can continue. Board data stays here until the owner approves.</p>
    </template>
    <template v-else-if="step === 'owner-reconnect-host'">
      <p class="dialog-copy">Scan this link from the device signed in to this board’s current owner Identity.</p>
      <img v-if="qrCode" :src="qrCode" alt="Connect owner device QR code" class="pairing-qr" />
      <label class="sync-link-label">Owner device link
        <textarea aria-label="Pairing link" readonly :value="inviteUrl" @focus="($event.target as HTMLTextAreaElement).select()" />
      </label>
      <div class="dialog-actions">
        <button class="button button-primary" type="button" @click="emit('copy', inviteUrl)">Copy link</button>
        <button class="button button-quiet" type="button" @click="emit('dismiss')">Close</button>
      </div>
      <p v-if="copyNotice" role="status" class="sync-success">{{ copyNotice }}</p>
    </template>
  </section>

  <section v-else-if="step === 'owner-reconnect-connecting'" class="owner-reconnect-panel">
    <p class="dialog-copy" role="status">Checking the owner Identity and board authority…</p>
    <p class="dialog-copy">No board data or storage access is saved until verification finishes.</p>
    <button class="button button-quiet" type="button" @click="emit('dismiss')">Cancel</button>
  </section>

  <section v-else-if="step === 'owner-reconnect-authorize' && review" class="owner-reconnect-panel" aria-label="Owner confirmation">
    <h3>Sync your existing board</h3>
    <p>A verified owner Identity matches this board. Participant {{ review.sourcePersonId.slice(0, 12) }} has {{ review.sourceRole }} access and wants to reconnect it to this device.</p>
    <p class="dialog-copy">Board data will be checked against the signed history before it is saved.</p>
    <p class="dialog-copy">{{ review.title }}</p>
    <div class="dialog-actions">
      <button class="button button-primary" type="button" @click="emit('approve')">Continue</button>
      <button class="button button-quiet" type="button" @click="emit('cancel')">Cancel</button>
    </div>
  </section>

  <section v-else-if="step === 'owner-reconnect-committing' && review" class="owner-reconnect-panel">
    <p class="dialog-copy" role="status">Verifying and saving {{ review.title }}…</p>
    <p class="dialog-copy">The owner link is waiting for the durable save confirmation.</p>
  </section>

  <section v-else-if="step === 'owner-reconnect-done' && review" class="owner-reconnect-panel">
    <p role="status" class="sync-success">{{ review.title }} is ready on this owner device.</p>
    <button class="button button-primary" type="button" @click="emit('dismiss')">Close</button>
  </section>

  <section v-else-if="step === 'owner-reconnect-done'" class="owner-reconnect-panel">
    <p role="status" class="sync-success">{{ copyNotice }}</p>
    <button class="button button-primary" type="button" @click="emit('dismiss')">Close</button>
  </section>

  <p v-if="step.startsWith('owner-reconnect-') && error" class="sync-error" role="alert">{{ error }}</p>
</template>
