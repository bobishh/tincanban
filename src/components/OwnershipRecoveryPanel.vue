<script setup lang="ts">
import { computed, ref, watch } from "vue"
import type { SuccessionView } from "../app/syncTypes"
import type { MeshMemberView } from "../ui/deviceInfo"
const props = defineProps<{
  members: MeshMemberView[]
  selectedPersonId?: string
  hasMesh?: boolean
  succession?: SuccessionView
  currentRole?: "owner" | "editor" | "visitor"
  currentPersonId?: string
  canManageMesh?: boolean
  canClaimSuccession?: boolean
}>()
const emit = defineEmits<{
  setSuccessor: [personId: string | null]
  voteSuccessor: [personId: string]
  claimSuccession: []
}>()
const candidateId = ref(props.selectedPersonId || "")
watch(() => props.selectedPersonId, value => { candidateId.value = value || "" })
const editors = computed(() => props.members.filter(member => member.role === "editor"))
const candidate = computed(() => editors.value.find(member => member.personId === candidateId.value))
const currentVote = computed(() => props.succession?.votes.find(vote => vote.voterPersonId === props.currentPersonId))
const canVote = computed(() => {
  const policy = props.succession
  return Boolean(policy && candidate.value && props.currentRole === "editor" && !currentVote.value
    && !policy.conflicted && !policy.successorPersonId
    && policy.eligibleEditorPersonIds.includes(props.currentPersonId || "")
    && policy.eligibleEditorPersonIds.includes(candidate.value.personId))
})
const memberName = (id: string) => props.members.find(member => member.personId === id)?.name || "Unavailable member"
</script>
<template>
  <div v-if="hasMesh" class="recovery-panel ui-stack">
    <p v-if="succession?.conflicted" class="sync-error" role="alert">Conflicting recovery claims found. Workspace writes paused; inspect signed claims before transferring ownership.</p>
    <p v-if="succession" class="dialog-copy">
      <template v-if="succession.successorPersonId">Named successor: {{ memberName(succession.successorPersonId) }}.</template>
      <template v-else>Editor quorum: {{ succession.quorum }} of {{ succession.eligibleEditorPersonIds.length }}.</template>
    </p>
    <p v-if="succession && currentRole === 'editor'" class="dialog-copy">Votes for you: {{ succession.votes.filter(vote => vote.candidatePersonId === currentPersonId).length }} / {{ succession.quorum }}.</p>
    <div v-if="!succession" class="sync-recovery-note"><p>No recovery policy.</p><p class="sync-helper-text">{{ editors.length ? 'Owner: name a successor or enable editor quorum.' : 'Add an editor in Participants before setting up ownership recovery.' }}</p></div>
    <button v-if="canManageMesh && candidate && candidate.personId !== succession?.successorPersonId" class="button" type="button" @click="emit('setSuccessor', candidate.personId)">Name successor</button>
    <button v-if="canManageMesh && candidate?.personId === succession?.successorPersonId && succession?.successorPersonId" class="button" type="button" @click="emit('setSuccessor', null)">Remove named successor</button>
    <button v-if="canVote && candidate" class="button" type="button" @click="emit('voteSuccessor', candidate.personId)">Vote for {{ candidate.self ? 'yourself' : candidate.name }}</button>
    <p v-if="currentRole === 'editor' && currentVote" class="dialog-copy">Vote recorded for {{ memberName(currentVote.candidatePersonId) }}.</p>
    <button v-if="canManageMesh && !succession" class="button" type="button" :disabled="!editors.length" @click="emit('setSuccessor', null)">Enable editor quorum</button>
    <button v-if="canClaimSuccession && !succession?.conflicted" class="button button-danger" type="button" @click="emit('claimSuccession')">Claim ownership</button>
  </div>
</template>
<style scoped>
.recovery-panel { display: grid; gap: var(--space-3); padding-block: var(--space-2); }
p { margin: 0; }
.button { justify-self: start; }
.sync-recovery-note { display: grid; gap: var(--space-1); }
.sync-helper-text { color: var(--muted); font-size: .9rem; line-height: 1.4; }
</style>
