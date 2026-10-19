import { WasmStateCore, type WasmVerifiedHistoryArchiveCapture, type WasmVerifiedHistoryRebase,
  type WasmVerifiedHistoryBaselineAttestation, type WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { canonicalizeJson, sha256Base64Url } from "@meta-uber/mesh-identity"
import { captureNativeCatalogue, discardNativeCatalogue, readNativeCatalogueObjects } from "./historyCaptureSink"
import { createWorkspaceHistoryPreparation } from "./historyPreparationRepository"
import { prepareArchiveLocators } from "@meta-uber/mesh-replication/history-archive-locator-preparation"
import { createArchiveRemote } from "@meta-uber/mesh-replication/history-archive-remote"
import { confirmArchiveCoverageSet } from "@meta-uber/mesh-replication/history-archive-coverage-set"
import { MAX_ARCHIVE_PART_BYTES, writeArchiveBytes, type ArchiveBytesReference, type ArchiveObjectStore,
  type ArchiveTreeContext } from "@meta-uber/mesh-replication/history-archive"
import type { ArchiveEncryptionBinding, ArchiveEncryptionScope, EncryptedArchiveObject } from "@meta-uber/mesh-replication/history-archive-crypto"
import type { HistoryPreparationIdentity, HistoryPreparationJournal, HistoryPreparationRemote } from "@meta-uber/mesh-replication/history-preparation-journal"
import type { ArchiveCoverageAuthority as HistoryArchiveCoverageAuthority } from "@meta-uber/mesh-replication/history-archive-coverage"
import type { BlindReplicaConfig } from "./blindReplication"
import { signingEvidence, type VerifiedSigningContext } from "../domain/signingContext"
import { finalizeWorkspaceHistoryBaseline } from "./historyBaselineFinalize"
import { verifyReceivedWireHistoryBaseline, type WireHistoryBaseline } from "../product-replica"
import { createReceivedHistoryBaselineRepository } from "./receivedHistoryBaselineRepository"
import { readWorkspaceBasisSnapshot } from "../storageJournal"
import type { useTincanban } from "../state"
import { defaultStorage } from "../storage"
import { exportAuthorizationBundle, localWorkspaceAdmissionAuthority, workspaceRole } from "./changeAuthorization"
import { defaultProofStore } from "../domain/proofs"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { HistoryCaptureSourceChangedError } from "./historyCheckpointSource"
import { checkpointAdmissionReady } from "./blindCheckpointAdmission"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

type NativeHistorySource = {
  records: unknown[]
  snapshot: {
    workspaceId: string
    genesisOwner: unknown
    genesisEpoch: number
    expectedCurrentOwner: unknown
    document: Uint8Array | number[]
    ownershipTransfers: unknown[]
    successionClaims: unknown[]
    revocations: unknown[]
    deviceRevocations: unknown[]
    departures: unknown[]
  }
  pendingChangeBytes?: Array<Uint8Array | number[]>
  nowMs: number
}

type Catalogue = { context: ArchiveTreeContext; root: { objectId: string } }
type NativeCatalogueCapture = {
  writeEncryptedCatalogue(
    scopeId: string,
    keyEpoch: number,
    contentKey: Uint8Array,
    nonceSource: () => Uint8Array,
    sink: (ciphertextId: string, binding: ArchiveEncryptionBinding, object: EncryptedArchiveObject) => void,
    ensureCurrent: () => void,
  ): unknown
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}
function nativeBaselinePayload(basis: WasmVerifiedReceivedHistoryBaseline | null | undefined): { baselineId?: unknown; historyEpoch?: unknown } | undefined {
  const envelope: unknown = basis?.envelope()
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return undefined
  const payload = (envelope as Record<string, unknown>).payload
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as { baselineId?: unknown; historyEpoch?: unknown } : undefined
}

function recordForNative(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("History source authorization is malformed")
  const record = value as Record<string, unknown>
  if (!Object.hasOwn(record, "signed") || typeof record.publicKey !== "string" || !Array.isArray(record.certificates)) {
    throw new Error("History source authorization is incomplete")
  }
  return { signed: structuredClone(record.signed), publicKey: record.publicKey,
    certificates: structuredClone(record.certificates), grant: structuredClone(record.grant ?? null) }
}

function sourceSnapshot(input: NativeHistorySource, workspaceId: string) {
  const captured = structuredClone(input)
  if (!captured || captured.snapshot?.workspaceId !== workspaceId || !Array.isArray(captured.records) ||
      !Number.isSafeInteger(captured.snapshot.genesisEpoch) || captured.snapshot.genesisEpoch < 1 ||
      !Number.isSafeInteger(captured.nowMs) || captured.nowMs < 0) throw new Error("Invalid Native history source")
  const document = captured.snapshot.document instanceof Uint8Array
    ? new Uint8Array(captured.snapshot.document) : new Uint8Array(captured.snapshot.document)
  return { ...captured, records: captured.records.map(recordForNative), snapshot: { ...captured.snapshot, document },
    pendingChangeBytes: (captured.pendingChangeBytes ?? []).map(bytes => bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes)) }
}

