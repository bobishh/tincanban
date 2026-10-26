import * as Automerge from "@automerge/automerge/slim"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { OwnerReconnectAuthenticatedPeer, OwnerReconnectHistoryReader, OwnerReconnectSourceState,
  VerifiedOwnerReconnectWorkspace } from "@meta-uber/mesh-workspace"
import type { WorkspaceGrant, WorkspaceDocumentV2 } from "../domain/model"
import type { LocalProfile } from "../domain/identity"
import { canonicalizeJson, fromBase64Url, sha256Base64Url, verifyEnvelope } from "../domain/identity"
import { parseBoardStorageAccess } from "../domain/boardStorageAccess"
import { workspaceRole, exportAuthorizationBundle } from "../sync/changeAuthorization"
import { getReplicaConfigurations, setReplicaPreference } from "../sync/privateReplicaRepository"
import { assertReplicaCredentialsUnfrozen } from "../sync/replicaCredentialFreeze"
import { parseReplicaConfig } from "../sync/blindReplicaConfig"
import { verifyBoardStorageAccess } from "../sync/workspaceRustyAccess"
import { verifyDeviceChain } from "../sync/meshRecords"
import { peerStore } from "../sync/peerStore"
import { workspaceSet, type PeerHistoryObjectReader, type WorkspaceSetStore } from "../sync/workspaceSet"
import { capturePeerHistoryBaselineDescriptor } from "../sync/workspaceSetHistory"
import { readLocal, writeLocal } from "../localDb"
import { withLocalStateWriteLock } from "../localStateLock"

const receiptPrefix = "tincanban.owner-reconnect-receipt.v1:"

type WorkspaceEntry = { id?: unknown; bytes?: unknown; authorization?: unknown; historyBaseline?: unknown; [key: string]: unknown }
type OwnerReconnectReceipt = { version: 1; invitationId: string; workspaceId: string; offerDigest: string }

async function prepareOwnerReplicaConfig(profile: LocalProfile, workspaceId: string,
  verified: VerifiedOwnerReconnectWorkspace) {
  const incoming = parseReplicaConfig(JSON.stringify({ ...verified.replicaConfig, purpose: "workspace", cursor: 0, lastUploaded: "" }))
  if (incoming.workspaceId !== workspaceId || incoming.boardAccess) throw new Error("Verified owner storage configuration is invalid")
  const current = await getReplicaConfigurations(profile.identity.personId)
  const existing = current.find(config => config.workspaceId === workspaceId && !config.removalPending)
  const comparable = (config: typeof incoming) => Object.fromEntries(Object.entries(config)
    .filter(([key]) => !["cursor", "lastUploaded", "preferenceRevision", "boardAccess"].includes(key)))
  if (existing) {
    if (existing.boardAccess || canonicalizeJson(comparable(existing)) !== canonicalizeJson(comparable(incoming))) {
      throw new Error("Existing board storage settings conflict with this verified owner connection")
    }
  } else {
    await assertReplicaCredentialsUnfrozen(profile.identity.personId, incoming)
  }
  return { incoming, hasExisting: existing !== undefined }
}

function workspaceHistoryReader(history: OwnerReconnectHistoryReader): PeerHistoryObjectReader {
  return {
    ensureCurrent: history.ensureCurrent,
    readBaseline: async (workspaceId, baselineId) => {
      const baseline = await history.readBaseline(workspaceId, baselineId)
      return baseline === undefined ? undefined : capturePeerHistoryBaselineDescriptor(baseline)
    },
    readDocument: (descriptor, workspaceId) => history.readDocument(descriptor, workspaceId),
    read: (objectId, binding, baselineId) => history.read(objectId, binding, baselineId),
  }
}

