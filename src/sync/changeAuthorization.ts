import * as Automerge from "@automerge/automerge/slim"
import { canonicalizeJson, publicKeyId, sha256Base64Url, signEnvelope, type LocalProfile } from "../domain/identity"
import type { WorkspaceDocumentV2, WorkspaceGrant, DeviceCertificate } from "../domain/model"
import { defaultProofStore } from "../domain/proofs"
import { peerStore, type WorkspaceAuthorityRecord, type WorkspaceMeshCredential } from "./peerStore"
import { type WorkspaceAuthority, type WorkspaceDeviceRevocation, type WorkspaceOwnershipTransfer,
  type WorkspaceSuccessionClaim } from "./meshRecords"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { mergeAuthorizationRecords, putRecords, records, type WorkspaceChangeAuthorization } from "./workspaceChangeProofStore"
import { rememberWorkspaceAdmission, reusedWorkspaceAdmission } from "./workspaceAdmissionReuse"
import type { IncomingAuthorizationBundle, WorkspaceAdmissionResult, WorkspaceWriteAuthorityEvidence } from "./workspaceAdmissionCore"
import { readWorkspaceSnapshot } from "../storageJournal"
import { meshTrace } from "./meshTrace"
import { admissionInputHash, createAdmissionCheckpoint, matchesAdmissionCheckpoint, type WorkspaceAdmissionCheckpoint } from "./workspaceAdmissionCheckpoint"
import type { StoredCausalEvidence } from "../storageJournal"

import type { WorkspaceRole } from "../domain/permissions"
import { canonicalAuthorityJson, normalizeCertificateSets } from "./authorityFingerprint"
export class WorkspaceChangeRejected extends Error {
  constructor(message: string) { super(message); this.name = "WorkspaceChangeRejected" }
}

type StoredWorkspaceAuthority = WorkspaceMeshCredential | WorkspaceAuthorityRecord

async function storedWorkspaceAuthority(workspaceId: string): Promise<{ authority: StoredWorkspaceAuthority | null; invalid: boolean }> {
  try {
    // Active transport credentials are replaceable connection state. Durable
    // authority records are the authorization source of truth, including
    // historical owner keys needed to validate an older legitimate grant.
    const authority = await peerStore.getWorkspaceAuthority(workspaceId)
    if (authority) return validateStoredAuthority(authority)
    return validateStoredAuthority(await peerStore.getWorkspaceCredential(workspaceId))
  } catch {
    return { authority: null, invalid: typeof indexedDB !== "undefined" }
  }
}

/** Invalid durable authority is a read-only state, not permission to replay raw history. */
export async function workspaceAuthorityIsInvalid(workspaceId: string): Promise<boolean> {
  return (await storedWorkspaceAuthority(workspaceId)).invalid
}

async function validateStoredAuthority(authority: StoredWorkspaceAuthority | null): Promise<{ authority: StoredWorkspaceAuthority | null; invalid: boolean }> {
  if (!authority) return { authority: null, invalid: false }
  // Never treat historical keys as a repair path for a malformed current
  // authority. That would let a locally forged owner record retain editor
  // privileges through an older, valid owner grant.
  try {
    if (await publicKeyId(authority.ownerPublicKey) !== authority.ownerPersonId)
      return { authority: null, invalid: true }
    const scope = (authority as StoredWorkspaceAuthority & { scopeAuthoritySnapshot?: unknown }).scopeAuthoritySnapshot
    if (scope) {
      const validated = meshRustRuntime().state.validateScopeAuthority(scope, Date.now()) as {
        scopeId: string; controller: { personId: string; publicKey: string }
      }
      if (validated.scopeId !== authority.workspaceId || validated.controller.personId !== authority.ownerPersonId ||
        validated.controller.publicKey !== authority.ownerPublicKey) return { authority: null, invalid: true }
    }
  } catch {
    return { authority: null, invalid: true }
  }
  return { authority, invalid: false }
}

function uniqueCertificates(profile: LocalProfile, certificates: DeviceCertificate[]) {
  const values = [profile.certificate, ...certificates].filter(certificate =>
    certificate?.payload?.personId === profile.identity.personId)
  return [...new Map(values.map(certificate => [certificate.signature, certificate])).values()].sort((a, b) => a.signature.localeCompare(b.signature))
}