function sourceControl(source: NativeHistorySource): Record<string, unknown> {
  const snapshot = source.snapshot
  return { workspaceId: snapshot.workspaceId, genesisOwner: structuredClone(snapshot.genesisOwner), genesisEpoch: snapshot.genesisEpoch,
    expectedCurrentOwner: structuredClone(snapshot.expectedCurrentOwner), ownershipTransfers: structuredClone(snapshot.ownershipTransfers),
    successionClaims: structuredClone(snapshot.successionClaims), revocations: structuredClone(snapshot.revocations),
    deviceRevocations: structuredClone(snapshot.deviceRevocations), departures: structuredClone(snapshot.departures) }
}

async function sourceIds(source: NativeHistorySource, controlJson: Uint8Array, authorizationJson: Uint8Array[]) {
  const documentHash = await sha256Base64Url(source.snapshot.document instanceof Uint8Array
    ? source.snapshot.document : new Uint8Array(source.snapshot.document))
  const proofHashes = await Promise.all(authorizationJson.map(bytes => sha256Base64Url(bytes)))
  const pendingHashes = await Promise.all((source.pendingChangeBytes ?? []).map(bytes =>
    sha256Base64Url(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))))
  const authorityRevision = await sha256Base64Url(encoder.encode(canonicalizeJson(sourceControl(source))))
  const sourceRevision = await sha256Base64Url(encoder.encode(canonicalizeJson({ documentHash, controlHash: await sha256Base64Url(controlJson),
    proofHashes, pendingHashes })))
  return { sourceRevision, authorityRevision }
}

function encodedSource(source: NativeHistorySource, controlJson: Uint8Array, authorizationJson: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    const parts = [controlJson, source.snapshot.document instanceof Uint8Array ? source.snapshot.document : new Uint8Array(source.snapshot.document),
      ...authorizationJson, ...(source.pendingChangeBytes ?? []).map(bytes => bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))]
    for (const part of parts) {
      const prefix = new Uint8Array(8)
      new DataView(prefix.buffer).setBigUint64(0, BigInt(part.length))
      yield prefix
      for (let offset = 0; offset < part.length; offset += MAX_ARCHIVE_PART_BYTES) {
        yield part.subarray(offset, Math.min(part.length, offset + MAX_ARCHIVE_PART_BYTES))
      }
    }
  })()
}

function makeIdentity(input: { transitionId: string; personId: string; workspaceId: string; historyEpoch: number;
  previousBaselineId: string | null; sourceRevision: string; authorityRevision: string; privateBinding: string;
  config: BlindReplicaConfig; keyDigest: string }): HistoryPreparationIdentity {
  return { transitionId: input.transitionId, personId: input.personId, workspaceId: input.workspaceId,
    historyEpoch: input.historyEpoch, sourceRevision: input.sourceRevision, authorityRevision: input.authorityRevision,
    privateBinding: input.privateBinding, previousBaselineId: input.previousBaselineId,
    storage: { origin: input.config.origin, scopeId: input.config.scopeId, policyRevision: input.config.policyRevision,
      servicePublicKey: input.config.servicePublicKey, keyEpoch: input.config.keyEpoch, keyDigest: input.keyDigest } }
}

async function journalObjects(journal: HistoryPreparationJournal) {
  const objects: Array<{ ciphertextId: string; object: EncryptedArchiveObject }> = []
  for await (const item of journal.objects()) objects.push({ ciphertextId: item.sealed.ciphertextId, object: structuredClone(item.sealed.object) })
  return objects
}

async function rootBinding(journal: HistoryPreparationJournal, objectId: string): Promise<ArchiveEncryptionBinding> {
  for await (const item of journal.objects()) {
    if (item.binding.objectId === objectId && item.binding.objectKind === "page") return item.binding
  }
  throw new Error("History archive root is missing from the durable preparation")
}