function requireSourceGrant(value: unknown, workspaceId: string, personId: string): WorkspaceGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Current participant grant is unavailable")
  const grant = value as WorkspaceGrant
  if (grant.payload?.kind !== "workspace-grant" || grant.payload.version !== 1 ||
      grant.payload.workspaceId !== workspaceId || grant.payload.personId !== personId ||
      (grant.payload.role !== "editor" && grant.payload.role !== "visitor") ||
      typeof grant.signature !== "string" || typeof grant.signerKeyId !== "string") {
    throw new Error("Current participant grant is unavailable")
  }
  return grant
}
type ParticipantBoard = {
  credential: NonNullable<Awaited<ReturnType<typeof peerStore.getWorkspaceCredential>>>
  authority: NonNullable<Awaited<ReturnType<typeof peerStore.getWorkspaceAuthority>>>
  document: Uint8Array
  role: Awaited<ReturnType<typeof workspaceRole>>
}
type ParticipantStorage = { grant: WorkspaceGrant; replicaConfig: OwnerReconnectSourceState["replicaConfig"];
  ownerStorageProof: OwnerReconnectSourceState["ownerStorageProof"]; scopeAuthoritySnapshot: unknown }
type ParticipantBoardAuthorization = Pick<ParticipantBoard, "authority" | "role">

export function verifiedOwnerReconnectTitle(workspace: unknown): string {
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) throw new Error("Verified board snapshot is malformed")
  const entry = workspace as WorkspaceEntry
  if (typeof entry.bytes !== "string") throw new Error("Verified board snapshot is malformed")
  const doc = Automerge.load<WorkspaceDocumentV2>(fromBase64Url(entry.bytes))
  try { return typeof doc.title === "string" && doc.title.trim() ? doc.title : "Untitled board" }
  finally { Automerge.free(doc) }
}

export async function expectedOwnerForReconnect(input: { workspaceId: string; store: WorkspaceSetStore }): Promise<{ personId: string; publicKey: string }> {
  const [credential, authority] = await Promise.all([
    peerStore.getWorkspaceCredential(input.workspaceId), peerStore.getWorkspaceAuthority(input.workspaceId),
  ])
  if (!credential || !authority || credential.workspaceId !== input.workspaceId || authority.workspaceId !== input.workspaceId ||
      credential.ownerPersonId !== authority.ownerPersonId || credential.ownerPublicKey !== authority.ownerPublicKey) {
    throw new Error("Saved board owner authority is unavailable")
  }
  return { personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey }
}

export async function readOwnerReconnectSource(input: {
  profile: LocalProfile
  peer: OwnerReconnectAuthenticatedPeer
  workspaceId: string
  title: string
  store: WorkspaceSetStore
  ensureCurrent(): void | Promise<void>
}): Promise<OwnerReconnectSourceState> {
  await input.ensureCurrent()
  const board = await readParticipantBoard(input)
  if (board.role !== "editor" && board.role !== "visitor") throw new Error("Connect an owner device from a participant copy")
  if (!input.store.readAuthorization) throw new Error("Signed board history is unavailable on this device")
  const workspaceAuthority = await exportAuthorizationBundle(board.document, input.profile)
  const storage = await readParticipantStorage(input, board)
  const meshSnapshot = await workspaceSet(input.store, [{ id: input.workspaceId, title: input.title }]).snapshot()
  const entries = meshRustRuntime().state.decodeWorkspaceSet(meshSnapshot, [input.workspaceId]) as WorkspaceEntry[]
  if (entries.length !== 1 || entries[0]?.id !== input.workspaceId) throw new Error("Board snapshot changed during reconnect preparation")
  await input.ensureCurrent()
  const evidence = workspaceAuthority.authority
  const workspaceAccessSnapshot = {
    workspaceId: input.workspaceId,
    genesisOwner: evidence.genesisOwner,
    genesisEpoch: evidence.genesisEpoch,
    expectedCurrentOwner: evidence.currentOwner,
    document: board.document,
    ownershipTransfers: evidence.ownershipTransfers,
    successionClaims: evidence.successionClaims,
    revocations: evidence.revocations,
    deviceRevocations: evidence.deviceRevocations,
    departures: evidence.departures,
  }
  return {
    workspace: entries[0],
    workspaceAuthority,
    workspaceAccessSnapshot,
    scopeAuthoritySnapshot: board.authority.scopeAuthoritySnapshot ?? storage.scopeAuthoritySnapshot,
    grant: storage.grant,
    replicaConfig: storage.replicaConfig,
    ownerStorageProof: storage.ownerStorageProof,
    history: createHistorySource(input),
  }
}

