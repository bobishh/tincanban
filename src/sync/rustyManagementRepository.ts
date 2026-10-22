import { verifyDeviceCertificateChain } from "@meta-uber/mesh-identity"
import { canonicalizeJson, sha256Base64Url, verifyEnvelope, type SignedEnvelope } from "../domain/identity"
import type { DeviceCertificate, PublicIdentity } from "../domain/model"
import { compareAndSwapLocal, readLocal, updateLocal, type LocalStatePlan } from "../localDb"
import { withLocalStateWriteLock } from "../localStateLock"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { verifyRustyManagementCapability, verifyRustyManagementEvidence, type RustyManagementCapability } from "./rustyManagementCapability"
import { reconcileManagementConflict, type ManagementConflictResolver } from "./rustyManagementReconciliation"

export type ManagementBinding = { origin: string; servicePublicKey: string; resourceKind: "scope" | "board" | "person"; resourceId: string }
export type ManagementUpdateAuthorization = {
  kind: "rusty-management-policy-update"; version: 1; serviceId: string; origin: string; personId: string; deviceId: string;
  resourceKind: "scope" | "board" | "person"; resourceId: string; expectedRevision: number; operations: string[]; revokedDeviceIds: string[];
  requestId: string; issuedAt: number; expiresAt: number;
  personManagementRevision?: number; restoredDeviceIds?: string[];
}
export type ManagementUpdateRequest = { version: 1; identity: PublicIdentity; deviceId: string; certificates: DeviceCertificate[];
  managementCapability?: SignedEnvelope<RustyManagementCapability>; personManagementCapability?: SignedEnvelope<RustyManagementCapability>;
  authorization: SignedEnvelope<ManagementUpdateAuthorization> }
export type PortableManagementRecord = { binding: ManagementBinding; capability: SignedEnvelope<RustyManagementCapability> }
export type ManagementRecord = { binding: ManagementBinding; capability?: SignedEnvelope<RustyManagementCapability>; pending?: ManagementUpdateRequest }
type State = { version: 1; personId: string; records: ManagementRecord[]; resetOrigins?: string[] }
const encoder = new TextEncoder()
const stateKey = (owner: string) => `tincanban.rusty-management.v1.${owner}`
const same = (a: unknown, b: unknown) => canonicalizeJson(a) === canonicalizeJson(b)
const resourceKey = (binding: ManagementBinding) => canonicalizeJson([binding.origin, binding.resourceKind, binding.resourceId])
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)

function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid management record")
  const record = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new Error("Invalid management record fields")
  }
  return record
}

function bindingSnapshot(value: ManagementBinding): ManagementBinding {
  const binding = structuredClone(value)
  fields(binding, ["origin", "servicePublicKey", "resourceKind", "resourceId"])
  if (blindOrigin(binding.origin) !== binding.origin || !validId(binding.resourceId) ||
    !["scope", "board", "person"].includes(binding.resourceKind) || typeof binding.servicePublicKey !== "string" ||
    decodeBlindBytes(binding.servicePublicKey).length !== 32) throw new Error("Invalid management binding")
  return binding
}

function locate(state: State, binding: ManagementBinding): ManagementRecord | undefined {
  const selected = state.records.find(record => resourceKey(record.binding) === resourceKey(binding))
  if (selected && selected.binding.servicePublicKey !== binding.servicePublicKey) throw new Error("Rusty management service pin changed")
  return selected
}

async function verifiedState(raw: string | null, owner: string): Promise<State> {
  if (raw === null) return { version: 1, personId: owner, records: [] }
  if (encoder.encode(raw).length > 8 * 1024 * 1024) throw new Error("Management repository exceeds storage bound")
  const state = JSON.parse(raw) as State
  fields(state, ["version", "personId", "records"], ["resetOrigins"])
  if (state.version !== 1 || state.personId !== owner || !Array.isArray(state.records) || state.records.length > 256) throw new Error("Invalid management repository")
  validateResetOrigins(state.resetOrigins)
  const seen = new Set<string>()
  for (const record of state.records) {
    fields(record, ["binding"], ["capability", "pending"])
    record.binding = bindingSnapshot(record.binding)
    const key = resourceKey(record.binding)
    if (seen.has(key) || (!record.capability && !record.pending)) throw new Error("Invalid management record")
    seen.add(key)
    if (record.capability) await verifyRustyManagementEvidence(record.capability, record.binding, {
      personId: owner, resourceKind: record.binding.resourceKind, resourceId: record.binding.resourceId, minimumRevision: 0,
    })
    if (record.pending) await verifyManagementUpdateRequest(record.binding, owner, record.pending)
  }
  return state
}

