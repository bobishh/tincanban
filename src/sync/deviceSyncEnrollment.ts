import {
  createDeviceEnrollmentInvite,
  createPairingSecret,
  decodePairingFrame,
  encodePairingFrame,
  inspectPairingFrame,
  invitationUrl,
  type DeviceEnrollmentInvitation,
} from "@meta-uber/mesh-pairing"
import { MeshReconnectPolicy } from "@meta-uber/mesh-runtime"
import { meshNetworkConnection } from "@meta-uber/mesh-transport"
import { defaultInvitationService, deriveTranscriptAuthCode } from "./invitations"
import { createEnrollmentRequest, enrollmentPayload, installEnrollment, preflightEnrollment, readEnrollmentRequest } from "./enrollment"
import { defaultProofStore, certHashDefault } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { registerDeviceInRoot } from "../domain/personalRoot"
import { fromBase64Url, type LocalProfile } from "../domain/identity"
import { createPeerHistoryObjectReader, workspaceSet, type PeerHistoryObjectReader } from "./workspaceSet"
import { createEnrollmentHistoryReader } from "./enrollmentHistoryReader"
import { createEnrollmentHistoryAuthorizationGuard } from "./enrollmentHistoryAuthorization"
import { readPeerHistoryRequestOrPairing } from "./peerHistoryTransport"
import { awaitEnrollmentAcknowledgement, enrollmentRejection, sendEnrollmentRejection } from "./enrollmentAcknowledgement"
export { sendEnrollmentRejection } from "./enrollmentAcknowledgement"
import { peerStore } from "./peerStore"
import type { WorkspaceGrant } from "../domain/model"
import { startPersistentNode } from "./persistentNode"
import type { SyncConnection, SyncNode } from "./transport"
import { userMessage } from "./deviceSyncState"
import { showInviteQr } from "./deviceSyncInviteView"
import type { PairingContext } from "./deviceSyncContext"
import { meshTrace, type MeshTraceLevel } from "./meshTrace"
import { offlineRetryDelay } from "./offlineRetry"
import { meshIngressBudgetProfile } from "../iroh"

type EnrollmentContext = PairingContext & {
  activeWorkspaceId?: () => string
  handoffNode: (reason: string) => Promise<void>
  identityChanged?: () => Promise<void>
  waitToReconnect: (milliseconds: number) => Promise<void>
  setApprovalResolver: (resolve: ((approved: boolean) => void) | undefined) => void
  denyPendingApproval: () => void
}

function isCurrent(context: EnrollmentContext, run: number) {
  return context.currentRun() === run
}

function traceEnrollment(role: "host" | "guest", event: string, run: number,
  detail: Record<string, unknown> = {}, level: MeshTraceLevel = "info") {
  meshTrace(`enrollment.${role}.${event}`, { runId: run, ...detail }, level)
}

function errorReason(error: unknown, depth = 0): string {
  const message = error instanceof Error ? error.message : String(error)
  if (depth >= 4) return message
  if (error instanceof AggregateError) {
    return `${message}: ${error.errors.map(cause => errorReason(cause, depth + 1)).join("; ")}`
  }
  if (error instanceof Error && error.cause !== undefined) {
    return `${message}: ${errorReason(error.cause, depth + 1)}`
  }
  return message
}

function pairingNode(context: EnrollmentContext) {
  return context.durableMesh?.startInstanceNode() ?? startPersistentNode(context.transport)
}

async function makeQr(context: EnrollmentContext, invite: DeviceEnrollmentInvitation) {
  await showInviteQr(context.state, invitationUrl(context.origin(), invite))
}

function enrollmentError(context: EnrollmentContext, run: number, err: unknown, fallback: string) {
  if (!isCurrent(context, run)) return
  context.state.step.value = "error"
  context.state.error.value = userMessage(err, fallback)
}

