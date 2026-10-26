import * as Automerge from "@automerge/automerge/slim"
import { WasmStateCore, type WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { captureEncryptedArchiveObject, type EncryptedArchiveObject } from "@meta-uber/mesh-replication/history-archive-crypto"
import { canonicalizeJson, fromBase64Url, sha256Base64Url, toBase64Url } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { StoredReceivedHistoryBaseline, StoredWorkspaceSnapshot } from "../storageJournal"
import { validateWorkspaceAuthority, validateWorkspaceCredential, type WorkspaceAuthorityRecord, type WorkspaceMeshCredential } from "./peerStore"
import type { HistoryRecoveryRecord } from "./historyRecoveryArchive"
import type { WorkspaceRecoveryJournal } from "./workspaceHistoryRecoveryDecode"
import { restoreWorkspaceRecoveryOriginals } from "./workspaceHistoryRecoveryOriginals"
import { computeWorkspaceAdmission, type IncomingAuthorizationBundle, type WorkspaceAdmissionResult,
  type WorkspaceWriteAuthorityEvidence } from "../product-replica"
import { parseWireHistoryBaseline, verifyReceivedWireHistoryBaseline } from "../product-replica"
import { reverifyStoredPeerHistoryBaseline, type StoredPeerHistoryProofs } from "./peerHistoryBaselineReceiver"
import type { ArchiveCoverageAuthority } from "@meta-uber/mesh-replication/history-archive-coverage"
import { recoverySnapshotHistoryBasis, verifyRecoveryHistoryLineage } from "./workspaceRecoveryHistoryBasis"

export type WorkspaceRecoveryCurrentAuthority = WorkspaceWriteAuthorityEvidence | WorkspaceAuthorityRecord | WorkspaceMeshCredential
export type WorkspaceHistoryRecoveryAdmissionInput = {
  workspaceId: string
  decoded: { journal: WorkspaceRecoveryJournal; auxiliary: Map<string, unknown> }
  records: HistoryRecoveryRecord[]
  currentAuthority: WorkspaceRecoveryCurrentAuthority | null
  trustedScopeAuthority?: unknown
  ensureCurrent: () => void
}
export type WorkspaceHistoryRecoveryAdmission = {
  journal: WorkspaceRecoveryJournal
  snapshot: StoredWorkspaceSnapshot
  admission: WorkspaceAdmissionResult
  authority: WorkspaceWriteAuthorityEvidence
  scopeAuthoritySnapshot?: unknown
}
type OwnerHistoryEntry = { personId: string; publicKey: string; certificates: unknown[] }
const encoder = new TextEncoder()
const maximumBytes = 512 * 1024 * 1024
const recoveryPolicy = WasmStateCore as unknown as {
  authorizationRecordPages(bundle: IncomingAuthorizationBundle): unknown[][]
  hasAuthorityConflict(value: unknown): boolean
  mergeScopeAuthoritySnapshots(current: unknown, incoming: unknown, now: number): unknown
  prepareWriteEvidence(input: { incoming: WorkspaceWriteAuthorityEvidence; known: WorkspaceWriteAuthorityEvidence | null;
    records: unknown[]; genesisPersonId: string; remoteOwnerPersonId: string }): WorkspaceWriteAuthorityEvidence
  validateScopeAuthority(value: unknown, now: number): { scopeId: string; creator: { personId: string; publicKey: string };
    controller: { personId: string; publicKey: string } }
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}
type NativeHistoryCandidate = {
  envelope(): { payload: { baselineId?: unknown } }
  document(): Uint8Array
  originalJson(): Uint8Array
  controlJson(): Uint8Array
  plaintextObjects(): Map<string, Uint8Array>
  encryptedObjects(): Map<string, EncryptedArchiveObject>
  free(): void
}
function nativeCandidate(value: WasmVerifiedReceivedHistoryBaseline): NativeHistoryCandidate {
  return value as unknown as NativeHistoryCandidate
}
function recoveredOwnerHistory(recovered: WorkspaceWriteAuthorityEvidence, current: WorkspaceAuthorityRecord | WorkspaceMeshCredential | null): OwnerHistoryEntry[] {
  const identities: OwnerHistoryEntry[] = [recovered.genesisOwner, recovered.currentOwner,
    ...(current ? [{ personId: current.ownerPersonId, publicKey: current.ownerPublicKey, certificates: current.ownerCertificates }, ...(current.ownerHistory ?? [])] : []),
    ...recovered.ownershipTransfers.map(value => ({ personId: value.payload.toOwnerPersonId, publicKey: value.payload.toOwnerPublicKey,
      certificates: value.payload.toOwnerCertificates })),
    ...recovered.successionClaims.map(value => ({ personId: value.payload.toOwnerPersonId, publicKey: value.payload.toOwnerPublicKey,
      certificates: value.payload.toOwnerCertificates }))]
  const owners = new Map<string, OwnerHistoryEntry>()
  for (const identity of identities) {
    if (!identity.personId || !identity.publicKey || !Array.isArray(identity.certificates)) throw new Error("Recovered authority identity is malformed")
    const key = canonicalizeJson([identity.personId, identity.publicKey]), previous = owners.get(key)
    const certificates = new Map<string, unknown>()
    for (const certificate of [...(previous?.certificates ?? []), ...identity.certificates]) certificates.set(canonicalizeJson(certificate), certificate)
    owners.set(key, { personId: identity.personId, publicKey: identity.publicKey,
      certificates: [...certificates].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, certificate]) => certificate) })
  }
  return [...owners.values()].filter(owner => owner.personId !== recovered.currentOwner.personId || owner.publicKey !== recovered.currentOwner.publicKey)
    .sort((left, right) => canonicalizeJson([left.personId, left.publicKey]).localeCompare(canonicalizeJson([right.personId, right.publicKey])))
}

