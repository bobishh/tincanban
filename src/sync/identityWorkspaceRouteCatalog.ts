import { z } from "zod"
import { canonicalizeJson, sha256Base64Url } from "../domain/identity"
import { readLocal, type LocalStatePlan } from "../localDb"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { adaptVerifiedWorkspaceAdvertisement } from "@meta-uber/mesh-replication/protocol"
import type { MeshWorkspaceEnvelope } from "./durableMeshBase"
import { validateOptionalIdentityComponent, type IdentityDeviceComponent } from "./identityDeviceStateCodec"
import { mergePeerRecords, peerStore, type PeerStore, type WorkspacePeerRecord } from "./peerStore"
import { departures, deviceRevocations, ownerAuthorities, ownershipTransfers, revocations,
  successionClaims, successionPolicy, successionVotes } from "./durableMeshBase"
import { verifyWorkspaceMemberBundle, type WorkspaceMemberBundle } from "./meshRecords"
import { packWorkspaceRoutes, unpackWorkspaceRoutes } from "./identityWorkspaceRoutePacking"

import { isIdentityWorkspaceRouteRecoveryComponent, workspaceRouteKey as key, workspaceRouteComponent as componentName,
  workspaceRouteSchema as schema, packedWorkspaceRouteSchema as packedSchema,
  type WorkspaceRouteRecovery, type WorkspaceRouteManifest, type RouteIdentity, type RouteOperation, type RouteResult } from "./identityWorkspaceRouteWorkerContract"

const valueSchema = z.object({ personId: z.string().min(1).max(128),
  envelopes: z.array(z.unknown()).max(512) }).strict()
const storedSchema = valueSchema.extend({ version: z.literal(1) }).strict()
// Repeated signed ledgers compress well; bound both their decoded working set
// and the encoded component that shares the 1 MiB profile manifest.
const maxCatalogBytes = 8 * 1024 * 1024
const maxPackedCatalogBytes = 900 * 1024
const maxEnvelopeCount = 512

type Cached<Value> = { value: Value; verifiedAt: number; validUntil: number; weight: number }

class RouteCache<Value> {
  private readonly entries = new Map<string, Cached<Value>>()
  private weight = 0

  constructor(private readonly capacity: number, private readonly maxEntries: number) {}

  read(key: string, now: number): Value | undefined {
    const item = this.entries.get(key)
    if (!item) return
    this.entries.delete(key)
    if (now < item.verifiedAt || now >= item.validUntil) {
      this.weight -= item.weight
      return
    }
    this.entries.set(key, item)
    return item.value
  }

  store(key: string, value: Value, verifiedAt: number, validUntil = Infinity) {
    const weight = key.length * 2
    if (weight > this.capacity || validUntil <= verifiedAt) return
    const previous = this.entries.get(key)
    if (previous) {
      this.weight -= previous.weight
      this.entries.delete(key)
    }
    for (const [oldest, item] of this.entries) {
      if (this.entries.size < this.maxEntries && this.weight + weight <= this.capacity) break
      this.entries.delete(oldest)
      this.weight -= item.weight
    }
    this.entries.set(key, { value, verifiedAt, validUntil, weight })
    this.weight += weight
  }
}

const admittedMembers = new RouteCache<Awaited<ReturnType<typeof verifyWorkspaceMemberBundle>>>(maxCatalogBytes, 2048)
const normalizedCatalogs = new RouteCache<WorkspaceRouteRecovery>(maxCatalogBytes * 2, 6)
type CatalogClock = { now: number; validUntil: number }

async function peerRecord(envelope: MeshWorkspaceEnvelope, bundle: WorkspaceMemberBundle,
  verified: Awaited<ReturnType<typeof verifyWorkspaceMemberBundle>>): Promise<WorkspacePeerRecord> {
  const route = await adaptVerifiedWorkspaceAdvertisement(verified.advertisement)
  return { workspaceId: route.scopeId, personId: route.personId, deviceId: route.deviceId,
    ...(route.instanceId ? { instanceId: route.instanceId } : {}), endpoint: route.endpoint,
    transportSecret: envelope.transportSecret, role: verified.role, lastSeen: route.issuedAt,
    revokedAt: null, advertisement: bundle }
}