export async function selectDeviceEnrollment(context: EnrollmentContext) {
  const run = context.nextRun()
  context.state.step.value = "enroll-host-preparing"
  traceEnrollment("host", "started", run)
  try {
    await context.pauseMesh()
    await context.stopNode("Starting device enrollment")
    context.state.copyNotice.value = ""
    context.state.error.value = ""
    context.state.authCode.value = ""
    context.state.enrollmentDeviceName.value = ""
    if (!context.workspaceStore || !context.durableMesh) throw new Error("Device sync is unavailable.")
    const profile = await context.getProfile()
    const node = await pairingNode(context)
    if (!isCurrent(context, run)) return void node.close("Replaced")
    context.setNode(node)
    traceEnrollment("host", "node.started", run, { endpoint: node.endpointId.slice(0, 8) })
    const secret = createPairingSecret()
    const invite = createDeviceEnrollmentInvite(node.endpointId, secret, profile)
    await defaultInvitationService.saveIssuedInvitation(invite)
    await makeQr(context, invite)
    context.state.step.value = "enroll-host"
    await hostEnrollment(context, run, node, secret, invite, profile)
  } catch (err) {
    traceEnrollment("host", "failed", run, { reason: errorReason(err) }, "warn")
    enrollmentError(context, run, err, "Couldn’t start device sync.")
  }
}

async function hostEnrollment(context: EnrollmentContext, run: number, node: SyncNode, secret: string, invite: DeviceEnrollmentInvitation, profile: LocalProfile) {
  const acceptor = await node.accept()
  traceEnrollment("host", "listening", run)
  void receiveEnrollment(context, run, node, acceptor, secret, invite, profile)
}

type EnrollmentCandidate = {
  connection: SyncConnection
  stream: Awaited<ReturnType<SyncConnection["acceptStream"]>>
  guest: Awaited<ReturnType<typeof readEnrollmentRequest>>
}

const enrollmentAdmissionLimit = 2
const enrollmentAdmissionTimeout = 15_000

export async function receiveEnrollment(context: EnrollmentContext, run: number, node: SyncNode, acceptor: Awaited<ReturnType<SyncNode["accept"]>>, secret: string, invite: DeviceEnrollmentInvitation, profile: LocalProfile) {
  const connections = new Set<SyncConnection>()
  const admissions = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    admissions.abort()
    context.denyPendingApproval()
    void closeEnrollmentConnections(connections)
    void acceptor.close().catch(() => {})
    void node.close("Enrollment timed out").catch(() => {})
  }, 600_000)
  try {
    const stopped = () => timedOut || !isCurrent(context, run)
    const candidate = await acceptEnrollmentCandidate(context, run, acceptor, connections, secret, invite, stopped, admissions.signal)
    if (!candidate) {
      if (!isCurrent(context, run)) return
      throw new Error(timedOut ? "Device enrollment timed out. Create a new link." : "Device enrollment connection closed. Create a new link.")
    }
    await acceptor.close().catch(() => {})
    admissions.abort()
    await closeEnrollmentConnections(connections, candidate.connection)
    await completeEnrollmentCandidate(context, run, node, candidate, secret, invite, profile, stopped)
  } catch (err) {
    traceEnrollment("host", "failed", run, { reason: errorReason(err) }, "warn")
    if (isCurrent(context, run)) console.error("Device enrollment host failed", err)
    enrollmentError(context, run, err, "Couldn’t add this device.")
  } finally {
    clearTimeout(timeout)
    admissions.abort()
    if (isCurrent(context, run)) context.setApprovalResolver(undefined)
    await closeEnrollmentConnections(connections)
    await acceptor.close().catch(() => {})
    if (isCurrent(context, run)) await context.handoffNode("Enrollment finished")
  }
}

async function acceptEnrollmentCandidate(context: EnrollmentContext, run: number, acceptor: Awaited<ReturnType<SyncNode["accept"]>>, connections: Set<SyncConnection>, secret: string, invite: DeviceEnrollmentInvitation, stopped: () => boolean, signal: AbortSignal) {
  const admissions = new Set<Promise<EnrollmentCandidate | undefined>>()
  let pendingAccept: Promise<SyncConnection | undefined> | undefined
  let listenerClosed = false
  while (!stopped()) {
    if (!listenerClosed && !pendingAccept && admissions.size < enrollmentAdmissionLimit) pendingAccept = acceptor.accept()
    const event = await nextEnrollmentAdmissionEvent(admissions, pendingAccept)
    if (event.type === "cancelled") continue
    if (event.type === "connection") {
      pendingAccept = undefined
      if (!event.connection) listenerClosed = true
      else {
        connections.add(event.connection)
        traceEnrollment("host", "connection.accepted", run)
        admissions.add(readEnrollmentCandidate(run, event.connection, connections, secret, invite, signal))
      }
    } else {
      admissions.delete(event.admission)
      if (event.candidate) {
        closeLateEnrollmentConnection(pendingAccept, connections)
        return event.candidate
      }
    }
    if (listenerClosed && !admissions.size) return undefined
  }
  closeLateEnrollmentConnection(pendingAccept, connections)
}