async function readParticipantBoard(input: Parameters<typeof readOwnerReconnectSource>[0]): Promise<ParticipantBoard> {
  const credential = await peerStore.getWorkspaceCredential(input.workspaceId)
  const authority = await peerStore.getWorkspaceAuthority(input.workspaceId)
  if (!credential || credential.workspaceId !== input.workspaceId || !authority || authority.workspaceId !== input.workspaceId ||
      credential.ownerPersonId !== authority.ownerPersonId || credential.ownerPublicKey !== authority.ownerPublicKey) {
    throw new Error("Current board access is unavailable on this device")
  }
  if (input.peer.workspaceId !== input.workspaceId || input.peer.personId !== credential.ownerPersonId || !input.peer.deviceId) {
    throw new Error("Reconnect request is not from this board’s current owner")
  }
  const document = await input.store.read(input.workspaceId)
  await input.ensureCurrent()
  const doc = Automerge.load<WorkspaceDocumentV2>(document)
  let role: Awaited<ReturnType<typeof workspaceRole>>
  try {
    if (doc.id !== input.workspaceId || doc.ownerPersonId !== credential.ownerPersonId) {
      throw new Error("Current board authority does not match this copy")
    }
    role = await workspaceRole(doc, input.profile)
  } finally { Automerge.free(doc) }
  return { credential, authority, document, role }
}

async function readParticipantStorage(input: Parameters<typeof readOwnerReconnectSource>[0], board: ParticipantBoard): Promise<ParticipantStorage> {
  assertParticipantRole(board.role)
  const role = board.role
  const config = (await getReplicaConfigurations(input.profile.identity.personId))
    .find(value => value.workspaceId === input.workspaceId && !value.removalPending && value.boardAccess)
  if (!config?.boardAccess) throw new Error("Owner storage access is unavailable on this participant copy")
  const boardAccess = parseBoardStorageAccess(config.boardAccess)
  await verifyReconnectStorageAccess(config, boardAccess, board, role, input)
  const access = boardAccess.authorization.payload
  const grant = requireSourceGrant(access.workspaceGrant ?? board.credential.localGrant, input.workspaceId, input.profile.identity.personId)
  assertGrantMatchesBoard(access.ownerPersonId, grant, board.credential, input.workspaceId)
  if (!config.writeToken) throw new Error("This read-only copy does not contain the owner storage configuration needed to reconnect")
  const replicaConfig = parseReplicaConfig(JSON.stringify({
    purpose: "workspace", origin: access.connection.origin, scopeId: access.connection.scopeId,
    servicePublicKey: access.connection.servicePublicKey, readToken: access.connection.readToken,
    writeToken: config.writeToken, policyRevision: access.connection.policyRevision,
    workspaceId: input.workspaceId, keyEpoch: config.keyEpoch, contentKey: access.connection.contentKey,
    ...(config.historicalContentKeys ? { historicalContentKeys: config.historicalContentKeys } : {}),
    ...(config.historicalContentKeyVariants ? { historicalContentKeyVariants: config.historicalContentKeyVariants } : {}),
    ...(config.minimumWriterVersion === 2 ? { minimumWriterVersion: 2 } : {}),
    ...(access.connection.client ? { client: access.connection.client } : {}),
    ...(access.connection.clientBuild ? { clientBuild: access.connection.clientBuild } : {}),
    cursor: 0, lastUploaded: "",
  }))
  if (replicaConfig.workspaceId !== input.workspaceId || replicaConfig.boardAccess) {
    throw new Error("Owner storage configuration changed during reconnect preparation")
  }
  return { grant: grant as WorkspaceGrant, replicaConfig,
    ownerStorageProof: { authorization: boardAccess.authorization, certificates: boardAccess.certificates },
    scopeAuthoritySnapshot: access.scopeAuthority ?? board.authority.scopeAuthoritySnapshot }
}

function assertParticipantRole(role: ParticipantBoard["role"]): asserts role is "editor" | "visitor" {
  if (role !== "editor" && role !== "visitor") throw new Error("Connect an owner device from a participant copy")
}

