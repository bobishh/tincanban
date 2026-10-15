import { bootstrapIdentity } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { WorkspaceRole } from "../domain/permissions"
import { effectiveWorkspaceOwner, workspaceRole, workspaceWritesBlocked } from "../sync/changeAuthorization"
import type { useTincanban } from "../state"
import type { useDeviceSync } from "../sync/useDeviceSync"
import type { WorkspaceAccessResult } from "./workspaceAccessState"
import { diagnoseStartupStep } from "../sync/startupDiagnostics"
import { withWorkspaceAuthorityRaceRetry } from "./workspaceAuthorityRetry"

type ActiveAccess = { role: WorkspaceRole; ownerId: string; access: Record<string, WorkspaceAccessResult> }

export async function loadWorkspaceAccess(tincanban: ReturnType<typeof useTincanban>, doc: WorkspaceDocumentV2,
  sync: ReturnType<typeof useDeviceSync>, includeOthers = true, onActive?: (result: ActiveAccess) => void): Promise<ActiveAccess> {
  const profile = await bootstrapIdentity("My Device")
  const ensureCurrent = () => {
    if (tincanban.activeWorkspace.id !== doc.id) throw new Error("Workspace access request was replaced")
    const current = tincanban.getCurrentProfile()
    if (!current || current.identity.personId !== profile.identity.personId ||
      current.device.deviceId !== profile.device.deviceId) throw new Error("Workspace access identity changed")
  }
  const resolve = async (item: { id: string; title: string }) => {
    try {
      let role: WorkspaceRole
      if (item.id === doc.id) {
        role = await withWorkspaceAuthorityRaceRetry(() => workspaceRole(doc, profile), ensureCurrent).catch(async cause => {
          const { repairOwnerRevocationBoundary } = await import("../sync/ownerRevocationBoundaryRepair")
          await repairOwnerRevocationBoundary(cause, doc, profile, personId => sync.revokePeer(personId))
          return withWorkspaceAuthorityRaceRetry(() => workspaceRole(doc, profile), ensureCurrent)
        })
      } else role = await withWorkspaceAuthorityRaceRetry(() => tincanban.getWorkspaceRole(item.id), ensureCurrent)
      return [item.id, { role, blocked: await workspaceWritesBlocked(item.id) }] as const
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      const error = `“${item.title}” (${item.id}): permissions could not be verified. ${detail}`
      return [item.id, { role: "visitor" as const, blocked: true, error }] as const
    }
  }
  const items = tincanban.availableWorkspaces.value
  const activeItem = items.find(item => item.id === doc.id) ?? { id: doc.id, title: doc.title }
  const detail = { workspaceId: doc.id }
  const [activeId, activeRaw] = await diagnoseStartupStep("access-active-workspace", () => resolve(activeItem), detail)
  const active: WorkspaceAccessResult = activeRaw
  const ownerId = active?.error ? "" : await diagnoseStartupStep("access-current-owner", () => effectiveWorkspaceOwner(doc.id, doc.ownerPersonId), detail)
  const initial = { role: active.role, ownerId, access: { [activeId]: active } }
  await diagnoseStartupStep("access-ui-commit", () => onActive?.(initial), detail)
  const others = includeOthers ? await Promise.all(items.filter(item => item.id !== doc.id).map(resolve)) : []
  const access: Record<string, WorkspaceAccessResult> = Object.fromEntries([[activeId, active], ...others])
  return { ...initial, access }
}
