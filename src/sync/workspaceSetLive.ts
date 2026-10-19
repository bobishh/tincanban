import { BrowserMeshScopeSync, createLiveWorkspaceSession, type RustLiveWorkspaceSession } from "@meta-uber/mesh-runtime"
import { inspectPairingFrame } from "@meta-uber/mesh-pairing"
import { createBackgroundMeshScope, validateBackgroundScopeDocument } from "./meshScopeClient"
import { createScopeShutdown } from "./scopeShutdown"
import { HandoffConfirmationInbox } from "./handoffConfirmation"
import { WorkspaceChangeRejected } from "./changeAuthorization"
import { MeshNetworkError as SyncNetworkError } from "@meta-uber/mesh-transport"
import { meshIngressTransferDeadlineMs } from "../iroh"
import { meshTrace } from "./meshTrace"
import { readProofPage, writeProofPage, clearProofPages } from "./proofPageCache"
import { createProofTransferRestarter } from "./proofTransferRestart"
import { serveOwnerOfferProofs } from "./ownerOfferProofs"
import type { DuplexStream, SyncConnection } from "./transport"
import { createPeerHistoryObjectReader } from "./workspaceSetHistory"
import { isPeerHistoryFrame, readPeerHistoryRequestOrPairing } from "./peerHistoryTransport"
import type { LiveWorkspaceSync, WorkspaceSetStore, WorkspaceSetWorkspace, WorkspaceSetFactory, LiveWorkspaceOptions } from "./workspaceSet"

const MESH_HEARTBEAT_TIMEOUT_MS = 12_000

async function measureScopePhase<T>(phase: string, workspaceId: string, peerId: string,
  operation: () => Promise<T>, byteLength?: number): Promise<T> {
  const started = performance.now()
  try { return await operation() }
  finally {
    const elapsedMs = Math.round(performance.now() - started)
    if (elapsedMs >= 250) meshTrace("workspace.scope.phase", {
      phase, workspaceId: workspaceId, peerId: peerId, elapsedMs,
      ...(byteLength === undefined ? {} : { byteLength }),
    }, "warn")
  }
}

// Receipt binds exact document, proofs and catalog to this authenticated
// stream. Timeout means unknown outcome, never rollback.
export async function publishConfirmedWorkspace(connection: SyncConnection, secret: string, bytes: Uint8Array): Promise<void> {
  const protocol = createLiveWorkspaceSession("confirmed-delivery", secret)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        const stream = await connection.openStream()
        await stream.send(protocol.encode("mesh-durable-batch", bytes))
        await stream.closeSend()
        protocol.verifySavedReceipt(await stream.read(), bytes)
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Ownership delivery is unconfirmed. Reconnect and retry the same transfer.")), MESH_HEARTBEAT_TIMEOUT_MS)
      }),
    ])
  } finally { clearTimeout(timer); protocol.free?.() }
}

export async function publishGossipPacket(connection: SyncConnection, secret: string, packet: Uint8Array): Promise<void> {
  const protocol = createLiveWorkspaceSession("gossip", secret)
  try {
    const frame = protocol.encode("mesh-iroh-gossip", packet)
    const stream = await connection.openStream()
    await stream.send(frame)
    await stream.closeSend()
  } finally { protocol.free?.() }
}

async function confirmHeartbeat(connection: SyncConnection, secret: string): Promise<void> {
  const protocol = createLiveWorkspaceSession("heartbeat", secret)
  const stream = await connection.openStream()
  await stream.send(protocol.encode("sync-heartbeat", new Uint8Array()))
  await stream.closeSend()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const frame = await Promise.race([
      stream.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SyncNetworkError("Mesh heartbeat timed out")),
          MESH_HEARTBEAT_TIMEOUT_MS,
        )
      }),
    ])
    protocol.verifyHeartbeatAck(frame)
  } finally {
    clearTimeout(timer)
    protocol.free?.()
  }
}

function enqueueHeartbeat(
  queue: Promise<void>,
  isStopped: () => boolean,
  connection: SyncConnection,
  secret: string,
): Promise<void> {
  return queue.then(async () => {
    if (!isStopped()) await confirmHeartbeat(connection, secret)
  })
}

