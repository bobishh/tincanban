import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { initializePolicyBrowserRuntime } from "./iroh"
import { installPairingCodec } from "@meta-uber/mesh-pairing"
import { installMeshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import {
  initSync,
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
  WasmStateCore,
} from "@meta-uber/mesh-transport/wasm"
const wasm = readFileSync(resolve(process.cwd(), "vendor/meta-mesh/packages/mesh-transport/wasm/policy/meta_mesh_policy_bg.wasm"))
initSync({ module: wasm })

installMeshRustRuntime({
  state: WasmStateCore,
  createDeviceRouteCatalog: () => new WasmDeviceRouteCatalog(),
  createAutomergeSyncEngine: (localDeviceId, maximumFrameBytes) =>
    new WasmAutomergeSyncEngine(localDeviceId, maximumFrameBytes),
  createAutomergeDeviceSyncFlow: (targetDeviceId, documentId, maximumRounds) =>
    new WasmAutomergeDeviceSyncFlow(targetDeviceId, documentId, maximumRounds),
  decodeAutomergeDeviceSyncRequest: (request, expectedRemoteDeviceId) =>
    WasmAutomergeDeviceSyncFlow.decodeIncomingRequest(request, expectedRemoteDeviceId),
  encodeAutomergeDeviceSyncResponse: (batchId, ack, frame) =>
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

installPairingCodec(new WasmPairingCodec())

await initializePolicyBrowserRuntime()