async function compactEnvelopePeers(envelope: MeshWorkspaceEnvelope, clock: CatalogClock): Promise<MeshWorkspaceEnvelope> {
  const records = new Map<string, WorkspacePeerRecord>()
  const authority = { workspaceId: envelope.workspaceId, ownerPersonId: envelope.ownerPersonId,
    ownerPublicKey: envelope.ownerPublicKey, ownerCertificates: envelope.ownerCertificates as never,
    ownerHistory: envelope.ownerHistory as never, allowStaleRoute: true }
  const context = canonicalizeJson(authority)
  for (const raw of envelope.peers) {
    try {
      // An accepted stale-route bundle stays valid as time advances. Only the
      // selection of live and fallback contacts changes at its lease expiry.
      const verificationKey = context + canonicalizeJson(raw)
      let verified = admittedMembers.read(verificationKey, clock.now)
      if (!verified) {
        verified = await verifyWorkspaceMemberBundle(raw, { ...authority, now: clock.now })
        admittedMembers.store(verificationKey, verified, clock.now)
      }
      const expiry = verified.advertisement.payload.expiresAt
      if (expiry !== undefined) {
        const deadline = Date.parse(expiry)
        if (!Number.isFinite(deadline)) clock.validUntil = clock.now
        else if (deadline > clock.now) clock.validUntil = Math.min(clock.validUntil, deadline)
      }
      const incoming = await peerRecord(envelope, raw, verified)
      const existing = records.get(incoming.deviceId)
      records.set(incoming.deviceId, existing ? mergePeerRecords(existing, incoming) : incoming)
    } catch {
      // A rejected future-dated contact can become valid later.
      clock.validUntil = clock.now
    }
  }
  const peers = [...records.values()].flatMap(record =>
    meshRustRuntime().state.recoveryPeerAdvertisements(record, clock.now) as WorkspaceMemberBundle[])
  return { ...envelope, peers }
}

function envelopeAuthorityKey(envelope: MeshWorkspaceEnvelope): string {
  const authority = Object.fromEntries(Object.entries(envelope).filter(([name]) => name !== "peers"))
  return canonicalizeJson(authority)
}

function scopeAuthorityGroupKey(envelope: MeshWorkspaceEnvelope): string {
  return canonicalizeJson([envelope.workspaceId, envelope.ownerPersonId, envelope.ownerPublicKey, envelope.transportSecret])
}

function mergeScopeSnapshots(current: unknown, incoming: unknown, now: number): MeshWorkspaceEnvelope["scopeAuthoritySnapshot"] {
  if (current === undefined) return incoming as MeshWorkspaceEnvelope["scopeAuthoritySnapshot"]
  if (incoming === undefined) return current as MeshWorkspaceEnvelope["scopeAuthoritySnapshot"]
  return meshRustRuntime().state.mergeScopeAuthoritySnapshots(current, incoming, now) as MeshWorkspaceEnvelope["scopeAuthoritySnapshot"]
}

type ScopeAuthorityVariant = { snapshot: MeshWorkspaceEnvelope["scopeAuthoritySnapshot"]; envelopes: MeshWorkspaceEnvelope[] }