export async function recordGenesisAuthority(doc: Automerge.Doc<WorkspaceDocumentV2>, profile: LocalProfile): Promise<Authorization[]> {
  const creator = { personId: profile.identity.personId, publicKey: profile.identity.publicKey,
    certificates: [profile.certificate] }
  const payload = meshRustRuntime().state.planScopeGenesis({ scopeId: doc.id,
    documentOwnerPersonId: doc.ownerPersonId, creator }) as {
    kind: "scope-genesis"; version: 1; scopeId: string; creator: typeof creator; controlEpoch: 1
  }
  if (typeof indexedDB === "undefined") {
    // CLI/unit hosts still need the exact genesis changes signed into their
    // local journal; skipping proofs would make causal replay erase the seed
    // workspace when it builds the first authorized projection.
    const hashes = Automerge.getChangesMetaSince(doc, []).map(change => change.hash)
    return hashes.length ? authorizeLocalChanges(doc, profile, hashes) : []
  }
  const genesis = await signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId)
  const scopeAuthoritySnapshot = { genesis, grants: [], grantIssuers: [], revocations: [], controlTransfers: [] }
  const validated = meshRustRuntime().state.validateScopeAuthority(scopeAuthoritySnapshot, Date.now()) as {
    scopeId: string; controller: { personId: string }
  }
  if (validated.scopeId !== doc.id || validated.controller.personId !== profile.identity.personId)
    throw new Error("Invalid workspace genesis authority")
  const authority: WorkspaceAuthorityRecord & { scopeAuthoritySnapshot: typeof scopeAuthoritySnapshot } = {
    version: 1, workspaceId: doc.id, genesisOwnerPersonId: profile.identity.personId,
    ownerPersonId: profile.identity.personId, ownerPublicKey: profile.identity.publicKey,
    ownerCertificates: [profile.certificate], epoch: 1,
    updatedAt: new Date().toISOString(), catalog: {}, scopeAuthoritySnapshot,
  }
  await peerStore.putWorkspaceAuthority(authority)
  const hashes = Automerge.getChangesMetaSince(doc, []).map(change => change.hash)
  return hashes.length ? authorizeLocalChanges(doc, profile, hashes) : []
}

type Authorization = WorkspaceChangeAuthorization

export async function workspaceRole(doc: WorkspaceDocumentV2, profile: LocalProfile): Promise<WorkspaceRole> {
  const stored = await storedWorkspaceAuthority(doc.id)
  if (stored.invalid) {
    traceWorkspaceAccess(doc, profile, stored.authority, "visitor", "invalid")
    return "visitor"
  }
  const authority = stored.authority
  const genesisOwner = authorities(authority).find(owner => owner.personId === doc.ownerPersonId)
  if (!authority && typeof indexedDB === "undefined" && doc.ownerPersonId === profile.identity.personId) {
    const root = { personId: profile.identity.personId, publicKey: profile.identity.publicKey,
      certificates: [profile.certificate] }
    return decideWorkspaceRole(doc, profile, {
      version: 1, workspaceId: doc.id, genesisOwnerPersonId: root.personId,
      ownerPersonId: root.personId, ownerPublicKey: root.publicKey,
      ownerCertificates: root.certificates, ownerHistory: [], epoch: 1,
      updatedAt: new Date().toISOString(), catalog: {},
    }, root)
  }
  if (!authority || !genesisOwner) {
    traceWorkspaceAccess(doc, profile, authority, "visitor", "missing")
    return "visitor"
  }
  try {
    const role = await decideWorkspaceRole(doc, profile, authority, genesisOwner)
    traceWorkspaceAccess(doc, profile, authority, role, "valid")
    return role
  } catch (error) {
    traceWorkspaceAccess(doc, profile, authority, "unavailable", "error", error)
    throw error
  }
}

