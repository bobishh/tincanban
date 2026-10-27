import { decodePairingFrame, encodePairingFrame, inspectPairingFrame, type DeviceEnrollmentInvitation } from "@meta-uber/mesh-pairing"
import type { Context } from "@opentelemetry/api"
import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { registerWorkspaceInRoot } from "../domain/personalRoot"
import { defaultStorage } from "../storage"
import { compareAndSwapLocal } from "../localDb"
import { planPersonalRootUpdate } from "../storagePersonalRoot"
import { changeReplicaPreference, portableReplicaState, type PrivateReplicaState } from "./privateReplicaPreferences"
import { exportPrivateReplicaState, getIdentityReplicaConfigurations, getReplicaConfigurations,
  planPrivateReplicaImport } from "./privateReplicaRepository"
import { identityDevicePreferencesChanged } from "./identityDevicePreferenceEvents"
import { assertReplicaCredentialsUnfrozen } from "./replicaCredentialFreeze"
import { assertActiveIdentityEnrollmentDevice, createSamePersonWorkspaceBootstrap, preflightSamePersonWorkspaceBootstrap,
  type EnrollmentRequestInfo } from "./enrollment"
import { readIdentityAuthorityView, mergeIdentityAuthorityView } from "./identityAuthorityStore"
import { createPeerHistoryObjectReader, workspaceSet, type PeerHistoryObjectReader } from "./workspaceSet"
import { createEnrollmentHistoryAuthorizationGuard } from "./enrollmentHistoryAuthorization"
import { readPeerHistoryRequestOrPairing } from "./peerHistoryTransport"
import { createEnrollmentHistoryReader } from "./enrollmentHistoryReader"
import { awaitEnrollmentAcknowledgement, enrollmentRejection } from "./enrollmentAcknowledgement"
import { peerStore } from "./peerStore"
import type { SyncConnection, SyncNode } from "./transport"
import type { DurableMesh } from "./durableMesh"
import type { WorkspaceSetStore } from "./workspaceSet"
import type { EnrollmentContext } from "./deviceSyncEnrollment"
import { traceEnrollment, traceEnrollmentOperation } from "./enrollmentDiagnostics"

function isCurrent(context: EnrollmentContext, run: number) {
  return context.currentRun() === run
}

export function selectActiveWorkspace(context: EnrollmentContext, ids: string[]) {
  const requested = context.activeWorkspaceId?.()
  return requested && ids.includes(requested) ? requested : ids[0]!
}

export async function approveSamePersonWorkspace(context: EnrollmentContext, run: number, node: SyncNode,
  stream: Awaited<ReturnType<SyncConnection["acceptStream"]>>, connection: SyncConnection, secret: string,
  invite: DeviceEnrollmentInvitation, profile: LocalProfile, guest: EnrollmentRequestInfo,
  diagnosticContext?: Context) {
  const workspaceId = selectActiveWorkspace(context, context.availableWorkspaces.map(item => item.id))
  const workspace = context.availableWorkspaces.find(item => item.id === workspaceId)
  if (!workspace || !context.durableMesh) throw new Error("Selected workspace is unavailable for device sync")
  if (await context.workspaceOwner?.(workspaceId) !== profile.identity.personId) {
    throw new Error("Only the current workspace owner can add this Identity device")
  }
  await serveApprovedIdentityWorkspace({ profile, workspace, mesh: context.durableMesh,
    store: context.meshWorkspaceStore ?? context.workspaceStore!, endpoint: node.endpointId,
    getProfile: context.getProfile, isCurrent: () => isCurrent(context, run), stream, connection, invite, guest })
  context.state.step.value = "enroll-host-done"
  void diagnosticContext
}

type WorkspaceTransferSession = {
  profile: LocalProfile
  mesh: DurableMesh
  store: WorkspaceSetStore
  endpoint?: string
  getProfile(): Promise<LocalProfile>
  isCurrent(): boolean
  connection: SyncConnection
  invite: DeviceEnrollmentInvitation
}

