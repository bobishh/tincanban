import { z } from "zod"
import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { readLocal, type LocalStatePlan } from "../localDb"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { adaptVerifiedWorkspaceAdvertisement } from "@meta-uber/mesh-replication/protocol"
import type { WorkspaceGrant } from "../domain/model"
import { isEnvelope, type MeshWorkspaceEnvelope } from "./durableMeshBase"
import type { IdentityDeviceComponent } from "./identityDeviceStateCodec"
import { mergePeerRecords, type PeerStore, type WorkspaceMeshCredential, type WorkspacePeerRecord } from "./peerStore"
import type { DurableMesh } from "./durableMesh"
import { departures, deviceRevocations, ownerAuthorities, ownershipTransfers, revocations,
  successionClaims, successionPolicy, successionVotes } from "./durableMeshBase"
import { verifyWorkspaceMemberBundle, type WorkspaceMemberBundle } from "./meshRecords"

const componentName = "workspaceRouteRecovery"
const schema = "workspace-route-recovery@1"
const key = (personId: string) => `tincanban.identity-workspace-routes.v1.${personId}`
const valueSchema = z.object({ personId: z.string().min(1).max(128),
  envelopes: z.array(z.unknown()).max(512) }).strict()
const storedSchema = valueSchema.extend({ version: z.literal(1) }).strict()
const maxCatalogBytes = 900 * 1024
const maxEnvelopeCount = 512

export type WorkspaceRouteRecovery = { personId: string; envelopes: MeshWorkspaceEnvelope[] }
type Manifest = { personId: string; components: Record<string, IdentityDeviceComponent> }

async function peerRecord(envelope: MeshWorkspaceEnvelope, bundle: WorkspaceMemberBundle,
  verified: Awaited<ReturnType<typeof verifyWorkspaceMemberBundle>>): Promise<WorkspacePeerRecord> {
  const route = await adaptVerifiedWorkspaceAdvertisement(verified.advertisement)
  return { workspaceId: route.scopeId, personId: route.personId, deviceId: route.deviceId,
    ...(route.instanceId ? { instanceId: route.instanceId } : {}), endpoint: route.endpoint,
    transportSecret: envelope.transportSecret, role: verified.role, lastSeen: route.issuedAt,
    revokedAt: null, advertisement: bundle }
}

function mergedPeerBundles(records: WorkspacePeerRecord[]): WorkspaceMemberBundle[] {
  return records.flatMap(record => {
    const instances = record.instances?.filter(instance => instance.advertisement) ?? []
    if (instances.length) return instances.map(instance => instance.advertisement as WorkspaceMemberBundle)
    return record.advertisement ? [record.advertisement as WorkspaceMemberBundle] : []
  })
}

async function compactEnvelopePeers(envelope: MeshWorkspaceEnvelope): Promise<MeshWorkspaceEnvelope> {
  const records = new Map<string, WorkspacePeerRecord>()
  for (const raw of envelope.peers) {
    try {
      const verified = await verifyWorkspaceMemberBundle(raw, { workspaceId: envelope.workspaceId,
        ownerPersonId: envelope.ownerPersonId, ownerPublicKey: envelope.ownerPublicKey,
        ownerCertificates: envelope.ownerCertificates as never, ownerHistory: envelope.ownerHistory as never,
        allowStaleRoute: true, now: Date.now() })
      const incoming = await peerRecord(envelope, raw, verified)
      const existing = records.get(incoming.deviceId)
      records.set(incoming.deviceId, existing ? mergePeerRecords(existing, incoming) : incoming)
    } catch {
      // Preserve only SDK-verified routes; stale leases remain useful bootstrap contacts.
    }
  }
  const peers = [...records.values()].flatMap(record => mergedPeerBundles([record]))
  return { ...envelope, peers }
}

function envelopeAuthorityKey(envelope: MeshWorkspaceEnvelope): string {
  const authority = Object.fromEntries(Object.entries(envelope).filter(([name]) => name !== "peers"))
  return canonicalizeJson(authority)
}

function scopeAuthorityGroupKey(envelope: MeshWorkspaceEnvelope): string {
  return canonicalizeJson([envelope.workspaceId, envelope.ownerPersonId, envelope.ownerPublicKey, envelope.transportSecret])
}