type EnrollmentAdmissionEvent =
  | { type: "admission"; admission: Promise<EnrollmentCandidate | undefined>; candidate: EnrollmentCandidate | undefined }
  | { type: "connection"; connection: SyncConnection | undefined }
  | { type: "cancelled" }

async function nextEnrollmentAdmissionEvent(admissions: Set<Promise<EnrollmentCandidate | undefined>>, pendingAccept: Promise<SyncConnection | undefined> | undefined): Promise<EnrollmentAdmissionEvent> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const events: Promise<EnrollmentAdmissionEvent>[] = [...admissions].map(async (admission): Promise<EnrollmentAdmissionEvent> => ({
      type: "admission", admission, candidate: await admission,
    }))
    if (pendingAccept) events.push(pendingAccept.then(connection => ({ type: "connection", connection })))
    events.push(new Promise(resolve => { timer = setTimeout(() => resolve({ type: "cancelled" }), 100) }))
    return await Promise.race(events)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function closeLateEnrollmentConnection(pendingAccept: Promise<SyncConnection | undefined> | undefined, connections: Set<SyncConnection>) {
  void pendingAccept?.then(async connection => {
    if (!connection) return
    connections.add(connection)
    await connection.close().catch(() => {})
    connections.delete(connection)
  }).catch(() => {})
}

async function readEnrollmentCandidate(run: number, connection: SyncConnection, connections: Set<SyncConnection>, secret: string, invite: DeviceEnrollmentInvitation, signal: AbortSignal): Promise<EnrollmentCandidate | undefined> {
  let verified = false
  try {
    const stream = await admissionDeadline(connection.acceptStream(), signal)
    const raw = await admissionDeadline(stream.read(), signal)
    const header = inspectPairingFrame(raw)
    if (header.type !== "enroll-request" || header.secret !== secret) {
      traceEnrollment("host", "frame.rejected", run, { type: header.type }, "warn")
      return undefined
    }
    const guest = await readEnrollmentRequest(decodePairingFrame(raw, "enroll-request", secret), invite)
    traceEnrollment("host", "request.verified", run, { deviceId: guest.deviceId.slice(0, 8) })
    verified = true
    return { connection, stream, guest }
  } catch (err) {
    traceEnrollment("host", "connection.rejected", run, { reason: errorReason(err) }, "warn")
  } finally {
    if (!verified) {
      connections.delete(connection)
      await connection.close().catch(() => {})
    }
  }
}

async function admissionDeadline<T>(work: Promise<T>, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    if (signal.aborted) throw new Error("Enrollment admission cancelled.")
    return await Promise.race([work, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Enrollment connection did not authenticate in time.")), enrollmentAdmissionTimeout)
    }), new Promise<T>((_, reject) => {
      abort = () => reject(new Error("Enrollment admission cancelled."))
      signal.addEventListener("abort", abort, { once: true })
    })])
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) signal.removeEventListener("abort", abort)
  }
}

async function closeEnrollmentConnections(connections: Set<SyncConnection>, keep?: SyncConnection) {
  await Promise.all([...connections].filter(connection => connection !== keep).map(async connection => {
    connections.delete(connection)
    await connection.close().catch(() => {})
  }))
}

async function completeEnrollmentCandidate(context: EnrollmentContext, run: number, node: SyncNode, candidate: EnrollmentCandidate, secret: string, invite: DeviceEnrollmentInvitation, profile: LocalProfile, stopped: () => boolean) {
  if (stopped()) return
  const { connection, stream, guest } = candidate
  const claim = await defaultInvitationService.claimInvitation(invite.invitationId, guest.deviceId)
  if (!claim.ok) throw new Error(claim.error)
  if (stopped()) return
  const authCode = await deriveTranscriptAuthCode(secret, invite.invitationId, guest.publicKey)
  if (stopped()) return
  context.state.authCode.value = authCode
  context.state.enrollmentDeviceName.value = guest.displayName
  context.state.step.value = "enroll-host-pending"
  context.state.isOpen.value = true
  const approved = await waitForApproval(context, run)
  if (stopped()) return
  if (!approved) {
    traceEnrollment("host", "declined", run, { deviceId: guest.deviceId.slice(0, 8) })
    await rejectEnrollment(stream, secret)
    await awaitEnrollmentDeclineAcknowledgement(connection, secret).catch(() => undefined)
    throw new Error("Device enrollment was declined or cancelled.")
  }
  context.state.step.value = "enroll-syncing"
  traceEnrollment("host", "approved", run, { deviceId: guest.deviceId.slice(0, 8) })
  await approveEnrollment(context, run, node, stream, connection, secret, invite, profile, guest)
  traceEnrollment("host", "completed", run, { deviceId: guest.deviceId.slice(0, 8) })
}