/** Diagnostics are uncommon; keep their classifier and payload out of startup JS. */
function traceWorkspaceAccess(doc: WorkspaceDocumentV2, profile: LocalProfile, authority: StoredWorkspaceAuthority | null,
  role: WorkspaceRole | "unavailable", validation: "valid" | "invalid" | "missing" | "error", error?: unknown) {
  if (typeof window === "undefined" || !window.location.search.includes("syncTrace=1")) return
  void import("./workspaceAccessTrace").then(({ traceWorkspaceAccessSnapshot }) =>
    traceWorkspaceAccessSnapshot(doc, profile, authority, role, validation, error)).catch(() => {})
}

/** Immutable grant identity embedded in each newly authored editor change. */
export async function localChangeAuthorityGrantHash(workspaceId: string, personId: string, allowVisitorProfile = false): Promise<string | undefined> {
  if (typeof indexedDB === "undefined") return undefined
  const stored = await storedWorkspaceAuthority(workspaceId)
  const authority = stored.authority
  if (stored.invalid) throw new Error("Workspace authority is unavailable")
  if (!authority) throw new Error("Workspace authority is unavailable")
  if (authority.ownerPersonId === personId) return undefined
  const grant = authority.localGrant as WorkspaceGrant | undefined
  if (!grant || grant.payload.workspaceId !== workspaceId || grant.payload.personId !== personId ||
    (grant.payload.role !== "editor" && !(allowVisitorProfile && grant.payload.role === "visitor"))) {
    throw new Error(allowVisitorProfile ? "Workspace profile grant is unavailable" : "Workspace editor grant is unavailable")
  }
  return sha256Base64Url(new TextEncoder().encode(canonicalizeJson(grant)))
}

async function decideWorkspaceRole(doc: WorkspaceDocumentV2, profile: LocalProfile, authority: StoredWorkspaceAuthority,
  genesisOwner: WorkspaceAuthority): Promise<WorkspaceRole> {
  const catalog = authority.catalog as {
    ownershipTransfers?: WorkspaceOwnershipTransfer[]
    successionClaims?: WorkspaceSuccessionClaim[]
    revocations?: unknown[]
    deviceRevocations?: WorkspaceDeviceRevocation[]
    departures?: Array<{ record: unknown; authority: WorkspaceAuthority }>
  } | undefined
  const localCertificates = uniqueCertificates(profile, await defaultProofStore.listCertificates().catch(() => []))
  const role = await (await import("./workspaceAccess")).decideAccess(doc as Automerge.Doc<WorkspaceDocumentV2>, {
    snapshot: {
      workspaceId: doc.id, genesisOwner, genesisEpoch: 1,
      expectedCurrentOwner: { personId: authority.ownerPersonId, publicKey: authority.ownerPublicKey,
        certificates: authority.ownerCertificates as DeviceCertificate[] },
      ownershipTransfers: catalog?.ownershipTransfers ?? [], successionClaims: catalog?.successionClaims ?? [],
      revocations: catalog?.revocations ?? [],
      deviceRevocations: (catalog?.deviceRevocations ?? []).map(value => ({ record: value.record, signer: value.authority })),
      departures: catalog?.departures ?? [],
    },
    identity: { personId: profile.identity.personId, publicKey: profile.identity.publicKey,
      certificates: localCertificates },
    deviceId: profile.device.deviceId,
    grant: authority.localGrant as WorkspaceGrant | undefined,
    departures: catalog?.departures ?? [],
    legacyAuthorityEvidence: (catalog as { breakGlassClaims?: unknown[] } | undefined)?.breakGlassClaims ?? [],
  })
  await assertCurrentAccessAuthority(doc.id, authority)
  return role
}

async function assertCurrentAccessAuthority(workspaceId: string, authority: StoredWorkspaceAuthority) {
  if (typeof indexedDB === "undefined") return
  if (authorityValidationFingerprint((await storedWorkspaceAuthority(workspaceId)).authority) !== authorityValidationFingerprint(authority))
    throw new Error("Workspace authority changed during access validation. Retry.")
}

export async function effectiveWorkspaceOwner(workspaceId: string, genesisOwnerPersonId: string) {
  if (typeof indexedDB === "undefined") return genesisOwnerPersonId
  return (await storedWorkspaceAuthority(workspaceId)).authority?.ownerPersonId ?? genesisOwnerPersonId
}

