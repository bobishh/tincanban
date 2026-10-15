<script setup lang="ts">
import { computed, ref, watch } from "vue"
import ModalLayer from "./ModalLayer.vue"
import type { ApplicationReviewOption, ApplicationReviewResponse } from "../domain/applicationReviewData"

const props = defineProps<{
  review: ApplicationReviewResponse | null
  busy: boolean
  failure: string
  saved: boolean
}>()
const emit = defineEmits<{
  close: []
  select: [option: ApplicationReviewOption]
  page: [offset: number]
  save: []
  retry: []
}>()

const selectedKey = ref<string | null>(null)
const selectedOption = computed(() => props.review?.options.find(option => optionKey(option) === selectedKey.value) ?? null)
const eligibleSelection = computed(() => Boolean(selectedOption.value && canBind(selectedOption.value)))
const canSave = computed(() => Boolean(props.review && eligibleSelection.value && props.review.decisionHash &&
  props.review.automationState === "active" && !props.busy && !props.saved))
const hasBinding = computed(() => Boolean(props.saved || props.review?.binding))
const canRetry = computed(() => Boolean(props.review && hasBinding.value && !props.busy &&
  props.review.automationState === "active" &&
  (props.review.status === "review" || props.review.status === "pending" || props.review.status === "failed")))
const canGoPrevious = computed(() => Boolean(props.review && props.review.offset > 0 && !props.busy))
const canGoNext = computed(() => Boolean(props.review?.hasMore && !props.busy))

watch(() => props.review, () => { selectedKey.value = null })

function optionKey(option: ApplicationReviewOption): string {
  return JSON.stringify([option.cardId, option.sourceRecordId])
}

function canBind(option: ApplicationReviewOption): boolean {
  return option.sourceStatus !== null && Boolean(option.sourceRecordId && option.sourceHash && option.workflow)
}

function choose(option: ApplicationReviewOption) {
  if (!canBind(option) || props.busy) return
  selectedKey.value = optionKey(option)
  emit("select", option)
}
</script>

<template>
  <ModalLayer :busy="busy" class="overlay-level-120" @close="emit('close')">
    <section class="dialog application-review-dialog" role="dialog" aria-modal="true"
      aria-label="Bind retained email to application" :aria-busy="busy">
      <div class="dialog-head review-head">
        <div><span class="review-eyebrow">Application message</span><h2>Bind retained email to application</h2></div>
        <button class="icon-button review-close" type="button" aria-label="Close application review" @click="emit('close')">×</button>
      </div>

      <p v-if="failure" class="review-failure" role="alert">{{ failure }}</p>
      <p v-else-if="busy" class="dialog-copy" role="status">Loading or saving application review…</p>
      <p v-else-if="!review" class="dialog-copy" role="status">No application message is loaded.</p>

      <template v-if="review">
        <section class="review-message" aria-label="Retained email">
          <h3 class="review-subject">{{ review.subject || "(No subject)" }}</h3>
          <p class="review-email-text">{{ review.text }}</p>
          <p v-if="review.sentAt" class="review-date">{{ review.sentAt }}</p>
        </section>

        <p v-if="review.automationState !== 'active'" class="dialog-copy" role="status">
          This automation is {{ review.automationState }}. Application binding is unavailable.
        </p>
        <p v-else-if="review.status === 'pending' || review.status === 'processing'" class="dialog-copy" role="status">
          Message status: {{ review.status }}. Review the saved message before binding.
        </p>

        <section class="review-candidates" role="group" aria-label="Application candidates">
          <div class="review-section-heading"><h3>Application candidates</h3>
            <span>{{ review.total }} total</span></div>
          <p v-if="!review.options.length" class="dialog-copy">No application candidates on this page.</p>
          <div v-else class="review-candidate-list">
            <button v-for="option in review.options" :key="optionKey(option)" class="review-candidate"
              type="button" :aria-label="option.displayTitle" :aria-pressed="selectedKey === optionKey(option)"
              :disabled="busy || !canBind(option)" @click="choose(option)">
              <span class="review-candidate-title" aria-hidden="true">{{ option.displayTitle }}</span>
              <span v-if="option.sourceStatus === 'available'" class="review-source" aria-hidden="true">
                Original source: {{ option.sourceCompany }} · {{ option.sourceTitle }}
              </span>
              <span v-else class="review-source review-source-status" aria-hidden="true">
                Source evidence: {{ option.sourceStatus ?? "missing" }}
              </span>
            </button>
          </div>
        </section>

        <div class="review-paging" role="group" aria-label="Candidate pages">
          <button class="button button-quiet button-small" type="button" :disabled="!canGoPrevious"
            @click="emit('page', Math.max(0, review.offset - 20))">Previous</button>
          <span>Showing {{ review.options.length ? review.offset + 1 : 0 }}–{{ review.offset + review.options.length }} of {{ review.total }}</span>
          <button class="button button-quiet button-small" type="button" :disabled="!canGoNext"
            @click="emit('page', review.offset + 20)">Next</button>
        </div>

        <p v-if="hasBinding" class="review-saved" role="status">Owner binding saved.</p>
        <div class="dialog-actions review-actions">
          <button v-if="canRetry" class="button button-quiet" type="button" :disabled="busy" @click="emit('retry')">
            Retry processing
          </button>
          <button class="button button-primary" type="button" :disabled="!canSave" @click="emit('save')">Save binding</button>
          <button class="button button-quiet" type="button" @click="emit('close')">Close</button>
        </div>
      </template>
      <div v-else class="dialog-actions review-actions"><button class="button button-quiet" type="button" @click="emit('close')">Close</button></div>
    </section>
  </ModalLayer>