function validateResetOrigins(origins: unknown): void {
  if (origins !== undefined && (!Array.isArray(origins) || origins.length > 128 ||
    origins.some((origin: unknown) => typeof origin !== "string" || blindOrigin(origin) !== origin) ||
    new Set(origins).size !== origins.length)) throw new Error("Invalid management reset origins")
}

function acceptsPeerCapability(state: State, value: PortableManagementRecord): boolean {
  return !state.resetOrigins?.includes(value.binding.origin) ||
    same(locate(state, value.binding)?.capability ?? null, value.capability)
}

/** Verify durable intent without requiring an unexpired request: completed retries may outlive the original deadline. */
async function verifyManagementUpdateRequest(binding: ManagementBinding, owner: string, value: ManagementUpdateRequest): Promise<void> {
  binding = bindingSnapshot(binding)
  const request = structuredClone(value)
  fields(request, ["version", "identity", "deviceId", "certificates", "authorization"], ["managementCapability", "personManagementCapability"])
  fields(request.authorization, ["payload", "signerKeyId", "signature"])
  const payload = request.authorization.payload
  fields(payload, ["kind", "version", "serviceId", "origin", "personId", "deviceId", "resourceKind", "resourceId",
    "expectedRevision", "operations", "revokedDeviceIds", "requestId", "issuedAt", "expiresAt"], ["personManagementRevision", "restoredDeviceIds"])
  validateIdentityEvidence(request, owner)
  if (!requestMatches(payload, binding, owner, request.deviceId) ||
    payload.serviceId !== await sha256Base64Url(decodeBlindBytes(binding.servicePublicKey))) throw new Error("Invalid management request binding")
  validatePolicy(payload)
  validateRestorationIntent(payload)
  if (!Number.isSafeInteger(payload.issuedAt) || payload.issuedAt < 0 || !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > 120_000) throw new Error("Invalid management request timing")
  const publicKey = await verifyDeviceCertificateChain(request.identity, request.deviceId, request.certificates, "MATCH/1")
  if (!await verifyEnvelope(request.authorization, publicKey)) throw new Error("Management request signature invalid")
  if (payload.expectedRevision === 0) {
    await verifyCreationEvidence(binding, owner, request)
  } else {
    if (request.personManagementCapability || payload.personManagementRevision !== undefined) throw new Error("Person creation evidence cannot replace existing resource authority")
    const cap = await verifyRustyManagementCapability(request.managementCapability, binding, { personId: owner, deviceId: request.deviceId,
      resourceKind: binding.resourceKind, resourceId: binding.resourceId, operation: "management.update", minimumRevision: payload.expectedRevision })
    if (cap.revision !== payload.expectedRevision || cap.revokedDeviceIds.some(id =>
      !payload.revokedDeviceIds.includes(id) && !payload.restoredDeviceIds?.includes(id))) {
      throw new Error("Management request revision or revocation conflict")
    }
  }
}

function validateRestorationIntent(payload: ManagementUpdateAuthorization): void {
  if (payload.restoredDeviceIds && (!Array.isArray(payload.restoredDeviceIds) || payload.restoredDeviceIds.length > 512 ||
    payload.restoredDeviceIds.some(id => !validId(id) || payload.revokedDeviceIds.includes(id)) ||
    new Set(payload.restoredDeviceIds).size !== payload.restoredDeviceIds.length)) throw new Error("Invalid device restoration intent")
}