export function createLiveWorkspaceSetSync(
  connection: SyncConnection,
  secret: string,
  replica: ReturnType<WorkspaceSetFactory>,
  options: LiveWorkspaceOptions,
): LiveWorkspaceSync {
  const protocol = createLiveWorkspaceSession("workspace-set", secret)
  let stopped = false
  let queue = Promise.resolve()
  let heartbeatQueue = Promise.resolve()
  let knownChat = new Map<string, Set<string>>()
  const handoffConfirmations = new HandoffConfirmationInbox()
  const handlers = new Set<Promise<void>>()
  const peerHistoryGuard = async () => {
    if (stopped) throw new Error("Direct peer session is no longer current")
    await options.ensureCurrent?.()
    if (stopped) throw new Error("Direct peer session is no longer current")
  }
  const peerHistory = createPeerHistoryObjectReader(connection, peerHistoryGuard)
  let receiveFailure: unknown
  let pendingTransferTimer: ReturnType<typeof setTimeout> | undefined
  const done = (async () => {
    while (!stopped) {
      const stream = await connection.acceptStream()
      if (stopped) return
      const task = (async () => {
        const frame = await readPeerHistoryRequestOrPairing(stream)
        if (await replica.servePeerHistoryBaselineRead(frame, stream, options.remoteDeviceId, peerHistoryGuard)) return
        if (await replica.servePeerHistoryDocumentRead(frame, stream, options.remoteDeviceId, peerHistoryGuard)) return
        if (await replica.servePeerHistoryObjectRead(frame, stream, options.remoteDeviceId, peerHistoryGuard)) return
        let frameType: string | undefined
        try {
          frameType = inspectPairingFrame(frame).type
          if (frameType === "mesh-handoff-confirmed") {
            handoffConfirmations.push(stream, frame)
            return
          }
        } catch { /* Not a pairing frame; decode below. */ }
        if (await replica.serveProofPage(frame, stream, secret)) return
        const operation = protocol.receiveWithPlan(frame)
        if (!operation) {
          if (frameType === "mesh-owner-workspace-offer-page-v1" || frameType === "mesh-control-sync") {
            pendingTransferTimer ??= setTimeout(() => {
              pendingTransferTimer = undefined
              protocol.clearPendingTransfers()
            }, meshIngressTransferDeadlineMs())
          }
          await stream.closeSend()
          return
        }
        if (pendingTransferTimer) clearTimeout(pendingTransferTimer)
        pendingTransferTimer = undefined
        await applyWorkspaceSetReceivePlan(protocol, operation, stream, frame,
          async bytes => replica.receive(await replica.resolveProofs(bytes, connection, secret), false, peerHistory), options, handoffConfirmations)
      })().catch(async error => {
        if (!stopped) { receiveFailure = error; await connection.close().catch(() => {}) }
      })
      handlers.add(task)
      void task.then(() => handlers.delete(task))
    }
  })().catch(error => { if (!stopped) throw receiveFailure ?? error })
  return {
    done,
    readHistoryObject: (baselineId, objectId, binding) => peerHistory.read(objectId, binding, baselineId),
    readHistoryBaseline: (workspaceId, baselineId) => peerHistory.readBaseline(workspaceId, baselineId),
    readHistoryDocument: (descriptor, workspaceId) => peerHistory.readDocument(descriptor, workspaceId),
    publish() {
      queue = queue.then(async () => {
        if (stopped) return
        const nextKnownChat = new Map([...knownChat].map(([id, known]) => [id, new Set(known)]))
        const bytes = await replica.snapshot(nextKnownChat)
        if (stopped) return
        const plan = protocol.prepareSnapshotPublish(bytes)
        if (!plan.frame) { knownChat = nextKnownChat; return }
        try {
          const stream = await connection.openStream()
          await stream.send(new Uint8Array(plan.frame))
          await stream.closeSend()
          protocol.finishPublish(new Uint8Array(plan.snapshot), true)
        } catch (error) {
          protocol.finishPublish(new Uint8Array(plan.snapshot), false)
          throw error
        }
        knownChat = nextKnownChat
      })
      return queue
    },
    heartbeat() {
      heartbeatQueue = enqueueHeartbeat(heartbeatQueue, () => stopped, connection, secret)
      return heartbeatQueue
    },
    async close() {
      stopped = true
      if (pendingTransferTimer) clearTimeout(pendingTransferTimer)
      pendingTransferTimer = undefined
      protocol.clearPendingTransfers()
      await connection.close()
      await Promise.allSettled(handlers)
      protocol.free?.()
    },
  }
}