function prepareEncryptedByteTree(journal: HistoryPreparationJournal, scope: ArchiveEncryptionScope,
  context: ArchiveTreeContext, bytes: Uint8Array, ensureCurrent: () => void | Promise<void>) {
  const capturedBytes = bytes.slice()
  const byteLength = capturedBytes.length
  let partIndex = 0
  const partCount = Math.ceil(byteLength / MAX_ARCHIVE_PART_BYTES)
  const store: ArchiveObjectStore = {
    async write(objectId, bytes) {
      await ensureCurrent()
      let isPage = false
      try {
        const parsed: unknown = JSON.parse(decoder.decode(bytes))
        isPage = Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
          (parsed as Record<string, unknown>).kind === "workspace-history-index-page")
      } catch { /* Automerge source parts are binary */ }
      const binding: ArchiveEncryptionBinding = { ...context, objectId,
        objectKind: isPage ? "page" : "part", partIndex: isPage ? 0 : partIndex++, partCount: isPage ? 1 : partCount }
      if (binding.objectKind === "part" && binding.partIndex >= partCount) throw new Error("History basis produced too many byte parts")
      await journal.stage(scope, binding, bytes)
      await ensureCurrent()
    },
    async read() { throw new Error("History basis byte tree is write-only during capture") },
  }
  function* chunks() {
    for (let offset = 0; offset < byteLength; offset += MAX_ARCHIVE_PART_BYTES) {
      yield capturedBytes.subarray(offset, offset + MAX_ARCHIVE_PART_BYTES)
    }
  }
  return writeArchiveBytes(context, chunks(), store)
}

async function coverPreparation(journal: HistoryPreparationJournal, rootObjectId: string, remote: HistoryPreparationRemote) {
  const root = await rootBinding(journal, rootObjectId)
  await journal.archive(root)
  return journal.cover(remote)
}

/** Capture exact originals, encrypt and cover both archive namespaces, then publish a signed current Owner baseline. */
export type CaptureCheckpointPort = (candidate: WasmVerifiedReceivedHistoryBaseline, wire: WireHistoryBaseline) => Promise<void>
type CaptureInput = {
  config: BlindReplicaConfig
  transitionId: string
  source: NativeHistorySource
  signer: { personId: string; deviceId: string; certificates: unknown[] }
  receivedBasis?: WasmVerifiedReceivedHistoryBaseline | null
  previous?: WasmVerifiedReceivedHistoryBaseline | null
  scope: ArchiveEncryptionScope
  authority: HistoryArchiveCoverageAuthority
  scopeAuthority: unknown
  resolveSigningContext: (binding: Record<string, string | number>) => Promise<VerifiedSigningContext>
  readCurrentWorkspaceBytes: () => Promise<Uint8Array>
  checkpointBeforeActivation?: CaptureCheckpointPort
  fetch?: typeof fetch
  ensureCurrent: () => void | Promise<void>
  ensureNativeCurrent: () => void
}
type CaptureWork = CaptureInput & { config: BlindReplicaConfig; source: NativeHistorySource;
  signer: { personId: string; deviceId: string; certificates: unknown[] }; scope: ArchiveEncryptionScope;
  authority: HistoryArchiveCoverageAuthority; scopeAuthority: unknown; receivedBasis: WasmVerifiedReceivedHistoryBaseline | null;
  previous: WasmVerifiedReceivedHistoryBaseline | null; controlJson: Uint8Array; authorizationJson: Uint8Array[];
  sourceRevision: string; authorityRevision: string; historyEpoch: number; capture: WasmVerifiedHistoryArchiveCapture;
  rebase: WasmVerifiedHistoryRebase; data: HistoryPreparationJournal; dataIdentity: HistoryPreparationIdentity;
  captureKey: string; remote: HistoryPreparationRemote; keyringRemote: ReturnType<typeof createArchiveRemote> }

async function captureAndPublishWorkspaceHistoryBaseline(input: CaptureInput): Promise<{ baselineId: string; wire: WireHistoryBaseline }> {
  const work = await prepareCaptureWork(input)
  const result = await prepareCaptureArchives(work)
  await activateCapturedHistory(work, result.baselineId, result.wire, result.encryptedObjects)
  await work.ensureCurrent()
  return { baselineId: result.baselineId, wire: result.wire }
}

