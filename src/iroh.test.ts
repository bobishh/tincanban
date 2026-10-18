import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { BrowserNode, WasmBlobEngine, WasmGossipEngine, browserTransportDebugLoggingEnabled, initSync } from "@meta-uber/mesh-transport/transport-wasm"
import { startIrohBrowserNode, WasmPairingCodec } from "./iroh"
import { fileReferenceSchema } from "./domain/entitySchemas"

// Ensure WASM is initialized for Node environment
const wasmPath = resolve(__dirname, "../vendor/meta-mesh/packages/mesh-transport/transport-wasm/meta_mesh_bg.wasm")
const wasmBytes = readFileSync(wasmPath)
initSync({ module: wasmBytes })

describe("Iroh persistent node secret support", () => {
  it("keeps verbose Iroh connection logging disabled unless a caller explicitly enables it", async () => {
    expect(browserTransportDebugLoggingEnabled()).toBe(false)

    const node = await startIrohBrowserNode(undefined, { verboseTransportLogging: true })
    try {
      expect(browserTransportDebugLoggingEnabled()).toBe(true)
    } finally {
      await node.close()
    }

    const defaultNode = await startIrohBrowserNode()
    try {
      expect(browserTransportDebugLoggingEnabled()).toBe(false)
    } finally {
      await defaultNode.close()
    }
  })

  it("maintains no-arg compatibility and generates a valid endpointId", async () => {
    const node = await startIrohBrowserNode()
    try {
      expect(node.endpointId).toBeDefined()
      expect(node.endpointId.length).toBe(64) // hex-encoded 32-byte public key
    } finally {
      await node.close()
    }
  })

  it("produces deterministic endpointId for the same 32-byte secret", async () => {
    const secret = new Uint8Array(32)
    secret.fill(42)

    const node1 = await startIrohBrowserNode(secret)
    const endpoint1 = node1.endpointId
    await node1.close()

    const node2 = await startIrohBrowserNode(secret)
    const endpoint2 = node2.endpointId
    await node2.close()

    expect(endpoint1).toBe(endpoint2)
  })

  it("produces different endpointIds for different secrets", async () => {
    const secret1 = new Uint8Array(32)
    secret1.fill(1)

    const secret2 = new Uint8Array(32)
    secret2.fill(2)

    const node1 = await startIrohBrowserNode(secret1)
    const endpoint1 = node1.endpointId
    await node1.close()

    const node2 = await startIrohBrowserNode(secret2)
    const endpoint2 = node2.endpointId
    await node2.close()

    expect(endpoint1).not.toBe(endpoint2)
  })

  it("rejects caller-provided secrets with invalid byte length", async () => {
    const shortSecret = new Uint8Array(16)
    const longSecret = new Uint8Array(33)
    const emptySecret = new Uint8Array(0)

    await expect(startIrohBrowserNode(shortSecret)).rejects.toThrow(/32 bytes/)
    await expect(startIrohBrowserNode(longSecret)).rejects.toThrow(/32 bytes/)
    await expect(startIrohBrowserNode(emptySecret)).rejects.toThrow(/32 bytes/)

    await expect(BrowserNode.start(shortSecret)).rejects.toThrow(/32 bytes/)
    await expect(BrowserNode.start(longSecret)).rejects.toThrow(/32 bytes/)
    await expect(BrowserNode.start(emptySecret)).rejects.toThrow(/32 bytes/)
  })

  it("BrowserNode.start directly accepts a 32-byte secret and retains no-arg compatibility", async () => {
    const defaultNode = await BrowserNode.start()
    try {
      expect(defaultNode.endpointId.length).toBe(64)
    } finally {
      await defaultNode.close()
    }

    const secret = new Uint8Array(32)
    secret[0] = 7
    const customNode = await BrowserNode.start(secret)
    try {
      expect(customNode.endpointId.length).toBe(64)
    } finally {
      await customNode.close()
    }
  })
})