async function verifyReconnectStorageAccess(config: Awaited<ReturnType<typeof getReplicaConfigurations>>[number],
  access: ReturnType<typeof parseBoardStorageAccess>, board: ParticipantBoard, role: "editor" | "visitor",
  input: Parameters<typeof readOwnerReconnectSource>[0]): Promise<void> {
  if (access.authorization.payload.version === 1) {
    await verifyRetainedOwnerStorage(config, access, board, input.workspaceId)
    return
  }
  await verifyBoardStorageAccess(config, input.workspaceId, board.authority, role,
    input.profile.identity.personId, input.profile.identity.publicKey)
}

function assertGrantMatchesBoard(ownerPersonId: string, grant: WorkspaceGrant,
  credential: ParticipantBoard["credential"], workspaceId: string): void {
  if (ownerPersonId !== credential.ownerPersonId || canonicalizeJson(grant) !== canonicalizeJson(credential.localGrant) ||
      grant.payload.workspaceId !== workspaceId) throw new Error("Current participant access does not match the signed board grant")
}

export async function verifyRetainedOwnerStorage(config: Awaited<ReturnType<typeof getReplicaConfigurations>>[number],
  access: ReturnType<typeof parseBoardStorageAccess>, board: ParticipantBoardAuthorization, workspaceId: string): Promise<void> {
  const record = access.authorization
  const payload = record.payload
  const owner = board.authority
  const scopeSnapshot = owner.scopeAuthoritySnapshot
  assertRetainedStorageFields(config, access, owner, workspaceId, scopeSnapshot)
  const state = meshRustRuntime().state
  const scope = state.validateScopeAuthority(scopeSnapshot, Date.now()) as {
    scopeId: string; controller: { personId: string; publicKey: string }
  }
  assertRetainedScopeConnection(config, payload.connection, scope, owner, workspaceId)
  const signerKey = await verifyDeviceChain({ personId: owner.ownerPersonId, publicKey: owner.ownerPublicKey,
    deviceId: record.signerKeyId, certificates: access.certificates })
  await verifyRetainedSignature(config, record, payload, signerKey, owner, state)
}

function assertRetainedStorageFields(config: Awaited<ReturnType<typeof getReplicaConfigurations>>[number],
  access: ReturnType<typeof parseBoardStorageAccess>, owner: ParticipantBoard["authority"], workspaceId: string,
  scopeSnapshot: unknown): asserts scopeSnapshot {
  const payload = access.authorization.payload
  if (payload.version === 1 && access.mode === "write" && config.workspaceId === workspaceId &&
      payload.workspaceId === workspaceId && payload.ownerPersonId === owner.ownerPersonId && config.writeToken &&
      scopeSnapshot) return
  throw new Error("Retained owner storage connection is incomplete")
}

function assertRetainedScopeConnection(config: Awaited<ReturnType<typeof getReplicaConfigurations>>[number],
  connection: unknown, scope: { scopeId: string; controller: { personId: string; publicKey: string } },
  owner: ParticipantBoard["authority"], workspaceId: string): void {
  if (scope.scopeId !== workspaceId || scope.controller.personId !== owner.ownerPersonId ||
      scope.controller.publicKey !== owner.ownerPublicKey || canonicalizeJson(storageConnection(config)) !== canonicalizeJson(connection)) {
    throw new Error("Retained owner storage connection differs from current Rusty authority")
  }
}

async function verifyRetainedSignature(config: Awaited<ReturnType<typeof getReplicaConfigurations>>[number],
  record: ReturnType<typeof parseBoardStorageAccess>["authorization"], payload: typeof record.payload,
  signerKey: string, owner: ParticipantBoard["authority"], state: ReturnType<typeof meshRustRuntime>["state"]): Promise<void> {
  if (state.isDeviceRevoked(owner, owner.ownerPersonId, record.signerKeyId) ||
      !await verifyEnvelope(record, signerKey) ||
      await sha256Base64Url(new TextEncoder().encode(config.writeToken)) !== payload.writeTokenHash) {
    throw new Error("Retained owner storage signature or token binding is invalid")
  }
}