async function prepareCaptureWork(input: CaptureInput): Promise<CaptureWork> {
  const captured = captureInputContext(input)
  const { config, source, signer, scope, authority, scopeAuthority, ensureCurrent, ensureNativeCurrent, transitionId,
    receivedBasis, previous } = captured
  const controlJson = encoder.encode(canonicalizeJson(sourceControl(source)))
  const authorizationJson = source.records.map(record => encoder.encode(canonicalizeJson(record)))
  const { sourceRevision, authorityRevision } = await sourceIds(source, controlJson, authorizationJson)
  await ensureCurrent()
  const native = prepareNativeCapture(source, signer, receivedBasis, previous, transitionId, controlJson, authorizationJson)
  const { historyEpoch, previousBaselineId, capture, rebase } = native
  const keyDigest = await sha256Base64Url(scope.key)
  const privateBinding = await sha256Base64Url(encoder.encode(canonicalizeJson({ personId: signer.personId,
    workspaceId: config.workspaceId, scopeId: config.scopeId, keyEpoch: config.keyEpoch, keyDigest })))
  const dataIdentity = makeIdentity({ transitionId, personId: signer.personId, workspaceId: config.workspaceId,
    historyEpoch, previousBaselineId: previousBaselineId as string | null, sourceRevision, authorityRevision,
    privateBinding, config, keyDigest })
  const data = createWorkspaceHistoryPreparation(dataIdentity, ensureNativeCurrent)
  await data.capture(encodedSource(source, controlJson, authorizationJson))
  const captureKey = await sha256Base64Url(encoder.encode(canonicalizeJson({ transitionId, sourceRevision,
    authorityRevision, workspaceId: config.workspaceId, scopeId: config.scopeId, keyEpoch: config.keyEpoch, keyDigest })))
  const keyringRemote = createArchiveRemote(config, { fetch: input.fetch ?? fetch, ensureCurrent })
  const remote: HistoryPreparationRemote = { upload: keyringRemote.upload, coverage: keyringRemote.coverage, aggregate: keyringRemote.aggregate }
  return { ...input, config, source, signer, scope, authority, scopeAuthority, ensureCurrent, ensureNativeCurrent,
    receivedBasis, previous, controlJson, authorizationJson, sourceRevision, authorityRevision, historyEpoch,
    capture, rebase, data, dataIdentity, captureKey, remote, keyringRemote }
}
function captureInputContext(input: CaptureInput) {
  const config = structuredClone(input.config), source = sourceSnapshot(input.source, input.config.workspaceId)
  const signer = structuredClone(input.signer), scope = structuredClone(input.scope), authority = structuredClone(input.authority)
  const scopeAuthority = structuredClone(input.scopeAuthority), receivedBasis = input.receivedBasis ?? null, previous = input.previous ?? null
  if (!validCaptureTransition(input.transitionId, receivedBasis, previous) || !validCaptureCallbacks(input) ||
      !validCaptureScope(source, config, scope, authority)) {
    throw new Error("History capture inputs do not share a current owner and Rusty scope")
  }
  return { ...input, config, source, signer, scope, authority, scopeAuthority, receivedBasis, previous,
    ensureCurrent: input.ensureCurrent, ensureNativeCurrent: input.ensureNativeCurrent, transitionId: input.transitionId }
}
function validCaptureTransition(transitionId: string, receivedBasis: WasmVerifiedReceivedHistoryBaseline | null,
  previous: WasmVerifiedReceivedHistoryBaseline | null): boolean {
  return /^[0-9a-f-]{36}$/.test(transitionId) && Boolean(receivedBasis) === Boolean(previous)
}
function validCaptureCallbacks(input: CaptureInput): boolean {
  return typeof input.ensureCurrent === "function" && typeof input.ensureNativeCurrent === "function" &&
    typeof input.resolveSigningContext === "function" && typeof input.readCurrentWorkspaceBytes === "function"
}
function validCaptureScope(source: NativeHistorySource, config: BlindReplicaConfig, scope: ArchiveEncryptionScope,
  authority: HistoryArchiveCoverageAuthority): boolean {
  return source.snapshot.workspaceId === config.workspaceId && scope.scopeId === config.scopeId && scope.keyEpoch === config.keyEpoch &&
    authority.scopeId === config.scopeId && authority.servicePublicKey === config.servicePublicKey && authority.policyRevision === config.policyRevision
}
function prepareNativeCapture(source: NativeHistorySource, signer: CaptureInput["signer"],
  receivedBasis: WasmVerifiedReceivedHistoryBaseline | null, previous: WasmVerifiedReceivedHistoryBaseline | null,
  transitionId: string, controlJson: Uint8Array, authorizationJson: Uint8Array[]) {
  const previousPayload = nativeBaselinePayload(previous), previousBaselineId = previousPayload?.baselineId ?? null
  if (previous && (typeof previousBaselineId !== "string" || previousBaselineId !== nativeBaselinePayload(receivedBasis)?.baselineId ||
      !Number.isSafeInteger(previousPayload?.historyEpoch))) throw new Error("Previous history baseline does not match its Native-verified basis")
  const historyEpoch = previous ? (previousPayload!.historyEpoch as number) + 1 : 1
  const preparation = receivedBasis ? WasmStateCore.prepareWorkspaceHistoryFromBasis(source, signer, receivedBasis) : WasmStateCore.prepareWorkspaceHistory(source, signer)
  const capture = preparation.captureOriginals(historyEpoch, controlJson, authorizationJson) as WasmVerifiedHistoryArchiveCapture
  return { historyEpoch, previousBaselineId, capture, rebase: capture.rebase(historyEpoch, transitionId) as WasmVerifiedHistoryRebase }
}