function recoveredCatalog(authority: WorkspaceWriteAuthorityEvidence) {
  return { ownershipTransfers: authority.ownershipTransfers, successionClaims: authority.successionClaims,
    revocations: authority.revocations, deviceRevocations: authority.deviceRevocations.map(value => ({ record: value.record, authority: value.signer })),
    departures: authority.departures }
}
function encodedBytes(value: unknown, maximum: number): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(maximum * 4 / 3)) throw new Error("Recovery archive encoding exceeds its bound")
  const bytes = fromBase64Url(value)
  if (bytes.length > maximum || toBase64Url(bytes) !== value) throw new Error("Recovery archive encoding is not canonical")
  return bytes
}
function authorizationBundle(value: unknown): IncomingAuthorizationBundle {
  if (!record(value) || !(value.version === 1 && Array.isArray(value.records) ||
    value.version === 2 && Array.isArray(value.pages) && value.pages.every(Array.isArray)) || !record(value.authority)) {
    throw new Error("Recovery requires original signed workspace authorization evidence")
  }
  return value as IncomingAuthorizationBundle
}
function currentAuthorityCatalog(current: WorkspaceAuthorityRecord | WorkspaceMeshCredential, workspaceId: string) {
  if (current.workspaceId !== workspaceId || recoveryPolicy.hasAuthorityConflict(current)) {
    throw new Error("Current workspace authority is conflicting or belongs to another workspace")
  }
  const catalog = current.catalog as Partial<WorkspaceWriteAuthorityEvidence> & {
    breakGlassClaims?: unknown[]; deviceRevocations?: Array<{ record: unknown; signer: WorkspaceWriteAuthorityEvidence["currentOwner"] }>
  } | undefined
  if (catalog?.breakGlassClaims?.length) throw new Error("Unsupported recovery authority path")
  return catalog
}
function knownEvidence(current: WorkspaceRecoveryCurrentAuthority | null, incoming: WorkspaceWriteAuthorityEvidence,
  workspaceId: string): WorkspaceWriteAuthorityEvidence | null {
  if (!current) return null
  if ("genesisOwner" in current) return current
  const owners = [{ personId: current.ownerPersonId, publicKey: current.ownerPublicKey, certificates: current.ownerCertificates }, ...(current.ownerHistory ?? [])]
  const genesisId = currentGenesisId(current, incoming)
  const genesisOwner = owners.find(owner => owner.personId === genesisId)
  if (!genesisOwner) throw new Error("Current authority does not retain the original workspace genesis")
  const catalog = currentAuthorityCatalog(current, workspaceId)
  return { genesisOwner: genesisOwner as WorkspaceWriteAuthorityEvidence["genesisOwner"], genesisEpoch: 1,
    currentOwner: owners[0] as WorkspaceWriteAuthorityEvidence["currentOwner"], currentEpoch: current.epoch,
    ownershipTransfers: catalog?.ownershipTransfers ?? [], successionClaims: catalog?.successionClaims ?? [], revocations: catalog?.revocations ?? [],
    deviceRevocations: (catalog?.deviceRevocations ?? []).map(value => ({ record: value.record, signer: value.signer })),
    departures: catalog?.departures ?? [] }
}
function currentGenesisId(current: WorkspaceAuthorityRecord | WorkspaceMeshCredential, incoming: WorkspaceWriteAuthorityEvidence): string {
  return "genesisOwnerPersonId" in current && current.genesisOwnerPersonId || incoming.genesisOwner.personId
}
function scopeEvidence(control: Record<string, unknown>, current: WorkspaceRecoveryCurrentAuthority | null, supplied: unknown,
  workspaceId: string, genesis: WorkspaceWriteAuthorityEvidence["genesisOwner"]) {
  const backup = [control.authority, control.credential].filter(record).map(value => value.scopeAuthoritySnapshot).filter(Boolean)
  const currentScope = current && "scopeAuthoritySnapshot" in current ? current.scopeAuthoritySnapshot : undefined
  let merged: unknown = supplied ?? currentScope
  const snapshots: unknown[] = [...(merged ? [merged] : []), ...backup]
  for (const snapshot of snapshots) {
    const validated = recoveryPolicy.validateScopeAuthority(snapshot, 0)
    if (validated.scopeId !== workspaceId || validated.creator.personId !== genesis.personId || validated.creator.publicKey !== genesis.publicKey) {
      throw new Error("Recovery signed scope root differs from workspace genesis")
    }
    merged = recoveryPolicy.mergeScopeAuthoritySnapshots(merged ?? null, snapshot, 0)
  }
  if (currentScope && supplied) merged = recoveryPolicy.mergeScopeAuthoritySnapshots(currentScope, merged, 0)
  // Immutable signed genesis anchors historical verification. Current controls remain in merged evidence and are never rolled back.
  const anchor = record(merged) ? { genesis: merged.genesis, grants: [], grantIssuers: [], revocations: [], controlTransfers: [], successionTransfers: [] } : undefined
  return { merged, anchor }
}
function matchingBasisSources(input: WorkspaceHistoryRecoveryAdmissionInput, stored: StoredReceivedHistoryBaseline,
  wire: ReturnType<typeof parseWireHistoryBaseline>): Extract<HistoryRecoveryRecord, { kind: "archive-source" }>[] {
  const sources = input.records.filter((item): item is Extract<HistoryRecoveryRecord, { kind: "archive-source" }> =>
    item.kind === "archive-source" && item.workspaceId === input.workspaceId && item.scopeId === stored.scopeId &&
    item.keyEpoch === stored.keyEpoch && item.signedJson === wire.signedJson)
  if (!sources.length || sources.length > 256) throw new Error("Recovery compact basis has no matching encrypted archive source")
  return sources
}