function requiredHandler<T>(handler: T | undefined, message: string): T {
  if (!handler) throw new Error(message)
  return handler
}

async function applyWorkspaceSetReceivePlan(
  protocol: RustLiveWorkspaceSession,
  operation: NonNullable<ReturnType<RustLiveWorkspaceSession["receiveWithPlan"]>>,
  stream: DuplexStream,
  frame: Uint8Array,
  merge: (bytes: Uint8Array) => Promise<void>,
  options: LiveWorkspaceOptions,
  handoffConfirmations?: HandoffConfirmationInbox,
): Promise<void> {
  const bytes = Uint8Array.from(operation.action.payload ?? [])
  const effects: Record<string, () => Promise<void>> = {
    mergeDurableBatch: () => merge(bytes),
    mergeWorkspaceSnapshot: () => merge(bytes),
    sendSavedAcknowledgement: async () => { await stream.send(protocol.acknowledgeSaved(bytes)) },
    sendHeartbeatAcknowledgement: async () => { await stream.send(protocol.encode("sync-heartbeat-ack", new Uint8Array())) },
    handleOwnerWorkspaceOffer: async () => {
      await requiredHandler(options.ownerWorkspaceOfferFrame === "mesh-owner-workspace-offer" || options.ownerWorkspaceOfferFrame === "mesh-owner-workspace-offer-page-v1"
        ? options.onOwnerWorkspaceOffer : undefined, "Unsupported owner workspace offer")(bytes)
    },
    handleGossip: async () => {
      await requiredHandler(options.onGossipPacket, "Unsupported gossip packet")(bytes)
    },
    handleBlobRequest: async () => {
      await requiredHandler(options.onBlobRequest, "Unsupported blob request")(stream, frame)
    },
    handleHandoffRequest: async () => {
      await requiredHandler(options.onHandoffRequest, "Unsupported handoff request")(stream, frame,
        handoffConfirmations?.acceptStream ?? (async () => { throw new Error("No handoff confirmation reader") }))
    },
    closeSend: async () => { await stream.closeSend() },
    unsupportedControl: async () => { throw new Error("Unsupported live workspace action: control") },
    unsupportedSnapshot: async () => { throw new Error("Unsupported live workspace action: snapshot") },
  }
  for (const effect of operation.plan.effects) {
    const runEffect = effects[effect]
    if (!runEffect) throw new Error(`Unsupported live workspace effect: ${effect}`)
    await runEffect()
  }
}

type AutomergeScopeContext = {
  connection: SyncConnection
  secret: string
  store: WorkspaceSetStore
  workspaceId: string
  localDeviceId: string
  remoteDeviceId: string
  historyReplica: ReturnType<WorkspaceSetFactory>
  peerHistory: ReturnType<typeof createPeerHistoryObjectReader>
  peerHistoryGuard: () => Promise<void>
  options: LiveWorkspaceOptions
  onDocumentRejected?: (error: WorkspaceChangeRejected | null) => void
  rejectionState: { last: string | undefined }
}

async function persistBackgroundScopeDocument(context: AutomergeScopeContext, candidate: Uint8Array, proof: unknown): Promise<void> {
  const { workspaceId, remoteDeviceId, store, peerHistory, peerHistoryGuard } = context
  await validateBackgroundScopeDocument(workspaceId, candidate)
  try {
    if (store.validate && store.receiveHistoryBaseline && store.activateHistoryBaseline) {
      try {
        await store.validate(workspaceId, candidate, proof)
        await peerHistoryGuard()
      } catch (validationError) {
        await peerHistoryGuard()
        const descriptor = await peerHistory.readBaseline(workspaceId)
        await peerHistoryGuard()
        if (!descriptor) throw validationError
        const baselineDocument = await peerHistory.readDocument(descriptor, workspaceId)
        await peerHistoryGuard()
        const basis = await store.receiveHistoryBaseline(workspaceId, candidate, proof, descriptor, peerHistory, baselineDocument)
        let activated = false
        try {
          await peerHistoryGuard()
          await store.validate(workspaceId, candidate, proof, basis)
          await peerHistoryGuard()
          await store.activateHistoryBaseline(workspaceId, basis)
          activated = true
        } catch (error) {
          freeUnactivatedBasis(basis, activated)
          throw error
        }
        await peerHistoryGuard()
        await store.merge(workspaceId, candidate, proof, basis)
        return
      }
    }
    await measureScopePhase("store.persist-document", workspaceId, remoteDeviceId,
      () => store.merge(workspaceId, candidate, proof), candidate.byteLength)
  } catch (error) {
    await clearProofPages(workspaceId).catch(() => {})
    throw error
  }
}

