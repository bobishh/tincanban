import * as Automerge from "@automerge/automerge/slim"
import { identitySeedFromPrivateKey } from "@meta-uber/mesh-identity"
import { canonicalizeJson, isCurrentIdentityProfile, toBase64Url, type LocalProfile } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { useAppCore } from "./useAppCore"
import { readStoredAttachment, writeStoredAttachmentStream } from "../attachments"
import { defaultStorage } from "../storage"
import { openWorkspaceJournal, requestResult, transactionDone } from "../storageJournal"
import { refreshAvailableWorkspaces } from "../statePersistence"
import { authorityValidationFingerprint, exportAuthorizationBundle, readWorkspaceSigningAuthority, workspaceRole } from "../sync/changeAuthorization"
import { workspaceSigningContext } from "../sync/workspaceSigning"
import { peerStore } from "../sync/peerStore"
import { exportPrivateReplicaState, planPrivateReplicaImport } from "../sync/privateReplicaRepository"
import { createIdentityDeviceRecovery } from "../sync/identityDeviceRecovery"
import { openIdentityDeviceRecovery } from "../sync/identityDeviceRecoveryCodec"
import { createHistoryRecoveryFileWriter, openHistoryRecoveryFile } from "../sync/historyRecoveryFile"
import { exportHistoryRecoveryArchive, type HistoryRecoveryEvidencePart, type HistoryRecoveryManifest } from "../sync/historyRecoveryArchive"
import { createWorkspaceHistoryRecoveryEvidence } from "../sync/workspaceHistoryRecoveryEvidence"
import { workspaceHistoryRecoverySources } from "../sync/workspaceHistoryRecoverySources"
import { decodeWorkspaceRecoveryEvidence } from "../sync/workspaceHistoryRecoveryDecode"
import { admitWorkspaceHistoryRecovery, recoveryProjectionAccess } from "../sync/workspaceHistoryRecoveryAdmission"
import { restoreWorkspaceRecoveryJournal } from "../sync/workspaceHistoryRecoveryJournal"
import { retainWorkspaceRecoveryObjects } from "../sync/workspaceHistoryRecoveryObjects"
import { retainWorkspaceRecoveryArchives } from "../sync/workspaceHistoryRecoveryArchives"
import { prepareWorkspaceHistoryRecoveryProjection, resumeWorkspaceHistoryRecoveryProjection } from "../sync/workspaceHistoryRecoveryProjection"
import { listWorkspaceAttachments } from "../sync/workspaceAttachments"
import { verifyDecodedPeerHistoryRecoveryCoverage } from "../sync/peerHistoryRecoveryCoverage"
import { createPeerHistoryRecoveryEvidence } from "../sync/peerHistoryRecovery"
import { missingHistoryBaselineParents, workspacePeerHistoryRecoveryLineage } from "../sync/workspacePeerHistoryLineage"
import { retainDecodedPeerHistoryRecovery } from "../sync/workspacePeerHistoryRecoveryObjects"
import { listWorkspaceHistoryPublications } from "../sync/historyBaselinePublicationRepository"

type Core = ReturnType<typeof useAppCore>
type Opened = Awaited<ReturnType<typeof openHistoryRecoveryFile>>
type Decoded = Awaited<ReturnType<typeof decodeWorkspaceRecoveryEvidence>>
export type PrivateWorkspaceRecoveryBackup = { file: Blob; words: string; coverage: "complete" | "incomplete"; missingCount: number }
export type PrivateWorkspaceRecoveryInspection = { workspaceId: string; personId: string; coverage: "complete" | "incomplete"; missingCount: number }
type Inspected = { opened: Opened; decoded: Decoded; recoveryId: string; expectedRevision?: string | null; replace?: boolean }
// UI receives only display fields. Neither a copied preview nor user-supplied IDs can activate private state.
const inspected = new WeakMap<PrivateWorkspaceRecoveryInspection, Inspected>()
const encoder = new TextEncoder()

