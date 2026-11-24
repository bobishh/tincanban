import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import type { LocalStatePlan } from "../localDb"
import type { WorkspaceGrant } from "../domain/model"
import type { MeshWorkspaceEnvelope } from "./durableMeshBase"
import type { IdentityDeviceComponent } from "./identityDeviceStateCodec"
import type { PeerStore, WorkspaceMeshCredential } from "./peerStore"
import type { DurableMesh } from "./durableMesh"
import { runIdentityWorkspaceRoutes } from "./identityWorkspaceRouteWorkerClient"
import type { WorkspaceRouteRecovery, WorkspaceRouteManifest } from "./identityWorkspaceRouteWorkerContract"

export { isIdentityWorkspaceRouteRecoveryComponent } from "./identityWorkspaceRouteWorkerContract"
export type { WorkspaceRouteRecovery } from "./identityWorkspaceRouteWorkerContract"

export class WorkspaceConnectionConflict extends Error {
  constructor(readonly workspaceId: string) {
    super("Saved connections for this board use different keys.")
    this.name = "WorkspaceConnectionConflict"
  }
}

function routeIdentity(profile: LocalProfile) {
  return { personId: profile.identity.personId, publicKey: profile.identity.publicKey, deviceId: profile.device.deviceId }
}

export function identityWorkspaceRouteRecoveryComponent(value: WorkspaceRouteRecovery): Promise<IdentityDeviceComponent> {
  return runIdentityWorkspaceRoutes({ kind: "pack", value })
}

export function readIdentityWorkspaceRouteRecovery(personId: string): Promise<WorkspaceRouteRecovery> {
  return runIdentityWorkspaceRoutes({ kind: "read", personId })
}

export function captureWorkspaceRouteEnvelopes(store: PeerStore, workspaceIds: string[], profile: LocalProfile,
  options: { skipUnavailable?: boolean } = {}): Promise<MeshWorkspaceEnvelope[]> {
  return runIdentityWorkspaceRoutes({ kind: "envelopes", workspaceIds, profile: routeIdentity(profile), options }, store)
}

export function captureIdentityWorkspaceRouteRecovery(store: PeerStore, workspaceIds: string[], profile: LocalProfile): Promise<WorkspaceRouteRecovery> {
  return runIdentityWorkspaceRoutes({ kind: "capture", workspaceIds, profile: routeIdentity(profile) }, store)
}

export function readIdentityWorkspaceRouteRevision(workspaceIds: string[], profile: LocalProfile): Promise<string> {
  return runIdentityWorkspaceRoutes({ kind: "revision", workspaceIds, profile: routeIdentity(profile) })
}

export function readIdentityWorkspaceRouteRecoveryComponent(manifest: WorkspaceRouteManifest): Promise<WorkspaceRouteRecovery> {
  return runIdentityWorkspaceRoutes({ kind: "component", manifest })
}

export function planIdentityWorkspaceRouteRecoveryImport(manifest: WorkspaceRouteManifest): Promise<LocalStatePlan> {
  return runIdentityWorkspaceRoutes({ kind: "import", manifest })
}

export function exportIdentityWorkspaceRouteRecovery(personId: string, workspaceIds?: string[]): Promise<Record<string, IdentityDeviceComponent>> {
  return runIdentityWorkspaceRoutes({ kind: "export", personId, workspaceIds })
}

/** Admit one pending envelope through DurableMesh; pending state remains portable for retry and later devices. */
type WorkspaceRouteRestore = {
  mesh: Pick<DurableMesh, "enrollmentGrant" | "validateInvitation" | "receiveInvitation" | "recoverWorkspaceAuthority"> &
    Partial<Pick<DurableMesh, "probeWorkspaceConnection">>
  envelopes: MeshWorkspaceEnvelope[]
  profile: LocalProfile
  readCredential: (workspaceId: string) => Promise<WorkspaceMeshCredential | null>
}

async function recoveryGrant(input: WorkspaceRouteRestore, workspaceId: string,
  envelope: MeshWorkspaceEnvelope): Promise<WorkspaceGrant | undefined> {
  const existing = await input.mesh.enrollmentGrant(workspaceId, input.profile)
  if (existing || envelope.ownerPersonId === input.profile.identity.personId) return existing
  return envelope.peers.find(peer => peer.grant?.payload.personId === input.profile.identity.personId)?.grant as WorkspaceGrant | undefined
}