function mergeScopeSnapshots(current: unknown, incoming: unknown): MeshWorkspaceEnvelope["scopeAuthoritySnapshot"] {
  if (current === undefined) return incoming as MeshWorkspaceEnvelope["scopeAuthoritySnapshot"]
  if (incoming === undefined) return current as MeshWorkspaceEnvelope["scopeAuthoritySnapshot"]
  return meshRustRuntime().state.mergeScopeAuthoritySnapshots(current, incoming, Date.now()) as MeshWorkspaceEnvelope["scopeAuthoritySnapshot"]
}

type ScopeAuthorityVariant = { snapshot: MeshWorkspaceEnvelope["scopeAuthoritySnapshot"]; envelopes: MeshWorkspaceEnvelope[] }

async function mergeCompatibleScopeSnapshots(envelopes: MeshWorkspaceEnvelope[]): Promise<MeshWorkspaceEnvelope[]> {
  const byWorkspaceOwner = new Map<string, ScopeAuthorityVariant[]>()
  for (const envelope of envelopes) {
    const key = scopeAuthorityGroupKey(envelope)
    const variants = byWorkspaceOwner.get(key) ?? []
    let merged = false
    for (const variant of variants) {
      try {
        variant.snapshot = mergeScopeSnapshots(variant.snapshot, envelope.scopeAuthoritySnapshot)
        variant.envelopes.push(envelope)
        merged = true
        break
      } catch {
        // SDK-rejected authority variants remain separate and pending.
      }
    }
    if (!merged) variants.push({ snapshot: envelope.scopeAuthoritySnapshot, envelopes: [envelope] })
    byWorkspaceOwner.set(key, variants)
  }
  return [...byWorkspaceOwner.values()].flatMap(variants => variants.flatMap(variant => variant.envelopes.map(envelope => {
    const metadata = Object.fromEntries(Object.entries(envelope).filter(([name]) => name !== "scopeAuthoritySnapshot")) as
      Omit<MeshWorkspaceEnvelope, "scopeAuthoritySnapshot">
    return variant.snapshot === undefined ? metadata : { ...metadata, scopeAuthoritySnapshot: variant.snapshot }
  })))
}

async function compactExactEnvelopeVariants(envelopes: MeshWorkspaceEnvelope[]): Promise<MeshWorkspaceEnvelope[]> {
  const exact = new Map<string, MeshWorkspaceEnvelope>()
  for (const envelope of envelopes) {
    const key = envelopeAuthorityKey(envelope)
    const previous = exact.get(key)
    exact.set(key, previous
      ? await compactEnvelopePeers({ ...previous, peers: [...previous.peers, ...envelope.peers] })
      : envelope)
  }
  return [...exact.values()]
}

async function normalize(personId: string, raw: unknown): Promise<WorkspaceRouteRecovery> {
  const parsed = valueSchema.safeParse(raw)
  if (!parsed.success || parsed.data.personId !== personId) throw new Error("Invalid workspace route recovery state")
  const checkedEnvelopes: MeshWorkspaceEnvelope[] = []
  for (const value of parsed.data.envelopes) {
    const envelope = JSON.parse(JSON.stringify(value)) as unknown
    if (!isEnvelope(envelope)) throw new Error("Invalid workspace route recovery envelope")
    checkedEnvelopes.push(await compactEnvelopePeers(envelope as MeshWorkspaceEnvelope))
  }
  const scopeMergedEnvelopes = await mergeCompatibleScopeSnapshots(checkedEnvelopes)
  const envelopes = (await compactExactEnvelopeVariants(scopeMergedEnvelopes)).sort((left, right) => left.workspaceId.localeCompare(right.workspaceId) ||
    envelopeAuthorityKey(left).localeCompare(envelopeAuthorityKey(right)))
  if (envelopes.length > maxEnvelopeCount) throw new Error("Workspace route recovery has too many authority variants")
  const result = { personId, envelopes }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maxCatalogBytes) {
    throw new Error("Workspace route recovery exceeds size limit")
  }
  return result
}