function identityGuard(profile: LocalProfile): () => void {
  return () => { if (!isCurrentIdentityProfile(profile)) throw new Error("Identity changed during workspace recovery") }
}
function missingCount(manifest: HistoryRecoveryManifest): number {
  return new Set([...manifest.missingObjects.map(item => `${item.scopeId}/${item.ciphertextId}`),
    ...manifest.unresolvedDirectories.filter(item => !manifest.missingObjects.some(object => object.ciphertextId === item.ciphertextId))
      .map(item => `directory/${item.sourceId}/${item.ciphertextId}`),
    ...(manifest.missingAttachmentIds ?? []).map(id => `attachment/${id}`),
    ...(manifest.missingPeerObjects ?? []).map(item => `peer/${item.baselineId}/${item.objectId}`)]).size
}
function historyBaselineId(signedJson: Uint8Array): string {
  const value = (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(signedJson)) as {
    payload?: { baselineId?: unknown }
  }).payload?.baselineId
  if (typeof value !== "string") throw new Error("Archived history source has no baseline identity")
  return value
}
function* parts(category: string, id: string, bytes: Uint8Array): Generator<HistoryRecoveryEvidencePart> {
  const size = 256 * 1024, partCount = Math.max(1, Math.ceil(bytes.length / size))
  for (let partIndex = 0; partIndex < partCount; partIndex++) yield {
    kind: "local-evidence-part", category, id, partIndex, partCount,
    data: toBase64Url(bytes.subarray(partIndex * size, (partIndex + 1) * size)),
  }
}
function jsonParts(category: string, id: string, value: unknown) {
  return parts(category, id, encoder.encode(canonicalizeJson(value)))
}
async function* attachmentSource(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += 256 * 1024) yield bytes.subarray(offset, offset + 256 * 1024)
}

/** Explicit private export: keys travel only inside the encrypted recovery stream. */
export async function createPrivateWorkspaceRecovery(core: Core): Promise<PrivateWorkspaceRecoveryBackup> {
  const profile = core.tincanban.getCurrentProfile()
  if (!profile?.privateKeys.identityPrivateKey) throw new Error("Create this backup on a device holding your identity recovery key")
  const workspaceId = core.tincanban.activeWorkspace.id, ensureIdentity = identityGuard(profile)
  ensureIdentity()
  const doc = await core.tincanban.readWorkspaceDoc(workspaceId)
  const signing = await workspaceSigningContext(doc, profile, "history-recovery-read", "workspaceId", undefined, {
    readAuthority: () => readWorkspaceSigningAuthority(workspaceId), authorityFingerprint: authorityValidationFingerprint, workspaceRole,
  })
  const identity = await createIdentityDeviceRecovery("better")
  ensureIdentity()
  const transfer = (await openIdentityDeviceRecovery(identity.file, identity.recoveryKey)).transfer
  const privateWire = canonicalizeJson(transfer.replicas)
  const source = await createWorkspaceHistoryRecoveryEvidence(workspaceId, ensureIdentity)
  const guard = async () => {
    ensureIdentity()
    await signing.requireCurrent()
    await source.assertUnchanged()
    if (canonicalizeJson(await exportPrivateReplicaState(profile.identity.personId)) !== privateWire) {
      throw new Error("Private Rusty connections changed during backup; retry when synchronization settles")
    }
    ensureIdentity()
  }
  await guard()
  const raw = await core.tincanban.readWorkspaceBytes(workspaceId)
  const authorization = await exportAuthorizationBundle(raw, profile)
  const [authority, credential] = await Promise.all([
    peerStore.getWorkspaceAuthority(workspaceId), peerStore.getWorkspaceCredential(workspaceId),
  ])
  const archive = await workspaceHistoryRecoverySources(workspaceId, transfer.replicas, guard)
  const peerAuthority = await readWorkspaceSigningAuthority(workspaceId)
  if (peerAuthority.invalid) throw new Error("Workspace permissions could not be verified")
  const scopeAuthority = peerAuthority.authority?.scopeAuthoritySnapshot
  const trustedScopeAuthority = scopeAuthority ? { genesis: scopeAuthority.genesis, grants: [], grantIssuers: [],
    revocations: [], controlTransfers: [], successionTransfers: [] } : undefined
  const peerLineage = await workspacePeerHistoryRecoveryLineage({ personId: profile.identity.personId, workspaceId, ensureCurrent: ensureIdentity,
    guard, trustedScopeAuthority, readObject: core.sync.fetchHistoryObject, readBaseline: core.sync.fetchHistoryBaseline,
    readDocument: core.sync.fetchHistoryDocument })
  const publications = await listWorkspaceHistoryPublications(workspaceId)
  const missingParents = missingHistoryBaselineParents([...archive.sources.map(source => ({ workspaceId: source.workspaceId,
    baselineId: historyBaselineId(source.signedJson), signedJson: source.signedJson })), ...peerLineage.sources], workspaceId)
  const peerArchive = createPeerHistoryRecoveryEvidence(peerLineage.sources, guard, missingParents)
  const missingAttachments = new Set<string>()
  async function* evidence(): AsyncGenerator<HistoryRecoveryEvidencePart> {
    yield* source.evidence
    yield* peerArchive.evidence
    yield* parts("workspace-source", "raw", raw)
    yield* jsonParts("workspace-control", "access", { authorization, authority, credential })
    for (const publication of publications) yield* jsonParts("publication-metadata", publication.publicationId, publication)
    // A content hash may have several display names. Save its bytes once; original names remain in the signed document.
    const seen = new Set<string>()
    for (const descriptor of listWorkspaceAttachments(doc)) {
      if (seen.has(descriptor.blobId)) continue
      seen.add(descriptor.blobId)
      await guard()
      const bytes = await readStoredAttachment(descriptor) ??
        await core.blindReplication.fetchAttachment(workspaceId, descriptor, current => core.sync.fetchBlob(workspaceId, current))
      await guard()
      if (!bytes) { missingAttachments.add(descriptor.blobId); continue }
      yield* jsonParts("attachment-metadata", descriptor.blobId, { descriptor })
      yield* parts("attachment-bytes", descriptor.blobId, bytes)
    }
    await guard()
  }
  const seed = await identitySeedFromPrivateKey(profile.privateKeys.identityPrivateKey, profile.identity.personId)
  try {
    const writer = await createHistoryRecoveryFileWriter({ workspaceId, identityRecovery: identity.file, seed })
    const manifest = await exportHistoryRecoveryArchive(workspaceId, archive.sources, {
      ensureCurrent: guard, write: record => writer.write(record), download: archive.download,
      evidence: evidence(), unavailableAttachments: () => [...missingAttachments], unavailablePeerObjects: peerArchive.missingObjects,
    })
    await guard()
    const file = await writer.finish()
    await guard()
    return { file, words: identity.recoveryKey, coverage: manifest.coverage, missingCount: missingCount(manifest) }
  } finally { seed.fill(0) }
}