async function verifyCreationEvidence(binding: ManagementBinding, owner: string, request: ManagementUpdateRequest) {
  if (request.managementCapability) throw new Error("Unexpected bootstrap management capability")
  if (!request.personManagementCapability) {
    if (request.authorization.payload.personManagementRevision !== undefined) throw new Error("Person creation capability is missing")
    return
  }
  if (binding.resourceKind === "person") throw new Error("Person policy cannot bootstrap itself from person evidence")
  const parent = await verifyRustyManagementCapability(request.personManagementCapability, binding, { personId: owner, deviceId: request.deviceId,
    resourceKind: "person", resourceId: owner, operation: "resource.create", minimumRevision: 1 })
  if (request.authorization.payload.personManagementRevision !== parent.revision) throw new Error("Person creation revision is not signed by this request")
}

function assertPreparedParentAuthority(state: State, binding: ManagementBinding, owner: string, request: ManagementUpdateRequest) {
  if (!request.personManagementCapability) return
  const parent = locate(state, { ...binding, resourceKind: "person", resourceId: owner })
  if (parent?.pending || !same(parent?.capability ?? null, request.personManagementCapability)) {
    throw new Error("Person creation authority changed before preparation")
  }
}

function validateIdentityEvidence(request: ManagementUpdateRequest, owner: string): void {
  fields(request.identity, ["personId", "publicKey", "displayName"])
  if (request.version !== 1 || request.identity?.personId !== owner || !validId(request.deviceId) ||
    request.authorization.signerKeyId !== request.deviceId || !Array.isArray(request.certificates) || request.certificates.length > 32 ||
    request.certificates.some(certificate => certificate.payload?.personId !== owner)) throw new Error("Invalid management identity evidence")
  if (typeof request.identity.displayName !== "string" || request.identity.displayName.length > 4096) throw new Error("Invalid management identity evidence")
  for (const certificate of request.certificates) {
    fields(certificate, ["payload", "signerKeyId", "signature"])
    fields(certificate.payload, ["kind", "version", "personId", "deviceId", "devicePublicKey", "issuerCertificateHash", "canEnrollDevices"])
  }
}

function requestMatches(payload: ManagementUpdateAuthorization, binding: ManagementBinding, owner: string, device: string): boolean {
  return payload.kind === "rusty-management-policy-update" && payload.version === 1 && payload.personId === owner &&
    payload.deviceId === device && payload.origin === binding.origin && payload.resourceKind === binding.resourceKind &&
    payload.resourceId === binding.resourceId && validId(payload.requestId) && Number.isSafeInteger(payload.expectedRevision) &&
    payload.expectedRevision >= 0 && payload.expectedRevision < Number.MAX_SAFE_INTEGER
}

export function validatePolicy(payload: Pick<ManagementUpdateAuthorization, "resourceKind" | "operations" | "revokedDeviceIds">): void {
  const allowed = payload.resourceKind === "person" ? ["management.update", "resource.create"] : payload.resourceKind === "scope" ? ["management.update", "scope.policy", "snapshot.checkpoint"] :
    ["management.update", "publication.status", "publication.publish", "publication.update", "publication.unpublish", "publication.stage-file"]
  const ordered = (values: string[], maximum: number) => Array.isArray(values) && values.length <= maximum &&
    values.every((value, index) => typeof value === "string" && (index === 0 || values[index - 1] < value))
  if (!ordered(payload.operations, allowed.length) || !payload.operations.includes("management.update") ||
    payload.operations.some(value => !allowed.includes(value)) || !ordered(payload.revokedDeviceIds, 4096) ||
    payload.revokedDeviceIds.some(id => !validId(id))) throw new Error("Invalid management policy rights")
}

/** One atomic record owns verified authority and local pending requests. Portable exports contain only signed capabilities. */
export class RustyManagementRepository {
  constructor(private readonly owner: string) { if (!validId(owner)) throw new Error("Invalid management repository owner") }

