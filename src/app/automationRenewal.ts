import type { useTincanban } from "../state"
import { automationBoardDescription } from "./automation"
import { exportAutomationConnectionPacket } from "./automationActivation"
import { inspectExistingAutomation, reactivateExistingAutomation } from "./automationInstanceManagement"
import { parseAutomationApproval } from "../domain/automationApproval"
import { automationEntityId, automationLifecycle } from "../domain/automationLifecycle"
import { hasEntityKind } from "../domain/model"
import { workspaceRole } from "../sync/changeAuthorization"

type Workspace = ReturnType<typeof useTincanban>

export type AutomationRenewalTarget = {
  workspaceId: string
  definitionId: string
  executorPersonId: string
}

export function parseAutomationRenewalTarget(url: URL): AutomationRenewalTarget {
  const workspaceId = url.searchParams.get("workspace") ?? ""
  const definitionId = url.searchParams.get("definition") ?? ""
  const executorPersonId = url.searchParams.get("executor") ?? ""
  if (!workspaceId || workspaceId.length > 256 || !/^[A-Za-z0-9_-]{1,128}$/.test(definitionId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(executorPersonId)) {
    throw new Error("This renewal link does not identify an existing automation.")
  }
  return { workspaceId, definitionId, executorPersonId }
}

export async function readAutomationRenewal(workspace: Workspace, target: AutomationRenewalTarget) {
  const current = workspace.getCurrentProfile()
  if (!current) throw new Error("Open this link on an authorized owner device.")
  const profile = structuredClone(current)
  await workspace.whenReady()
  const doc = await workspace.readWorkspaceDoc(target.workspaceId)
  if (doc.id !== target.workspaceId || doc.archivedAt || await workspaceRole(doc, profile) !== "owner") {
    throw new Error("Open this link on an authorized owner device with this board.")
  }
  const entity = doc.entities[automationEntityId(target.definitionId)]
  if (!hasEntityKind(entity, "automation") || entity.executor.personId !== target.executorPersonId ||
      automationLifecycle(entity).state === "deleted") {
    throw new Error("The existing automation is unavailable on this board.")
  }
  const { definition, grant } = parseAutomationApproval(entity.approval)
  const { id, scope, name, type, typeVersion, parameters } = definition.payload
  if (id !== target.definitionId || scope.workspaceId !== target.workspaceId || grant.payload.personId !== target.executorPersonId) {
    throw new Error("The board approval does not match the selected automation.")
  }
  const configuration = { name, type, typeVersion, parameters }
  return { profile, grant, configuration, origin: entity.executor.origin, workspaceTitle: doc.title,
    board: automationBoardDescription(doc, configuration) }
}

export async function prepareBoardAutomationRenewal(workspace: Workspace, target: AutomationRenewalTarget, expectedGrantId: string) {
  const approved = await readAutomationRenewal(workspace, target)
  if (approved.grant.payload.grantId !== expectedGrantId) {
    throw new Error("The existing approval changed. Reload this page to review it.")
  }
  await workspace.switchWorkspace(target.workspaceId)
  const ensureCurrent = () => {
    const current = workspace.getCurrentProfile()
    if (workspace.getActiveDoc()?.id !== target.workspaceId || current?.identity.personId !== approved.profile.identity.personId ||
        current.device.deviceId !== approved.profile.device.deviceId || current.certificate.signature !== approved.profile.certificate.signature) {
      throw new Error("The owner device or selected board changed during renewal.")
    }
  }
  const guards = { ensureCurrent }
  const inspected = await inspectExistingAutomation(approved.profile, { ...target, origin: approved.origin }, guards)
  const { description } = inspected
  if (description.adoptionRequired || description.state === "deleted" || description.grantId !== expectedGrantId || !description.storage) {
    throw new Error("The existing automation does not match this board approval. Sync the board and retry.")
  }
  const packet = await exportAutomationConnectionPacket(workspace, inspected.identity, target.workspaceId,
    approved.board.fingerprint, approved.configuration, { grant: approved.grant, storage: description.storage })
  const payload: unknown = JSON.parse(packet)
  const activation = { workspaceId: target.workspaceId, packet: payload, explicitApproval: true }
  return () => reactivateExistingAutomation(approved.profile, inspected, activation, guards)
}