function createLiveAutomergeScope(context: AutomergeScopeContext) {
  const { connection, secret, store, workspaceId, localDeviceId, remoteDeviceId,
    historyReplica, peerHistory, options, onDocumentRejected, rejectionState } = context
  const scope = new BrowserMeshScopeSync(createBackgroundMeshScope(workspaceId, secret), {
    readDocument: () => measureScopePhase("store.read-document", workspaceId, remoteDeviceId,
      () => store.read(workspaceId)),
    readAuthorization: store.readAuthorization ? bytes => measureScopePhase("store.read-authorization", workspaceId,
      remoteDeviceId, () => store.readAuthorization!(bytes, workspaceId), bytes.byteLength) : undefined,
    readChat: store.readChat ? known => measureScopePhase("store.read-chat", workspaceId, remoteDeviceId,
      () => store.readChat!(workspaceId, known, remoteDeviceId)) : undefined,
    readMesh: store.readMesh ? () => measureScopePhase("store.read-mesh", workspaceId, remoteDeviceId,
      () => store.readMesh!(workspaceId)) : undefined,
    persistDocument: (candidate, proof) => persistBackgroundScopeDocument(context, candidate, proof),
    onDocumentAccepted: count => {
      if (count > 0 && rejectionState.last) { rejectionState.last = undefined; onDocumentRejected?.(null) }
    },
    mergeDurableBatch: bytes => measureScopePhase("store.merge-durable-batch", workspaceId, remoteDeviceId,
      async () => {
        await historyReplica.receive(await historyReplica.resolveProofs(bytes, connection, secret), false, peerHistory)
      }, bytes.byteLength),
    mergeAuthorization: async authorization => {
      const bytes = await store.read(workspaceId)
      await measureScopePhase("store.merge-authorization", workspaceId, remoteDeviceId,
        () => store.merge(workspaceId, bytes, authorization), bytes.byteLength)
    },
    mergeChat: store.mergeChat ? chat => measureScopePhase("store.merge-chat", workspaceId, remoteDeviceId,
      () => store.mergeChat!(workspaceId, chat, false, remoteDeviceId)) : undefined,
    mergeMesh: store.mergeMesh ? mesh => measureScopePhase("store.merge-mesh", workspaceId, remoteDeviceId,
      () => store.mergeMesh!(workspaceId, mesh)) : undefined,
    onTiming: timing => {
      const elapsedMs = Math.round(timing.elapsedMs)
      if (elapsedMs >= 250) meshTrace("workspace.scope.queue", {
        operation: timing.operation, operationId: timing.operationId, phase: timing.phase,
        workspaceId, peerId: remoteDeviceId, elapsedMs,
        ...(timing.frameBytes === undefined ? {} : { frameBytes: timing.frameBytes }),
      }, "warn")
    },
    readProofPage: key => readProofPage(workspaceId, key),
    writeProofPage: (key, payload) => writeProofPage(workspaceId, key, payload),
    onOwnerWorkspaceOffer: options.ownerWorkspaceOfferFrame && options.onOwnerWorkspaceOffer
      ? bytes => measureScopePhase("callback.owner-workspace-offer", workspaceId, remoteDeviceId,
        () => options.onOwnerWorkspaceOffer!(bytes), bytes.byteLength) : undefined,
    onGossip: options.onGossipPacket
      ? bytes => measureScopePhase("callback.gossip", workspaceId, remoteDeviceId,
        () => options.onGossipPacket!(bytes), bytes.byteLength) : undefined,
    onBlobRequest: options.onBlobRequest
      ? (stream, frame) => measureScopePhase("callback.blob-request", workspaceId, remoteDeviceId,
        () => options.onBlobRequest!(stream, frame), frame.byteLength) : undefined,
    onHandoffRequest: options.onHandoffRequest
      ? (stream, frame) => measureScopePhase("callback.handoff-request", workspaceId, remoteDeviceId,
        () => options.onHandoffRequest!(stream, frame, connection.acceptStream), frame.byteLength) : undefined,
  })
  scope.startDocumentSync(localDeviceId, remoteDeviceId)
  return scope
}