/** Reuse the signed bootstrap for an already approved Identity device, including boards without storage. */
export async function serveApprovedIdentityWorkspace(input: WorkspaceTransferSession & {
  workspace: { id: string; title: string }
  stream: Awaited<ReturnType<SyncConnection["acceptStream"]>>
  guest: EnrollmentRequestInfo
}) {
  const { profile, workspace, mesh, store, endpoint, connection, invite, stream, guest } = input
  const workspaceId = workspace.id
  const secret = invite.secret
  const ensureCurrent = () => { if (!input.isCurrent()) throw new Error("Identity workspace transfer was cancelled") }
  const authorityView = await currentSamePersonEnrollmentAuthority(invite, profile, guest, ensureCurrent)
  const root = await defaultStorage.loadPersonalRoot()
  const reference = root?.identity.personId === profile.identity.personId ? root.workspaces[workspaceId] : undefined
  if (!reference || reference.forgotten) throw new Error("Selected workspace is not in the current Identity catalog")
  const storage = (await getReplicaConfigurations(profile.identity.personId)).filter(config => config.workspaceId === workspaceId)
  const identityStorage = (await getIdentityReplicaConfigurations(profile.identity.personId)).filter(config =>
    storage.some(workspaceConfig => workspaceConfig.origin === config.origin &&
      workspaceConfig.servicePublicKey === config.servicePublicKey))
  if (identityStorage.length !== new Set(storage.map(config => config.origin)).size) {
    throw new Error("Connect the selected Rusty service to Identity profile sync before adding this device")
  }
  const assertStorageUnfrozen = async () => {
    for (const config of [...storage, ...identityStorage]) {
      await assertReplicaCredentialsUnfrozen(profile.identity.personId, config)
    }
  }
  await assertStorageUnfrozen()
  await mesh.ensureOwnerWorkspaces([workspaceId], endpoint ?? await mesh.prepareOwnerWorkspaceTransfer(workspaceId), profile)
  const grant = await mesh.enrollmentGrant(workspaceId, profile)
  const grants = grant ? [grant] : []
  ensureCurrent()
  const meshWorkspaces = await mesh.invitationPayload([workspaceId])
  const authorities = await mesh.validateInvitation(meshWorkspaces, [workspaceId], profile, grants)
  if (storage.length && !authorities.has(workspaceId)) throw new Error("Current workspace scope authority is required for device sync")
  ensureCurrent()
  const replica = workspaceSet(store, [workspace])
  const snapshot = await replica.snapshot()
  const historyGuard = createEnrollmentHistoryAuthorizationGuard({ workspaceIds: [workspaceId], profile,
    remoteDeviceId: guest.deviceId, isCurrent: input.isCurrent, readProfile: input.getProfile,
    readCredential: async id => (await peerStore.getWorkspaceCredential(id)) ?? undefined })
  const acknowledgementHistory = createEnrollmentHistoryReader(store, [workspaceId], guest.deviceId, historyGuard)
  await historyGuard()
  const payload = await createSamePersonWorkspaceBootstrap({ invite, profile, recipientDeviceId: guest.deviceId,
    recipientPublicKey: guest.publicKey, authorityView, workspace: { id: workspaceId, title: workspace.title, reference },
    meshWorkspaces, grants, storage, identityStorage, snapshot })
  await historyGuard()
  await assertStorageUnfrozen()
  await stream.send(encodePairingFrame("enroll-approved", secret, payload))
  await stream.closeSend()
  await completeEnrollmentApproval(connection, replica, guest.deviceId, secret, historyGuard, acknowledgementHistory,
    "The new device rejected workspace sync")
}

