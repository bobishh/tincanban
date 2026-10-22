import type { Ref } from "vue"
import type { LocalProfile } from "../domain/identity"
import { identityEnrollmentConfirmed } from "./identityEnrollmentReceipt"
import { createIdentityRegistrationGate } from "./identityRegistrationGate"

export function createIdentityPortalFlow(options: {
  configured: boolean
  showPortal: Ref<boolean>
  getProfile(): LocalProfile | null | undefined
  refreshIdentity(): Promise<void>
}) {
  let resolveEnrollment: ((completed: boolean) => void) | undefined
  const gate = createIdentityRegistrationGate({ ...options,
    requestRegistration: () => new Promise<boolean>(resolve => {
      resolveEnrollment = resolve
      options.showPortal.value = true
    }) })

  return {
    gate,
    async complete() {
      await options.refreshIdentity()
      const profile = options.getProfile()
      const completed = Boolean(profile && await identityEnrollmentConfirmed(profile))
      resolveEnrollment?.(completed)
      resolveEnrollment = undefined
      options.showPortal.value = false
    },
    close() {
      resolveEnrollment?.(false)
      resolveEnrollment = undefined
      options.showPortal.value = false
    },
  }
}

type WorkspaceInviteSync = {
  selectedWorkspaceIds: { value: string[] }
  selectedWorkspaceId: { value: string }
  generateWorkspaceInvite(): Promise<unknown>
}

export function createWorkspaceInviteAction(options: {
  gate: ReturnType<typeof createIdentityRegistrationGate>
  getWorkspaceId(): string
  sync: WorkspaceInviteSync
}) {
  return async () => await options.gate.run({
    capture: async () => ({ workspaceId: options.getWorkspaceId(), selectedWorkspaceIds: [...options.sync.selectedWorkspaceIds.value],
      selectedWorkspaceId: options.sync.selectedWorkspaceId.value }),
    assertCurrent: async (_profile, intent) => {
      if (options.getWorkspaceId() !== intent.workspaceId) throw new Error("Workspace changed while Identity enrollment was in progress")
    },
    // The sync controller rechecks selected workspace ownership before it starts a host.
    recheckAuthority: async () => {},
    execute: async (_profile, intent) => {
      options.sync.selectedWorkspaceIds.value = [...intent.selectedWorkspaceIds]
      options.sync.selectedWorkspaceId.value = intent.selectedWorkspaceId
      return await options.sync.generateWorkspaceInvite()
    },
  })
}