async function waitForApproval(context: EnrollmentContext, run: number) {
  return new Promise<boolean>(resolve => {
    const timer = setInterval(() => {
      if (!isCurrent(context, run)) {
        clearInterval(timer)
        resolve(false)
      }
    }, 100)
    context.setApprovalResolver((approved: boolean) => {
      clearInterval(timer)
      resolve(approved)
    })
  })
}

async function rejectEnrollment(stream: Awaited<ReturnType<SyncConnection["acceptStream"]>>, secret: string) {
  const error = new TextEncoder().encode(JSON.stringify({ error: "Device enrollment was declined or cancelled." }))
  await stream.send(encodePairingFrame("enroll-approved", secret, error))
  await stream.closeSend()
}

async function awaitEnrollmentDeclineAcknowledgement(connection: SyncConnection, secret: string) {
  const acknowledgement = await connection.acceptStream()
  decodePairingFrame(await acknowledgement.read(), "enroll-ack", secret)
  await acknowledgement.closeSend()
}

async function acknowledgeEnrollmentDecline(connection: SyncConnection, secret: string) {
  const acknowledgement = await connection.openStream()
  await acknowledgement.send(encodePairingFrame("enroll-ack", secret, new Uint8Array()))
  await acknowledgement.closeSend()
}

async function approveEnrollment(
  context: EnrollmentContext,
  run: number,
  node: SyncNode,
  stream: Awaited<ReturnType<SyncConnection["acceptStream"]>>,
  connection: SyncConnection,
  secret: string,
  invite: DeviceEnrollmentInvitation,
  profile: LocalProfile,
  guest: { deviceId: string; publicKey: string; displayName: string },
) {
  const result = await defaultInvitationService.approveEnrollment(invite.invitationId, guest, profile)
  if (!result.ok) throw new Error(result.error)
  const certificateHash = await certHashDefault(result.certificate)
  await defaultProofStore.putCertificate(certificateHash, result.certificate)
  const root = await defaultStorage.updatePersonalRootForIdentity(profile.identity.personId, current => {
    if (!current) throw new Error("Personal identity is unavailable. Reload and try again.")
    registerDeviceInRoot(current, { ...guest, certificateHash, addedAt: new Date().toISOString() })
    return current
  })
  if (!root) throw new Error("Personal identity is unavailable. Reload and try again.")
  const transfer = await transferableWorkspaces(context, profile)
  const workspaces = transfer.workspaces
  const ids = workspaces.map(item => item.id)
  const active = selectActiveWorkspace(context, ids)
  await context.durableMesh?.forgetEnrolledDevice(ids, guest.deviceId)
  await context.durableMesh?.ensureOwnerWorkspaces(transfer.ownerIds, node.endpointId, profile)
  const store = context.meshWorkspaceStore ?? context.workspaceStore!
  const replica = workspaceSet(store, workspaces)
  const historyGuard = createEnrollmentHistoryAuthorizationGuard({ workspaceIds: ids, profile,
    remoteDeviceId: guest.deviceId, isCurrent: () => isCurrent(context, run), readProfile: context.getProfile,
    readCredential: async id => (await peerStore.getWorkspaceCredential(id)) ?? undefined })
  const acknowledgementHistory = createEnrollmentHistoryReader(store, ids, guest.deviceId, historyGuard)
  await historyGuard()
  const payload = await enrollmentPayload(invite, profile, result.certificate, root, workspaces, active,
    await context.durableMesh!.invitationPayload(ids), transfer.grants, await replica.snapshot())
  await historyGuard()
  await stream.send(encodePairingFrame("enroll-approved", secret, payload))
  await stream.closeSend()
  let ack: Awaited<ReturnType<SyncConnection["acceptStream"]>> | undefined
  let acknowledgement: Uint8Array | undefined
  for (let rounds = 0; rounds < 4096; rounds++) {
    const incoming = await connection.acceptStream()
    const frame = await readPeerHistoryRequestOrPairing(incoming)
    await historyGuard()
    if (await replica.servePeerHistoryBaselineRead(frame, incoming, guest.deviceId, historyGuard)) continue
    if (await replica.servePeerHistoryDocumentRead(frame, incoming, guest.deviceId, historyGuard)) continue
    if (await replica.servePeerHistoryObjectRead(frame, incoming, guest.deviceId, historyGuard)) continue
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
    throw new Error(`The new device rejected enrollment: ${reason}`)
  }
  await replica.receive(await replica.resolveProofs(decodePairingFrame(acknowledgement, "enroll-ack", secret), connection, secret),
    true, acknowledgementHistory)
  await historyGuard()
  await ack.send(encodePairingFrame("enroll-complete", secret, new Uint8Array()))
  await ack.closeSend()
  const confirmation = await connection.acceptStream()
  decodePairingFrame(await confirmation.read(), "mesh-handoff-confirmed", secret)
  context.state.step.value = "enroll-host-done"
}