async function readComponent(manifest: Manifest): Promise<WorkspaceRouteRecovery> {
  const found: unknown[] = []
  const accept = (name: string, component: IdentityDeviceComponent) => {
    if (name !== componentName || component.schema !== schema || component.required) return
    if (component.value.personId !== manifest.personId) throw new Error("Workspace route recovery identity mismatch")
    found.push(...valueSchema.shape.envelopes.parse(component.value.envelopes))
  }
  for (const [name, component] of Object.entries(manifest.components)) {
    if (name === "preservedExtensions" && component.schema === "preserved-identity-components@1") {
      const extensions = component.value.extensions as Array<{ name: string; component: IdentityDeviceComponent }>
      for (const entry of extensions) accept(entry.name, entry.component)
    } else accept(name, component)
  }
  return normalize(manifest.personId, { personId: manifest.personId, envelopes: found })
}

export function isIdentityWorkspaceRouteRecoveryComponent(name: string, component: IdentityDeviceComponent): boolean {
  return name === componentName && component.schema === schema && !component.required
}

export async function identityWorkspaceRouteRecoveryComponent(value: WorkspaceRouteRecovery): Promise<IdentityDeviceComponent> {
  const checked = await normalize(value.personId, value)
  return { schema, required: false, value: checked }
}

async function decode(personId: string, raw: string | null): Promise<WorkspaceRouteRecovery> {
  if (raw === null) return { personId, envelopes: [] }
  if (new TextEncoder().encode(raw).byteLength > maxCatalogBytes) throw new Error("Workspace route recovery exceeds size limit")
  let input: unknown
  try { input = JSON.parse(raw) } catch { throw new Error("Invalid workspace route recovery state") }
  const parsed = storedSchema.safeParse(input)
  if (!parsed.success || parsed.data.personId !== personId) throw new Error("Invalid workspace route recovery state")
  return normalize(personId, { personId, envelopes: parsed.data.envelopes })
}

export async function readIdentityWorkspaceRouteRecovery(personId: string): Promise<WorkspaceRouteRecovery> {
  return decode(personId, await readLocal(key(personId)))
}

/** Capture only credentials the current local device can actively use; the SDK owns membership semantics. */
export async function captureWorkspaceRouteEnvelopes(store: PeerStore, workspaceIds: string[], profile: LocalProfile,
  options: { skipUnavailable?: boolean } = {}): Promise<MeshWorkspaceEnvelope[]> {
  const ids = [...new Set(workspaceIds)]
  if (ids.length !== workspaceIds.length || ids.some(id => !id)) throw new Error("Invalid workspace route capture request")
  const envelopes: MeshWorkspaceEnvelope[] = []
  for (const workspaceId of ids) {
    const credential = await store.getWorkspaceCredential(workspaceId)
    if (!credential) {
      if (options.skipUnavailable) continue
      throw new Error("Missing workspace mesh credential")
    }
    const partition = meshRustRuntime().state.partitionCredentials({ credentials: [credential],
      personId: profile.identity.personId, publicKey: profile.identity.publicKey, deviceId: profile.device.deviceId })
    if (partition.activeIndices.length !== 1) {
      if (options.skipUnavailable) continue
      throw new Error("Workspace mesh credential is not active for this Identity device")
    }
    const peerStoreWithFallback = store as PeerStore & { listPeers?: PeerStore["listPeers"] }
    const peerInstances = peerStoreWithFallback.listPeerInstances
      ? await peerStoreWithFallback.listPeerInstances(workspaceId)
      : await peerStoreWithFallback.listPeers?.(workspaceId) ?? []
    const peers = peerInstances.filter(peer => !peer.revokedAt && peer.advertisement)
      .map(peer => peer.advertisement as MeshWorkspaceEnvelope["peers"][number])
    const authority = await store.getWorkspaceAuthority(workspaceId)
    envelopes.push({ version: 1, workspaceId: credential.workspaceId, ownerPersonId: credential.ownerPersonId,
      ownerPublicKey: credential.ownerPublicKey, ownerCertificates: credential.ownerCertificates,
      transportSecret: credential.transportSecret, epoch: credential.epoch, peers,
      revocations: revocations(credential), deviceRevocations: deviceRevocations(credential), departures: departures(credential),
      ownerHistory: ownerAuthorities(credential).slice(1), ownershipTransfers: ownershipTransfers(credential),
      successionPolicy: successionPolicy(credential), successionVotes: successionVotes(credential), successionClaims: successionClaims(credential),
      scopeAuthoritySnapshot: authority?.scopeAuthoritySnapshot })
  }
  return (await normalize(profile.identity.personId, { personId: profile.identity.personId, envelopes })).envelopes
}