async function matchingBasisObjects(input: WorkspaceHistoryRecoveryAdmissionInput, scopeId: string): Promise<Map<string, EncryptedArchiveObject>> {
  const objects = new Map<string, EncryptedArchiveObject>()
  let bytes = 0
  for (const item of input.records) {
    if (item.kind !== "encrypted-object" || item.scopeId !== scopeId) continue
    input.ensureCurrent()
    const object = captureEncryptedArchiveObject(item.object, scopeId), encoded = canonicalizeJson(object)
    if (await sha256Base64Url(encoder.encode(encoded)) !== item.ciphertextId) throw new Error("Recovery ciphertext differs from its original object ID")
    input.ensureCurrent()
    const previous = objects.get(item.ciphertextId)
    if (previous && canonicalizeJson(previous) !== encoded) throw new Error("Recovery archive contains incompatible ciphertext variants")
    if (!previous) { bytes += encoder.encode(encoded).length; objects.set(item.ciphertextId, object) }
    if (bytes > maximumBytes || objects.size > 1_048_576) throw new Error("Recovery archive ciphertext exceeds bounds")
  }
  return objects
}

async function verifyEncryptedBasisSource(source: Extract<HistoryRecoveryRecord, { kind: "archive-source" }>,
  input: WorkspaceHistoryRecoveryAdmissionInput, stored: StoredReceivedHistoryBaseline, wire: ReturnType<typeof parseWireHistoryBaseline>,
  pointerId: string, trustedScope: unknown, objects: Map<string, EncryptedArchiveObject>): Promise<WasmVerifiedReceivedHistoryBaseline> {
  const key = encodedBytes(source.key, 32)
  if (key.length !== 32) throw new Error("Invalid compact basis reading key")
  try {
    input.ensureCurrent()
    const candidate = await verifyReceivedWireHistoryBaseline({ wire,
      scope: { scopeId: stored.scopeId, keyEpoch: stored.keyEpoch, key },
      pinnedStorage: stored.pinnedStorage as ArchiveCoverageAuthority,
      trustedScopeAuthority: trustedScope, ensureCurrent: input.ensureCurrent,
      fetch: { ensureCurrent: input.ensureCurrent, download: async id => {
        input.ensureCurrent()
        const object = objects.get(id)
        if (!object) throw new Error("Exact backup archive ciphertext is missing")
        return structuredClone(object)
      } } })
    if (nativeCandidate(candidate).envelope().payload.baselineId !== pointerId ||
        !sameBytes(nativeCandidate(candidate).document(), stored.document)) {
      candidate.free()
      throw new Error("Recovery Native baseline differs from its saved source")
    }
    return candidate
  } finally { key.fill(0) }
}

