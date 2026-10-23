import { defaultInvitationService } from "./invitations"
import type { WorkspaceGrant } from "../domain/model"
import { toBase64Url } from "../domain/identity"
import { defaultProofStore } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { userMessage } from "./deviceSyncState"
import type { JoinDecision } from "./deviceSyncJoinApproval"
import { nextKeeperGrantEpoch } from "./keeperGrantEpoch"
import type { HostRuntime, OwnerConnection } from "./deviceSyncHost"
import { z } from "zod"

export type WorkspaceGuest = { personId: string; displayName?: unknown; meshPeers?: unknown; followOwner?: unknown }

const workspaceRequestSchema = z.object({
  personId: z.string().min(1), invitationId: z.string().min(1), displayName: z.unknown().optional(),
  meshPeers: z.unknown().optional(), followOwner: z.unknown().optional(),
}).passthrough()

export type WorkspaceApproval = {
  personId: string
  deviceId?: string
  meshPeers?: unknown
  role: JoinDecision["role"]
  ownerConnection?: OwnerConnection
  grants?: WorkspaceGrant[]
}
export type WorkspaceApprovalResult = { ok: true; value: WorkspaceApproval } | { ok: false; error: string }

export function readWorkspaceRequest(runtime: HostRuntime, payload: Uint8Array): WorkspaceGuest {
  const parsed = workspaceRequestSchema.safeParse(JSON.parse(new TextDecoder().decode(payload)))
  if (!parsed.success || parsed.data.invitationId !== runtime.invite.invitationId) throw new Error("Invalid workspace join request.")
  const guest = parsed.data
  if (runtime.keeperAdmission && (guest.followOwner === true) !== runtime.keeperAdmission.followOwner) {
    throw new Error("Keeper future-board policy does not match the approved pairing.")
  }
  return guest
}

export async function approveWorkspaceAccess(runtime: HostRuntime, guest: WorkspaceGuest): Promise<WorkspaceApprovalResult> {
  if (guest.personId === runtime.profile.identity.personId) {
    return { ok: false, error: "This invite is for another person, but this browser uses the owner's identity. Use a separate identity to join as an editor." }
  }
  let deviceId: string | undefined
  if (!runtime.context.durableMesh) return { ok: false, error: "Couldn’t verify guest device." }
  try { deviceId = await runtime.context.durableMesh.checkGuestDevices(runtime.workspaces.map(item => item.id), guest.personId, guest.meshPeers) }
  catch (error) { return { ok: false, error: userMessage(error, "Couldn’t verify guest device.") } }
  if (!deviceId) return { ok: false, error: "Couldn’t verify guest device." }
  const existing = runtime.grants.get(guest.personId)
  if (existing) return { ok: true, value: { personId: guest.personId, deviceId,
    meshPeers: guest.meshPeers, role: existing.grants[0]?.payload.role === "editor" ? "editor" : "visitor",
    grants: existing.grants, ownerConnection: existing.ownerConnection } }
  if (Date.parse(runtime.invite.expiresAt) <= Date.now()) return { ok: false, error: "This invitation has expired." }
  if (runtime.keeperAdmission && !matchesKeeperAdmission(runtime, guest.personId)) {
    return { ok: false, error: "Keeper join does not match the approved identity and scope set." }
  }
  const workspaceIds = runtime.workspaces.map(workspace => workspace.id).sort()
  const binding = { personId: guest.personId, invitationId: runtime.invite.invitationId,
    expiresAt: runtime.invite.expiresAt, workspaceIds, deviceId }
  let approval = runtime.approvals.get(binding)
  if (!approval) {
    const decision = await decideWorkspaceJoin(runtime, guest)
    if (!decision) return { ok: false, error: "The owner declined this request." }
    const ownerConnection = decision.followOwner
      ? { controllerPersonId: runtime.profile.identity.personId } satisfies OwnerConnection : undefined
    approval = { ...binding, role: decision.role, ownerConnection }
    runtime.approvals.set(approval)
  }
  return { ok: true, value: { personId: guest.personId, deviceId, meshPeers: guest.meshPeers,
    role: approval.role, ownerConnection: approval.ownerConnection } }
}

async function decideWorkspaceJoin(runtime: HostRuntime, guest: WorkspaceGuest): Promise<JoinDecision | null> {
  if (runtime.keeperAdmission) return { role: "editor", followOwner: runtime.keeperAdmission.followOwner }
  const name = typeof guest.displayName === "string" ? guest.displayName.slice(0, 80) : `Participant ${guest.personId.slice(0, 6)}`
  return runtime.context.waitForJoinDecision(guest.personId, name, guest.followOwner === true)
}