export async function workspaceWritesBlocked(workspaceId: string) {
  if (typeof indexedDB === "undefined") return false
  const stored = await storedWorkspaceAuthority(workspaceId)
  if (stored.invalid) throw new Error("Workspace authority could not be verified")
  return Boolean(stored.authority && meshRustRuntime().state.hasAuthorityConflict(stored.authority))
}

function authorities(credential: StoredWorkspaceAuthority | null) {
  if (!credential) return []
  return [{ personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey,
    certificates: credential.ownerCertificates as DeviceCertificate[] },
  ...((credential.ownerHistory ?? []) as WorkspaceAuthority[])]
}

export async function prepareLocalChangeAuthorizations(doc: Automerge.Doc<WorkspaceDocumentV2>, profile: LocalProfile, hashes: string[]) {
  const credential = typeof indexedDB === "undefined" ? undefined : (await storedWorkspaceAuthority(doc.id)).authority
  if (typeof indexedDB !== "undefined" && !credential) throw new Error("Workspace authority is unavailable. Import this board as a new board.")
  const ownerPersonId = credential?.ownerPersonId ?? doc.ownerPersonId
  const certificates = (await defaultProofStore.listCertificates()).filter(cert => cert.payload.personId === profile.identity.personId)
  if (!certificates.some(cert => cert.payload.deviceId === profile.device.deviceId)) certificates.push(profile.certificate)
  const signed = await signEnvelope(profile.privateKeys.devicePrivateKey, {
    kind: "workspace-changes" as const, version: 1 as const, workspaceId: doc.id, hashes,
    personId: profile.identity.personId, deviceId: profile.device.deviceId,
  }, profile.device.deviceId)
  return [{ signed, publicKey: profile.identity.publicKey, certificates,
    ...(profile.identity.personId !== ownerPersonId ? { grant: credential?.localGrant as WorkspaceGrant } : {}),
    ownerPublicKey: credential?.ownerPublicKey ?? profile.identity.publicKey,
    ownerCertificates: credential?.ownerCertificates as DeviceCertificate[] ?? certificates,
  }] satisfies Authorization[]
}

export async function authorizeLocalChanges(doc: Automerge.Doc<WorkspaceDocumentV2>, profile: LocalProfile, hashes: string[]) {
  const authorizations = await prepareLocalChangeAuthorizations(doc, profile, hashes)
  await putRecords(doc.id, authorizations)
  return authorizations
}
export async function exportAuthorizations(bytes: Uint8Array) {
  const doc = Automerge.load<WorkspaceDocumentV2>(bytes)
  try { return await records(doc.id) }
  finally { Automerge.free(doc) }
}

/**
 * Carries signed write proofs with the authority evidence Rust needs to admit
 * them. The receiver verifies this evidence before it uses any of it and does
 * not store it as a side effect of validation.
 */
export async function exportAuthorizationBundle(bytes: Uint8Array, knownProfile?: LocalProfile): Promise<Extract<IncomingAuthorizationBundle, { version: 1 }>> {
  const doc = Automerge.load<WorkspaceDocumentV2>(bytes)
  try { return await exportDocumentAuthorizationBundle(doc, knownProfile) }
  finally { Automerge.free(doc) }
}

export async function exportDocumentAuthorizationBundle(doc: Automerge.Doc<WorkspaceDocumentV2>, knownProfile?: LocalProfile): Promise<Extract<IncomingAuthorizationBundle, { version: 1 }>> {
  const { authority: evidence } = await localWorkspaceAdmissionAuthority(doc, knownProfile)
  const snapshot = await readWorkspaceSnapshot(doc.id)
  const rawEvidence = (snapshot?.causalEvidence?.authorizationEvidence ?? []) as Authorization[]
  return { version: 1, records: mergeAuthorizationRecords(await records(doc.id), rawEvidence), authority: evidence }
}