async function verifyEncryptedBasisSources(sources: Extract<HistoryRecoveryRecord, { kind: "archive-source" }>[],
  input: WorkspaceHistoryRecoveryAdmissionInput, stored: StoredReceivedHistoryBaseline, wire: ReturnType<typeof parseWireHistoryBaseline>,
  pointerId: string, trustedScope: unknown, objects: Map<string, EncryptedArchiveObject>): Promise<WasmVerifiedReceivedHistoryBaseline> {
  let failure: unknown
  for (const source of sources) {
    try { return await verifyEncryptedBasisSource(source, input, stored, wire, pointerId, trustedScope, objects) }
    catch (error) { failure = error }
  }
  throw failure ?? new Error("Recovery compact basis could not be verified")
}
async function receiveBackupBasis(input: WorkspaceHistoryRecoveryAdmissionInput, snapshot: StoredWorkspaceSnapshot,
  trustedScope: unknown): Promise<WasmVerifiedReceivedHistoryBaseline | undefined> {
  const stored = recoverySnapshotHistoryBasis(input.decoded.journal, snapshot)
  if (!stored) return undefined
  if (!trustedScope) throw new Error("Recovery compact basis requires a signed scope authority")
  const candidate = await receiveBackupBasisRow(input, stored, trustedScope)
  try {
    await verifyRecoveryHistoryLineage(input.decoded.journal, input.workspaceId, candidate,
      row => receiveBackupBasisRow(input, row, trustedScope), input.ensureCurrent)
    return candidate
  } catch (error) { candidate.free(); throw error }
}

async function receiveBackupBasisRow(input: WorkspaceHistoryRecoveryAdmissionInput, stored: StoredReceivedHistoryBaseline,
  trustedScope: unknown): Promise<WasmVerifiedReceivedHistoryBaseline> {
  if (!stored.baselineId) throw new Error("Recovery compact baseline has no original identity")
  if ((stored as StoredReceivedHistoryBaseline & { peerProofs?: StoredPeerHistoryProofs }).peerProofs !== undefined) {
    const candidate = await reverifyStoredPeerHistoryBaseline({ stored, trustedScopeAuthority: trustedScope, ensureCurrent: input.ensureCurrent })
    const verified = nativeCandidate(candidate)
    if (verified.envelope().payload.baselineId !== stored.baselineId || !sameBytes(verified.document(), stored.document)) {
      candidate.free(); throw new Error("Recovery Native peer baseline differs from its saved source")
    }
    return candidate
  }
  const wire = parseWireHistoryBaseline(stored.wire)
  if (!sameBytes(encodedBytes(wire.signedJson, 256 * 1024), stored.signedJson)) throw new Error("Recovery basis signature differs from its original descriptor")
  const sources = matchingBasisSources(input, stored, wire)
  const objects = await matchingBasisObjects(input, stored.scopeId)
  return verifyEncryptedBasisSources(sources, input, stored, wire, stored.baselineId, trustedScope, objects)
}