/** Authentication and original signed-history admission finish before a usable preview exists. */
export async function inspectPrivateWorkspaceRecovery(file: Blob, words: string): Promise<PrivateWorkspaceRecoveryInspection> {
  const opened = await openHistoryRecoveryFile(file, words)
  const decoded = await decodeWorkspaceRecoveryEvidence(opened.records, opened.header.workspaceId)
  const manifest = opened.records.at(-1)
  if (manifest?.kind !== "history-recovery-manifest") throw new Error("Recovery final manifest is missing")
  await verifyDecodedPeerHistoryRecoveryCoverage(decoded, manifest, () => {}, opened.records)
  await admitWorkspaceHistoryRecovery({ workspaceId: opened.header.workspaceId, decoded, records: opened.records,
    currentAuthority: null, ensureCurrent: () => {} })
  const preview = Object.freeze({ workspaceId: opened.header.workspaceId, personId: opened.header.identityRecovery.personId,
    coverage: manifest.coverage, missingCount: missingCount(manifest) })
  inspected.set(preview, { opened, decoded, recoveryId: crypto.randomUUID() })
  return preview
}

async function readRevision(workspaceId: string): Promise<string | null> {
  const database = await openWorkspaceJournal(), tx = database.transaction("revisions", "readonly"), done = transactionDone(tx)
  const row: unknown = await requestResult(tx.objectStore("revisions").get(workspaceId))
  await done
  return row === undefined ? null : canonicalizeJson(row)
}