async function prepareCaptureArchives(work: CaptureWork): Promise<{ baselineId: string; wire: WireHistoryBaseline;
  encryptedObjects: Map<string, EncryptedArchiveObject> }> {
  const { config, transitionId, source, scope, authority, scopeAuthority, ensureCurrent, ensureNativeCurrent,
    previous, capture, rebase, data, dataIdentity, keyringRemote } = work
  const original = await prepareOriginalArchive(work)
  const basis = await prepareCompactBasis(work)
  const basisCoverage = await confirmArchiveCoverageSet(authority, basis.locators.root.root.ciphertextId,
    `${transitionId}-basis-set`, basis.coverageObjects,
    { coverage: keyringRemote.coverage, aggregate: keyringRemote.aggregate, ensureCurrent })
  const originalObjects = await journalObjects(data), originalDirectoryObjects = await journalObjects(original.directory)
  const previousAttestation: WasmVerifiedHistoryBaselineAttestation | null = previous?.proposalParent() ?? null
  const result = await finalizeWorkspaceHistoryBaseline({ config, capture, rebase, originalObjects, originalDirectoryObjects,
    retainUntilCheckpoint: Boolean(work.checkpointBeforeActivation),
    locatorRoot: original.locators.root, dataReceipt: original.receipt, directoryReceipt: original.locators.directory.coverage!,
    basis: { context: basis.context, reference: basis.reference, locatorRoot: basis.locators.root, coverage: basisCoverage },
    basisObjects: basis.coverageObjects.map(entry => ({ ciphertextId: entry.objectId, keyEpoch: entry.keyEpoch })),
    preparations: [dataIdentity, original.identity, basis.identity, basis.directoryIdentity], scope, authority, scopeAuthority,
    previous: previousAttestation, source, resolveSigningContext: work.resolveSigningContext, ensureCurrent, ensureNativeCurrent })
  const encryptedObjects = mergeEncryptedObjects([...originalObjects, ...original.directoryObjects, ...basis.dataObjects, ...basis.directoryObjects])
  return { baselineId: result.baselineId, wire: result.wire, encryptedObjects }
}