/** Pure preflight. File encryption and saved admission flags never substitute for Native causal authorization. */
export async function admitWorkspaceHistoryRecovery(inputValue: WorkspaceHistoryRecoveryAdmissionInput): Promise<WorkspaceHistoryRecoveryAdmission> {
  const input = captureAdmissionInput(inputValue)
  const journal = input.decoded.journal
  const { original, raw, control, authorization } = recoveryInputs(input)
  const document = Automerge.load<WorkspaceDocumentV2>(raw)
  let basis: WasmVerifiedReceivedHistoryBaseline | undefined
  try {
    if (document.id !== input.workspaceId) throw new Error("Recovery raw workspace does not match its journal")
    const known = knownEvidence(input.currentAuthority, authorization.authority, input.workspaceId)
    assertCompatibleGenesis(known, authorization.authority)
    const scopes = scopeEvidence(control, input.currentAuthority, input.trustedScopeAuthority, input.workspaceId, authorization.authority.genesisOwner)
    basis = await receiveBackupBasis(input, original, scopes.anchor)
    input.ensureCurrent()
    const { authority, admission } = await computeRecoveryAdmission(input, authorization, known, basis, raw, document)
    input.ensureCurrent()
    const snapshot = createAdmittedSnapshot(input.workspaceId, original, raw, admission, basis)
    const receivedBaselines: WorkspaceRecoveryJournal["receivedBaselines"] = journal.receivedBaselines.map(row => {
      if (!record(row.value) || row.value.id !== row.id || row.value.workspaceId !== input.workspaceId ||
        !["staged", "active", "restored"].includes(String(row.value.state))) throw new Error("Recovered archival baseline row is malformed")
      return { id: row.id, value: { ...structuredClone(row.value), state: "restored" } }
    })
    if (basis) {
      const stored = recoverySnapshotHistoryBasis(journal, original)!
      const peer = (stored as StoredReceivedHistoryBaseline & { peerProofs?: StoredPeerHistoryProofs }).peerProofs !== undefined
      const native = nativeCandidate(basis)
      const row: StoredReceivedHistoryBaseline = { id: stored.id, stageId: stored.stageId, workspaceId: input.workspaceId, state: "active",
        signedJson: native.originalJson(), document: native.document(), controlJson: native.controlJson(),
        ...(peer ? { peerProofs: { version: 1 as const, objects: [...native.plaintextObjects()].map(([objectId, bytes]) => ({ objectId, bytes: bytes.slice() })) } } :
          { wire: parseWireHistoryBaseline(stored.wire) }),
        encryptedObjects: [...native.encryptedObjects()].map(([ciphertextId, object]) => ({ ciphertextId, object: structuredClone(object) })),
        scopeId: stored.scopeId, keyEpoch: stored.keyEpoch, pinnedStorage: structuredClone(stored.pinnedStorage), expectedSnapshot: null,
        baselineId: native.envelope().payload.baselineId as string, createdAt: stored.createdAt }
      const index = receivedBaselines.findIndex(value => value.id === row.id)
      if (index >= 0) receivedBaselines[index] = { id: row.id, value: row }
      else receivedBaselines.push({ id: row.id, value: row })
    }
    // Original changes/proofs/receipts remain lookup evidence, never admission flags. Delta integrity state is rebuilt locally.
    const retained = restoreWorkspaceRecoveryOriginals(journal, input.workspaceId,
      basis ? nativeCandidate(basis).envelope().payload.baselineId as string : null)
    const candidate: WorkspaceRecoveryJournal = { snapshots: [{ id: input.workspaceId, value: snapshot }],
      authorizations: [{ id: input.workspaceId, value: { id: input.workspaceId, workspaceId: input.workspaceId, records: structuredClone(admission.verifiedAuthorizations) } }],
      ...retained, frontiers: [], deltas: [], revisions: [], receivedBaselines }
    input.ensureCurrent()
    return { journal: candidate, snapshot, admission, authority, ...(scopes.merged ? { scopeAuthoritySnapshot: scopes.merged } : {}) }
  } finally { basis?.free(); Automerge.free(document) }
}

