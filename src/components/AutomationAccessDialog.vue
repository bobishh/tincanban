<script setup lang="ts">
import type { useTincanban } from "../state"
import type { LocalProfile } from "../domain/identity"
import { useAutomationConnection } from "../app/useAutomationConnection"
import AutomationConnectionDialog from "./AutomationConnectionDialog.vue"

const props = defineProps<{ workspace: ReturnType<typeof useTincanban>; profile: LocalProfile | null }>()
const emit = defineEmits<{ signIn: [] }>()
const { describeAutomationBoard, exportAutomationConnection, prepareServiceAccess, registerServiceAccess } = useAutomationConnection(props.workspace)
</script>

<template>
  <AutomationConnectionDialog :workspace-id="workspace.activeWorkspace.id" :ready="workspace.ready.value"
    :profile="profile" :boards="workspace.availableWorkspaces.value" :describe="describeAutomationBoard"
    :export-packet="exportAutomationConnection" :prepare-service-access="prepareServiceAccess" :register-service-access="registerServiceAccess" @sign-in="emit('signIn')" />
</template>
