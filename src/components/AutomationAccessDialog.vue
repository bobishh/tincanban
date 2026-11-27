<script setup lang="ts">
import type { useTincanban } from "../state"
import type { LocalProfile } from "../domain/identity"
import { useAutomationConnection } from "../app/useAutomationConnection"
import AutomationConnectionDialog from "./AutomationConnectionDialog.vue"
import AutomationRenewalDialog from "./AutomationRenewalDialog.vue"

const props = defineProps<{ path: string; workspace: ReturnType<typeof useTincanban>; profile: LocalProfile | null }>()
const emit = defineEmits<{ signIn: [] }>()
const { describeAutomationBoard, exportAutomationConnection } = useAutomationConnection(props.workspace)
</script>

<template>
  <AutomationRenewalDialog v-if="path === '/automation/renew'" :workspace="workspace" :workspace-id="workspace.activeWorkspace.id" />
  <AutomationConnectionDialog v-else :workspace-id="workspace.activeWorkspace.id" :ready="workspace.ready.value"
    :profile="profile" :boards="workspace.availableWorkspaces.value" :describe="describeAutomationBoard"
    :export-packet="exportAutomationConnection" @sign-in="emit('signIn')" />
</template>
