import { ref, watch, type Ref } from "vue"
import type { useTincanban } from "../state"
import type { AutomationWorkerIdentity, AutomationConfiguration } from "./automation"

/** Compose the connection route with board selection; board signing stays in the existing approval path. */
export function useAutomationConnection(workspace: ReturnType<typeof useTincanban>, returning: Ref<boolean>) {
  const connectingAutomation = ref(window.location.pathname === "/automation/connect")
  watch(returning, () => { connectingAutomation.value = window.location.pathname === "/automation/connect" })
  async function describeAutomationBoard(workspaceId: string, configuration: AutomationConfiguration) {
    await workspace.whenReady()
    await workspace.switchWorkspace(workspaceId)
    const profile = workspace.getCurrentProfile()
    const doc = await workspace.readWorkspaceDoc(workspaceId)
    const { workspaceRole } = await import("../sync/changeAuthorization")
    if (!profile || await workspaceRole(doc, profile) !== "owner") throw new Error("Only the board owner can connect a workflow")
    const { automationBoardDescription } = await import("./automation")
    return automationBoardDescription(doc, configuration)
  }
  async function exportAutomationConnection(identity: AutomationWorkerIdentity, workspaceId: string, fingerprint: string, configuration: AutomationConfiguration) {
    return (await import("./automationActivation")).exportAutomationConnectionPacket(workspace, identity, workspaceId, fingerprint, configuration)
  }
  return { connectingAutomation, describeAutomationBoard, exportAutomationConnection }
}