async function transferableWorkspaces(context: EnrollmentContext, profile: LocalProfile) {
  const workspaces = [] as { id: string; title: string }[]
  const grants: WorkspaceGrant[] = []
  const ownerIds: string[] = []
  for (const item of context.availableWorkspaces) {
    if (!context.workspaceOwner || await context.workspaceOwner(item.id) === profile.identity.personId) {
      workspaces.push(item); ownerIds.push(item.id)
    } else {
      const grant = await context.durableMesh!.enrollmentGrant(item.id, profile)
      if (grant) { workspaces.push(item); grants.push(grant) }
    }
  }
  if (!workspaces.length) throw new Error("No accessible workspaces are available to sync.")
  return { workspaces, grants, ownerIds }
}

function selectActiveWorkspace(context: EnrollmentContext, ids: string[]) {
  const requested = context.activeWorkspaceId?.()
  return requested && ids.includes(requested) ? requested : ids[0]!
}

export async function requestDeviceEnrollment(context: EnrollmentContext, invite: DeviceEnrollmentInvitation) {
  const run = context.nextRun()
  let connection: SyncConnection | undefined
  let handedOff = false
  context.state.step.value = "enroll-guest-waiting"
  context.state.error.value = ""
  traceEnrollment("guest", "started", run, { endpoint: invite.issuerEndpoint.slice(0, 8) })
  try {
    if (!context.workspaceStore || !context.durableMesh) throw new Error("Device sync is unavailable.")
    await context.pauseMesh()
    await context.stopNode("Starting device enrollment")
    const profile = await context.getProfile()
    context.state.authCode.value = await deriveTranscriptAuthCode(invite.secret, invite.invitationId, profile.device.publicKey)
    const node = await startPersistentNode(context.transport)
    if (!isCurrent(context, run)) return void node.close("Replaced")
    context.setNode(node)
    traceEnrollment("guest", "node.started", run, { endpoint: node.endpointId.slice(0, 8) })
    connection = await dialEnrollmentPeer(context, run, node, invite)
    if (!connection || !isCurrent(context, run)) return
    connection = meshNetworkConnection(connection, meshIngressBudgetProfile())
    traceEnrollment("guest", "connected", run)
    await receiveEnrollmentApproval(context, run, node, connection, invite, profile)
    connection = undefined
    handedOff = true
  } catch (err) {
    traceEnrollment("guest", "failed", run, { reason: errorReason(err) }, "warn")
    if (isCurrent(context, run)) console.error("Device enrollment guest failed", err)
    enrollmentError(context, run, err, "Couldn’t add this device. Create a new link and try again.")
  } finally {
    await connection?.close().catch(() => {})
    if (isCurrent(context, run) && !handedOff) await context.handoffNode("Enrollment finished")
  }
}