function captureAdmissionInput(value: WorkspaceHistoryRecoveryAdmissionInput): WorkspaceHistoryRecoveryAdmissionInput {
  if (!value.workspaceId || value.workspaceId.length > 256 || typeof value.ensureCurrent !== "function") throw new Error("Invalid recovery admission input")
  value.ensureCurrent()
  return { ...value, decoded: structuredClone(value.decoded), records: structuredClone(value.records),
    currentAuthority: structuredClone(value.currentAuthority), trustedScopeAuthority: structuredClone(value.trustedScopeAuthority) }
}
function recoveryInputs(input: WorkspaceHistoryRecoveryAdmissionInput) {
  const { journal } = input.decoded, snapshots = journal.snapshots
  if (!Array.isArray(input.records) || input.records.length > 2_097_664 || snapshots.length !== 1 || snapshots[0]!.id !== input.workspaceId) {
    throw new Error("Recovery requires exactly one workspace snapshot")
  }
  const original = snapshots[0]!.value as StoredWorkspaceSnapshot
  if (!record(original) || original.workspaceId !== input.workspaceId || original.id !== input.workspaceId || !(original.bytes instanceof Uint8Array) ||
      typeof original.savedAt !== "string" || !Number.isFinite(Date.parse(original.savedAt))) throw new Error("Recovery snapshot belongs to another workspace or has invalid metadata")
  const raw = input.decoded.auxiliary.get("workspace-source/raw"), control = input.decoded.auxiliary.get("workspace-control/access")
  if (!(raw instanceof Uint8Array) || !raw.length || raw.length > maximumBytes || !record(control)) throw new Error("Recovery requires original workspace source and signed control evidence")
  return { original, raw, control, authorization: authorizationBundle(control.authorization) }
}
function assertCompatibleGenesis(known: WorkspaceWriteAuthorityEvidence | null, incoming: WorkspaceWriteAuthorityEvidence): void {
  if (known && (incoming.genesisOwner.personId !== known.genesisOwner.personId || incoming.genesisOwner.publicKey !== known.genesisOwner.publicKey)) {
    throw new Error("Recovery signed workspace genesis conflicts with current authority")
  }
}
async function computeRecoveryAdmission(input: WorkspaceHistoryRecoveryAdmissionInput, authorization: IncomingAuthorizationBundle,
  known: WorkspaceWriteAuthorityEvidence | null, basis: WasmVerifiedReceivedHistoryBaseline | undefined, raw: Uint8Array,
  document: Automerge.Doc<WorkspaceDocumentV2>) {
  const records = recoveryPolicy.authorizationRecordPages(authorization).flat()
  const authority = recoveryPolicy.prepareWriteEvidence({ incoming: authorization.authority, known, records,
    genesisPersonId: basis ? authorization.authority.genesisOwner.personId : document.ownerPersonId,
    remoteOwnerPersonId: document.ownerPersonId }) as WorkspaceWriteAuthorityEvidence
  if (known && (authority.currentEpoch < known.currentEpoch || authority.genesisOwner.personId !== known.genesisOwner.personId ||
    authority.genesisOwner.publicKey !== known.genesisOwner.publicKey)) throw new Error("Recovery cannot replace current workspace authority with stale control")
  const admission = computeWorkspaceAdmission({ workspaceId: input.workspaceId, remote: raw,
    authorization: { ...authorization, authority }, knownAuthority: known, receivedBasis: basis, now: Date.now() }, WasmStateCore as never)
  input.ensureCurrent()
  return { authority, admission }
}
function createAdmittedSnapshot(workspaceId: string, original: StoredWorkspaceSnapshot, raw: Uint8Array,
  admission: WorkspaceAdmissionResult, basis: WasmVerifiedReceivedHistoryBaseline | undefined): StoredWorkspaceSnapshot {
  const authorizedDocument = new Uint8Array(admission.authorizedDocument as Uint8Array)
  const projected = Automerge.load<WorkspaceDocumentV2>(authorizedDocument)
  try {
    if (projected.id !== workspaceId || !admission.admittedHashes.length) throw new Error("Recovery has no admitted workspace genesis")
    return { id: workspaceId, workspaceId, title: String(projected.title ?? ""), heads: [...admission.authorizedHeads],
      bytes: authorizedDocument.slice(), archivedAt: projected.archivedAt, savedAt: original.savedAt,
      causalEvidence: { bytes: raw.slice(), decisions: structuredClone(admission.decisions), authorizationEvidence: structuredClone(admission.authorizationEvidence) },
      ...(basis ? { receivedHistory: { baselineId: nativeCandidate(basis).envelope().payload.baselineId as string, excludedLocalChangeHashes: [] } } : {}) }
  } finally { Automerge.free(projected) }
}

