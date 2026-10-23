import type { JoinDecision } from "./deviceSyncJoinApproval"

export type JoinApprovalOwnerConnection = { controllerPersonId: string }
export type PendingJoinApproval = {
  personId: string
  invitationId: string
  expiresAt: string
  workspaceIds: string[]
  deviceId: string
  role: JoinDecision["role"]
  ownerConnection?: JoinApprovalOwnerConnection
}

type ApprovalBinding = Pick<PendingJoinApproval, "personId" | "invitationId" | "expiresAt" | "workspaceIds" | "deviceId">
type Entry = { approval: PendingJoinApproval; timer: ReturnType<typeof setTimeout> }

export function createWorkspaceJoinApprovalCache() {
  const entries = new Map<string, Entry>()
  const deletePerson = (personId: string) => {
    const entry = entries.get(personId)
    if (!entry) return
    clearTimeout(entry.timer)
    entries.delete(personId)
  }

  return {
    get(binding: ApprovalBinding): PendingJoinApproval | undefined {
      const entry = entries.get(binding.personId)
      if (!entry) return undefined
      const approval = entry.approval
      const valid = approval.personId === binding.personId && approval.invitationId === binding.invitationId &&
        approval.expiresAt === binding.expiresAt && approval.deviceId === binding.deviceId &&
        approval.workspaceIds.length === binding.workspaceIds.length &&
        approval.workspaceIds.every((workspaceId, index) => workspaceId === binding.workspaceIds[index]) &&
        Date.parse(approval.expiresAt) > Date.now()
      if (!valid) {
        deletePerson(binding.personId)
        return undefined
      }
      return approval
    },
    set(approval: PendingJoinApproval) {
      deletePerson(approval.personId)
      const delay = Math.max(0, Date.parse(approval.expiresAt) - Date.now())
      const timer = setTimeout(() => {
        if (entries.get(approval.personId)?.approval === approval) entries.delete(approval.personId)
      }, delay)
      const entry = { approval, timer }
      entries.set(approval.personId, entry)
    },
    delete: deletePerson,
    clear() { for (const personId of entries.keys()) deletePerson(personId) },
  }
}