async function mergeCompatibleScopeSnapshots(envelopes: MeshWorkspaceEnvelope[], clock: CatalogClock): Promise<MeshWorkspaceEnvelope[]> {
  const byWorkspaceOwner = new Map<string, ScopeAuthorityVariant[]>()
  for (const envelope of envelopes) {
    const key = scopeAuthorityGroupKey(envelope)
    const variants = byWorkspaceOwner.get(key) ?? []
    let merged = false
    for (const variant of variants) {
      try {
        variant.snapshot = mergeScopeSnapshots(variant.snapshot, envelope.scopeAuthoritySnapshot, clock.now)
        variant.envelopes.push(envelope)
        merged = true
        break
      } catch {
        // SDK-rejected authority variants remain separate and pending.
        clock.validUntil = clock.now
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

async function compactExactEnvelopeVariants(envelopes: MeshWorkspaceEnvelope[], clock: CatalogClock): Promise<MeshWorkspaceEnvelope[]> {
  const exact = new Map<string, MeshWorkspaceEnvelope>()
  for (const envelope of envelopes) {
    const key = envelopeAuthorityKey(envelope)
    const previous = exact.get(key)
    exact.set(key, previous
      ? await compactEnvelopePeers({ ...previous, peers: [...previous.peers, ...envelope.peers] }, clock)
      : envelope)
  }
  return [...exact.values()]
}

async function normalize(personId: string, raw: unknown): Promise<WorkspaceRouteRecovery> {
  const parsed = valueSchema.safeParse(raw)
  if (!parsed.success || parsed.data.personId !== personId) throw new Error("Invalid workspace route recovery state")
  const clock = { now: Date.now(), validUntil: Infinity }
  const encoded = JSON.stringify({ version: 1, ...parsed.data })
  const cached = normalizedCatalogs.read(encoded, clock.now)
  if (cached) return cached
  const checkedEnvelopes: MeshWorkspaceEnvelope[] = []
  const { envelopes: detached } = JSON.parse(encoded) as WorkspaceRouteRecovery
  for (const envelope of detached) {
    if (!meshRustRuntime().state.isWorkspaceEnvelope(envelope, clock.now)) throw new Error("Invalid workspace route recovery envelope")
    // Succession can use time-sensitive authority. Recheck that ledger in
    // the worker while still reusing positively verified member bundles.
    if (envelope.scopeAuthoritySnapshot?.successionTransfers?.length) clock.validUntil = clock.now
    checkedEnvelopes.push(await compactEnvelopePeers(envelope, clock))
  }
  const scopeMergedEnvelopes = await mergeCompatibleScopeSnapshots(checkedEnvelopes, clock)
  const envelopes = (await compactExactEnvelopeVariants(scopeMergedEnvelopes, clock)).sort((left, right) => left.workspaceId.localeCompare(right.workspaceId) ||
    envelopeAuthorityKey(left).localeCompare(envelopeAuthorityKey(right)))
  if (envelopes.length > maxEnvelopeCount) throw new Error("Workspace route recovery has too many authority variants")
  const result = { personId, envelopes }
  if (new TextEncoder().encode(JSON.stringify({ version: 1, ...result })).byteLength > maxCatalogBytes) {
    throw new Error("Workspace route recovery exceeds size limit")
  }
  normalizedCatalogs.store(encoded, result, clock.now, clock.validUntil)
  return result
}

async function readComponent(manifest: WorkspaceRouteManifest): Promise<WorkspaceRouteRecovery> {
  const found: unknown[] = []
  const accept = async (name: string, component: IdentityDeviceComponent) => {
    if (!isIdentityWorkspaceRouteRecoveryComponent(name, component)) return
    const value = component.schema === packedSchema
      ? unpackWorkspaceRoutes(manifest.personId, component.value, maxCatalogBytes, maxPackedCatalogBytes)
      : component.value
    const checked = validateOptionalIdentityComponent(componentName, { schema, required: false, value: value as Record<string, unknown> })
    if (checked.value.personId !== manifest.personId) throw new Error("Workspace route recovery identity mismatch")
    found.push(...valueSchema.shape.envelopes.parse(checked.value.envelopes))
  }
  for (const [name, component] of Object.entries(manifest.components)) {
    if (name === "preservedExtensions" && component.schema === "preserved-identity-components@1") {
      const extensions = component.value.extensions as Array<{ name: string; component: IdentityDeviceComponent }>
      for (const entry of extensions) await accept(entry.name, entry.component)
    } else await accept(name, component)
  }
  return normalize(manifest.personId, { personId: manifest.personId, envelopes: found })
}

async function identityWorkspaceRouteRecoveryComponent(value: WorkspaceRouteRecovery): Promise<IdentityDeviceComponent> {
  const checked = await normalize(value.personId, value)
  validateOptionalIdentityComponent(componentName, { schema, required: false, value: checked })
  const packed = packWorkspaceRoutes(checked, maxCatalogBytes, maxPackedCatalogBytes)
  return { schema: packedSchema, required: false, value: packed }
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

async function readIdentityWorkspaceRouteRecovery(personId: string): Promise<WorkspaceRouteRecovery> {
  return decode(personId, await readLocal(key(personId)))
}

/** Capture only credentials the current local device can actively use; the SDK owns membership semantics. */
async function captureWorkspaceRouteEnvelopes(store: PeerStore, workspaceIds: string[], profile: RouteIdentity,
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
      personId: profile.personId, publicKey: profile.publicKey, deviceId: profile.deviceId })
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
  return (await normalize(profile.personId, { personId: profile.personId, envelopes })).envelopes
}

async function captureIdentityWorkspaceRouteRecovery(store: PeerStore, workspaceIds: string[], profile: RouteIdentity): Promise<WorkspaceRouteRecovery> {
  const allowed = new Set(workspaceIds)
  const [saved, current] = await Promise.all([readIdentityWorkspaceRouteRecovery(profile.personId),
    captureWorkspaceRouteEnvelopes(store, workspaceIds, profile, { skipUnavailable: true })])
  return normalize(profile.personId, { personId: profile.personId,
    envelopes: [...saved.envelopes.filter(envelope => allowed.has(envelope.workspaceId)), ...current] })
}

function readIdentityWorkspaceRouteRecoveryComponent(manifest: WorkspaceRouteManifest): Promise<WorkspaceRouteRecovery> {
  return readComponent(manifest)
}

/** Pending envelopes remain data until DurableMesh revalidates them against active workspace authority. */
async function planIdentityWorkspaceRouteRecoveryImport(manifest: WorkspaceRouteManifest): Promise<LocalStatePlan> {
  const incoming = await readIdentityWorkspaceRouteRecoveryComponent(structuredClone(manifest))
  const raw = await readLocal(key(manifest.personId))
  const previous = await decode(manifest.personId, raw)
  const next = await normalize(manifest.personId, { personId: manifest.personId, envelopes: [...previous.envelopes, ...incoming.envelopes] })
  const value = JSON.stringify({ version: 1, ...next })
  return { conditions: [{ key: key(manifest.personId), value: raw }],
    writes: next.envelopes.length || raw !== null ? [{ key: key(manifest.personId), value }] : [] }
}

async function exportIdentityWorkspaceRouteRecovery(personId: string, workspaceIds?: string[]): Promise<Record<string, IdentityDeviceComponent>> {
  const saved = await readIdentityWorkspaceRouteRecovery(personId)
  const allowed = workspaceIds ? new Set(workspaceIds) : undefined
  const filtered = allowed ? await normalize(personId, { personId,
    envelopes: saved.envelopes.filter(envelope => allowed.has(envelope.workspaceId)) }) : saved
  return filtered.envelopes.length ? { [componentName]: await identityWorkspaceRouteRecoveryComponent(filtered) } : {}
}

const revisions = new WeakMap<WorkspaceRouteRecovery, Promise<string>>()

function routeRevision(routes: WorkspaceRouteRecovery): Promise<string> {
  let revision = revisions.get(routes)
  if (!revision) {
    revision = sha256Base64Url(new TextEncoder().encode(canonicalizeJson(routes)))
    revisions.set(routes, revision)
  }
  return revision
}

export async function processIdentityWorkspaceRoutes(request: RouteOperation, store = peerStore): Promise<RouteResult> {
  switch (request.kind) {
    case "warm": return null
    case "normalize": return normalize(request.value.personId, request.value)
    case "pack": return identityWorkspaceRouteRecoveryComponent(request.value)
    case "read": return readIdentityWorkspaceRouteRecovery(request.personId)
    case "component": return readIdentityWorkspaceRouteRecoveryComponent(request.manifest)
    case "import": return planIdentityWorkspaceRouteRecoveryImport(request.manifest)
    case "export": return exportIdentityWorkspaceRouteRecovery(request.personId, request.workspaceIds)
    case "capture":
      return captureIdentityWorkspaceRouteRecovery(store, request.workspaceIds, request.profile)
    case "revision":
      return routeRevision(await captureIdentityWorkspaceRouteRecovery(store, request.workspaceIds, request.profile))
    case "envelopes":
      return captureWorkspaceRouteEnvelopes(store, request.workspaceIds, request.profile, request.options)
  }
}
