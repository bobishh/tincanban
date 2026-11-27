import type { useTincanban } from "../state"
import type { AutomationInstanceReadInput, AutomationInstanceRelay } from "./automationInstanceClient"
import type { AutomationWorkerIdentity, AutomationConfiguration } from "./automation"

/** Compose the connection route with board selection; board signing stays in the existing approval path. */
export function useAutomationConnection(workspace: ReturnType<typeof useTincanban>) {
  async function describeAutomationBoard(workspaceId: string, configuration: AutomationConfiguration, target?: AutomationInstanceReadInput) {
    if (target) return (await (await import("./automationServiceUpgrade")).readServiceUpgradeBoard(workspace, target)).board
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
  async function prepareServiceAccess(target: AutomationInstanceReadInput, relay: AutomationInstanceRelay,
    fingerprint: string, ensureCurrent: () => void) {
    return (await import("./automationServiceUpgrade")).prepareServiceAccessUpgrade(workspace, target, relay, fingerprint, ensureCurrent)
  }
  async function registerServiceAccess(identity: AutomationWorkerIdentity, packetValue: unknown, ensureCurrent: () => void) {
    const { registerConnectionServiceAccess } = await import("./automationActivation")
    await registerConnectionServiceAccess(workspace, identity, packetValue, ensureCurrent)
  }
  return { describeAutomationBoard, exportAutomationConnection, prepareServiceAccess, registerServiceAccess }
}