async function currentSamePersonEnrollmentAuthority(invite: DeviceEnrollmentInvitation, profile: LocalProfile,
  guest: EnrollmentRequestInfo, ensureCurrent: () => void) {
  const requestView = guest.identityAuthorityView
  if (!requestView || invite.issuerPersonId !== profile.identity.personId) {
    throw new Error("Current Identity authority view is required for same-person device sync")
  }
  ensureCurrent()
  const currentView = await readIdentityAuthorityView(profile.identity.personId)
  if (!currentView) throw new Error("Current Identity authority view is required for same-person device sync")
  const accepted = await assertActiveIdentityEnrollmentDevice(currentView, requestView, profile.identity.personId,
    guest.deviceId, guest.publicKey)
  await assertActiveIdentityEnrollmentDevice(accepted.authorityView, accepted.authorityView,
    profile.identity.personId, profile.device.deviceId, profile.device.publicKey)
  await mergeIdentityAuthorityView(accepted.authorityView, ensureCurrent)
  ensureCurrent()
  const authorityView = await readIdentityAuthorityView(profile.identity.personId)
  if (!authorityView) throw new Error("Current Identity authority view is unavailable")
  const currentTarget = await assertActiveIdentityEnrollmentDevice(authorityView, authorityView,
    profile.identity.personId, guest.deviceId, guest.publicKey)
  await assertActiveIdentityEnrollmentDevice(currentTarget.authorityView, currentTarget.authorityView,
    profile.identity.personId, profile.device.deviceId, profile.device.publicKey)
  return authorityView
}

export async function completeEnrollmentApproval(connection: SyncConnection, replica: ReturnType<typeof workspaceSet>,
  remoteDeviceId: string, secret: string, historyGuard: () => Promise<void>, acknowledgementHistory: PeerHistoryObjectReader,
  rejectionMessage: string) {
  let ack: Awaited<ReturnType<typeof connection.acceptStream>> | undefined
  let acknowledgement: Uint8Array | undefined
  for (let rounds = 0; rounds < 4096; rounds++) {
    const incoming = await connection.acceptStream()
    const frame = await readPeerHistoryRequestOrPairing(incoming)
    await historyGuard()
    if (await replica.servePeerHistoryBaselineRead(frame, incoming, remoteDeviceId, historyGuard)) continue
    if (await replica.servePeerHistoryDocumentRead(frame, incoming, remoteDeviceId, historyGuard)) continue
    if (await replica.servePeerHistoryObjectRead(frame, incoming, remoteDeviceId, historyGuard)) continue
    if (await replica.serveProofPage(frame, incoming, secret, historyGuard)) continue
    ack = incoming
    acknowledgement = frame
    break
  }
  if (!ack || !acknowledgement) throw new Error("Enrollment proof reply limit exceeded")
  if (inspectPairingFrame(acknowledgement).type === "enroll-rejected") {
    const reason = enrollmentRejection(decodePairingFrame(acknowledgement, "enroll-rejected", secret))
    await ack.send(encodePairingFrame("enroll-rejected-ack", secret, new Uint8Array()))
    await ack.closeSend()
    throw new Error(`${rejectionMessage}: ${reason}`)
  }
  await replica.receive(await replica.resolveProofs(decodePairingFrame(acknowledgement, "enroll-ack", secret), connection, secret),
    true, acknowledgementHistory)
  await historyGuard()
  await ack.send(encodePairingFrame("enroll-complete", secret, new Uint8Array()))
  await ack.closeSend()
  const confirmation = await connection.acceptStream()
  decodePairingFrame(await confirmation.read(), "mesh-handoff-confirmed", secret)
}

