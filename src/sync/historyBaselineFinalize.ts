import { WasmVerifiedHistoryArchiveCapture, type WasmVerifiedHistoryArchiveCoverage, WasmVerifiedHistoryRebase,
  type WasmVerifiedHistoryArchiveStorage, type WasmVerifiedHistoryBaselineAttestation } from "@meta-uber/mesh-transport/wasm"
import { canonicalizeJson } from "../domain/identity"
import { signWithContext, assertSigningContextCurrent, signingEvidence, type VerifiedSigningContext } from "../domain/signingContext"
import { encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import type { ArchiveEncryptionScope, EncryptedArchiveObject } from "@meta-uber/mesh-replication/history-archive-crypto"
import type { ArchiveLocatorRoot } from "@meta-uber/mesh-replication/history-archive-locators"
import type { ArchiveCoverageAggregateReceipt, ArchiveCoverageAuthority as HistoryArchiveCoverageAuthority } from "@meta-uber/mesh-replication/history-archive-coverage"
import type { HistoryPreparationIdentity } from "@meta-uber/mesh-replication/history-preparation-journal"
import { verifyCompleteArchiveCoverage } from "@meta-uber/mesh-replication/history-archive-coverage-set"
import type { BlindReplicaConfig } from "./blindReplication"
import type { WireHistoryBaseline } from "../product-replica/historyBaselineReceiver"
import { publishWorkspaceHistoryRecord, retainPreparedHistoryPublication } from "./historyBaselinePublicationRepository"

const encoder = new TextEncoder()

type FinalizationInput = {
  retainUntilCheckpoint?: boolean
  config: BlindReplicaConfig
  capture: WasmVerifiedHistoryArchiveCapture
  rebase: WasmVerifiedHistoryRebase
  originalObjects: Iterable<{ ciphertextId: string; object: EncryptedArchiveObject }>
  originalDirectoryObjects: Iterable<{ ciphertextId: string; object: EncryptedArchiveObject }>
  locatorRoot: ArchiveLocatorRoot
  dataReceipt: ArchiveCoverageAggregateReceipt
  directoryReceipt: ArchiveCoverageAggregateReceipt
  basis: { context: WireHistoryBaseline["basis"]["context"]; reference: WireHistoryBaseline["basis"]["reference"];
    locatorRoot: ArchiveLocatorRoot; coverage: ArchiveCoverageAggregateReceipt }
  basisObjects: Array<{ ciphertextId: string; keyEpoch: number }>
  preparations: HistoryPreparationIdentity[]
  scope: ArchiveEncryptionScope
  authority: HistoryArchiveCoverageAuthority
  scopeAuthority: unknown
  previous?: WasmVerifiedHistoryBaselineAttestation | null
  source: unknown
  resolveSigningContext: (binding: Record<string, string | number>) => Promise<VerifiedSigningContext>
  ensureCurrent: () => void | Promise<void>
  ensureNativeCurrent: () => void
}

function assertFinalizationInput(input: FinalizationInput): void {
  if (!(input.capture instanceof WasmVerifiedHistoryArchiveCapture) || !(input.rebase instanceof WasmVerifiedHistoryRebase) ||
      typeof input.ensureCurrent !== "function" || typeof input.ensureNativeCurrent !== "function" ||
      !Array.isArray(input.preparations) || input.preparations.length < 2 ||
      input.config.workspaceId !== input.basis.context.workspaceId || input.scope.scopeId !== input.config.scopeId ||
      input.scope.keyEpoch !== input.config.keyEpoch || input.authority.scopeId !== input.config.scopeId ||
      input.authority.servicePublicKey !== input.config.servicePublicKey || input.authority.policyRevision !== input.config.policyRevision ||
      input.rebase.transitionId() !== input.preparations[0]?.transitionId) {
    throw new Error("History baseline publication inputs do not share one Rusty scope and Native transition")
  }
}

async function captureFinalizationObjects(input: FinalizationInput): Promise<Map<string, EncryptedArchiveObject>> {
  const objects = new Map<string, EncryptedArchiveObject>()
  for (const entry of [...input.originalObjects, ...input.originalDirectoryObjects]) {
    await input.ensureCurrent()
    if (!entry || typeof entry.ciphertextId !== "string" || objects.has(entry.ciphertextId)) {
      throw new Error("History baseline archive contains duplicate ciphertext")
    }
    objects.set(entry.ciphertextId, structuredClone(entry.object))
  }
  if (objects.size > 8192) throw new Error("History baseline archive exceeds its bounded object set")
  return objects
}

async function verifyBasisCoverage(input: FinalizationInput): Promise<void> {
  const basisObjects = structuredClone(input.basisObjects).sort((left, right) => left.ciphertextId < right.ciphertextId ? -1 :
    left.ciphertextId > right.ciphertextId ? 1 : 0)
  if (basisObjects.length < 1 || basisObjects.length > 8192 || basisObjects.some((entry, index) =>
    !/^[A-Za-z0-9_-]{43}$/.test(entry.ciphertextId) || entry.keyEpoch !== input.scope.keyEpoch ||
    index > 0 && basisObjects[index - 1]!.ciphertextId === entry.ciphertextId)) {
    throw new Error("Compact history basis coverage set is invalid")
  }
  await verifyCompleteArchiveCoverage(input.basis.coverage, input.authority,
    input.basis.locatorRoot.root.ciphertextId, basisObjects.map(entry => ({ objectId: entry.ciphertextId, keyEpoch: entry.keyEpoch })))
  await input.ensureCurrent()
}

function assertProposalSigner(signingContext: VerifiedSigningContext,
  proposal: { personId: string; deviceId: string; kind: string }): void {
  const evidence = signingEvidence(signingContext)
  if (proposal.personId !== signingContext.personId || proposal.deviceId !== signingContext.deviceId ||
      signingContext.purpose !== proposal.kind || signingContext.domain !== "MESH-HISTORY/1" ||
      evidence.identity.personId !== proposal.personId) throw new Error("Native history proposal does not match the current Owner signing context")
}

/** Join Native original evidence, exact storage receipts, compact basis coverage, and the current Owner signature. */
export async function finalizeWorkspaceHistoryBaseline(input: FinalizationInput): Promise<{ baselineId: string; wire: WireHistoryBaseline }> {
  const config = structuredClone(input.config)
  const scope = structuredClone(input.scope)
  const authority = structuredClone(input.authority)
  const scopeAuthority = structuredClone(input.scopeAuthority)
  const source = structuredClone(input.source)
  const previous = input.previous
  const ensureCurrent = input.ensureCurrent
  assertFinalizationInput(input)
  await ensureCurrent()
  const objects = await captureFinalizationObjects(input)
  const verifiedStorage = input.capture.verifyStorageDirectory(scope.scopeId, scope.keyEpoch, scope.key,
    structuredClone(input.locatorRoot), objects, input.ensureNativeCurrent) as WasmVerifiedHistoryArchiveStorage
  await ensureCurrent()
  const resources: { coverage?: WasmVerifiedHistoryArchiveCoverage; attestation?: WasmVerifiedHistoryBaselineAttestation } = {}
  try {
  resources.coverage = verifiedStorage.verifyCoverage(structuredClone(authority), input.preparations[0]!.transitionId,
    input.preparations[1]!.transitionId, encoder.encode(canonicalizeJson(input.dataReceipt)),
    encoder.encode(canonicalizeJson(input.directoryReceipt))) as WasmVerifiedHistoryArchiveCoverage
  const coverage = resources.coverage
  await ensureCurrent()
  await verifyBasisCoverage(input)
  const proposal = (previous ? input.capture.ownerAttestedProposalFromParent(input.rebase, coverage, scopeAuthority, previous) :
    input.capture.ownerAttestedProposal(input.rebase, coverage, scopeAuthority)) as {
    kind: string; version: number; workspaceId: string; baselineId: string; transitionId: string; personId: string; deviceId: string
  }
  if (proposal.kind !== "workspace-history-baseline" || proposal.version !== 2 ||
      proposal.workspaceId !== config.workspaceId || proposal.transitionId !== input.rebase.transitionId()) {
    throw new Error("Native history baseline proposal does not match its verified transition")
  }
  const signingContext = await input.resolveSigningContext({ workspaceId: proposal.workspaceId,
    historyEpoch: input.preparations[0]!.historyEpoch, transitionId: proposal.transitionId })
  const current = async () => {
    await ensureCurrent()
    await assertSigningContextCurrent(signingContext)
    await ensureCurrent()
  }
  assertProposalSigner(signingContext, proposal)
  const signed = await signWithContext(signingContext, proposal as { kind: string } & Record<string, unknown>)
  await current()
  const signedJson = encoder.encode(canonicalizeJson(signed))
  resources.attestation = (previous ? input.capture.confirmOwnerAttestedProposalFromParent(input.rebase, coverage, scopeAuthority, previous, signedJson, source) :
    input.capture.confirmOwnerAttestedProposal(input.rebase, coverage, scopeAuthority, signedJson, source)) as WasmVerifiedHistoryBaselineAttestation
  const attestation = resources.attestation
  await current()
  const envelope = attestation.envelope() as { payload?: { baselineId?: unknown; workspaceId?: unknown } }
  const baselineId = envelope.payload?.baselineId
  if (typeof baselineId !== "string" || envelope.payload?.workspaceId !== config.workspaceId) {
    throw new Error("Native confirmed a malformed history baseline")
  }
  const wire: WireHistoryBaseline = { version: 1, signedJson: encodeBlindBytes(signedJson),
    basis: { ...structuredClone(input.basis), coverage: structuredClone(input.basis.coverage) } }
  const preparations = input.preparations.map(identity => structuredClone(identity))
  const publish = input.retainUntilCheckpoint ? retainPreparedHistoryPublication : publishWorkspaceHistoryRecord
  await publish({ workspaceId: config.workspaceId, publicationId: input.rebase.transitionId(), wire, preparations },
    input.ensureNativeCurrent)
  await current()
  return { baselineId, wire }
  } finally {
    resources.attestation?.free()
    resources.coverage?.free()
    verifiedStorage.free()
  }
}