export function createLiveAutomergeWorkspaceSync(
  connection: SyncConnection,
  secret: string,
  store: WorkspaceSetStore,
  workspaceId: string,
  localDeviceId: string,
  remoteDeviceId: string,
  createReplica: (store: WorkspaceSetStore, entries: WorkspaceSetWorkspace[]) => ReturnType<WorkspaceSetFactory>,
  onDocumentRejected?: (error: WorkspaceChangeRejected | null) => void,
  options: LiveWorkspaceOptions = {},
): LiveWorkspaceSync {
  let stopped = false
  const restartProofTransfer = createProofTransferRestarter(connection, { workspaceId, peerId: remoteDeviceId })
  const rejectionState = { last: undefined as string | undefined }
  let heartbeatQueue = Promise.resolve()
  const liveness = createLiveWorkspaceSession(workspaceId, secret)
  const frameHandlers = new Set<Promise<void>>()
  const peerHistoryGuard = async () => {
    if (stopped) throw new Error("Direct peer session is no longer current")
    await options.ensureCurrent?.()
    if (stopped) throw new Error("Direct peer session is no longer current")
  }
  const peerHistory = createPeerHistoryObjectReader(connection, peerHistoryGuard)
  const historyReplica = createReplica(store, [workspaceId])
  const scope = createLiveAutomergeScope({ connection, secret, store, workspaceId, localDeviceId, remoteDeviceId,
    historyReplica, peerHistory, peerHistoryGuard, options, onDocumentRejected, rejectionState })
  const responseStream: DuplexStream = {
    async send(frame) {
      if (stopped) return
      const stream = await connection.openStream()
      await stream.send(frame)
      await stream.closeSend()
      void consumeResponse(stream)
    },
    async read() { throw new Error("Response stream cannot be read directly") },
    async closeSend() {},
  }
  const consumeResponse = async (stream: DuplexStream): Promise<void> => {
    try {
      const frame = await measureScopePhase("transport.response-read", workspaceId, remoteDeviceId,
        () => stream.read())
      if (!stopped && frame.length > 0) await receive(responseStream, frame)
    } catch (error) {
      if (!stopped) meshTrace("document.response.failed", {
        workspaceId: workspaceId, peerId: remoteDeviceId,
        reason: error instanceof Error ? error.message : String(error),
      }, "warn", error)
    }
  }
  const sendFrame = async (frame: Uint8Array, kind: "document" | "control"): Promise<boolean> => {
    if (stopped) return false
    const stream = await measureScopePhase(`transport.${kind}.open`, workspaceId, remoteDeviceId,
      () => connection.openStream(), frame.byteLength)
    await measureScopePhase(`transport.${kind}.send`, workspaceId, remoteDeviceId,
      () => stream.send(frame), frame.byteLength)
    await measureScopePhase(`transport.${kind}.close-send`, workspaceId, remoteDeviceId,
      () => stream.closeSend(), frame.byteLength)
    if (kind === "document") void consumeResponse(stream)
    return true
  }
  const receive = async (stream: DuplexStream, frame: Uint8Array): Promise<void> => {
    try {
      if (await historyReplica.servePeerHistoryBaselineRead(frame, stream, remoteDeviceId, peerHistoryGuard)) return
      if (await historyReplica.servePeerHistoryDocumentRead(frame, stream, remoteDeviceId, peerHistoryGuard)) return
      if (await historyReplica.servePeerHistoryObjectRead(frame, stream, remoteDeviceId, peerHistoryGuard)) return
      if (await serveOwnerOfferProofs(connection, secret, stream, frame)) return
      await measureScopePhase("scope.receive", workspaceId, remoteDeviceId,
        () => scope.receive(stream, frame), frame.byteLength)
    }
    catch (error) {
      await restartProofTransfer(error)
      if (!(error instanceof WorkspaceChangeRejected)) throw error
      if (rejectionState.last !== error.message) onDocumentRejected?.(error)
      rejectionState.last = error.message
    }
  }
  const incomingContext = { isStopped: () => stopped, liveness, receive, workspaceId, remoteDeviceId }
  const shutdown = createScopeShutdown(scope, connection, () => { stopped = true }, () => { liveness.free?.() },
    error => meshTrace("workspace.scope.close.failed", {
      workspaceId, peerId: remoteDeviceId, reason: error instanceof Error ? error.message : String(error),
    }, "warn", error))
  const done = (async () => {
    try {
      while (!stopped) {
        const stream = await connection.acceptStream()
        if (stopped) return
        // Keep accepting independent QUIC streams while application storage
        // waits. Scope runtime still serializes document/control mutations.
        const task = handleLiveWorkspaceStream(stream, incomingContext)
        frameHandlers.add(task)
        void task.finally(() => frameHandlers.delete(task))
        if (frameHandlers.size >= 32) await Promise.race(frameHandlers)
      }
    } catch (error) { if (!stopped) throw error }
  })().finally(() => shutdown.drain())
  return {
    done,
    readHistoryObject: (baselineId, objectId, binding) => peerHistory.read(objectId, binding, baselineId),
    readHistoryBaseline: (workspaceId, baselineId) => peerHistory.readBaseline(workspaceId, baselineId),
    readHistoryDocument: (descriptor, workspaceId) => peerHistory.readDocument(descriptor, workspaceId),
    async reconcile() {
      if (stopped) return
      try { await measureScopePhase("scope.reconcile-total", workspaceId, remoteDeviceId,
        () => scope.reconcile(sendFrame)) }
      catch (error) { if (!stopped) throw error }
    },
    async publish() {
      if (stopped) return
      try { await measureScopePhase("scope.publish-total", workspaceId, remoteDeviceId,
        () => scope.publish(sendFrame)) }
      catch (error) { if (!stopped) throw error }
    },
    heartbeat() {
      heartbeatQueue = enqueueHeartbeat(heartbeatQueue, () => stopped, connection, secret)
      return heartbeatQueue
    },
    close: shutdown.close,
  }
}