function storageConnection(config: Awaited<ReturnType<typeof getReplicaConfigurations>>[number]) {
  const values = parseReplicaConfig(JSON.stringify(config))
  return Object.fromEntries(Object.entries(values).filter(([key]) =>
    !["boardAccess", "writeToken", "cursor", "lastUploaded", "preferenceRevision", "removalPending"].includes(key)))
}

function createHistorySource(input: Parameters<typeof readOwnerReconnectSource>[0]): OwnerReconnectSourceState["history"] {
  return {
    readBaseline: async (workspaceId, baselineId) => {
      await input.ensureCurrent()
      if (workspaceId !== input.workspaceId) throw new Error("History request changed workspace")
      return input.store.readHistoryBaseline?.(workspaceId, baselineId)
    },
    readDocument: async request => {
      await input.ensureCurrent()
      if (request.workspaceId !== input.workspaceId || !input.store.readHistoryBaselineDocument) {
        throw new Error("Board history document is unavailable")
      }
      const result = await input.store.readHistoryBaselineDocument(request, input.peer.deviceId)
      await input.ensureCurrent()
      return result
    },
    readObject: async request => {
      await input.ensureCurrent()
      if (request.workspaceId !== input.workspaceId || !input.store.readHistoryArchiveObject) {
        throw new Error("Board history archive is unavailable")
      }
      const result = await input.store.readHistoryArchiveObject(request.workspaceId, request.baselineId,
        request.objectId, request.binding, input.peer.deviceId)
      await input.ensureCurrent()
      return result
    },
  }
}

export async function persistVerifiedOwnerReconnect(input: {
  invitationId: string
  profile: LocalProfile
  store: WorkspaceSetStore
  workspaceId: string
  verified: VerifiedOwnerReconnectWorkspace
  history: OwnerReconnectHistoryReader
  ensureCurrent(): void | Promise<void>
}): Promise<void> {
  const { invitationId, workspaceId, verified, profile, store } = input
  if (verified.workspaceId !== workspaceId || !verified.offerDigest || !invitationId) {
    throw new Error("Verified board response is not bound to this reconnect")
  }
  const receiptKey = `${receiptPrefix}${profile.identity.personId}:${invitationId}`
  await withLocalStateWriteLock(receiptKey, async () => {
    const rawReceipt = await readLocal(receiptKey)
    if (rawReceipt !== null) {
      let receipt: OwnerReconnectReceipt
      try { receipt = JSON.parse(rawReceipt) as OwnerReconnectReceipt }
      catch { throw new Error("Saved owner reconnect receipt is invalid") }
      if (receipt.version !== 1 || receipt.invitationId !== invitationId || receipt.workspaceId !== workspaceId ||
          receipt.offerDigest !== verified.offerDigest) {
        throw new Error("This reconnect link was already used for a different board state")
      }
      return
    }
    await input.ensureCurrent()
    const entry = { ...(verified.workspace as WorkspaceEntry), authorization: verified.workspaceAuthority }
    if (entry.id !== workspaceId || typeof entry.bytes !== "string") throw new Error("Verified board snapshot is malformed")
    const { incoming, hasExisting } = await prepareOwnerReplicaConfig(profile, workspaceId, verified)
    const snapshot = meshRustRuntime().state.encodeWorkspaceSet([entry])
    const replica = workspaceSet(store, [{ id: workspaceId }])
    const history = workspaceHistoryReader(input.history)
    await replica.validate(snapshot, history)
    await input.ensureCurrent()
    await replica.receive(snapshot, true, history)
    await input.ensureCurrent()
    if (!store.recordVerifiedOwnerWorkspace) throw new Error("Owner board catalog is unavailable")
    await store.recordVerifiedOwnerWorkspace(workspaceId)
    await input.ensureCurrent()
    if (!hasExisting) await setReplicaPreference(profile.identity.personId, incoming)
    await input.ensureCurrent()
    await store.activate(workspaceId)
    const receipt: OwnerReconnectReceipt = { version: 1, invitationId, workspaceId, offerDigest: verified.offerDigest }
    await writeLocal(receiptKey, JSON.stringify(receipt))
    await input.ensureCurrent()
  })
}