async function prepareOriginalArchive(work: CaptureWork) {
  const { config, transitionId, scope, ensureCurrent, ensureNativeCurrent, data, dataIdentity, captureKey, remote,
    capture, historyEpoch } = work
  const nativeCapture = capture as unknown as NativeCatalogueCapture
  const catalogue = await captureNativeCatalogue(captureKey, sink => nativeCapture.writeEncryptedCatalogue(scope.scopeId,
    scope.keyEpoch, scope.key, () => crypto.getRandomValues(new Uint8Array(12)), sink, ensureNativeCurrent), ensureCurrent) as Catalogue
  if (catalogue.context.workspaceId !== config.workspaceId || catalogue.context.historyEpoch !== historyEpoch ||
      catalogue.context.indexId !== "catalogue" || !catalogue.root?.objectId) throw new Error("Native history catalogue scope changed")
  for await (const entry of readNativeCatalogueObjects(captureKey, ensureCurrent)) {
    await data.stageSealed(scope, entry.binding, entry.sealed)
  }
  // The preparation journal now owns every sealed object. Keep the temporary
  // catalogue only when staging fails, so an interrupted retry can replay it.
  await discardNativeCatalogue(captureKey, ensureCurrent)
  const originalData = await coverPreparation(data, catalogue.root.objectId, remote)
  if (!originalData.coverage) throw new Error("Original history archive lacks complete Rusty coverage")
  const originalDirectoryIdentity = { ...dataIdentity, transitionId: `${transitionId}-directory` }
  const originalDirectory = createWorkspaceHistoryPreparation(originalDirectoryIdentity, ensureNativeCurrent)
  const originalLocators = await prepareArchiveLocators({ data, directory: originalDirectory, scope, remote, ensureCurrent })
  return { catalogue, receipt: originalData.coverage, identity: originalDirectoryIdentity, directory: originalDirectory, locators: originalLocators,
    directoryObjects: await journalObjects(originalDirectory) }
}
async function prepareCompactBasis(work: CaptureWork) {
  const { config, transitionId, scope, ensureNativeCurrent, ensureCurrent, remote, dataIdentity, rebase } = work
  const bytes = rebase.document(), sourceRevision = await sha256Base64Url(bytes)
  const identity = { ...dataIdentity, transitionId: `${transitionId}-basis-data`, sourceRevision }
  const data = createWorkspaceHistoryPreparation(identity, ensureNativeCurrent)
  await data.capture([bytes])
  const context = { workspaceId: config.workspaceId, historyEpoch: work.historyEpoch, indexId: "basis-document" }
  const reference: ArchiveBytesReference = await prepareEncryptedByteTree(data, scope, context, bytes, ensureCurrent)
  const state = await data.read()
  if (!state || state.phase !== "captured") throw new Error("Compact history preparation was not durably captured")
  const covered = await coverPreparation(data, reference.root.objectId, remote)
  if (!covered.coverage) {
    throw new Error("Compact history bytes lack complete Rusty coverage")
  }
  const directoryIdentity = { ...identity, transitionId: `${transitionId}-basis-directory` }
  const directory = createWorkspaceHistoryPreparation(directoryIdentity, ensureNativeCurrent)
  const locators = await prepareArchiveLocators({ data, directory, scope, remote, ensureCurrent })
  const dataObjects = await journalObjects(data), directoryObjects = await journalObjects(directory)
  const coverageObjects = [...dataObjects, ...directoryObjects].map(entry => ({ objectId: entry.ciphertextId, keyEpoch: scope.keyEpoch }))
    .sort((left, right) => left.objectId < right.objectId ? -1 : left.objectId > right.objectId ? 1 : 0)
  assertUniqueCoverageObjects(coverageObjects)
  return { context, reference, identity, directoryIdentity, locators, dataObjects, directoryObjects, coverageObjects }
}
function assertUniqueCoverageObjects(objects: Array<{ objectId: string }>): void {
  if (new Set(objects.map(item => item.objectId)).size !== objects.length) throw new Error("Compact history coverage set contains duplicate ciphertext")
}
function mergeEncryptedObjects(entries: Array<{ ciphertextId: string; object: EncryptedArchiveObject }>): Map<string, EncryptedArchiveObject> {
  const result = new Map<string, EncryptedArchiveObject>()
  for (const entry of entries) {
    const previous = result.get(entry.ciphertextId)
    if (previous && canonicalizeJson(previous) !== canonicalizeJson(entry.object)) throw new Error("History archive contains a ciphertext identifier collision")
    result.set(entry.ciphertextId, structuredClone(entry.object))
  }
  return result
}

