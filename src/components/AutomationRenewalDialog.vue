<script setup lang="ts">
import { onMounted, ref, shallowRef } from "vue"
import type { useTincanban } from "../state"
import { parseAutomationRenewalTarget, readAutomationRenewal, prepareBoardAutomationRenewal,
  type AutomationRenewalTarget } from "../app/automationRenewal"
import DialogWindow from "./DialogWindow.vue"

const props = defineProps<{ workspace: ReturnType<typeof useTincanban>; workspaceId: string }>()
const target = shallowRef<AutomationRenewalTarget>()
const approval = shallowRef<Awaited<ReturnType<typeof readAutomationRenewal>>>()
const busy = ref(true)
const restored = ref(false)
const error = ref("")
let commit: Awaited<ReturnType<typeof prepareBoardAutomationRenewal>> | undefined
const message = (cause: unknown) => cause instanceof Error ? cause.message : "Automation access could not be restored."

onMounted(async () => {
  try {
    target.value = parseAutomationRenewalTarget(new URL(location.href))
    approval.value = await readAutomationRenewal(props.workspace, target.value)
  } catch (cause) { error.value = message(cause) }
  finally { busy.value = false }
})

async function restore() {
  if (!target.value || !approval.value || busy.value || restored.value) return
  busy.value = true
  error.value = ""
  try {
    commit ??= await prepareBoardAutomationRenewal(props.workspace, target.value, approval.value.grant.payload.grantId)
    await commit()
    commit = undefined
    restored.value = true
  } catch (cause) { error.value = message(cause) }
  finally { busy.value = false }
}

function close() { location.assign("/") }
</script>

<template>
  <DialogWindow window-id="automation-renewal" :workspace-id="workspaceId" title="Restore automation access" :busy="busy" @close="close">
    <section class="dialog dialog-window-content ui-stack">
      <p v-if="restored" role="status">Automation access restored.</p>
      <template v-else-if="approval">
        <p>{{ approval.configuration.name }} · {{ approval.workspaceTitle }}</p>
        <p>Restore the existing service’s board access for 30 days.</p>
        <p><strong>Read</strong> Entire workspace, including its documents.</p>
        <p><strong>Write</strong> Job cards in {{ approval.board.columns.join(', ') }} and automation messages in workspace chat.</p>
      </template>
      <p v-if="error" role="alert" class="notice notice-error">{{ error }}</p>
      <p v-if="busy && !approval" role="status">Checking board access…</p>
      <div class="dialog-actions">
        <button class="button button-quiet" type="button" :disabled="busy" @click="close">Close</button>
        <button v-if="approval && !restored" class="button" type="button" :disabled="busy" @click="restore">
          {{ busy ? "Restoring access…" : "Restore access" }}
        </button>
      </div>
    </section>
  </DialogWindow>
</template>
