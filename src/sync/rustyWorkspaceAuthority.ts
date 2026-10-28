import { load, free } from "@automerge/automerge/slim"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { WorkspaceWriteAuthorityEvidence, IncomingAuthorizationBundle } from "../product-replica"
import { defaultStorage } from "../storage"
import { peerStore, type WorkspaceAuthorityRecord } from "./peerStore"
import type { BlindReplicaConfig } from "./blindReplication"
import { readRustyOwnerWorkspaceScopeAuthority } from "./rustyIdentityTransport"

type ScopeView = { scopeId: string; creator: WorkspaceWriteAuthorityEvidence["genesisOwner"];
  controller: WorkspaceWriteAuthorityEvidence["currentOwner"]; controlEpoch: number }

/** Bootstrap from Rusty's signed ledger, never from a catalog reference or the local profile alone. */
export async function ensureOwnedRustyWorkspaceAuthority(config: BlindReplicaConfig, profile: LocalProfile,
  ensureCurrent: () => void): Promise<WorkspaceAuthorityRecord | undefined> {
  if (config.boardAccess) return
  const existing = await peerStore.getWorkspaceAuthority(config.workspaceId)
  if (existing) return existing
  const accepted = await readRustyOwnerWorkspaceScopeAuthority(profile, config, ensureCurrent)
  const view = meshRustRuntime().state.validateScopeAuthority(accepted.snapshot, Date.now()) as ScopeView
  const history = [view.creator, ...((accepted.snapshot as {
    controlTransfers?: Array<{ payload: { toController: ScopeView["controller"] } }>
  }).controlTransfers ?? []).map(record => record.payload.toController)]
  const record: WorkspaceAuthorityRecord = { version: 1, workspaceId: config.workspaceId,
    genesisOwnerPersonId: view.creator.personId, ownerPersonId: view.controller.personId,
    ownerPublicKey: view.controller.publicKey, ownerCertificates: view.controller.certificates,
    ownerHistory: history.filter(owner => owner.personId !== view.controller.personId), epoch: view.controlEpoch,
    updatedAt: new Date().toISOString(), catalog: {},
    scopeAuthoritySnapshot: accepted.snapshot as WorkspaceAuthorityRecord["scopeAuthoritySnapshot"] }
  ensureCurrent()
  await defaultStorage.withWorkspaceAuthorityMutation(config.workspaceId,
    context => context.write(() => { ensureCurrent(); return peerStore.putWorkspaceAuthority(record) }))
  return record
}

/** Call after full signed document/history admission; retain its verified workspace proof projection for future writes. */
export async function rememberAdmittedRustyWorkspaceAuthority(config: BlindReplicaConfig, bytes: Uint8Array,
  authorization: unknown, ensureCurrent: () => void): Promise<void> {
  if (config.boardAccess) return
  const current = await peerStore.getWorkspaceAuthority(config.workspaceId)
  if (!current?.scopeAuthoritySnapshot) return
  const view = meshRustRuntime().state.validateScopeAuthority(current.scopeAuthoritySnapshot, Date.now()) as ScopeView
  const bundle = authorization as IncomingAuthorizationBundle
  const document = load<WorkspaceDocumentV2>(bytes)
  let evidence: WorkspaceWriteAuthorityEvidence
  try {
    if (document.id !== config.workspaceId) throw new Error("Admitted workspace binding changed")
    evidence = meshRustRuntime().state.prepareWriteEvidence({ incoming: bundle.authority, known: null,
      records: bundle.version === 1 ? bundle.records : bundle.pages.flat(),
      genesisPersonId: view.creator.personId, remoteOwnerPersonId: document.ownerPersonId }) as WorkspaceWriteAuthorityEvidence
  } finally { free(document) }
  if (evidence.genesisOwner.publicKey !== view.creator.publicKey || evidence.currentOwner.personId !== view.controller.personId ||
      evidence.currentOwner.publicKey !== view.controller.publicKey || evidence.currentEpoch !== view.controlEpoch) {
    throw new Error("Admitted workspace ownership differs from Rusty's signed controller")
  }
  const record: WorkspaceAuthorityRecord = { ...current, ownerCertificates: evidence.currentOwner.certificates,
    catalog: { ownershipTransfers: evidence.ownershipTransfers, successionClaims: evidence.successionClaims,
      revocations: evidence.revocations, departures: evidence.departures,
      deviceRevocations: evidence.deviceRevocations.map(entry => ({ record: entry.record, authority: entry.signer })) } }
  ensureCurrent()
  await defaultStorage.withWorkspaceAuthorityMutation(config.workspaceId, async context => {
    const saved = await peerStore.getWorkspaceAuthority(config.workspaceId)
    ensureCurrent()
    if (canonicalizeJson(saved) === canonicalizeJson(record)) return
    await context.write(() => { ensureCurrent(); return peerStore.putWorkspaceAuthority(record) })
  })
}