async function activateCapturedHistory(work: CaptureWork, baselineId: string, wire: WireHistoryBaseline,
  encryptedObjects: Map<string, EncryptedArchiveObject>): Promise<void> {
  const { config, scope, authority, scopeAuthority, ensureCurrent, ensureNativeCurrent, receivedBasis, source } = work
  const candidate = await verifyReceivedWireHistoryBaseline({ wire, scope, pinnedStorage: authority,
    previous: receivedBasis, fetch: { ensureCurrent, download: async ciphertextId => {
      await ensureCurrent()
      const object = encryptedObjects.get(ciphertextId)
      if (!object) throw new Error("Prepared history ciphertext is missing from local durable storage")
      return structuredClone(object)
    } }, ensureCurrent: ensureNativeCurrent, trustedScopeAuthority: scopeAuthority })
  try {
    const repository = createReceivedHistoryBaselineRepository(config.workspaceId, ensureNativeCurrent)
    await defaultStorage.withWorkspaceTransaction(config.workspaceId, async transaction => {
      const active = await repository.readActive()
      if (active?.baselineId !== baselineId) {
        const currentBytes = await work.readCurrentWorkspaceBytes()
        await ensureCurrent()
        const capturedBytes = source.snapshot.document instanceof Uint8Array
          ? source.snapshot.document : new Uint8Array(source.snapshot.document)
        if (!equalBytes(currentBytes, capturedBytes)) throw new HistoryCaptureSourceChangedError(baselineId)
        const staged = await repository.readStaged()
        let stageId: string
        if (staged) {
          if (staged.baselineId !== baselineId) throw new Error("A different history baseline is already staged")
          stageId = staged.stageId
        } else {
          const expectedSnapshot = await readWorkspaceBasisSnapshot(config.workspaceId)
          await ensureCurrent()
          stageId = await repository.stage(candidate, expectedSnapshot ?? null, wire)
        }
        await work.checkpointBeforeActivation?.(candidate, wire)
        await ensureCurrent()
        if (!equalBytes(await work.readCurrentWorkspaceBytes(), capturedBytes)) throw new HistoryCaptureSourceChangedError(baselineId)
        if (work.checkpointBeforeActivation) await (await import("./historyBaselinePublicationRepository"))
          .commitPreparedHistoryPublication(config.workspaceId, work.transitionId, ensureNativeCurrent)
        await repository.activate(stageId, candidate, transaction)
      }
    })
  } finally {
    candidate.free()
  }
}

/** Build Native source from the app's materialized workspace bytes and current signed authority. */
export async function captureWorkspaceHistoryBaselineFromApp(input: {
  tincanban: ReturnType<typeof useTincanban>
  config: BlindReplicaConfig
  transitionId: string
  previousBaselineId: string | null
  scopeAuthority: unknown
  ensureCurrent: () => void | Promise<void>
  ensureNativeCurrent: () => void
  checkpointBeforeActivation?: CaptureInput["checkpointBeforeActivation"]
}): Promise<{ baselineId: string; wire: WireHistoryBaseline }> {
  const { tincanban, config, transitionId, ensureCurrent, ensureNativeCurrent } = input
  const { assertHistoryStorageCheckpointSupport } = await import("./blindHistoryCheckpoint")
  await assertHistoryStorageCheckpointSupport(config, ensureCurrent)
  const resumed = await (await import("./historyBaselinePublicationResume")).resumePublishedHistoryBaseline(input)
  if (resumed) return resumed
  const profile = captureProfile(tincanban)
  const { doc, bytes, authorization } = await loadCaptureSource(tincanban, config.workspaceId, profile, ensureCurrent)
  const source = nativeSource(config.workspaceId, bytes, authorization)
  await requireAdmittedWorkspaceEvidence(config.workspaceId, ensureCurrent)
  const certificates = [...authorization.authority.currentOwner.certificates,
    ...await defaultProofStore.listCertificates()].filter(certificate => certificate.payload.personId === profile.identity.personId)
  const scopeAuthority = structuredClone(input.scopeAuthority)
  const currentAuthority = captureAuthorityGuard(tincanban, config.workspaceId, profile, doc, ensureCurrent)
  const preparationSigner = await resolveLocalSigningContext(profile, "workspace-history-baseline",
    { workspaceId: config.workspaceId, transitionId },
    { certificates, currentAuthority, ensureCurrent, domain: "MESH-HISTORY/1", expiresAt: Date.now() + 60_000 })
  const verifiedCertificates = signingEvidence(preparationSigner).certificates
  const previous = await loadPreviousCaptureBasis(input, profile.identity.personId, ensureNativeCurrent)
  try {
    return await captureAndPublishWorkspaceHistoryBaseline({ config, transitionId, source,
      signer: { personId: profile.identity.personId, deviceId: profile.device.deviceId, certificates: verifiedCertificates },
      receivedBasis: previous, previous, scope: { scopeId: config.scopeId, keyEpoch: config.keyEpoch,
        key: decodeBlindBytes(config.contentKey) }, authority: { scopeId: config.scopeId,
        policyRevision: config.policyRevision, servicePublicKey: config.servicePublicKey }, scopeAuthority,
      resolveSigningContext: async binding => resolveLocalSigningContext(profile, "workspace-history-baseline", binding,
        { certificates, currentAuthority, ensureCurrent, domain: "MESH-HISTORY/1", expiresAt: Date.now() + 60_000 }),
      readCurrentWorkspaceBytes: () => tincanban.readWorkspaceBytes(config.workspaceId), ensureCurrent, ensureNativeCurrent,
      checkpointBeforeActivation: input.checkpointBeforeActivation })
  } finally { previous?.free() }
}