export async function receiveSamePersonWorkspaceBootstrap(context: EnrollmentContext, run: number, node: SyncNode,
  connection: SyncConnection, invite: DeviceEnrollmentInvitation, profile: LocalProfile, bytes: Uint8Array) {
  if (!context.durableMesh || !context.workspaceStore) throw new Error("Device sync is unavailable")
  await receiveApprovedIdentityWorkspace({ profile, mesh: context.durableMesh,
    store: context.meshWorkspaceStore ?? context.workspaceStore, endpoint: node.endpointId, connection, invite, bytes,
    getProfile: context.getProfile, isCurrent: () => isCurrent(context, run), received: async workspaceId => {
      await context.workspaceStore!.activate(workspaceId)
      await context.identityChanged?.()
    }, handoff: async () => {
      await context.handoffNode("Enrollment finished")
      await context.durableMesh!.waitUntilListening()
    } })
  context.state.step.value = "enroll-guest-done"
  traceEnrollment(invite, "guest", "completed", run, { workspaces: 1 })
  if (typeof window !== "undefined") window.history.replaceState(window.history.state, "", "/")
}

/** Verify history before activating credentials; the same retained offer can retry after interruption. */
export async function receiveApprovedIdentityWorkspace(input: WorkspaceTransferSession & {
  bytes: Uint8Array
  expectedWorkspaceId?: string
  received?(workspaceId: string): Promise<void>
  handoff?(): Promise<void>
}) {
  const { profile, mesh, store, endpoint, connection, invite, bytes } = input
  const requestView = await readIdentityAuthorityView(profile.identity.personId)
  if (!requestView) throw new Error("Current Identity authority view is required for same-person device sync")
  const prepared = await preflightSamePersonWorkspaceBootstrap(bytes, invite, profile, requestView)
  const workspaceId = prepared.workspace.id
  if (input.expectedWorkspaceId && workspaceId !== input.expectedWorkspaceId) throw new Error("Identity peer returned another workspace")
  const workspaceIds = [workspaceId]
  const ensureCurrent = () => { if (!input.isCurrent()) throw new Error("Identity workspace transfer was cancelled") }
  ensureCurrent()
  const scopes = await mesh.validateInvitation(prepared.meshWorkspaces, workspaceIds, profile, prepared.grants)
  if (prepared.storage.length && !scopes.has(workspaceId)) throw new Error("Current workspace authority is required for device sync")
  const replica = workspaceSet(store, [{ id: workspaceId, title: prepared.workspace.title }])
  const snapshot = await replica.resolveProofs(prepared.snapshot, connection, invite.secret)
  const historyReader = createPeerHistoryObjectReader(connection, ensureCurrent, scopes)
  await replica.validate(snapshot, historyReader)
  ensureCurrent()
  const historyGuard = createEnrollmentHistoryAuthorizationGuard({ workspaceIds, profile,
    remoteDeviceId: invite.issuerDeviceId, isCurrent: input.isCurrent, readProfile: input.getProfile,
    readCredential: async id => (await peerStore.getWorkspaceCredential(id)) ?? undefined })
  await mergeIdentityAuthorityView(prepared.authorityView, ensureCurrent)
  await traceEnrollmentOperation(invite, "guest.receive-workspace", () => replica.receive(snapshot, true, historyReader))
  await persistThenReceiveSamePersonWorkspace(profile, prepared, ensureCurrent, mesh)
  await historyGuard()
  const envelope = prepared.meshWorkspaces[0] as { ownerPersonId?: unknown }
  if (envelope.ownerPersonId === profile.identity.personId) {
    if (endpoint) await mesh.ensureOwnerWorkspaces(workspaceIds, endpoint, profile)
    else await mesh.prepareOwnerWorkspaceTransfer(workspaceId)
  }
  await input.received?.(workspaceId)
  const ack = await connection.openStream()
  await ack.send(encodePairingFrame("enroll-ack", invite.secret, await replica.snapshot()))
  await ack.closeSend()
  await awaitEnrollmentAcknowledgement(connection, ack, replica, invite.secret, ensureCurrent)
  await input.handoff?.()
  const confirmation = await connection.openStream()
  await confirmation.send(encodePairingFrame("mesh-handoff-confirmed", invite.secret, new Uint8Array()))
  await confirmation.closeSend()
  return workspaceId
}

