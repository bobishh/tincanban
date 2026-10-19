import { installPairingCodec } from "@meta-uber/mesh-pairing"
import { installMeshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { GossipStateMachine } from "@meta-uber/mesh-replication"
import type { IrohStream as RawIrohStream } from "@meta-uber/mesh-transport"
import { z } from "zod"
import policyInit, {
  WasmAutomergeSyncEngine,
  WasmAutomergeDeviceSyncFlow,
  WasmMeshBatchDeliveryFlow,
  WasmDeviceRouteCatalog,
  WasmMeshRuntimeState,
  WasmGossipLifecycleState,
  WasmMeshLifecycleState,
  WasmMeshSessionLifecycle,
  WasmLiveWorkspaceSession,
  WasmMeshScopeRuntime,
  WasmMeshHandshakeFlow,
  WasmMeshAuthenticatedSessions,
  WasmPairingCodec,
  WasmIngressBudgetProfile,
  WasmWorkspaceJoinHandshake,
  WasmWorkspaceJoinHandoff,
  WasmStateCore,
} from "@meta-uber/mesh-transport/wasm"
export { WasmPairingCodec, WasmWorkspaceJoinHandshake, WasmWorkspaceJoinHandoff }
export { WasmIngressBudgetProfile }

let pairingCodecInstalled = false
let rustRuntimeInstalled = false
let browserRuntimeInitialization: Promise<void> | undefined
let ingressBudgetProfile: InstanceType<typeof WasmIngressBudgetProfile> | undefined

const automergeDeviceSyncRequestSchema = z.object({
  frame: z.unknown(),
  batch: z.object({
    protocolVersion: z.literal(1),
    scopeId: z.string(),
    documentId: z.string(),
    batchId: z.string(),
    changes: z.array(z.object({ hash: z.string(), bytes: z.union([z.instanceof(Uint8Array), z.array(z.number().int().min(0).max(255))]) })),
  }),
})

export type IrohNode = {
  endpointId: string
  createGossipEngine: () => GossipStateMachine
  dial: (remoteEndpoint: string) => Promise<IrohConnection>
  dialRelay: (remoteEndpoint: string) => Promise<IrohConnection>
  accept: () => Promise<IrohAcceptor>
  close: (reason?: string) => Promise<void>
}

type IrohConnection = {
  remoteEndpointId: string
  openStream: () => Promise<RawIrohStream>
  acceptStream: () => Promise<RawIrohStream>
  close: () => Promise<void>
}

type IrohAcceptor = {
  accept: () => Promise<IrohConnection | undefined>
  close: () => Promise<void>
}

function irohArtifactAvailable(): boolean {
  return typeof WebAssembly !== "undefined"
}

async function installPolicyBrowserRuntime(): Promise<void> {
  if (!irohArtifactAvailable()) throw new Error("WebAssembly unavailable in this browser")
  await policyInit()
  ingressBudgetProfile ??= new WasmIngressBudgetProfile()
  if (!rustRuntimeInstalled) {
    installMeshRustRuntime({
      state: WasmStateCore,
      createDeviceRouteCatalog: () => new WasmDeviceRouteCatalog(),
      createAutomergeSyncEngine: (localDeviceId, maximumFrameBytes) =>
        new WasmAutomergeSyncEngine(localDeviceId, maximumFrameBytes),
      createAutomergeDeviceSyncFlow: (targetDeviceId, documentId, maximumRounds) =>
        new WasmAutomergeDeviceSyncFlow(targetDeviceId, documentId, maximumRounds),
      decodeAutomergeDeviceSyncRequest: (request, expectedRemoteDeviceId) =>
        automergeDeviceSyncRequestSchema.parse(
          WasmAutomergeDeviceSyncFlow.decodeIncomingRequest(request, expectedRemoteDeviceId),
        ),
      encodeAutomergeDeviceSyncResponse: (batchId, ack, frame): unknown =>
        WasmAutomergeDeviceSyncFlow.encodeResponse(batchId, ack, frame),
      createBatchDeliveryFlow: (targetDeviceId, routeInstanceIds, fallbackDelayMs, retryDelaysMs) =>
        new WasmMeshBatchDeliveryFlow(targetDeviceId, routeInstanceIds, fallbackDelayMs, retryDelaysMs),
      createMeshRuntimeState: () => new WasmMeshRuntimeState(),
      createGossipLifecycleState: topicPrefix => new WasmGossipLifecycleState(topicPrefix),
      createMeshLifecycleState: () => new WasmMeshLifecycleState(),
      createMeshSessionLifecycleState: stableAfterMs => new WasmMeshSessionLifecycle(stableAfterMs),
      createLiveWorkspaceSession: (workspaceId, secret) => new WasmLiveWorkspaceSession(workspaceId, secret),
      createMeshScopeRuntime: (workspaceId, secret) => new WasmMeshScopeRuntime(workspaceId, secret),
      createMeshHandshakeFlow: direction => new WasmMeshHandshakeFlow(direction),
      createMeshAuthenticatedSessions: () => new WasmMeshAuthenticatedSessions(),
    })
    rustRuntimeInstalled = true
  }
  if (!pairingCodecInstalled) {
    installPairingCodec(new WasmPairingCodec())
    pairingCodecInstalled = true
  }
}

/** Returns a finite Rust-owned outer frame limit after the matching WASM initializes. */
export function meshIngressFrameLimit(frameType: string): number {
  if (!ingressBudgetProfile) throw new Error("Mesh ingress budget profile is unavailable")
  return ingressBudgetProfile.maxFrameBytes(frameType)
}

export function meshIngressBudgetProfile(): InstanceType<typeof WasmIngressBudgetProfile> {
  if (!ingressBudgetProfile) throw new Error("Mesh ingress budget profile is unavailable")
  return ingressBudgetProfile
}

export function meshIngressPayloadLimit(frameType: string): number {
  if (!ingressBudgetProfile) throw new Error("Mesh ingress budget profile is unavailable")
  return ingressBudgetProfile.maxPayloadBytes(frameType)
}

export function meshIngressTransferDeadlineMs(): number {
  if (!ingressBudgetProfile) throw new Error("Mesh ingress budget profile is unavailable")
  return ingressBudgetProfile.maxTransferDeadlineMs()
}

/** Initializes the Rust/WASM policy runtime before application state reads it. */
export function initializePolicyBrowserRuntime(): Promise<void> {
  browserRuntimeInitialization ??= installPolicyBrowserRuntime().catch(error => {
    browserRuntimeInitialization = undefined
    throw error
  })
  return browserRuntimeInitialization
}

export type IrohBrowserNodeOptions = {
  /** Enables Iroh's high-volume connection and stream events for a focused reproduction. */
  verboseTransportLogging?: boolean
}

export async function startIrohBrowserNode(secret?: Uint8Array, options: IrohBrowserNodeOptions = {}): Promise<IrohNode> {
  if (secret !== undefined && secret.byteLength !== 32) throw new Error("Iroh node secret must be exactly 32 bytes")
  await initializePolicyBrowserRuntime()
  return (await import("./irohNode")).startIrohBrowserNode(secret, options)
}