function captureProfile(tincanban: ReturnType<typeof useTincanban>) {
  const profile = tincanban.getCurrentProfile()
  if (!profile) throw new Error("Current identity is unavailable for history capture")
  return structuredClone(profile)
}

async function loadCaptureSource(tincanban: ReturnType<typeof useTincanban>, workspaceId: string,
  profile: ReturnType<typeof captureProfile>, ensureCurrent: () => void | Promise<void>) {
  const doc = await tincanban.readWorkspaceDoc(workspaceId)
  await ensureCurrent()
  if (tincanban.getActiveDoc()?.id !== workspaceId || await workspaceRole(doc, profile) !== "owner") {
    throw new Error("Only the current workspace owner may compact its history")
  }
  const bytes = await tincanban.readWorkspaceBytes(workspaceId)
  await ensureCurrent()
  if (!await checkpointAdmissionReady(tincanban, workspaceId, bytes)) {
    throw new Error("Workspace history has unresolved or unadmitted changes")
  }
  const authorization = await exportAuthorizationBundle(bytes, profile)
  await ensureCurrent()
  if (authorization.authority.currentOwner.personId !== profile.identity.personId) {
    throw new Error("Workspace owner changed during history capture")
  }
  return { doc, bytes, authorization }
}

function nativeSource(workspaceId: string, bytes: Uint8Array,
  authorization: Awaited<ReturnType<typeof exportAuthorizationBundle>>): NativeHistorySource {
  const { authority } = authorization
  return { records: authorization.records, snapshot: { workspaceId, genesisOwner: authority.genesisOwner,
    genesisEpoch: authority.genesisEpoch, expectedCurrentOwner: authority.currentOwner, document: bytes,
    ownershipTransfers: authority.ownershipTransfers, successionClaims: authority.successionClaims,
    revocations: authority.revocations, deviceRevocations: authority.deviceRevocations, departures: authority.departures }, nowMs: Date.now() }
}

async function requireAdmittedWorkspaceEvidence(workspaceId: string, ensureCurrent: () => void | Promise<void>): Promise<void> {
  const evidence = await defaultStorage.loadCausalEvidence(workspaceId)
  await ensureCurrent()
  if (evidence?.decisions.some(decision => decision.status.type !== "admitted")) {
    throw new Error("Workspace history contains changes that require review before compaction")
  }
}

function captureAuthorityGuard(tincanban: ReturnType<typeof useTincanban>, workspaceId: string,
  profile: ReturnType<typeof captureProfile>, doc: Awaited<ReturnType<ReturnType<typeof useTincanban>["readWorkspaceDoc"]>>,
  ensureCurrent: () => void | Promise<void>) {
  return async () => {
    await ensureCurrent()
    const currentDoc = await tincanban.readWorkspaceDoc(workspaceId)
    if (tincanban.getActiveDoc() !== doc || tincanban.getActiveDoc()?.id !== workspaceId ||
        currentDoc.ownerPersonId !== doc.ownerPersonId || await workspaceRole(currentDoc, profile) !== "owner") {
      throw new Error("Workspace ownership changed during history capture")
    }
    const current = await localWorkspaceAdmissionAuthority(currentDoc, profile)
    await ensureCurrent()
    return canonicalizeJson([current.fingerprint, current.authority.currentEpoch])
  }
}

async function loadPreviousCaptureBasis(input: { config: BlindReplicaConfig; previousBaselineId: string | null },
  personId: string, ensureNativeCurrent: () => void): Promise<WasmVerifiedReceivedHistoryBaseline | null> {
  const publication = await import("./historyBaselinePublicationRepository").then(module =>
    module.readPublishedHistoryBaseline(input.config.workspaceId, structuredClone(input.config), ensureNativeCurrent))
  if ((publication?.baselineId ?? null) !== input.previousBaselineId) {
    throw new Error("Previous published history baseline changed before capture")
  }
  if (!input.previousBaselineId) return null
  const { reverifyActiveHistoryForWorkspace } = await import("./historyBaselineStartup")
  const previous = await reverifyActiveHistoryForWorkspace(input.config.workspaceId, personId, ensureNativeCurrent)
  if (!previous || nativeBaselinePayload(previous)?.baselineId !== input.previousBaselineId) {
    previous?.free()
    throw new Error("Previous active history basis could not be reverified")
  }
  return previous
}