/** Current authority only; ordinary local commands never export historical proofs. */
export async function localWorkspaceAdmissionAuthority(doc: Pick<WorkspaceDocumentV2, "id" | "ownerPersonId">, knownProfile?: LocalProfile) {
  const stored = await storedWorkspaceAuthority(doc.id)
  if (stored.invalid) throw new Error("Workspace authority could not be verified")
  let authority = stored.authority
  if (!authority && typeof indexedDB === "undefined" && knownProfile?.identity.personId === doc.ownerPersonId) {
    authority = {
      version: 1, workspaceId: doc.id, genesisOwnerPersonId: knownProfile.identity.personId,
      ownerPersonId: knownProfile.identity.personId, ownerPublicKey: knownProfile.identity.publicKey,
      ownerCertificates: uniqueCertificates(knownProfile, await defaultProofStore.listCertificates()),
      epoch: 1, updatedAt: new Date().toISOString(), catalog: {},
    }
  }
  const evidence = workspaceWriteAuthorityEvidence(doc, authority)
  if (!evidence) throw new Error("Workspace authority is unavailable for write authorization")
  const credential = await incomingCredential(doc.id)
  if (credential && meshRustRuntime().state.hasAuthorityConflict(credential)) throw new Error("Workspace writes paused: conflicting ownership records")
  const credentialFingerprint = authorityValidationFingerprint(credential)
  return { authority: evidence, credentialFingerprint, fingerprint: canonicalAuthorityJson({ authority: evidence, credential: credentialFingerprint }) }
}

function workspaceWriteAuthorityEvidence(doc: Pick<WorkspaceDocumentV2, "id" | "ownerPersonId">, authority: StoredWorkspaceAuthority | null): WorkspaceWriteAuthorityEvidence | undefined {
  if (!authority) return undefined
  const owners = authorities(authority)
  const genesisOwner = owners.find(owner => owner.personId === doc.ownerPersonId)
  if (!genesisOwner) return undefined
  const catalog = authority.catalog as {
    ownershipTransfers?: WorkspaceOwnershipTransfer[]
    successionClaims?: WorkspaceSuccessionClaim[]
    revocations?: unknown[]
    deviceRevocations?: WorkspaceDeviceRevocation[]
    departures?: Array<{ record: unknown; authority: WorkspaceAuthority }>
    breakGlassClaims?: unknown[]
  } | undefined
  // A removed recovery path must never be silently treated as valid evidence.
  assertSupportedAuthorityCatalog(catalog)
  return {
    genesisOwner,
    genesisEpoch: 1,
    currentOwner: owners[0]!,
    currentEpoch: authority.epoch,
    ownershipTransfers: catalog?.ownershipTransfers ?? [],
    successionClaims: catalog?.successionClaims ?? [],
    revocations: catalog?.revocations ?? [],
    deviceRevocations: (catalog?.deviceRevocations ?? []).map(value => ({ record: value.record, signer: value.authority })),
    departures: catalog?.departures ?? [],
  }
}

function assertSupportedAuthorityCatalog(catalog: { breakGlassClaims?: unknown[] } | undefined): void {
  if ((catalog?.breakGlassClaims ?? []).length) throw new Error("Break-glass authority is unsupported")
}

async function incomingCredential(workspaceId: string): Promise<StoredWorkspaceAuthority | null> {
  try { return (await storedWorkspaceAuthority(workspaceId)).authority } catch (error) {
    if (typeof indexedDB === "undefined" && /IndexedDB is not available/i.test(error instanceof Error ? error.message : String(error))) return null
    throw error
  }
}

function authorizationBundle(raw: unknown): IncomingAuthorizationBundle {
  const bundle = raw as IncomingAuthorizationBundle
  if (!bundle || ![1, 2].includes(bundle.version) || !bundle.authority ||
    (bundle.version === 1 ? !Array.isArray(bundle.records) : !Array.isArray(bundle.pages))) {
    throw new Error("The peer needs an update: missing workspace authority evidence")
  }
  return bundle
}

function normalizeAuthorityDepartures(authority: WorkspaceWriteAuthorityEvidence): WorkspaceWriteAuthorityEvidence {
  const departures = (authority as { departures?: unknown }).departures
  if (departures === undefined) return { ...authority, departures: [] }
  if (!Array.isArray(departures)) throw new Error("Invalid workspace authority departures")
  return authority
}

export async function validateIncomingChanges(local: Automerge.Doc<WorkspaceDocumentV2> | undefined, remote: Automerge.Doc<WorkspaceDocumentV2>, raw: unknown): Promise<void> {
  await validateIncomingChangeAuthorizations(local, remote, raw)
}