function freeUnactivatedBasis(basis: { free(): void }, activated: boolean): void {
  if (!activated) basis.free()
}

async function handleLiveWorkspaceStream(stream: DuplexStream, context: {
  isStopped: () => boolean
  liveness: RustLiveWorkspaceSession
  receive: (stream: DuplexStream, frame: Uint8Array) => Promise<void>
  workspaceId: string
  remoteDeviceId: string
}): Promise<void> {
  const { liveness, receive, workspaceId, remoteDeviceId } = context
    const started = performance.now()
    let kind = "unread"
    try {
      const frame = await readPeerHistoryRequestOrPairing(stream)
      if (context.isStopped()) return
      kind = isPeerHistoryFrame(frame) ? "workspace-history" : inspectPairingFrame(frame).type
      meshTrace("workspace.receive.started", {
        workspaceId: workspaceId, peerId: remoteDeviceId, kind,
      })
      if (kind === "sync-heartbeat") {
        // Rust authenticates and validates heartbeat independently of pending
        // document storage. A liveness ACK never acknowledges persisted data.
        const operation = liveness.receiveWithPlan(frame)
        if (!operation || operation.action.kind !== "heartbeat") throw new Error("Invalid mesh heartbeat")
        await applyWorkspaceSetReceivePlan(liveness, operation, stream, frame, async () => {}, {})
      } else await receive(stream, frame)
    } catch (error) {
      if (!context.isStopped()) meshTrace("workspace.frame.rejected", {
        workspaceId: workspaceId, peerId: remoteDeviceId,
        reason: error instanceof Error ? error.message : String(error),
      }, "warn", error)
      await stream.closeSend().catch(() => {})
    } finally {
      meshTrace("workspace.receive.completed", {
        workspaceId: workspaceId, peerId: remoteDeviceId, kind,
        elapsedMs: Math.round(performance.now() - started),
      })
    }
}