/** Preserve source rows, then atomically activate one Native-admitted workspace under the current identity. */
export async function restorePrivateWorkspaceRecovery(core: Core, preview: PrivateWorkspaceRecoveryInspection, replace: boolean): Promise<void> {
  const retained = inspected.get(preview)
  if (!retained) throw new Error("Inspect this recovery file before restoring it")
  const profile = core.tincanban.getCurrentProfile()
  if (!profile || profile.identity.personId !== preview.personId) throw new Error("Recover this file's identity in Settings → Identity first")
  const guard = identityGuard(profile), wasActive = core.tincanban.activeWorkspace.id === preview.workspaceId
  guard()
  await defaultStorage.withWorkspaceTransaction(preview.workspaceId, async transaction => {
    guard()
    const historyProgress = await defaultStorage.historyProgressForRead(preview.workspaceId)
    if (historyProgress.transitionId) throw new Error("Finish archiving this workspace before replacing its local copy")
    const current = await readWorkspaceSigningAuthority(preview.workspaceId)
    if (current.invalid) throw new Error("Current workspace authority is invalid; recovery cannot replace its permissions")
    const admitted = await admitWorkspaceHistoryRecovery({ workspaceId: preview.workspaceId, decoded: retained.decoded,
      records: retained.opened.records, currentAuthority: current.authority, ensureCurrent: guard })
    guard()
    const document = Automerge.load<WorkspaceDocumentV2>(admitted.snapshot.bytes)
    let title: string
    try { title = document.title }
    finally { Automerge.free(document) }
    const control = retained.decoded.auxiliary.get("workspace-control/access") as {
      authority: Awaited<ReturnType<typeof peerStore.getWorkspaceAuthority>>;
      credential: Awaited<ReturnType<typeof peerStore.getWorkspaceCredential>>;
    }
    const currentCredential = await peerStore.getWorkspaceCredential(preview.workspaceId)
    const access = recoveryProjectionAccess(admitted, current.authority, control, currentCredential)
    // Validate current private-state import constraints before replacing any workspace rows.
    // Activation repeats this plan under CAS; this early pass catches an already frozen credential transition.
    await planPrivateReplicaImport(preview.personId, retained.opened.transfer.replicas)
    guard()
    // Keep the first attempt's CAS boundary across retries. A later local edit must never become implicit replacement consent.
    if (retained.expectedRevision === undefined) {
      retained.expectedRevision = await readRevision(preview.workspaceId)
      retained.replace = replace
    }
    if (retained.replace !== replace) throw new Error("Recovery replacement choice changed; inspect the file again")
    await retainWorkspaceRecoveryObjects(preview.personId, preview.workspaceId, retained.recoveryId, retained.opened.records, guard)
    await retainWorkspaceRecoveryArchives(preview.personId, preview.workspaceId, retained.recoveryId, retained.opened.records, guard)
    await retainDecodedPeerHistoryRecovery(preview.personId, preview.workspaceId, retained.decoded, guard)
    for (const attachment of retained.decoded.attachments) {
      guard()
      await writeStoredAttachmentStream(attachment.descriptor, attachmentSource(attachment.bytes), guard)
    }
    guard()
    await prepareWorkspaceHistoryRecoveryProjection({ personId: preview.personId, workspaceId: preview.workspaceId,
      recoveryId: retained.recoveryId, manifest: retained.opened.transfer.manifest, authority: access.authority,
      credential: access.credential, title }, guard)
    // Recheck current policy after additive staging. Never erase a newly received revocation while writing an older backup.
    const latest = await readWorkspaceSigningAuthority(preview.workspaceId)
    if (latest.invalid || authorityValidationFingerprint(latest.authority) !== authorityValidationFingerprint(current.authority)) {
      throw new Error("Workspace permissions changed during recovery; retry with the current permissions")
    }
    await restoreWorkspaceRecoveryJournal(preview.workspaceId, admitted.journal, { personId: preview.personId,
      recoveryId: retained.recoveryId, replace, expectedRevision: retained.expectedRevision, ensureCurrent: guard,
      sourceJournal: retained.decoded.journal, transaction })
  })
  defaultStorage.invalidateWorkspaceCache(preview.workspaceId)
  guard()
  // Identity projections can acquire this workspace's mutation lock themselves.
  // Their durable intent resumes after journal activation releases that lock.
  await resumeWorkspaceHistoryRecoveryProjection(preview.personId, guard)
  guard()
  await refreshAvailableWorkspaces(defaultStorage)
  if (wasActive) await core.tincanban.switchWorkspace(preview.workspaceId)
  inspected.delete(preview)
}