async function validateRecoveryEnvelope(input: WorkspaceRouteRestore, workspaceId: string, envelope: MeshWorkspaceEnvelope) {
  const grant = await recoveryGrant(input, workspaceId, envelope)
  await input.mesh.validateInvitation([envelope], [workspaceId], input.profile, grant ? [grant] : [])
  const snapshot = envelope.scopeAuthoritySnapshot
  return { envelope, grant, authorityKey: canonicalizeJson([envelope.ownerPersonId, envelope.ownerPublicKey,
    envelope.transportSecret, snapshot ?? null]) }
}

function compatibleRoutes(existing: WorkspaceMeshCredential | null, candidates: MeshWorkspaceEnvelope[]): MeshWorkspaceEnvelope[] {
  const compatible = existing ? candidates.filter(envelope => envelope.transportSecret === existing.transportSecret) : candidates
  if (existing && !compatible.length) {
    throw new Error("Saved workspace route uses a different transport secret than this device's current credential")
  }
  return compatible
}

function groupRecoveryRoutes(admitted: Awaited<ReturnType<typeof validateRecoveryEnvelope>>[]) {
  const groups = new Map<string, typeof admitted>()
  for (const item of admitted) {
    const group = groups.get(item.authorityKey) ?? []
    group.push(item)
    groups.set(item.authorityKey, group)
  }
  return groups
}

async function receiveRecoveryRoute(input: WorkspaceRouteRestore, workspaceId: string,
  item: Awaited<ReturnType<typeof validateRecoveryEnvelope>>): Promise<void> {
  await input.mesh.receiveInvitation([item.envelope], [workspaceId], input.profile, item.grant ? [item.grant] : [],
    { mode: "identity-recovery" })
}

async function restoreWorkspaceRoutes(input: WorkspaceRouteRestore, workspaceId: string,
  candidates: MeshWorkspaceEnvelope[]): Promise<void> {
  if (!candidates.length) return
  const existing = await input.readCredential(workspaceId)
  const admitted: Awaited<ReturnType<typeof validateRecoveryEnvelope>>[] = []
  for (const envelope of candidates) {
    try { admitted.push(await validateRecoveryEnvelope(input, workspaceId, envelope)) }
    catch { /* Invalid authority variants remain pending, but cannot block a valid one. */ }
  }
  await input.mesh.recoverWorkspaceAuthority(workspaceId,
    admitted.flatMap(item => item.envelope.scopeAuthoritySnapshot ? [item.envelope.scopeAuthoritySnapshot] : []))
  const compatible = new Set(compatibleRoutes(existing, admitted.map(item => item.envelope)))
  const selected = admitted.filter(item => compatible.has(item.envelope))
  if (!existing && new Set(admitted.map(item => item.envelope.transportSecret)).size > 1) {
    const authorities = new Set(admitted.map(({ envelope }) => canonicalizeJson([
      envelope.ownerPersonId, envelope.ownerPublicKey, envelope.scopeAuthoritySnapshot ?? null,
    ])))
    if (authorities.size > 1) throw new Error("Multiple saved workspace authorities remain pending explicit resolution")
    for (const item of admitted) {
      if (!await input.mesh.probeWorkspaceConnection?.(item.envelope, input.profile, item.grant)) continue
      await receiveRecoveryRoute(input, workspaceId, item)
      return
    }
    throw new WorkspaceConnectionConflict(workspaceId)
  }
  const groups = groupRecoveryRoutes(selected)
  if (groups.size === 0) throw new Error("No saved workspace route has verifiable active authority")
  if (groups.size !== 1) throw new Error("Multiple saved workspace authorities remain pending explicit resolution")
  for (const item of groups.values().next().value ?? []) {
    await receiveRecoveryRoute(input, workspaceId, item)
  }
}

export async function restoreIdentityWorkspaceRoutes(input: WorkspaceRouteRestore & { workspaceIds: string[] }): Promise<void> {
  if (new Set(input.workspaceIds).size !== input.workspaceIds.length || input.workspaceIds.some(id => !id)) {
    throw new Error("Invalid workspace route restore request")
  }
  const pending = await runIdentityWorkspaceRoutes({ kind: "normalize",
    value: { personId: input.profile.identity.personId, envelopes: input.envelopes } })
  for (const workspaceId of input.workspaceIds) {
    await restoreWorkspaceRoutes(input, workspaceId, pending.envelopes.filter(envelope => envelope.workspaceId === workspaceId))
  }
}