  /** Explicit local reset: old signatures remain valid after a server erases its policy revisions. */
  async planForgetOrigin(origin: string): Promise<LocalStatePlan> {
    origin = blindOrigin(origin)
    const key = stateKey(this.owner), raw = await readLocal(key)
    const state = await verifiedState(raw, this.owner)
    state.records = state.records.filter(record => record.binding.origin !== origin)
    state.resetOrigins = [...new Set([...(state.resetOrigins ?? []), origin])].sort()
    if (state.resetOrigins.length > 128) throw new Error("Too many management reset origins")
    return { conditions: [{ key, value: raw }], writes: [{ key, value: canonicalizeJson(state) }] }
  }

  async read(binding: ManagementBinding): Promise<ManagementRecord | undefined> {
    binding = bindingSnapshot(binding)
    return structuredClone(locate(await verifiedState(await readLocal(stateKey(this.owner)), this.owner), binding))
  }

  async export(): Promise<PortableManagementRecord[]> {
    const state = await verifiedState(await readLocal(stateKey(this.owner)), this.owner)
    return state.records.flatMap(record => record.capability ? [{ binding: record.binding, capability: record.capability }] : [])
      .sort((a, b) => resourceKey(a.binding).localeCompare(resourceKey(b.binding)))
  }

  async prepare(binding: ManagementBinding, request: ManagementUpdateRequest): Promise<void> {
    binding = bindingSnapshot(binding)
    request = structuredClone(request)
    await verifyManagementUpdateRequest(binding, this.owner, request)
    await this.mutate(state => {
      const record = locate(state, binding)
      if (record?.pending) {
        if (!same(record.pending, request)) throw new Error("An unresolved management request is pending")
        return
      }
      if ((record?.capability?.payload.revision ?? 0) !== request.authorization.payload.expectedRevision ||
        !same(record?.capability ?? null, request.managementCapability ?? null)) throw new Error("Management authority changed before preparation")
      assertPreparedParentAuthority(state, binding, this.owner, request)
      if (request.authorization.payload.expiresAt <= Date.now() || request.authorization.payload.issuedAt > Date.now() + 30_000) {
        throw new Error("Management request expired before preparation")
      }
      if (record) record.pending = request
      else state.records.push({ binding, pending: request })
    })
  }

  async observe(binding: ManagementBinding, capability: SignedEnvelope<RustyManagementCapability>): Promise<void> {
    binding = bindingSnapshot(binding)
    capability = structuredClone(capability)
    const incoming = await verifyRustyManagementEvidence(capability, binding, { personId: this.owner,
      resourceKind: binding.resourceKind, resourceId: binding.resourceId, minimumRevision: 0 })
    await this.mutate(state => mergeCapability(state, binding, capability, incoming, false))
  }

  /** Build an atomic import plan; local state changes only when the caller commits it. */
  async planImport(values: PortableManagementRecord[], resolveConflict?: ManagementConflictResolver): Promise<LocalStatePlan> {
    values = structuredClone(values)
    if (!Array.isArray(values) || values.length > 256) throw new Error("Invalid management capability bundle")
    const verified: { binding: ManagementBinding; capability: SignedEnvelope<RustyManagementCapability>; incoming: RustyManagementCapability }[] = []
    const seen = new Set<string>()
    for (const value of values) {
      fields(value, ["binding", "capability"])
      const binding = bindingSnapshot(value.binding)
      if (seen.has(resourceKey(binding))) throw new Error("Duplicate management capability resource")
      seen.add(resourceKey(binding))
      const incoming = await verifyRustyManagementEvidence(value.capability, binding, { personId: this.owner,
        resourceKind: binding.resourceKind, resourceId: binding.resourceId, minimumRevision: 0 })
      verified.push({ binding, capability: value.capability, incoming })
    }
    const key = stateKey(this.owner)
    const raw = await readLocal(key)
    const state = await verifiedState(raw, this.owner)
    const reconciledOrigins = new Set<string>()
    for (const value of verified) {
      // A reset origin requires direct server evidence on this device, even for a higher old revision.
      if (!acceptsPeerCapability(state, value)) continue
      if (await reconcileImportConflict(state, this.owner, value, resolveConflict)) reconciledOrigins.add(value.binding.origin)
      else await mergeCapability(state, value.binding, value.capability, value.incoming, true)
    }
    if (reconciledOrigins.size) state.resetOrigins = [...new Set([...(state.resetOrigins ?? []), ...reconciledOrigins])].sort()
    validateResetOrigins(state.resetOrigins)
    if (state.records.length > 256) throw new Error("Management repository exceeds storage bound")
    const next = canonicalizeJson(state)
    if (encoder.encode(next).length > 8 * 1024 * 1024) throw new Error("Management repository exceeds storage bound")
    const unchanged = next === raw || (raw === null && state.records.length === 0)
    return { conditions: [{ key, value: raw }], writes: unchanged ? [] : [{ key, value: next }] }
  }