describe("Iroh gossip and blobs support in match", () => {
  it("Given the production browser node, when tincanban starts gossip, then it creates the Rust gossip engine", async () => {
    const secret = new Uint8Array(32)
    secret.fill(9)
    const node = await startIrohBrowserNode(secret)
    try {
      const engine = node.createGossipEngine()
      const joined = engine.joinTopic("production-workspace", [])
      expect(joined.topicId).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await node.close()
    }
  })

  it("Given the shared Rust core, when a pairing frame is decoded, then binary payload survives", () => {
    const codec = new WasmPairingCodec()
    const payload = new Uint8Array([0, 1, 255])
    const frame = codec.encode("mesh-control-sync", "workspace-secret", payload)

    expect(codec.inspect(frame)).toEqual({ type: "mesh-control-sync", secret: "workspace-secret" })
    expect(codec.decode(frame, "mesh-control-sync", "workspace-secret")).toEqual(payload)
  })

  it("Given the shared Rust core, when pairing secret is wrong, then decoding fails closed", () => {
    const codec = new WasmPairingCodec()
    const frame = codec.encode("sync-request", "secret-a", new Uint8Array([1]))

    expect(() => codec.decode(frame, "sync-request", "secret-b")).toThrow("Pairing authorization failed")
  })

  it("WasmBlobEngine creates content-addressed blob with ticket and verifies payload", () => {
    const engine = new WasmBlobEngine()
    const data = new TextEncoder().encode("resume attachment markdown")
    const blob = engine.createBlob(data, "resume.md", "text/markdown", null)

    expect(blob.blobId).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(blob.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(blob.ticket).toBeDefined()
    expect(blob.size).toBe(data.byteLength)

    expect(engine.hasBlob(blob.hash)).toBe(true)
    expect(engine.getBlob(blob.hash)).toEqual(data)
    expect(engine.verifyBlob(blob.hash, data)).toBe(true)

    // Verify Automerge entity schema validates the blob reference with ticket
    const fileRef = {
      type: "blob" as const,
      hash: blob.hash,
      ticket: blob.ticket,
      byteLength: blob.size,
      mimeType: blob.mediaType,
      fileName: blob.name,
    }
    const validated = fileReferenceSchema.parse(fileRef)
    expect(validated).toEqual(fileRef)
  })

  it("WasmGossipEngine joins workspace topic and broadcasts deduplicated messages", () => {
    const peer1 = "peer-alpha-001"
    const peer2 = "peer-beta-002"
    const engine1 = new WasmGossipEngine(peer1)
    const engine2 = new WasmGossipEngine(peer2)

    const joined1 = engine1.joinTopic("workspace-sync", [peer2])
    const joined2 = engine2.joinTopic("workspace-sync", [peer1])
    expect(joined1.topicId).toBe(joined2.topicId)
    const engines = new Map([[peer1, engine1], [peer2, engine2]])
    const deliveries: Uint8Array[] = []
    type GossipStep = ReturnType<typeof engine1.joinTopic>
    const drive = (initial: Array<{ sender: string; step: GossipStep }>) => {
      const queue = [...initial]
      let iterations = 0
      while (queue.length) {
        expect(++iterations).toBeLessThan(1_000)
        const { sender, step } = queue.shift()!
        deliveries.push(...step.deliveries.map(delivery => delivery.content))
        for (const send of step.sends) {
          const target = engines.get(send.peer)
          expect(target).toBeDefined()
          queue.push({ sender: send.peer, step: target!.handleMessage(sender, send.packet) })
        }
      }
    }
    drive([{ sender: peer1, step: joined1 }, { sender: peer2, step: joined2 }])

    const payload = new TextEncoder().encode("entity-change-notice")
    const broadcast = engine1.broadcast("workspace-sync", payload)
    expect(broadcast.sends.length).toBeGreaterThan(0)
    const packet = broadcast.sends[0].packet
    drive([{ sender: peer1, step: broadcast }])

    expect(deliveries).toContainEqual(payload)

    // Duplicate message delivery has no application event.
    const duplicate = engine2.handleMessage(peer1, packet)
    expect(duplicate.deliveries).toEqual([])
  })
})


describe("policy initialization recovery", () => {
  it("Given unavailable WebAssembly, when initialization fails, then concurrent callers share failure and a later retry installs policy", async () => {
    vi.resetModules()
    const runtime = await import("./iroh")
    vi.stubGlobal("WebAssembly", undefined)
    try {
      const first = runtime.initializePolicyBrowserRuntime()
      const concurrent = runtime.initializePolicyBrowserRuntime()
      expect(concurrent).toBe(first)
      await expect(first).rejects.toThrow("WebAssembly unavailable in this browser")
    } finally { vi.unstubAllGlobals() }

    // Node preloads the same policy binary that the browser downloads.
    const policy = await import("@meta-uber/mesh-transport/wasm")
    policy.initSync({ module: readFileSync(resolve(__dirname, "../vendor/meta-mesh/packages/mesh-transport/wasm/policy/meta_mesh_policy_bg.wasm")) })
    await expect(runtime.initializePolicyBrowserRuntime()).resolves.toBeUndefined()
    const { meshRustRuntime } = await import("@meta-uber/mesh-replication/runtime")
    const installed = meshRustRuntime()
    const routes = installed.createDeviceRouteCatalog()
    const mesh = installed.createMeshRuntimeState()
    const lifecycle = installed.createMeshLifecycleState()
    try {
      expect(routes.routesFor("board", "remote")).toEqual([])
      mesh.start()
      const update = mesh.encodeWorkspaceUpdate("board", "nonce")
      expect(mesh.isWorkspaceUpdate(update, "board")).toBe(true)
      expect(mesh.isWorkspaceUpdate(update, "other-board")).toBe(false)
      expect(lifecycle.beginStart()).toBe(true)
      expect(lifecycle.completeStart()).toBe(true)
      expect(lifecycle.stopped).toBe(false)
    } finally {
      routes.free?.()
      mesh.free?.()
      lifecycle.free?.()
    }
    const codec = new runtime.WasmPairingCodec()
    const payload = new Uint8Array([3, 1, 4])
    expect(codec.decode(codec.encode("mesh-handshake-request", "retry-secret", payload), "mesh-handshake-request", "retry-secret"))
      .toEqual(payload)
  })
})
