import type { useTincanban } from "../state"
import { automationBoardDescription } from "./automation"
import { inspectKnownAutomation } from "./automationInstanceManagement"
import { isLegacyAutomationGrant, parseAutomationApproval } from "../domain/automationApproval"
import { automationEntityId, automationLifecycle } from "../domain/automationLifecycle"
import { hasEntityKind } from "../domain/model"
import { workspaceRole } from "../sync/changeAuthorization"
import type { AutomationInstanceReadInput, AutomationInstanceRelay } from "./automationInstanceClient"

type Workspace = ReturnType<typeof useTincanban>

export async function readServiceUpgradeBoard(workspace: Workspace, target: AutomationInstanceReadInput) {
  const current = workspace.getCurrentProfile()
  if (!current) throw new Error("Sign in on the authorized owner device")
  const profile = structuredClone(current)
  await workspace.whenReady()
  await workspace.switchWorkspace(target.workspaceId)
  const doc = await workspace.readWorkspaceDoc(target.workspaceId)
  if (doc.id !== target.workspaceId || doc.archivedAt || await workspaceRole(doc, profile) !== "owner") {
    throw new Error("Open the existing board on the authorized owner device")
  }
  const entity = doc.entities[automationEntityId(target.definitionId)]
  if (!hasEntityKind(entity, "automation") || entity.executor.personId !== target.executorPersonId ||
      entity.executor.origin !== target.origin || automationLifecycle(entity).state === "deleted") {
    throw new Error("Sync the existing board to review this automation’s access")
  }
  const { definition, grant } = parseAutomationApproval(entity.approval)
  const { id, scope, name, type, typeVersion, parameters } = definition.payload
  if (id !== target.definitionId || scope.workspaceId !== target.workspaceId || grant.payload.personId !== target.executorPersonId) {
    throw new Error("The board approval does not match this workflow’s current automation")
  }
  const configuration = { name, type, typeVersion, parameters }
  return { profile, grant, configuration, board: automationBoardDescription(doc, configuration) }
}

export async function prepareServiceAccessUpgrade(workspace: Workspace, target: AutomationInstanceReadInput,
  relay: AutomationInstanceRelay, expectedFingerprint: string, ensureCurrent: () => void) {
  const { profile, grant, configuration, board } = await readServiceUpgradeBoard(workspace, target)
  if (board.fingerprint !== expectedFingerprint) throw new Error("Review the changed board permissions")
  const check = () => {
    ensureCurrent()
    if (workspace.getActiveDoc()?.id !== target.workspaceId) throw new Error("Board changed during service approval")
  }
  const { description, identity } = await inspectKnownAutomation(profile, target, { relay, ensureCurrent: check })
  const matchingGrant = description.grantId === grant.payload.grantId ||
    description.expiresAt !== null && !isLegacyAutomationGrant(grant)
  if (!matchingGrant || description.adoptionRequired || description.state === "deleted" ||
      description.serviceAccessVersion !== 1 || !description.storage) {
    throw new Error("The existing executor could not confirm support for service access on this board")
  }
  const { exportAutomationConnectionPacket } = await import("./automationActivation")
  check()
  const packet = await exportAutomationConnectionPacket(workspace, identity, target.workspaceId, board.fingerprint,
    configuration, { grant, storage: description.storage })
  check()
  return { packet, identity }
}