</template>

<style src="../styles/design-system/reading-fonts.css"></style>
<style scoped>
.application-review-dialog { width: min(720px, 100%); padding: clamp(16px, 4vw, 28px); }
.review-head { align-items: start; gap: 12px; margin-bottom: 18px; }
.review-head h2 { max-width: 18ch; margin-top: 4px; }
.review-eyebrow, .review-date, .review-section-heading > span, .review-paging { color: var(--muted); font-size: .9rem; }
.review-close { flex: 0 0 auto; min-width: 44px; min-height: 44px; }
.review-message { min-width: 0; padding: 14px; border: 1px solid var(--line); background: var(--paper); }
.review-subject { margin: 0 0 8px; font-size: 1.25rem; }
.review-email-text { max-height: min(34vh, 320px); margin: 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 400 1rem/1.55 var(--site-font-reading); }
.review-date { margin: 10px 0 0; overflow-wrap: anywhere; }
.review-failure { padding: 10px 12px; border-left: 4px solid var(--red); color: var(--red); overflow-wrap: anywhere; }
.review-candidates { margin-top: 20px; }
.review-section-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.review-section-heading h3 { margin: 0 0 10px; font-size: 1.2rem; }
.review-candidate-list { display: grid; gap: 8px; max-height: 34vh; overflow: auto; }
.review-candidate { display: grid; gap: 4px; min-width: 0; padding: 10px 12px; border: 1px solid var(--line); color: var(--ink); background: var(--paper); text-align: left; cursor: pointer; }
.review-candidate[aria-pressed="true"] { outline: 3px solid var(--yellow); outline-offset: 1px; }
.review-candidate:disabled { opacity: .65; cursor: not-allowed; }
.review-candidate-title { font: 700 1.15rem/1.25 var(--site-font-brand); overflow-wrap: anywhere; }
.review-source { color: var(--muted); font-size: .95rem; overflow-wrap: anywhere; }
.review-source-status { text-transform: none; }
.review-paging { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.review-saved { color: var(--ink); font-weight: 700; }
.review-actions { gap: 8px; }
@media (max-width: 560px) {
  .application-review-dialog { padding: 16px; }
  .review-paging { justify-content: center; }
  .review-paging > span { flex: 1 1 100%; order: -1; text-align: center; }
  .review-actions > * { flex: 1 1 auto; }
}
</style>
