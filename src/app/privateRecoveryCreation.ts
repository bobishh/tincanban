import type { useAppCore } from "./useAppCore"
import type { PrivateWorkspaceRecoveryBackup } from "./workspaceHistoryRecovery"
type RecoveryModule = { createPrivateWorkspaceRecovery: (core: ReturnType<typeof useAppCore>, workspaceId: string) => Promise<PrivateWorkspaceRecoveryBackup> }

/** Capture the clicked scope before lazy loading; nonmodal navigation cannot retarget an export. */
export async function createPrivateRecoveryForSelectedWorkspace(core: ReturnType<typeof useAppCore>,
  load: () => Promise<RecoveryModule> = () => import("./workspaceHistoryRecovery")) {
  const workspaceId = core.tincanban.activeWorkspace.id, workspaceTitle = core.tincanban.activeWorkspace.title
  const binding = () => {
    const profile = core.tincanban.getCurrentProfile()
    return JSON.stringify([profile?.identity.personId, profile?.device.deviceId, profile?.certificate.signature])
  }
  const captured = binding()
  const guard = () => { if (binding() !== captured) throw new Error("Identity changed during backup creation") }
  const module = await load()
  guard()
  const backup = await module.createPrivateWorkspaceRecovery(core, workspaceId)
  guard()
  return { ...backup, workspaceId, workspaceTitle }
}