/** Validation is deliberately side-effect free so callers can reject an entire
 * enrollment batch before a workspace, proof, or authority record is written. */
export async function validateIncomingChangeAuthorizations(local: Automerge.Doc<WorkspaceDocumentV2> | undefined,
  remote: Automerge.Doc<WorkspaceDocumentV2>, raw: unknown): Promise<Authorization[]> {
  return (await evaluateIncomingWorkspaceAdmission(local, remote, raw)).verifiedAuthorizations
}

/** Reclassifies complete raw history, including hashes already stored locally. */
export async function evaluateIncomingWorkspaceAdmission(local: Automerge.Doc<WorkspaceDocumentV2> | undefined,
  remote: Automerge.Doc<WorkspaceDocumentV2>, raw: unknown, priorEvidenceRecords: Authorization[] = []): Promise<WorkspaceAdmissionResult & { rawBytes: Uint8Array; credentialFingerprint: string; admissionCheckpoint?: WorkspaceAdmissionCheckpoint }> {
  const { credential, frozenCredential, knownAuthority, combinedBundle, context } = await workspaceAdmissionContext(local ?? remote, raw, priorEvidenceRecords, Boolean(local))
  const startedAt = performance.now()
  meshTrace("workspace.admission.started", { workspaceId: remote.id, epoch: credential?.epoch ?? null })
  const { bytes: rawBytes, heads } = rawAdmissionSnapshot(local, remote)
  // Causal admission uses signed change-time authority, not receiver wall time.
  const reuseKey = canonicalizeJson({ heads, ...context })
  const reused = reusedWorkspaceAdmission(remote.id, reuseKey)
  const plan = reused ?? await (await import("./workspaceAdmissionClient")).runWorkspaceAdmission({ workspaceId: remote.id,
    local: undefined, remote: rawBytes.slice(), authorization: combinedBundle, knownAuthority, now: Date.now(),
  })
  if (reused) meshTrace("workspace.admission.reused", { workspaceId: remote.id, elapsedMs: Math.round(performance.now() - startedAt) })
  else if (plan.profile) meshTrace("workspace.admission.profile", { workspaceId: remote.id, ...plan.profile })
  const admissionCheckpoint = plan.authorizedHeads && plan.decisions
    ? await createAdmissionCheckpoint(await admissionInputHash(rawBytes, context), plan.authorizedHeads, plan.decisions) : undefined
  // Authority may change while either policy computation or hashing yields.
  const currentCredential = await incomingCredential(remote.id)
  traceAdmissionAuthority(remote.id, credential, currentCredential, frozenCredential, startedAt, plan)
  if (!reused) rememberWorkspaceAdmission(remote.id, reuseKey, plan)
  return { ...structuredClone(plan), rawBytes, credentialFingerprint: frozenCredential, admissionCheckpoint, authorizationEvidence: structuredClone(plan.verifiedAuthorizations) }
}

/** Reuse only a locally committed projection, never an incoming snapshot's marker. */
export async function storedWorkspaceAdmissionIsCurrent(doc: Automerge.Doc<WorkspaceDocumentV2>,
  evidence: StoredCausalEvidence, authorization: unknown, savedRecords?: Authorization[]): Promise<boolean> {
  if (!evidence.admissionCheckpoint || evidence.admissionCheckpoint.incremental) return false
  const { context, frozenCredential } = await workspaceAdmissionContext(doc, authorization,
    (evidence.authorizationEvidence ?? []) as Authorization[], true, savedRecords)
  const matches = await matchesAdmissionCheckpoint(evidence.admissionCheckpoint,
    await admissionInputHash(evidence.bytes, context), Automerge.getHeads(doc), evidence.decisions)
  return matches && authorityValidationFingerprint(await incomingCredential(doc.id)) === frozenCredential
}