async function issueWorkspaceGrants(runtime: HostRuntime, personId: string, role: JoinDecision["role"]) {
  const accessEpochs = new Map(await Promise.all(runtime.workspaces.map(async item => [
    item.id,
    nextKeeperGrantEpoch(await runtime.context.durableMesh?.nextAccessEpoch(item.id) ?? 1,
      runtime.keeperAdmission?.serviceGrantFloors?.[item.id] ?? 0),
  ] as const)))
  const result = await defaultInvitationService.approveWorkspaceJoinSet(runtime.invite.invitationId, personId,
    runtime.workspaces.map(item => item.id), runtime.profile, runtime.owners, role, accessEpochs)
  if (!result.ok) throw new Error(result.error)
  for (const grant of result.grants) {
    await defaultStorage.withWorkspaceAuthorityMutation(grant.payload.workspaceId,
      context => context.write(() => defaultProofStore.putGrant(grant.payload.grantId, grant)))
  }
  return result.grants
}

async function acceptApprovedGuest(runtime: HostRuntime, guest: { personId: string; meshPeers?: unknown },
  grants: WorkspaceGrant[], role: JoinDecision["role"], ownerConnection?: OwnerConnection, deviceId?: string) {
  try { await runtime.context.durableMesh?.acceptGuest(runtime.workspaces.map(item => item.id), guest.meshPeers, grants) }
  catch (error) {
    if (error instanceof Error && /Device access revoked/i.test(error.message)) return { ok: false as const, error: error.message }
    throw error
  }
  if (ownerConnection) await runtime.context.durableMesh?.connectOwnerKeeper(guest.personId, role)
  runtime.grants.set(guest.personId, { ok: true, grants, ownerConnection })
  return { ok: true as const, value: { personId: guest.personId, deviceId, grants, ownerConnection } }
}

function matchesKeeperAdmission(runtime: HostRuntime, personId: string) {
  const admission = runtime.keeperAdmission
  if (!admission || personId !== admission.servicePersonId) return false
  const actualScopes = runtime.workspaces.map(workspace => workspace.id).sort()
  const approvedScopes = [...admission.workspaceIds].sort()
  return actualScopes.length === approvedScopes.length && actualScopes.every((workspaceId, index) => workspaceId === approvedScopes[index])
}

export async function prepareWorkspaceAccess(runtime: HostRuntime, approval: WorkspaceApproval,
  keeperSnapshot?: (snapshot: Uint8Array) => Promise<void>) {
  const injectedFailure = (window as Window & { __TINCANBAN_INJECT_SYNC_SNAPSHOT_FAILURE__?: string }).__TINCANBAN_INJECT_SYNC_SNAPSHOT_FAILURE__
  if (injectedFailure) throw new Error(injectedFailure)
  const snapshot = await runtime.replica.snapshot()
  await keeperSnapshot?.(snapshot)
  if (runtime.stopped() || runtime.run !== runtime.context.currentRun()) throw new Error("Invitation superseded")
  if (Date.parse(runtime.invite.expiresAt) <= Date.now()) throw new Error("This invitation has expired.")
  const currentDeviceId = await runtime.context.durableMesh?.checkGuestDevices(
    runtime.workspaces.map(workspace => workspace.id), approval.personId, approval.meshPeers)
  if (!currentDeviceId || approval.deviceId !== currentDeviceId) throw new Error("Couldn’t verify guest device.")
  if (runtime.stopped() || runtime.run !== runtime.context.currentRun()) throw new Error("Invitation superseded")
  if (Date.parse(runtime.invite.expiresAt) <= Date.now()) throw new Error("This invitation has expired.")
  const grants = approval.grants ?? await issueWorkspaceGrants(runtime, approval.personId, approval.role)
  const admitted = await acceptApprovedGuest(runtime, approval, grants, approval.role, approval.ownerConnection, approval.deviceId)
  if (!admitted.ok) throw new Error(admitted.error)
  runtime.approvals.delete(approval.personId)
  return new TextEncoder().encode(JSON.stringify({ grants,
    ownerConnection: approval.ownerConnection,
    snapshot: toBase64Url(snapshot),
    meshWorkspaces: await runtime.context.durableMesh?.invitationPayload(runtime.workspaces.map(item => item.id)),
  }))
}