  /** Merge authenticated same-person portable evidence atomically; stale peers cannot roll back fresher local authority. */
  async import(values: PortableManagementRecord[]): Promise<void> {
    const snapshot = structuredClone(values)
    const key = stateKey(this.owner)
    await withLocalStateWriteLock(key, async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const plan = await this.planImport(snapshot)
        if (plan.writes.length === 0 || await compareAndSwapLocal(plan)) return
      }
      throw new Error("Management repository changed repeatedly; retry required")
    })
  }

  private async mutate(change: (state: State) => void | Promise<void>): Promise<void> {
    const key = stateKey(this.owner)
    await withLocalStateWriteLock(key, async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const raw = await readLocal(key)
        const state = await verifiedState(raw, this.owner)
        await change(state)
        const next = canonicalizeJson(state)
        if (state.records.length > 256 || encoder.encode(next).length > 8 * 1024 * 1024) throw new Error("Management repository exceeds storage bound")
        if (next === raw) return
        let committed = false
        await updateLocal(key, current => {
          if (current !== raw) return current ?? canonicalizeJson({ version: 1, personId: this.owner, records: [] })
          committed = true
          return next
        })
        if (committed) return
      }
      throw new Error("Management repository changed repeatedly; retry required")
    })
  }
}

async function reconcileImportConflict(state: State, owner: string, incoming: PortableManagementRecord,
  resolve?: ManagementConflictResolver): Promise<boolean> {
  const record = locate(state, incoming.binding)
  if (!resolve || !record?.capability || record.capability.payload.revision !== incoming.capability.payload.revision ||
      same(record.capability, incoming.capability)) return false
  record.capability = await reconcileManagementConflict(owner, record.capability, incoming, resolve)
  await reconcilePending(record, record.capability.payload)
  return true
}

async function mergeCapability(state: State, binding: ManagementBinding, capability: SignedEnvelope<RustyManagementCapability>,
  incoming: RustyManagementCapability, allowStalePeer: boolean): Promise<void> {
  const record = locate(state, binding)
  const previous = record?.capability?.payload
  if (previous) {
    if (incoming.revision < previous.revision) {
      if (allowStalePeer) return
      throw new Error("Management authority rollback")
    }
    if (incoming.revision === previous.revision && !same(record?.capability, capability)) throw new Error("Management policy revision conflict")
    if (previous.revokedDeviceIds.some(id => !incoming.revokedDeviceIds.includes(id) &&
        !incoming.restoredDeviceIds?.includes(id))) throw new Error("Management revocation rollback")
  }
  if (!record) { state.records.push({ binding, capability }); return }
  record.capability = capability
  await reconcilePending(record, incoming)
}

async function reconcilePending(record: ManagementRecord, incoming: RustyManagementCapability): Promise<void> {
  const pending = record.pending?.authorization
  if (!pending || incoming.requestId !== pending.payload.requestId ||
    incoming.authorizationHash !== await sha256Base64Url(encoder.encode(canonicalizeJson(pending)))) return
  if (incoming.revision !== pending.payload.expectedRevision + 1 || !same(incoming.operations, pending.payload.operations) ||
    !same(incoming.revokedDeviceIds, pending.payload.revokedDeviceIds)) throw new Error("Management confirmation does not cover pending intent")
  delete record.pending
}