async function workspaceAdmissionContext(doc: Automerge.Doc<WorkspaceDocumentV2>, raw: unknown,
  priorEvidenceRecords: Authorization[], hasLocal: boolean, savedRecords?: Authorization[]) {
  const credential = await incomingCredential(doc.id)
  if (credential && meshRustRuntime().state.hasAuthorityConflict(credential)) throw new Error("Workspace writes paused: conflicting ownership records")
  const unnormalizedBundle = authorizationBundle(raw)
  const bundle = { ...unnormalizedBundle, authority: normalizeCertificateSets(normalizeAuthorityDepartures(unnormalizedBundle.authority)) }
  const frozenCredential = authorityValidationFingerprint(credential)
  const knownAuthority = normalizeCertificateSets(hasLocal ? workspaceWriteAuthorityEvidence(doc, credential) ?? null : null)
  const rawRecords = (bundle.version === 1 ? bundle.records : bundle.pages.flat()) as Authorization[]
  const allRecords = mergeAuthorizationRecords([...savedRecords ?? await records(doc.id), ...priorEvidenceRecords], rawRecords)
  const combinedBundle: IncomingAuthorizationBundle = { version: 1, records: allRecords, authority: bundle.authority }
  return { credential, frozenCredential, knownAuthority, combinedBundle,
    context: { workspaceId: doc.id, authorization: combinedBundle, knownAuthority, credential: frozenCredential } }
}

function rawAdmissionSnapshot(local: Automerge.Doc<WorkspaceDocumentV2> | undefined, remote: Automerge.Doc<WorkspaceDocumentV2>) {
  if (!local || local === remote) return { bytes: Automerge.save(remote), heads: Automerge.getHeads(remote).sort() }
  const merged = Automerge.merge(Automerge.clone(local), remote)
  try { return { bytes: Automerge.save(merged), heads: Automerge.getHeads(merged).sort() } }
  finally { Automerge.free(merged) }
}

function traceAdmissionAuthority(workspaceId: string, credential: StoredWorkspaceAuthority | null,
  currentCredential: StoredWorkspaceAuthority | null, frozenCredential: string, startedAt: number, plan: WorkspaceAdmissionResult): void {
  const changedFields = authorityChangedFields(credential, currentCredential)
  if (authorityValidationFingerprint(currentCredential) !== frozenCredential ||
    (currentCredential && meshRustRuntime().state.hasAuthorityConflict(currentCredential))) {
    meshTrace("workspace.admission.authority-changed", { workspaceId,
      elapsedMs: Math.round(performance.now() - startedAt), changedFields,
      previousEpoch: credential?.epoch ?? null, currentEpoch: currentCredential?.epoch ?? null }, "warn")
    throw new Error("Workspace authority changed during validation. Retry synchronization.")
  }
  meshTrace(changedFields.length ? "workspace.admission.authority-refreshed" : "workspace.admission.completed", {
    workspaceId, elapsedMs: Math.round(performance.now() - startedAt), changedFields,
    admitted: plan.admittedHashes?.length ?? 0, pending: plan.pendingHashes?.length ?? 0,
    quarantined: plan.quarantinedHashes?.length ?? 0,
  })
}

export function authorityValidationFingerprint(authority: StoredWorkspaceAuthority | null): string {
  if (!authority) return canonicalizeJson(null)
  // Peer refreshes advance the storage timestamp without changing rights.
  // Keep every security field in the race guard, including unknown future fields.
  const rights = { ...authority }
  delete (rights as Partial<StoredWorkspaceAuthority>).updatedAt
  return canonicalAuthorityJson(rights)
}

function authorityChangedFields(before: StoredWorkspaceAuthority | null, after: StoredWorkspaceAuthority | null): string[] {
  const left = (before ?? {}) as unknown as Record<string, unknown>
  const right = (after ?? {}) as unknown as Record<string, unknown>
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    .filter(key => canonicalizeJson(left[key] ?? null) !== canonicalizeJson(right[key] ?? null))
}

/** Persists only proofs that a completed admission has already verified. */
async function persistIncomingChangeAuthorizations(workspaceId: string, verified: unknown[]): Promise<boolean> {
  return putRecords(workspaceId, verified as Authorization[])
}

/** @deprecated Use validateIncomingChangeAuthorizations then persistIncomingChangeAuthorizations. */
export async function validateIncomingChangesWithProofStatus(local: Automerge.Doc<WorkspaceDocumentV2> | undefined, remote: Automerge.Doc<WorkspaceDocumentV2>, raw: unknown): Promise<boolean> {
  return persistIncomingChangeAuthorizations(remote.id, await validateIncomingChangeAuthorizations(local, remote, raw))
}