export async function persistThenReceiveSamePersonWorkspace(profile: LocalProfile,
  prepared: Awaited<ReturnType<typeof preflightSamePersonWorkspaceBootstrap>>, ensureCurrent: () => void,
  durableMesh: Pick<NonNullable<EnrollmentContext["durableMesh"]>, "receiveInvitation">) {
  await persistSamePersonWorkspaceAccess(profile, prepared, ensureCurrent)
  await durableMesh.receiveInvitation(prepared.meshWorkspaces, [prepared.workspace.id], profile, prepared.grants)
}

async function persistSamePersonWorkspaceAccess(profile: LocalProfile,
  prepared: Awaited<ReturnType<typeof preflightSamePersonWorkspaceBootstrap>>, ensureCurrent: () => void) {
  const personId = profile.identity.personId
  const { workspace, storage, identityStorage } = prepared
  const rootPlan = await planPersonalRootUpdate(personId, current => {
    if (!current || current.identity.publicKey !== profile.identity.publicKey) throw new Error("Local Identity catalog is unavailable")
    const existing = current.workspaces[workspace.id]
    if (existing) {
      if (existing.forgotten || existing.documentId !== workspace.reference.documentId || existing.grantHash !== workspace.reference.grantHash) {
        throw new Error("Workspace catalog conflicts with the approved device bootstrap")
      }
      return current
    }
    registerWorkspaceInRoot(current, workspace.id, workspace.reference.documentId, workspace.reference.grantHash)
    return current
  })
  let replicaState: PrivateReplicaState = { ...await exportPrivateReplicaState(personId), actorId: crypto.randomUUID(), progress: {} }
  let replicaChanged = false
  const currentConfigs = await getReplicaConfigurations(personId)
  const currentIdentityConfigs = await getIdentityReplicaConfigurations(personId)
  const portable = (config: object) => {
    const value = { ...config, cursor: 0, lastUploaded: "" } as Record<string, unknown>
    delete value.preferenceRevision
    return value
  }
  for (const incoming of storage) {
    await assertReplicaCredentialsUnfrozen(personId, incoming)
    const sameScope = currentConfigs.find(config => config.origin === incoming.origin && config.scopeId === incoming.scopeId)
    const sameWorkspace = currentConfigs.find(config => config.origin === incoming.origin && config.workspaceId === workspace.id)
    if (sameScope) {
      if (canonicalizeJson(portable(sameScope)) !== canonicalizeJson(portable(incoming))) {
        throw new Error("Existing Rusty workspace access conflicts with the approved device bootstrap")
      }
      continue
    }
    if (sameWorkspace) throw new Error("Another Rusty scope is already connected to this workspace on this device")
    replicaState = changeReplicaPreference({ ...replicaState, actorId: crypto.randomUUID(), progress: {} }, incoming)
    replicaChanged = true
  }
  for (const incoming of identityStorage) {
    await assertReplicaCredentialsUnfrozen(personId, incoming)
    const existing = currentIdentityConfigs.find(config => config.origin === incoming.origin)
    if (existing) {
      if (canonicalizeJson(portable(existing)) !== canonicalizeJson(portable(incoming))) {
        throw new Error("Existing Identity profile Rusty access conflicts with the approved device bootstrap")
      }
      continue
    }
    replicaState = changeReplicaPreference({ ...replicaState, actorId: crypto.randomUUID(), progress: {} }, incoming)
    replicaChanged = true
  }
  const replicaPlan = replicaChanged ? await planPrivateReplicaImport(personId, portableReplicaState(replicaState))
    : { conditions: [], writes: [] }
  ensureCurrent()
  if (!await compareAndSwapLocal({ conditions: [...rootPlan.conditions, ...replicaPlan.conditions],
    writes: [...rootPlan.writes, ...replicaPlan.writes] }, ensureCurrent)) {
    throw new Error("Workspace state changed during device bootstrap; retry with a new link")
  }
  identityDevicePreferencesChanged(personId)
}
