import type { IrohNode, IrohBrowserNodeOptions } from "./iroh"
import type { GossipStateMachine } from "@meta-uber/mesh-replication"
import { browserRelayUrls } from "./browserRelaySettings"
import { diagnoseStartupStep } from "./sync/startupDiagnostics"

export async function startIrohBrowserNode(secret?: Uint8Array, options: IrohBrowserNodeOptions = {}): Promise<IrohNode> {
  const { default: transportInit, BrowserNode, WasmGossipEngine, setBrowserTransportDebugLogging } =
    await diagnoseStartupStep("transport-module", () => import("@meta-uber/mesh-transport/transport-wasm"))
  const detail = { bytes: 0 }
  await diagnoseStartupStep("transport-wasm", async () => {
    const wasm = await transportInit()
    detail.bytes = wasm.memory.buffer.byteLength
  }, detail)
  setBrowserTransportDebugLogging(options.verboseTransportLogging === true)
  const node = await diagnoseStartupStep("transport-node", () => BrowserNode.start(secret, browserRelayUrls()))
  return {
    endpointId: node.endpointId,
    createGossipEngine: () => new WasmGossipEngine(node.endpointId) as GossipStateMachine,
    dial: endpoint => node.dial(endpoint) as ReturnType<IrohNode["dial"]>,
    dialWebRtc: endpoint => node.dialWebRtc(endpoint),
    dialRelay: endpoint => node.dialRelay(endpoint) as ReturnType<IrohNode["dialRelay"]>,
    accept: () => node.accept(),
    close: reason => node.close(reason),
  }
}