export async function captureIdentityWorkspaceRouteRecovery(store: PeerStore, workspaceIds: string[], profile: LocalProfile): Promise<WorkspaceRouteRecovery> {
  const allowed = new Set(workspaceIds)
  const [saved, current] = await Promise.all([readIdentityWorkspaceRouteRecovery(profile.identity.personId),
    captureWorkspaceRouteEnvelopes(store, workspaceIds, profile, { skipUnavailable: true })])
  return normalize(profile.identity.personId, { personId: profile.identity.personId,
    envelopes: [...saved.envelopes.filter(envelope => allowed.has(envelope.workspaceId)), ...current] })
}

export function readIdentityWorkspaceRouteRecoveryComponent(manifest: Manifest): Promise<WorkspaceRouteRecovery> {
  return readComponent(manifest)
}

/** Pending envelopes remain data until DurableMesh revalidates them against active workspace authority. */
export async function planIdentityWorkspaceRouteRecoveryImport(manifest: Manifest): Promise<LocalStatePlan> {
  const incoming = await readIdentityWorkspaceRouteRecoveryComponent(structuredClone(manifest))
  const raw = await readLocal(key(manifest.personId))
  const previous = await decode(manifest.personId, raw)
  const next = await normalize(manifest.personId, { personId: manifest.personId, envelopes: [...previous.envelopes, ...incoming.envelopes] })
  const value = JSON.stringify({ version: 1, ...next })
  return { conditions: [{ key: key(manifest.personId), value: raw }],
    writes: next.envelopes.length || raw !== null ? [{ key: key(manifest.personId), value }] : [] }
}

export async function exportIdentityWorkspaceRouteRecovery(personId: string, workspaceIds?: string[]): Promise<Record<string, IdentityDeviceComponent>> {
  const saved = await readIdentityWorkspaceRouteRecovery(personId)
  const allowed = workspaceIds ? new Set(workspaceIds) : undefined
  const filtered = allowed ? await normalize(personId, { personId,
    envelopes: saved.envelopes.filter(envelope => allowed.has(envelope.workspaceId)) }) : saved
  return filtered.envelopes.length ? { [componentName]: await identityWorkspaceRouteRecoveryComponent(filtered) } : {}
}

/** Admit one pending envelope through DurableMesh; pending state remains portable for retry and later devices. */
type WorkspaceRouteRestore = {
  mesh: Pick<DurableMesh, "enrollmentGrant" | "validateInvitation" | "receiveInvitation">
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
  if (!existing && new Set(compatible.map(envelope => envelope.transportSecret)).size !== 1) {
    throw new Error("Saved workspace routes disagree on the transport secret")
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

async function restoreWorkspaceRoutes(input: WorkspaceRouteRestore, workspaceId: string,
  candidates: MeshWorkspaceEnvelope[]): Promise<void> {
  if (!candidates.length) return
  const existing = await input.readCredential(workspaceId)
  const compatible = compatibleRoutes(existing, candidates)
  const admitted: Awaited<ReturnType<typeof validateRecoveryEnvelope>>[] = []
  for (const envelope of compatible) {
    try { admitted.push(await validateRecoveryEnvelope(input, workspaceId, envelope)) }
    catch { /* Invalid authority variants remain pending, but cannot block a valid one. */ }
  }
  const groups = groupRecoveryRoutes(admitted)
  if (groups.size === 0) throw new Error("No saved workspace route has verifiable active authority")
  if (groups.size !== 1) throw new Error("Multiple saved workspace authorities remain pending explicit resolution")
  for (const item of groups.values().next().value ?? []) {
    await input.mesh.receiveInvitation([item.envelope], [workspaceId], input.profile, item.grant ? [item.grant] : [],
      { mode: "identity-recovery" })
  }
}

export async function restoreIdentityWorkspaceRoutes(input: WorkspaceRouteRestore & { workspaceIds: string[] }): Promise<void> {
  if (new Set(input.workspaceIds).size !== input.workspaceIds.length || input.workspaceIds.some(id => !id)) {
    throw new Error("Invalid workspace route restore request")
  }
  const pending = await normalize(input.profile.identity.personId, { personId: input.profile.identity.personId,
    envelopes: input.envelopes })
  for (const workspaceId of input.workspaceIds) {
    await restoreWorkspaceRoutes(input, workspaceId, pending.envelopes.filter(envelope => envelope.workspaceId === workspaceId))
  }
}
