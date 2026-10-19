import * as Automerge from "@automerge/automerge/slim"
import { WasmStateCore, type WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { computeWorkspaceDocumentAdmission, type IncomingAuthorizationBundle, type WorkspaceWriteAuthorityEvidence } from "./workspaceAdmission"

/** Historical issuer evidence never substitutes for a currently authorized owner or a live execution grant. */
export function admitHistoricalAutomationAuthority(input: {
  workspaceId: string; epoch: number; bytes: Uint8Array; authorization: unknown; receivedBasis?: WasmVerifiedReceivedHistoryBaseline
}) {
  const captured = { ...input, bytes: input.bytes.slice(), authorization: structuredClone(input.authorization) }
  const bundle = historicalBundle(captured.authorization)
  const document = Automerge.load<WorkspaceDocumentV2>(captured.bytes)
  try {
    const records = bundle.version === 1 ? bundle.records : bundle.pages.flat()
    const authority = WasmStateCore.prepareWriteEvidence({ incoming: bundle.authority, known: null, records,
      genesisPersonId: document.ownerPersonId, remoteOwnerPersonId: document.ownerPersonId }) as WorkspaceWriteAuthorityEvidence
    if (authority.currentOwner.personId !== bundle.authority.currentOwner.personId ||
      authority.currentOwner.publicKey !== bundle.authority.currentOwner.publicKey) {
      throw new Error("Automation ownership history does not match its current owner")
    }
    const admission = computeWorkspaceDocumentAdmission({ workspaceId: captured.workspaceId,
      authorization: { ...bundle, authority }, receivedBasis: captured.receivedBasis, knownAuthority: null, now: Date.now() }, WasmStateCore as never, document)
    if (admission.pendingHashes.length || admission.quarantinedHashes.length || admission.admittedHashes.length !== admission.neededHashes.length) {
      throw new Error("Automation approval history is not fully authorized")
    }
    const issuer = issuerAtEpoch(authority, captured.epoch)
    return { issuer, authority, admission,
      requireCurrentOwner(identity: WorkspaceWriteAuthorityEvidence["currentOwner"], deviceId: string) {
        const role: unknown = WasmStateCore.decideWorkspaceAccess({ snapshot: {
          workspaceId: captured.workspaceId, genesisOwner: authority.genesisOwner, genesisEpoch: authority.genesisEpoch,
          expectedCurrentOwner: authority.currentOwner, document: Array.from(captured.bytes),
          ownershipTransfers: authority.ownershipTransfers, successionClaims: authority.successionClaims,
          revocations: authority.revocations, deviceRevocations: authority.deviceRevocations, departures: authority.departures,
        }, identity: structuredClone(identity), deviceId, departures: authority.departures, legacyAuthorityEvidence: [] }, Date.now())
        if (role !== "owner") throw new Error("Only a currently authorized owner device can renew automation approval")
      },
    }
  } finally { Automerge.free(document) }
}

function historicalBundle(value: unknown): IncomingAuthorizationBundle {
  if (!value || typeof value !== "object") throw new Error("Complete automation ownership history is required")
  const bundle = value as IncomingAuthorizationBundle
  const authority = bundle.authority
  if (!(bundle.version === 1 && Array.isArray(bundle.records) || bundle.version === 2 && Array.isArray(bundle.pages) && bundle.pages.every(Array.isArray)) ||
    !authority?.genesisOwner || !authority.currentOwner || !Number.isSafeInteger(authority.genesisEpoch) ||
    !Number.isSafeInteger(authority.currentEpoch) || ![authority.ownershipTransfers, authority.successionClaims,
      authority.revocations, authority.deviceRevocations, authority.departures].every(Array.isArray)) {
    throw new Error("Complete automation ownership history is required")
  }
  return bundle
}

/** Select only after native admission validates every ownership boundary and signature. */
function issuerAtEpoch(authority: WorkspaceWriteAuthorityEvidence, epoch: number) {
  if (!Number.isSafeInteger(epoch) || epoch < authority.genesisEpoch || epoch > authority.currentEpoch) {
    throw new Error("Automation grant epoch is outside admitted ownership history")
  }
  const transitions = [...authority.ownershipTransfers, ...authority.successionClaims]
    .filter(record => record.payload.epoch <= epoch).sort((left, right) => left.payload.epoch - right.payload.epoch)
  const latest = transitions.at(-1)?.payload
  return latest ? { personId: latest.toOwnerPersonId, publicKey: latest.toOwnerPublicKey, certificates: latest.toOwnerCertificates }
    : authority.genesisOwner
}