export async function dialEnrollmentPeer(context: EnrollmentContext, run: number, node: SyncNode, invite: DeviceEnrollmentInvitation) {
  const reconnect = new MeshReconnectPolicy()
  const peerKey = `enrollment:${invite.issuerEndpoint}`
  try {
    for (let attempt = 0; isCurrent(context, run); attempt++) {
      const mode = reconnect.mode(node, peerKey)
      traceEnrollment("guest", "dial.started", run, { attempt: attempt + 1, mode })
      try {
        const connection = await reconnect.dial(node, peerKey, invite.issuerEndpoint)
        traceEnrollment("guest", "dial.connected", run, { attempt: attempt + 1, plannedMode: mode })
        return connection
      } catch (err) {
        traceEnrollment("guest", "dial.failed", run, { attempt: attempt + 1, plannedMode: mode,
          reason: errorReason(err) }, "warn")
        // An unpublished invitation endpoint can fail both routes temporarily.
        // Keep racing both on retry rather than pinning an unproven relay route.
        if (attempt >= 4) throw err
        await context.waitToReconnect(offlineRetryDelay(attempt + 1))
      }
    }
  } finally {
    reconnect.free()
  }
}

async function receiveEnrollmentApproval(context: EnrollmentContext, run: number, node: SyncNode, connection: SyncConnection, invite: DeviceEnrollmentInvitation, profile: LocalProfile) {
  const stream = await connection.openStream()
  await stream.send(encodePairingFrame("enroll-request", invite.secret, await createEnrollmentRequest(invite, profile)))
  await stream.closeSend()
  traceEnrollment("guest", "request.sent", run)
  const response = decodePairingFrame(await stream.read(), "enroll-approved", invite.secret)
  const declined = enrollmentDecline(response)
  if (declined) {
    await acknowledgeEnrollmentDecline(connection, invite.secret)
    throw new Error(declined)
  }
  if (!isCurrent(context, run)) return
  context.state.step.value = "enroll-syncing"
  traceEnrollment("guest", "approved", run)
  let prepared: Awaited<ReturnType<typeof preflightEnrollment>>
  let ids: string[]
  let replica: ReturnType<typeof workspaceSet>
  let snapshot: Uint8Array
  let historyReader: PeerHistoryObjectReader
  try {
    prepared = await preflightEnrollment(response, invite, profile)
    ids = prepared.payload.workspaces.map(item => item.id)
    replica = workspaceSet(context.meshWorkspaceStore ?? context.workspaceStore!, prepared.payload.workspaces)
    snapshot = await replica.resolveProofs(fromBase64Url(prepared.payload.snapshot), connection, invite.secret)
    const scopes = await context.durableMesh!.validateInvitation(prepared.payload.meshWorkspaces, ids, prepared.profile, prepared.payload.grants)
    historyReader = createPeerHistoryObjectReader(connection, () => {
      if (!isCurrent(context, run)) throw new Error("Device enrollment was cancelled")
    }, scopes)
    await replica.validate(snapshot, historyReader)
  } catch (error) {
    await sendEnrollmentRejection(connection, invite.secret, error).catch(() => undefined)
    throw error
  }
  const enrolled = await installEnrollment(response, invite, profile, context.state.replacementPersonId.value)
  await context.identityChanged?.()
  await context.durableMesh!.receiveInvitation(enrolled.meshWorkspaces, ids, enrolled.profile, enrolled.grants)
  await replica.receive(snapshot, true, historyReader)
  const ownerIds = enrolled.meshWorkspaces.filter(item => item.ownerPersonId === enrolled.profile.identity.personId).map(item => item.workspaceId)
  await context.durableMesh!.ensureOwnerWorkspaces(ownerIds, node.endpointId, enrolled.profile)
  await context.workspaceStore!.activate(enrolled.activeWorkspaceId)
  const ack = await connection.openStream()
  await ack.send(encodePairingFrame("enroll-ack", invite.secret, await replica.snapshot()))
  await ack.closeSend()
  await awaitEnrollmentAcknowledgement(connection, ack, replica, invite.secret, () => {
    if (!isCurrent(context, run)) throw new Error("Device enrollment was cancelled")
  })
  await context.handoffNode("Enrollment finished")
  await context.durableMesh!.waitUntilListening()
  const confirmation = await connection.openStream()
  await confirmation.send(encodePairingFrame("mesh-handoff-confirmed", invite.secret, new Uint8Array()))
  await confirmation.closeSend()
  context.state.step.value = "enroll-guest-done"
  traceEnrollment("guest", "completed", run, { workspaces: ids.length })
  if (typeof window !== "undefined") window.history.replaceState(window.history.state, "", "/")
}

function enrollmentDecline(bytes: Uint8Array) {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : undefined
  } catch { return undefined }
}