/** Project freshly admitted control without restoring stale owners or replacing current transport secrets. */
export function recoveryProjectionAccess(admitted: Pick<WorkspaceHistoryRecoveryAdmission, "authority" | "scopeAuthoritySnapshot"> & {
  snapshot: Pick<StoredWorkspaceSnapshot, "workspaceId" | "savedAt">
},
  currentAuthority: WorkspaceRecoveryCurrentAuthority | null,
  backupControl: { authority: WorkspaceAuthorityRecord | null; credential: WorkspaceMeshCredential | null },
  currentCredential?: WorkspaceMeshCredential | null): { authority: WorkspaceAuthorityRecord; credential: WorkspaceMeshCredential | null } {
  const recovered = structuredClone(admitted.authority), workspaceId = admitted.snapshot.workspaceId
  const { current, connection, base } = projectionSources(currentAuthority, backupControl, currentCredential)
  assertProjectionWorkspace(workspaceId, base, connection)
  const ownerHistory = recoveredOwnerHistory(recovered, current)
  const catalog = recoveredCatalog(recovered)
  const authority: WorkspaceAuthorityRecord = { version: 1, workspaceId, genesisOwnerPersonId: recovered.genesisOwner.personId,
    ownerPersonId: recovered.currentOwner.personId, ownerPublicKey: recovered.currentOwner.publicKey,
    ownerCertificates: structuredClone(recovered.currentOwner.certificates), ownerHistory, epoch: recovered.currentEpoch,
    updatedAt: base?.updatedAt ?? admitted.snapshot.savedAt, catalog,
    ...(base?.localGrant ? { localGrant: structuredClone(base.localGrant) } : {}),
    ...(admitted.scopeAuthoritySnapshot ? { scopeAuthoritySnapshot: structuredClone(admitted.scopeAuthoritySnapshot) as WorkspaceAuthorityRecord["scopeAuthoritySnapshot"] } : {}) }
  validateProjectedAuthority(authority)
  const credential: WorkspaceMeshCredential | null = connection ? { ...structuredClone(authority), transportSecret: connection.transportSecret } : null
  if (credential) validateWorkspaceCredential(credential)
  return { authority, credential }
}
function projectionSources(currentAuthority: WorkspaceRecoveryCurrentAuthority | null,
  backupControl: { authority: WorkspaceAuthorityRecord | null; credential: WorkspaceMeshCredential | null },
  currentCredential?: WorkspaceMeshCredential | null) {
  const current = currentAuthority && !("genesisOwner" in currentAuthority) ? structuredClone(currentAuthority) : null
  const backup = structuredClone(backupControl), connection = structuredClone(currentCredential ?? backup.credential)
  return { current, connection, base: current ?? backup.authority ?? connection }
}
function assertProjectionWorkspace(workspaceId: string, base: WorkspaceAuthorityRecord | WorkspaceMeshCredential | null,
  connection: WorkspaceMeshCredential | null): void {
  if (base && base.workspaceId !== workspaceId || connection && connection.workspaceId !== workspaceId) throw new Error("Recovery access projection targets another workspace")
}
function validateProjectedAuthority(authority: WorkspaceAuthorityRecord): void {
  validateWorkspaceAuthority(authority)
  if (recoveryPolicy.hasAuthorityConflict(authority)) throw new Error("Recovered access projection contains conflicting signed authority")
  const snapshot = authority.scopeAuthoritySnapshot
  if (!snapshot) return
  const scope = recoveryPolicy.validateScopeAuthority(snapshot, 0)
  if (scope.controller.personId !== authority.ownerPersonId || scope.controller.publicKey !== authority.ownerPublicKey) {
    throw new Error("Recovered signed scope does not retain the current Owner")
  }
}
