import { beforeAll, describe, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { MeshNetworkError } from "@meta-uber/mesh-transport"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { encodePairingFrame, inspectPairingFrame } from "@meta-uber/mesh-pairing"
import { adoptEnrolledIdentity, bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url, signEnvelope } from "../domain/identity"
import { certHashDefault, createDelegatedCertificate, createWorkspaceGrant, defaultProofStore } from "../domain/proofs"
import { createWorkspaceOwnershipTransfer, verifyWorkspaceGrant } from "./meshRecords"
import { assertRequiredMeshCapabilities, DurableMesh, isMeshDialNetworkFailure } from "./durableMesh"
import { isNativeKeeperRoute } from "./durableMeshSessions"
import { defaultStorage } from "../storage"
import { isEnvelope, isGrantRevoked } from "./durableMeshBase"
import { mergeSuccessionState } from "./durableMeshOwnershipScope"
import { clearMeshTrace, meshTraceSnapshot } from "./meshTrace"
import type { SyncConnection, SyncNode } from "./transport"
import type { WorkspaceMeshCredential, WorkspacePeerRecord } from "./peerStore"
import type { LocalProfile } from "../domain/identity"
import type { SessionEntry } from "./durableMeshBase"
import type { LiveWorkspaceSync } from "./workspaceSet"
import type { WorkspaceOwnershipTransfer } from "./meshRecords"

type TestCredential = {
  workspaceId: string
  ownerPersonId?: string
  ownerPublicKey?: string
  ownerCertificates?: unknown[]
  transportSecret?: string
  epoch?: number
  updatedAt?: string
  catalog?: {
    revocations?: unknown[]
    ownershipTransfers?: WorkspaceOwnershipTransfer[]
    successionClaims?: unknown[]
    [key: string]: unknown
  }
}
type TestPeer = Pick<WorkspacePeerRecord, "workspaceId" | "deviceId"> & {
  personId?: string
  instanceId?: string
  endpoint?: string
  transportSecret?: string | Uint8Array
  role?: "owner" | "editor" | "visitor"
  lastSeen?: string
  advertisement?: unknown
}
type TestSession = Omit<Partial<SessionEntry>, "connection" | "session"> & {
  connection?: Partial<SyncConnection>
  session?: Partial<LiveWorkspaceSync>
}
type MeshTestHooks = {
  node?: unknown
  acceptor?: unknown
  adoptedNode?: { endpointId: string; accept: () => Promise<unknown>; close: () => Promise<void> }
  sessions: Map<string, TestSession>
  lastDiagnostic: string
  activeWorkspaceIds?: Set<string>
  instanceId: string
  lifecycle?: { stopped: boolean }
  runtimeState?: { stop: () => void }
  gossip: { closeAll: () => unknown }
  browserSessions: { host: {
    currentRemoved: (entry: { workspaceId: string; deviceId: string; endpoint: string }) => Promise<void>
    create: (...args: unknown[]) => { session: Partial<LiveWorkspaceSync> }
  } }
  dialScheduler: { host: { peers: () => Promise<WorkspacePeerRecord[]> } }
  runtime: () => {
    routeAttemptActive: (key: string) => boolean
    reconnectState: (key: string) => { failures: number; retryAtMs: number } | null
    beginRouteAttempt: (key: string, at: number) => void
    scheduleReconnect: (key: string, at: number, delay: number, maximum: number) => void
    admitSession: (session: unknown, preferredDirection: string) => { generation?: number }
    removeSession: (key: unknown, generation: number) => string | null
  }
  peerKey: (workspaceId: string, deviceId: string, instanceId: string) => string
  routeFailures: (key: string) => number
  removeAuthenticatedPeer: (...args: string[]) => void
  refreshWorkspaceGossip: (...args: string[]) => Promise<void>
  notify: () => Promise<void>
  reclassifyWorkspaceAuthority: (workspaceId: string) => Promise<void>
  mergeRevocations: (credential: TestCredential, records: unknown[]) => Promise<void>
  activeCredentialsForProfile: (credentials: TestCredential[], profile: unknown) => Promise<TestCredential[]>
  peerInstances: (workspaceId?: string) => Promise<TestPeer[]>
  ensureOwnerCredential: (workspaceId: string) => Promise<TestCredential>
  start: (...args: unknown[]) => Promise<void>
  encodeOwnerWorkspaceOffer: (...args: unknown[]) => Promise<Uint8Array>
  addOwnerWorkspace: (workspaceId: string) => Promise<void>
  offerMissingOwnerWorkspaces: (...args: unknown[]) => Promise<void>
  dropSessions: () => Promise<void>
  prepareCredentials: () => Promise<void>
  connectPeer: (peer: TestPeer, route: object, signal: AbortSignal, routeSignal: AbortSignal) => Promise<void>
  dialDevice: (peers: TestPeer[], signal: AbortSignal) => Promise<void>
  hasDeviceSession: (workspaceId: string, deviceId: string) => boolean
  acceptConnection: (connection: object) => Promise<void>
  acceptOnInvitationNode: (connection: object, stream: object, frame: Uint8Array) => Promise<void>
  publishAll: () => Promise<void>
  publishWorkspace: (workspaceId: string) => Promise<void>
  broadcastWorkspaceGossip: (workspaceId: string) => Promise<void>
  installSession: (...args: [string, string, string, string, number | undefined, "incoming" | "outgoing", Partial<SyncConnection>,
    boolean?, string?, boolean?, string?, boolean?, ("mesh-owner-workspace-offer" | "mesh-owner-workspace-offer-page-v1")?, boolean?, string?]) => Promise<boolean>
  dialLoop: (signal: AbortSignal) => Promise<void>
  scheduleDials: (localDeviceId: string, signal: AbortSignal) => Promise<void>
  mergeOwnershipTransfers: (credential: TestCredential, transfers: WorkspaceOwnershipTransfer[]) => Promise<TestCredential>
  pruneInvalidStoredPeers: (credential: TestCredential, localDeviceId: string) => Promise<void>
  refreshOwnBundle: (credential: TestCredential, profile: LocalProfile, endpoint: string, certificates: unknown[]) => Promise<void>
  putVerifiedBundle: (credential: TestCredential, bundle: unknown) => Promise<void>
  mergeSuccessionState: (...args: unknown[]) => Promise<TestCredential>
  mergeDeviceRevocations: (...args: unknown[]) => Promise<void>
  mergeDepartures: (...args: unknown[]) => Promise<void>
  mergePeerBundles: (...args: unknown[]) => Promise<void>
  report: (stage: string, error: unknown) => void
  trace: (...args: unknown[]) => void
  shutdown: () => Promise<void>
  runMeshOnce: (signal: AbortSignal) => Promise<void>
}

function meshHooks(mesh: DurableMesh): MeshTestHooks {
  return mesh as unknown as MeshTestHooks
}

beforeAll(async () => { await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")) })


describe("DurableMesh peer catalog gossip", () => {
  it.each(["credential", "connection"])("Given a dial from an older runtime, When the node changes during %s, Then its failure cannot close or penalize the replacement", async phase => {
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never,
      workspaceStore: {} as never, getProfile: async () => ({} as never) })
    const internal = mesh as unknown as {
      node?: SyncNode
      requireDialCredential: () => Promise<unknown>
      openPeerConnection: () => Promise<unknown>
      recordRouteFailure: () => unknown
      reportProtocolFailure: () => unknown
      connectPeer: (peer: { workspaceId: string; deviceId: string }, route: object, signal: AbortSignal, routeSignal: AbortSignal) => Promise<unknown>
    }
    const previous = { close: vi.fn(async () => {}) }
    const replacement = { close: vi.fn(async () => {}) }
    internal.node = previous as unknown as SyncNode
    internal.requireDialCredential = vi.fn(async () => {
      if (phase === "credential") internal.node = replacement as unknown as SyncNode
      return {}
    })
    internal.openPeerConnection = vi.fn(async () => {
      internal.node = replacement as unknown as SyncNode
      throw new MeshNetworkError("browser runtime node is closed")
    })
    internal.recordRouteFailure = vi.fn()
    internal.reportProtocolFailure = vi.fn()
    await expect(internal.connectPeer({ workspaceId: "workspace", deviceId: "remote" }, {},
      new AbortController().signal, new AbortController().signal)).rejects.toThrow(/closed|cancelled/i)
    expect(internal.node).toBe(replacement)
    expect(replacement.close).not.toHaveBeenCalled()
    expect(internal.recordRouteFailure).not.toHaveBeenCalled()
    if (phase === "credential") expect(internal.openPeerConnection).not.toHaveBeenCalled()
    // This fixture owns no actual runtime node.
    internal.node = undefined
    await mesh.dispose()
  })
  it("Given unchanged rights, When handshakes overlap and timestamps refresh, Then history is reclassified once until rights change", async () => {
    let authority = { version: 1, workspaceId: "workspace", ownerPersonId: "owner", ownerPublicKey: "key",
      ownerCertificates: [], epoch: 1, updatedAt: "2026-10-09T11:00:00Z", catalog: {} }
    let finish!: () => void
    const reclassify = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
      .mockResolvedValue(undefined)
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never,
      workspaceStore: { reclassify } as never, getProfile: async () => ({} as never),
      store: { getWorkspaceAuthority: async () => authority } as never })
    const internal = mesh as unknown as { reclassifyWorkspaceAuthority: (workspaceId: string) => Promise<void> }
    const first = internal.reclassifyWorkspaceAuthority("workspace")
    const overlapping = internal.reclassifyWorkspaceAuthority("workspace")
    await vi.waitFor(() => expect(reclassify).toHaveBeenCalledOnce())
    finish()
    await Promise.all([first, overlapping])
    authority = { ...authority, updatedAt: "2026-10-09T11:00:01Z" }
    await internal.reclassifyWorkspaceAuthority("workspace")
    expect(reclassify).toHaveBeenCalledOnce()
    authority = { ...authority, epoch: 2 }
    await internal.reclassifyWorkspaceAuthority("workspace")
    expect(reclassify).toHaveBeenCalledTimes(2)
    authority = { ...authority, epoch: 3 }
    reclassify.mockRejectedValueOnce(new Error("History validation failed"))
    await expect(internal.reclassifyWorkspaceAuthority("workspace")).rejects.toThrow("History validation failed")
    await internal.reclassifyWorkspaceAuthority("workspace")
    expect(reclassify).toHaveBeenCalledTimes(4)
    await mesh.dispose()
  })
  it("Given mesh stops during a dial, when route selection aborts, then cancellation does not become a reconnect error", async () => {
    const onDiagnostic = vi.fn()
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({} as never), store: { listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [], listPeers: async () => [] } as never, onDiagnostic })
    const internal = mesh as unknown as {
      node?: unknown
      dialDevice: (devices: { workspaceId: string; deviceId: string; instanceId: string; advertisement: unknown }[], signal: AbortSignal) => Promise<void>
      runtime: () => { routeAttemptActive: (peerKey: string) => boolean }
      peerKey: (workspaceId: string, deviceId: string, instanceId: string) => string
    }
    const controller = new AbortController()
    controller.abort()
    internal.node = {}
    await internal.dialDevice([{ workspaceId: "workspace", deviceId: "remote", instanceId: "tab", advertisement: null }], controller.signal)
    expect(onDiagnostic).not.toHaveBeenCalled()
    expect(internal.runtime().routeAttemptActive(internal.peerKey("workspace", "remote", "tab"))).toBe(false)
    internal.node = undefined
    await mesh.dispose()
  })
  it("clears a rejected workspace diagnostic only when its peer session is removed", async () => {
    const onDiagnostic = vi.fn()
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({} as never), store: { listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [], listPeers: async () => [] } as never, onDiagnostic })
    const internal = meshHooks(mesh)
    internal.removeAuthenticatedPeer = vi.fn()
    internal.refreshWorkspaceGossip = vi.fn(async () => {})
    internal.notify = vi.fn(async () => {})
    const removed = internal.browserSessions.host.currentRemoved

    internal.lastDiagnostic = "Workspace workspac from remote-a: unsigned changes rejected"
    await removed({ workspaceId: "workspace", deviceId: "remote-b", endpoint: "endpoint-b" })
    expect(internal.lastDiagnostic).toBe("Workspace workspac from remote-a: unsigned changes rejected")

    await removed({ workspaceId: "workspace", deviceId: "remote-a", endpoint: "endpoint-a" })
    expect(internal.lastDiagnostic).toBe("")
    expect(onDiagnostic).toHaveBeenLastCalledWith("")

    internal.lastDiagnostic = "Handshake remote-a: invalid grant"
    await removed({ workspaceId: "workspace", deviceId: "remote-a", endpoint: "endpoint-a" })
    expect(internal.lastDiagnostic).toBe("Handshake remote-a: invalid grant")
    await mesh.dispose()
  })

  it("skips empty revocation planning only when no stored revocations exist", async () => {
    const plan = vi.spyOn(meshRustRuntime().state, "planAuthorityMerge")
    const getProfile = vi.fn(async () => ({ identity: { personId: "owner" }, device: { deviceId: "owner-device" } } as never))
    const putWorkspaceCredential = vi.fn()
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile, store: { putWorkspaceCredential } as never })
    const credential = { workspaceId: "workspace-1", catalog: { revocations: [] } }

    try {
      await meshHooks(mesh).mergeRevocations(credential, [])
      expect(plan).not.toHaveBeenCalled()
      expect(getProfile).not.toHaveBeenCalled()
      expect(putWorkspaceCredential).not.toHaveBeenCalled()
    } finally {
      plan.mockRestore()
      await mesh.dispose()
    }
  })

  it("Given unchanged stored revocations and an empty incoming list, then enforces eviction without rewriting unchanged peers", async () => {
    const credential = { workspaceId: "workspace-1", catalog: { revocations: [{ payload: { personId: "local" } }] } }
    const peer = { workspaceId: "workspace-1", personId: "remote", deviceId: "remote-device" }
    const state = meshRustRuntime().state
    const plan = vi.spyOn(state, "planAuthorityMerge").mockReturnValue({
      credential, peers: [peer], evictDeviceIds: [peer.deviceId], evictPersonIds: [], localAccessRevoked: true,
    })
    const upsertPeer = vi.fn()
    const putWorkspaceCredential = vi.fn()
    const evict = vi.fn(async () => {})
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ identity: { personId: "local" }, device: { deviceId: "local-device" } } as never),
      store: { listPeers: async () => [peer], putWorkspaceCredential, upsertPeer } as never })
    const internal = meshHooks(mesh)
    internal.sessions.set("workspace-1:remote-device:slot", { workspaceId: "workspace-1", deviceId: peer.deviceId, evict })

    try {
      const revision = await defaultStorage.readWorkspaceRevision(credential.workspaceId)
      await expect(internal.mergeRevocations(credential, [])).rejects.toThrow("Workspace access revoked")
      expect(plan).toHaveBeenCalledWith(expect.objectContaining({ credential,
        records: { kind: "revocations", records: [] } }))
      expect(upsertPeer).not.toHaveBeenCalled()
      expect(putWorkspaceCredential).not.toHaveBeenCalled()
      expect(await defaultStorage.readWorkspaceRevision(credential.workspaceId)).toBe(revision)
      expect(evict).toHaveBeenCalledWith("peer revoked")
    } finally {
      plan.mockRestore()
      await mesh.dispose()
    }
  })

  it("applies a fresh incoming revocation when the stored list is empty", async () => {
    const credential = { workspaceId: "workspace-1", catalog: { revocations: [] } }
    const nextCredential = { ...credential, catalog: { revocations: [{ payload: { personId: "remote" } }] } }
    const record = { payload: { personId: "remote" } }
    const peer = { workspaceId: "workspace-1", personId: "remote", deviceId: "remote-device" }
    const state = meshRustRuntime().state
    const plan = vi.spyOn(state, "planAuthorityMerge").mockReturnValue({
      credential: nextCredential, peers: [peer], evictDeviceIds: [peer.deviceId], evictPersonIds: [], localAccessRevoked: false,
    })
    const putWorkspaceCredential = vi.fn()
    const upsertPeer = vi.fn()
    const evict = vi.fn(async () => {})
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ identity: { personId: "owner" }, device: { deviceId: "owner-device" } } as never),
      store: { listPeers: async () => [peer], putWorkspaceCredential, upsertPeer } as never })
    ;meshHooks(mesh).sessions.set("workspace-1:remote-device:slot", { workspaceId: "workspace-1", deviceId: peer.deviceId, evict })

    try {
      await meshHooks(mesh).mergeRevocations(credential, [record])
      expect(plan).toHaveBeenCalledWith(expect.objectContaining({ records: { kind: "revocations", records: [record] } }))
      expect(putWorkspaceCredential).toHaveBeenCalledWith(nextCredential)
      expect(upsertPeer).toHaveBeenCalledWith(peer)
      expect(evict).toHaveBeenCalledWith("peer revoked")
    } finally {
      plan.mockRestore()
      await mesh.dispose()
    }
  })

  it("rejects a removed person's stale grant but accepts their newly approved generation", () => {
    const credential: WorkspaceMeshCredential = { version: 1, workspaceId: "workspace-1", ownerPersonId: "owner",
      ownerPublicKey: "owner-key", ownerCertificates: [], transportSecret: "secret", epoch: 1,
      updatedAt: new Date().toISOString(), catalog: { revocations: [{ payload: { personId: "returning", epoch: 2 } }] } }
    expect(isGrantRevoked(credential, "returning", { payload: { accessEpoch: 2 } })).toBe(true)
    expect(isGrantRevoked(credential, "returning", { payload: { accessEpoch: 3 } })).toBe(false)
    expect(isGrantRevoked(credential, "returning", { payload: {} })).toBe(true)
  })
  it("ignores an empty old envelope field but rejects obsolete authority evidence", () => {
    const envelope = {
      version: 1, workspaceId: "workspace-1", ownerPersonId: "owner", ownerPublicKey: "owner-key",
      ownerCertificates: [], transportSecret: "secret", epoch: 1, peers: [], breakGlassClaims: [],
    }
    expect(isEnvelope(envelope)).toBe(true)
    expect(() => isEnvelope({ ...envelope, breakGlassClaims: [{}] }))
      .toThrow("Unsupported legacy break-glass authority evidence")
  })
  it("Given Iroh has no route metadata, when Promise.any rejects, then it remains a network failure", () => {
    const unavailable = new AggregateError([new Error("No addressing information available")], "All promises were rejected")
    expect(isMeshDialNetworkFailure(unavailable)).toBe(true)
    expect(isMeshDialNetworkFailure(new AggregateError([new Error("Invalid write signature")], "All promises were rejected"))).toBe(false)
  })

  it("Given a peer without iroh gossip, when capabilities are checked, then the handshake fails closed", () => {
    expect(() => assertRequiredMeshCapabilities(["heartbeat-v1", "automerge-sync-v1"]))
      .toThrow("Peer does not support required iroh gossip")
    expect(() => assertRequiredMeshCapabilities(["heartbeat-v1", "iroh-gossip-v1"]))
      .toThrow("Peer does not support required Automerge sync")
    expect(() => assertRequiredMeshCapabilities(["automerge-sync-v1", "iroh-gossip-v1", "device-revocation-v1"]))
      .toThrow("Peer needs causal write admission support")
    expect(() => assertRequiredMeshCapabilities(["automerge-sync-v1", "iroh-gossip-v1", "device-revocation-v1",
      "causal-write-admission-v1"]))
      .not.toThrow()
  })

  it("Given stored mesh trust belongs to another transient identity, when startup filters credentials, then it preserves trust for recovery", async () => {
    const removeWorkspaceMeshData = vi.fn()
    const credential = {
      version: 1 as const, workspaceId: "workspace-1", ownerPersonId: "previous-person",
      ownerPublicKey: "previous-key", ownerCertificates: [], transportSecret: "mesh-secret",
      epoch: 1, updatedAt: new Date().toISOString(),
    }
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ identity: { personId: "current-person", publicKey: "current-key" }, device: { deviceId: "current-device" } } as never),
      store: { removeWorkspaceMeshData, listWorkspaceCredentials: async () => [credential], listWorkspaceAuthorities: async () => [], listPeers: async () => [] } as never })

    await expect(meshHooks(mesh).activeCredentialsForProfile([credential],
      { identity: { personId: "current-person", publicKey: "current-key" }, device: { deviceId: "current-device" } })).resolves.toEqual([])
    expect(removeWorkspaceMeshData).not.toHaveBeenCalled()
    await mesh.dispose()
  })

  it("Given an identity-mismatched credential has peers, when scheduling routes, then it never dials that workspace", async () => {
    const credential = {
      version: 1 as const, workspaceId: "stale-workspace", ownerPersonId: "previous-person",
      ownerPublicKey: "previous-key", ownerCertificates: [], transportSecret: "mesh-secret", epoch: 1, updatedAt: new Date().toISOString(),
    }
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ identity: { personId: "current-person", publicKey: "current-key" }, device: { deviceId: "current-device" } } as never),
      store: { listWorkspaceCredentials: async () => [credential], listWorkspaceAuthorities: async () => [], listPeers: async () => [{ workspaceId: "stale-workspace", deviceId: "old-device" }] } as never })
    const internal = meshHooks(mesh)

    await internal.activeCredentialsForProfile([credential], { identity: { personId: "current-person", publicKey: "current-key" }, device: { deviceId: "current-device" } })

    await expect(internal.peerInstances()).resolves.toEqual([])
    await mesh.dispose()
  })

  it("explains a missing recovery policy separately from editor eligibility", async () => {
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ identity: { personId: "editor" } } as never),
      store: { getWorkspaceCredential: async () => ({ localGrant: { payload: { role: "editor" } } }) } as never })
    await expect(mesh.voteForSuccessor("workspace", "editor")).rejects.toThrow("The owner has not enabled ownership recovery")
    await mesh.dispose()
  })

  it("refuses to start ownership transfer to a peer without durable receipt support", async () => {
    const put = vi.fn()
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ identity: { personId: "owner" } } as never),
      store: { getWorkspaceCredential: async () => ({ ownerPersonId: "owner" }), putWorkspaceCredential: put,
        getPendingOwnershipTransfer: async () => null,
        listPeers: async () => [{ personId: "target", deviceId: "target-device" }] } as never })
    ;meshHooks(mesh).sessions.set("test", { workspaceId: "workspace", deviceId: "target-device" })
    await expect(mesh.transferOwnership("workspace", "target")).rejects.toThrow(/online/i)
    expect(put).not.toHaveBeenCalled()
    ;meshHooks(mesh).sessions.clear()
    await mesh.dispose()
  })

  it("does not offer a new owner workspace to a same-person session without the v2 offer capability", async () => {
    const credential = { workspaceId: "new-workspace", ownerPersonId: "owner", ownerPublicKey: "owner-key",
      ownerCertificates: [], transportSecret: "secret", epoch: 1, updatedAt: new Date().toISOString() }
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ identity: { personId: "owner", publicKey: "owner-key" }, device: { deviceId: "owner-device" } } as never),
      store: { getWorkspaceCredential: async () => credential, getPeer: async () => ({ personId: "owner" }),
        listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [] } as never })
    const internal = meshHooks(mesh)
    internal.ensureOwnerCredential = vi.fn(async () => credential)
    internal.start = vi.fn(async () => {})
    internal.notify = vi.fn(async () => {})
    internal.encodeOwnerWorkspaceOffer = vi.fn(async () => new Uint8Array([1]))
    const connection = { openStream: vi.fn() }
    internal.sessions.set("workspace:owner-device:instance", {
      workspaceId: "workspace", deviceId: "owner-device", instanceId: "instance", connection,
      remotePersonId: "owner", session: {}, evict: async () => {},
    })

    await internal.addOwnerWorkspace("new-workspace")
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(internal.encodeOwnerWorkspaceOffer).not.toHaveBeenCalled()
    expect(connection.openStream).not.toHaveBeenCalled()
    await mesh.dispose()
  })

  it("activates a newly created owner workspace in the current route catalog", async () => {
    const credential = { version: 1 as const, workspaceId: "new-workspace", ownerPersonId: "owner",
      ownerPublicKey: "owner-key", ownerCertificates: [], transportSecret: "secret", epoch: 1, updatedAt: new Date().toISOString() }
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ identity: { personId: "owner", publicKey: "owner-key" }, device: { deviceId: "owner-device" } } as never),
      store: { listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [], listPeers: async () => [] } as never })
    const internal = meshHooks(mesh)
    internal.activeWorkspaceIds = new Set(["existing-workspace"])
    internal.ensureOwnerCredential = vi.fn(async () => credential)
    internal.start = vi.fn(async () => {})
    internal.notify = vi.fn(async () => {})

    await internal.addOwnerWorkspace("new-workspace")

    expect(internal.activeWorkspaceIds).toEqual(new Set(["existing-workspace", "new-workspace"]))
    await mesh.dispose()
  })

  it("offers a new owner workspace over the renamed frame only after v2 negotiation", async () => {
    const credential = { workspaceId: "workspace", ownerPersonId: "owner", ownerPublicKey: "owner-key",
      ownerCertificates: [], transportSecret: "secret", epoch: 1, updatedAt: new Date().toISOString() }
    const offer = new TextEncoder().encode(JSON.stringify({ workspaceId: "new-workspace", workspace: { id: "new-workspace", bytes: "AA" } }))
    const receipt = new TextEncoder().encode(await sha256Base64Url(offer))
    const stream = { send: vi.fn<(data: Uint8Array) => Promise<void>>(async () => {}), closeSend: vi.fn(async () => {}),
      read: vi.fn(async () => encodePairingFrame("mesh-durable-ack", "secret", receipt)) }
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ identity: { personId: "owner", publicKey: "owner-key" }, device: { deviceId: "owner-device" } } as never),
      getOwnedWorkspaceIds: async () => ["new-workspace"],
      store: { getWorkspaceCredential: async () => credential, listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [] } as never })
    const internal = meshHooks(mesh)
    internal.ensureOwnerCredential = vi.fn(async () => credential)
    internal.start = vi.fn(async () => {})
    internal.notify = vi.fn(async () => {})
    internal.encodeOwnerWorkspaceOffer = vi.fn(async () => offer)
    const connection = { openStream: vi.fn(async () => stream) }
    internal.sessions.set("workspace:owner-device:instance", {
      workspaceId: "workspace", deviceId: "owner-device", instanceId: "instance", connection,
      remotePersonId: "owner", ownerWorkspaceOfferFrame: "mesh-owner-workspace-offer", session: {}, evict: async () => {},
    })

    await internal.addOwnerWorkspace("new-workspace")
    await vi.waitFor(() => expect(stream.send).toHaveBeenCalledOnce())

    expect(inspectPairingFrame(stream.send.mock.calls[0]![0]).type).toBe("mesh-owner-workspace-offer")
    await mesh.dispose()
  })

  it("shares one owner-workspace offer when concurrent sessions see the same missing scope", async () => {
    const credential = { workspaceId: "workspace", ownerPersonId: "owner", ownerPublicKey: "owner-key",
      ownerCertificates: [], transportSecret: "secret", epoch: 1, updatedAt: new Date().toISOString() }
    const offer = new TextEncoder().encode(JSON.stringify({ workspaceId: "new-workspace", workspace: { id: "new-workspace", bytes: "AA" } }))
    const receipt = new TextEncoder().encode(await sha256Base64Url(offer))
    const stream = { send: vi.fn<(data: Uint8Array) => Promise<void>>(async () => {}), closeSend: vi.fn(async () => {}),
      read: vi.fn(async () => encodePairingFrame("mesh-durable-ack", "secret", receipt)) }
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ identity: { personId: "owner", publicKey: "owner-key" }, device: { deviceId: "owner-device" } } as never),
      getOwnedWorkspaceIds: async () => ["new-workspace"],
      store: { getWorkspaceCredential: async () => credential, listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [] } as never })
    const internal = meshHooks(mesh)
    internal.encodeOwnerWorkspaceOffer = vi.fn(async () => offer)
    const connection = { openStream: vi.fn(async () => stream) }

    await Promise.all([
      internal.offerMissingOwnerWorkspaces(connection, "secret", [], "owner", "mesh-owner-workspace-offer"),
      internal.offerMissingOwnerWorkspaces(connection, "secret", [], "owner", "mesh-owner-workspace-offer"),
    ])

    expect(internal.encodeOwnerWorkspaceOffer).toHaveBeenCalledOnce()
    expect(connection.openStream).toHaveBeenCalledOnce()
    expect(stream.send).toHaveBeenCalledOnce()
    await mesh.dispose()
  })

  it("does not trust a stale peer record to offer an owner workspace to another person", async () => {
    const credential = { workspaceId: "workspace", ownerPersonId: "owner", ownerPublicKey: "owner-key",
      ownerCertificates: [], transportSecret: "secret", epoch: 1, updatedAt: new Date().toISOString() }
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ identity: { personId: "owner", publicKey: "owner-key" }, device: { deviceId: "owner-device" } } as never),
      store: { getWorkspaceCredential: async () => credential, getPeer: async () => ({ personId: "owner" }),
        listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [] } as never })
    const internal = meshHooks(mesh)
    internal.ensureOwnerCredential = vi.fn(async () => credential)
    internal.start = vi.fn(async () => {})
    internal.notify = vi.fn(async () => {})
    internal.encodeOwnerWorkspaceOffer = vi.fn(async () => new Uint8Array([1]))
    const connection = { openStream: vi.fn() }
    internal.sessions.set("workspace:other-device:instance", {
      workspaceId: "workspace", deviceId: "other-device", instanceId: "instance", connection,
      remotePersonId: "other-person", ownerWorkspaceOfferFrame: "mesh-owner-workspace-offer", session: {}, evict: async () => {},
    })

    await internal.addOwnerWorkspace("new-workspace")
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(internal.encodeOwnerWorkspaceOffer).not.toHaveBeenCalled()
    expect(connection.openStream).not.toHaveBeenCalled()
    await mesh.dispose()
  })
  it("does not report a cancelled losing route as an invalid peer or penalize its health", async () => {
    const onDiagnostic = vi.fn()
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({} as never), store: { listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [], listPeers: async () => [] } as never, onDiagnostic })
    const controller = new AbortController(); controller.abort()
    ;meshHooks(mesh).node = {}
    await expect(meshHooks(mesh).connectPeer({ workspaceId: "workspace", deviceId: "remote" }, {}, new AbortController().signal, controller.signal)).rejects.toThrow(/cancelled/)
    expect(onDiagnostic).not.toHaveBeenCalled()
    expect(meshHooks(mesh).routeFailures("workspace:remote")).toBe(0)
    ;meshHooks(mesh).node = undefined
    await mesh.dispose()
  })

  it("Given an incoming session wins a dial race, when the losing outgoing route fails, then connected UI stays healthy", async () => {
    const onDiagnostic = vi.fn()
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({} as never),
      store: { listPeers: async () => [], listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [] } as never, onDiagnostic })
    const internal = meshHooks(mesh)
    const peer = {
      workspaceId: "workspace", personId: "remote-person", deviceId: "remote-device", instanceId: "legacy:remote",
      endpoint: "remote-endpoint", transportSecret: "secret", role: "editor" as const, lastSeen: new Date().toISOString(),
      advertisement: { advertisement: { signerKeyId: "remote-device", signature: "signature", payload: {
        kind: "peer-advertisement", version: 1, workspaceId: "workspace", personId: "remote-person",
        deviceId: "remote-device", endpoint: "remote-endpoint", issuedAt: new Date().toISOString(),
      } } },
    }
    internal.node = {}
    internal.connectPeer = vi.fn(async () => {
      internal.runtime().admitSession({ key: { workspaceId: "workspace", deviceId: "remote-device", instanceId: "incoming" },
        connectionId: "incoming", remoteIssuedAt: new Date().toISOString(), direction: "incoming" }, "incoming")
      internal.sessions.set("workspace:remote-device:incoming", { workspaceId: "workspace", deviceId: "remote-device" })
      throw new Error("All promises were rejected")
    })

    await internal.dialDevice([peer], new AbortController().signal)

    expect(internal.hasDeviceSession("workspace", "remote-device")).toBe(true)
    expect(onDiagnostic).not.toHaveBeenCalled()
    internal.sessions.clear()
    internal.node = undefined
    await mesh.dispose()
  })

  it("returns invitation-node ownership after installing the mesh session and keeps its workspace feed until close", async () => {
    const listeners: (() => void)[] = []
    const unsubscribe = vi.fn()
    let finishSession!: () => void
    const done = new Promise<void>(resolve => { finishSession = resolve })
    const connection = {}
    const publishAll = vi.fn(async () => {})
    const mesh = new DurableMesh({ transport: {} as never, workspace: { subscribe: (listener: () => void) => {
      listeners.push(listener)
      return unsubscribe
    } } as never, workspaceStore: {} as never,
    getProfile: async () => ({} as never), store: { listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [], listPeers: async () => [] } as never })
    const internal = meshHooks(mesh)
    internal.acceptConnection = vi.fn(async () => {
      internal.sessions.set("invited", { connection, session: { done } })
    })
    internal.publishAll = publishAll

    await internal.acceptOnInvitationNode(connection, {}, new Uint8Array())
    expect(listeners).toHaveLength(1)
    listeners[0]!()
    expect(publishAll).toHaveBeenCalledOnce()
    expect(unsubscribe).not.toHaveBeenCalled()

    finishSession()
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce())
    await mesh.dispose()
  })

  it("Given every route reaches an offline device, when dialing exhausts network routes, then UI stays in reconnecting state", async () => {
    const onDiagnostic = vi.fn()
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({} as never),
      store: { listPeers: async () => [], listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [] } as never, onDiagnostic })
    const internal = meshHooks(mesh)
    const peer = {
      workspaceId: "workspace", personId: "remote-person", deviceId: "remote-device", instanceId: "legacy:remote",
      endpoint: "remote-endpoint", transportSecret: "secret", role: "editor" as const, lastSeen: new Date().toISOString(),
      advertisement: { advertisement: { signerKeyId: "remote-device", signature: "signature", payload: {
        kind: "peer-advertisement", version: 1, workspaceId: "workspace", personId: "remote-person",
        deviceId: "remote-device", endpoint: "remote-endpoint", issuedAt: new Date().toISOString(),
      } } },
    }
    internal.node = {}
    internal.connectPeer = vi.fn(async () => { throw new MeshNetworkError("remote device offline") })

    await internal.dialDevice([peer], new AbortController().signal)

    expect(onDiagnostic).not.toHaveBeenCalled()
    internal.node = undefined
    await mesh.dispose()
  })

  it("skips signed keeper routes for browser-originated dials while keeping browser routes", async () => {
    const peer = (deviceId: string, userAgent: string) => ({ workspaceId: "workspace", deviceId,
      personId: `person-${deviceId}`, endpoint: `endpoint-${deviceId}`, transportSecret: "secret", role: "visitor" as const,
      lastSeen: new Date().toISOString(), advertisement: { advertisement: { payload: { userAgent } } } })
    const keeper = peer("lighthouse-device", "mesh-lighthouse/1.2.3")
    const browser = peer("browser-device", "Mozilla/5.0 Chrome/140")
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({} as never),
      store: { listPeerInstances: async () => [keeper, browser], listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [] } as never })
    const schedulerPeers = await meshHooks(mesh).dialScheduler.host.peers()

    expect(isNativeKeeperRoute(keeper as never)).toBe(true)
    expect(isNativeKeeperRoute(browser as never)).toBe(false)
    expect(schedulerPeers.map((item: { deviceId: string }) => item.deviceId)).toEqual(["browser-device"])
    await mesh.dispose()
  })

  it("Given publish loses its stream, when the session is evicted, then UI reconnects without a persistent sync error", async () => {
    const onDiagnostic = vi.fn()
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({} as never),
      store: { listPeers: async () => [], listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [] } as never, onDiagnostic })
    const internal = meshHooks(mesh)
    const evict = vi.fn(async () => {})
    internal.sessions.set("workspace:remote:slot", { workspaceId: "workspace", deviceId: "remote-device", evict,
      session: { publish: async () => { throw new MeshNetworkError("closed by peer: browser connection closed (code 0)") } } })

    await internal.publishAll()

    expect(evict).toHaveBeenCalledWith("publish failed")
    expect(onDiagnostic).not.toHaveBeenCalled()
    await mesh.dispose()
  })

  it("Given one workspace publishes slowly, when that scope changes repeatedly, then unrelated scopes stay idle and requests coalesce", async () => {
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({} as never),
      store: { listPeers: async () => [], listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [] } as never })
    const internal = meshHooks(mesh)
    let release!: () => void
    const firstPublish = new Promise<void>(resolve => { release = resolve })
    const scoped = { publish: vi.fn().mockImplementationOnce(() => firstPublish).mockResolvedValue(undefined) }
    const unrelated = { publish: vi.fn().mockResolvedValue(undefined) }
    internal.sessions.set("scope-a:peer:slot", { workspaceId: "scope-a", deviceId: "peer", session: scoped,
      evict: vi.fn(async () => {}) })
    internal.sessions.set("scope-b:peer:slot", { workspaceId: "scope-b", deviceId: "peer", session: unrelated,
      evict: vi.fn(async () => {}) })
    internal.broadcastWorkspaceGossip = vi.fn(async () => {})

    const publishing = internal.publishWorkspace("scope-a")
    await vi.waitFor(() => expect(scoped.publish).toHaveBeenCalledOnce())
    const repeated = [internal.publishWorkspace("scope-a"), internal.publishWorkspace("scope-a")]
    release()
    await Promise.all([publishing, ...repeated])

    expect(scoped.publish).toHaveBeenCalledTimes(2)
    expect(unrelated.publish).not.toHaveBeenCalled()
    expect(internal.broadcastWorkspaceGossip).toHaveBeenCalledTimes(2)
    await mesh.dispose()
  })

  it("Given simultaneous same-peer handshakes, when credentials load concurrently, then only one session owns the receive loop", async () => {
    const credential = { workspaceId: "workspace", transportSecret: "secret" }
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never,
      workspaceStore: { read: () => new Promise<Uint8Array>(() => {}) } as never,
      getProfile: async () => ({ device: { deviceId: "local" } } as never),
      store: { getWorkspaceCredential: async () => credential, listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [], listPeers: async () => [] } as never })
    const connection = () => ({ acceptStream: vi.fn(() => new Promise<never>(() => {})), openStream: vi.fn(), close: vi.fn(async () => {}) })
    const first = connection(), second = connection()
    await Promise.all([first, second].map(value => meshHooks(mesh).installSession("workspace", "remote", "slot-0", "2026-09-17", 1, "incoming", value)))
    expect(first.acceptStream.mock.calls.length + second.acceptStream.mock.calls.length).toBe(1)
    expect(first.close.mock.calls.length + second.close.mock.calls.length).toBe(1)
    await mesh.dispose()
  })

  it("Given chat changed while its mesh session was offline, when a replacement session becomes current, then it replays the local chat", async () => {
    const credential = { workspaceId: "workspace", transportSecret: "secret" }
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ device: { deviceId: "local" } } as never),
      store: { getWorkspaceCredential: async () => credential, listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [], listPeers: async () => [] } as never })
    const internal = meshHooks(mesh)
    const publish = vi.fn(async () => {})
    internal.lifecycle = { stopped: false }
    internal.browserSessions.host.create = vi.fn(() => ({
      session: { publish, close: async () => {}, done: new Promise<never>(() => {}) },
    }))
    const connection = { close: vi.fn(async () => {}), acceptStream: vi.fn(), openStream: vi.fn() }

    await internal.installSession("workspace", "remote", "slot-0", "2026-09-21", 1, "incoming", connection)
    await new Promise<void>(resolve => queueMicrotask(resolve))

    expect(publish).toHaveBeenCalledOnce()
    internal.lifecycle = undefined
    await mesh.dispose()
  })

  it("Given an admitted session, when UI notification fails, then storage maintenance still starts for that current session", async () => {
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ device: { deviceId: "local" } } as never),
      store: { getWorkspaceCredential: async () => ({ workspaceId: "workspace", transportSecret: "secret" }),
        listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [], listPeers: async () => [] } as never })
    const internal = meshHooks(mesh)
    const maintenance = { start: vi.fn(), stop: vi.fn() }
    const connection = { close: vi.fn(async () => {}) }
    const notificationError = new Error("UI projection unavailable")
    internal.browserSessions.host.create = vi.fn(() => ({
      session: { publish: async () => {}, close: async () => {}, done: new Promise<never>(() => {}) },
    }))
    ;(mesh as unknown as { rustyAccessMaintenance: WeakMap<object, typeof maintenance> })
      .rustyAccessMaintenance.set(connection, maintenance)
    internal.notify = vi.fn(async () => { throw notificationError })
    try {
      await expect(internal.installSession("workspace", "remote", "slot-0", "2026-10-27", 1,
        "incoming", connection)).rejects.toThrow(notificationError)
      expect(internal.sessions.get("workspace:remote:slot-0")?.connection).toBe(connection)
      expect(maintenance.start).toHaveBeenCalledOnce()
    } finally {
      internal.notify = async () => {}
      await mesh.dispose()
    }
  })

  it("accepts independent sibling instances without replacing their connections or sharing Automerge state", async () => {
    const credential = { workspaceId: "workspace", transportSecret: "secret" }
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never,
      workspaceStore: { read: () => new Promise<Uint8Array>(() => {}) } as never,
      getProfile: async () => ({ device: { deviceId: "local" } } as never),
      store: { getWorkspaceCredential: async () => credential, listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [], listPeers: async () => [] } as never })
    const connection = () => ({ acceptStream: vi.fn(() => new Promise<never>(() => {})), openStream: vi.fn(), close: vi.fn(async () => {}) })
    const first = connection(), sibling = connection()
    const internal = meshHooks(mesh)
    await internal.installSession("workspace", "remote", "slot-0", "2026-09-17", 1, "incoming", first)
    expect(await internal.installSession("workspace", "remote", "slot-1", "2026-09-17", 99, "outgoing", sibling)).toBe(true)
    expect(first.close).not.toHaveBeenCalled()
    expect(sibling.close).not.toHaveBeenCalled()
    expect(internal.sessions.size).toBe(2)
    expect(internal.sessions.get("workspace:remote:slot-0")?.session)
      .not.toBe(internal.sessions.get("workspace:remote:slot-1")?.session)
    await internal.sessions.get("workspace:remote:slot-0")?.evict?.("remote closed")
    expect(internal.sessions.get("workspace:remote:slot-1")?.connection).toBe(sibling)
    expect(sibling.close).not.toHaveBeenCalled()
    await mesh.dispose()
  })

  it("Given a session whose receive loop hangs, when publish fails and a replacement connects, then stale cleanup cannot evict the replacement", async () => {
    let rejectSnapshot!: (error: Error) => void
    let resolveOldAccept!: (stream: never) => void
    let snapshot = new Promise<Uint8Array>((_resolve, reject) => { rejectSnapshot = reject })
    const changes: unknown[][] = []
    const credential = {
      workspaceId: "workspace-1", ownerPersonId: "owner", ownerPublicKey: "owner-key",
      ownerCertificates: [], transportSecret: "mesh-secret", epoch: 1, updatedAt: new Date().toISOString(),
    }
    const peer = {
      workspaceId: "workspace-1", personId: "remote-person", deviceId: "remote-device", role: "editor" as const,
      endpoint: "remote-endpoint", lastSeen: new Date().toISOString(),
    }
    const mesh = new DurableMesh({
      transport: {} as never,
      workspace: {} as never,
      workspaceStore: { read: () => snapshot } as never,
      getProfile: async () => ({ identity: { personId: "local-person" }, device: { deviceId: "local-device" } } as never),
      store: {
        getWorkspaceCredential: async () => credential,
        listWorkspaceCredentials: async () => [credential], listWorkspaceAuthorities: async () => [],
        listPeers: async () => [peer],
      } as never,
      onChange: (...args) => changes.push(args),
    })
    const oldConnection = {
      acceptStream: () => new Promise<never>(resolve => { resolveOldAccept = resolve }),
      openStream: vi.fn(),
      close: vi.fn(async () => {}),
    }
    const replacementConnection = {
      acceptStream: () => new Promise<never>(() => {}),
      openStream: vi.fn(async () => ({ send: async () => {}, closeSend: async () => {}, read: async () => new Uint8Array() })),
      close: vi.fn(async () => {}),
    }

    const internal = meshHooks(mesh)
    await internal.installSession("workspace-1", "remote-device", "instance-1",
      "2026-09-16T09:00:00.000Z", 1, "incoming", oldConnection,
      false, "incoming-test", false, "", false, undefined, false, "remote-endpoint")
    expect(internal.sessions.size).toBe(1)
    const publish = internal.publishAll()
    rejectSnapshot(new Error("publish failed"))
    await publish
    await vi.waitFor(() => expect(internal.sessions.size).toBe(0))
    await expect(mesh.views("workspace-1")).resolves.toMatchObject([{ online: false }])

    snapshot = Promise.resolve(new Uint8Array([1]))
    await internal.installSession("workspace-1", "remote-device", "instance-1",
      "2026-09-16T09:00:00.000Z", 1, "incoming", replacementConnection,
      false, "incoming-replacement", false, "", false, undefined, false, "remote-endpoint")
    const replacement = internal.sessions.get("workspace-1:remote-device:instance-1")?.session
    resolveOldAccept(undefined as never)
    await Promise.resolve()
    await Promise.resolve()

    expect(internal.sessions.get("workspace-1:remote-device:instance-1")?.session).toBe(replacement)
    await expect(mesh.views("workspace-1")).resolves.toMatchObject([{ online: true }])
    expect(changes.length).toBeGreaterThan(0)
    await mesh.dispose()
  })

  it("Given an established session drops, when its receive loop fails, then reconnect is backed off", async () => {
    let rejectReceive!: (error: Error) => void
    const done = new Promise<never>((_resolve, reject) => { rejectReceive = reject })
    const mesh = new DurableMesh({
      transport: {} as never,
      workspace: {} as never,
      workspaceStore: {} as never,
      getProfile: async () => ({ device: { deviceId: "local-device" } } as never),
      store: {
        getWorkspaceCredential: async () => ({ workspaceId: "workspace", transportSecret: "secret" }),
        listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [],
        listPeers: async () => [],
      } as never,
    })
    const internal = meshHooks(mesh)
    internal.browserSessions.host.create = vi.fn(() => ({
      session: { publish: async () => {}, close: async () => {}, done },
    }))
    const connection = { close: vi.fn(async () => {}) }

    await internal.installSession("workspace", "remote-device", "slot-0", "2026-09-24", 1,
      "outgoing", connection, false, "outgoing-test")
    rejectReceive(new MeshNetworkError("connection lost"))

    await vi.waitFor(() => expect(internal.sessions.size).toBe(0))
    const reconnect = internal.runtime().reconnectState("workspace:remote-device:slot-0")
    expect(reconnect).not.toBeNull()
    if (!reconnect) throw new Error("Reconnect state was not scheduled")
    expect(reconnect.retryAtMs).toBeGreaterThan(Date.now())
    await mesh.dispose()
  })

  it("Given a live session while Iroh gossip has no neighbour yet, when the workspace changes, then direct sync still publishes", async () => {
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ device: { deviceId: "local" } } as never),
      store: { getWorkspaceCredential: async () => ({ workspaceId: "workspace", transportSecret: "secret" }),
        listPeers: async () => [], listWorkspaceCredentials: async () => [], listWorkspaceAuthorities: async () => [] } as never })
    const internal = meshHooks(mesh)
    const publish = vi.fn(async () => {})
    internal.lifecycle = { stopped: false }
    internal.browserSessions.host.create = vi.fn(() => ({
      session: { publish, close: async () => {}, done: new Promise<never>(() => {}) },
    }))
    const connection = { acceptStream: vi.fn(() => new Promise<never>(() => {})), close: vi.fn(async () => {}) }
    await internal.installSession("workspace", "remote", "slot", "2026-09-23", 1, "incoming", connection)
    publish.mockClear()
    await internal.publishAll()

    expect(publish).toHaveBeenCalledOnce()
    internal.lifecycle = undefined
    await mesh.dispose()
  })

  it("Given a newer browser instance closed, when an older live instance has no session, then it still dials the known peer", async () => {
    const controller = new AbortController()
    const own = {
      workspaceId: "workspace-1", personId: "local-person", deviceId: "local-device",
      instanceId: "slot-0", endpoint: "local-endpoint", transportSecret: "mesh-secret", role: "owner" as const,
      lastSeen: "2026-09-14T12:00:00.000Z",
      advertisement: { advertisement: { payload: { issuedAt: "2026-09-14T12:00:00.000Z" } } },
    }
    const peer = {
      workspaceId: "workspace-1", personId: "remote-person", deviceId: "remote-device",
      instanceId: "slot-1", endpoint: "remote-endpoint", transportSecret: "mesh-secret", role: "editor" as const,
      lastSeen: "2026-09-14T12:01:00.000Z",
      advertisement: { advertisement: { payload: { issuedAt: "2026-09-14T12:01:00.000Z" } } },
    }
    const mesh = new DurableMesh({
      transport: {} as never, workspaceStore: {} as never, workspace: {} as never,
      getProfile: async () => ({ device: { deviceId: "local-device" } } as never),
      store: {} as never,
    })
    const internal = meshHooks(mesh)
    internal.node = {}
    internal.instanceId = "slot-0"
    internal.peerInstances = vi.fn(async (workspaceId?: string) => workspaceId ? [own, peer] : [peer])
    internal.dialDevice = vi.fn(async () => controller.abort())
    const guard = setTimeout(() => controller.abort(), 50)

    await internal.dialLoop(controller.signal)

    clearTimeout(guard)
    expect(internal.dialDevice).toHaveBeenCalledWith([peer], controller.signal)
    await mesh.dispose()
  })

  it("Given a signed route lease expired, when reconnect scans the catalog, then it keeps probing that bootstrap route", async () => {
    const controller = new AbortController()
    const peer = {
      workspaceId: "workspace-1", personId: "remote-person", deviceId: "remote-device",
      instanceId: "slot-1", endpoint: "remote-endpoint", transportSecret: "mesh-secret", role: "editor" as const,
      lastSeen: "2026-09-14T12:00:00.000Z",
      advertisement: { advertisement: { payload: { issuedAt: "2026-09-14T12:00:00.000Z",
        expiresAt: new Date(Date.now() - 60_000).toISOString() } } },
    }
    const mesh = new DurableMesh({
      transport: {} as never, workspaceStore: {} as never, workspace: {} as never,
      getProfile: async () => ({ device: { deviceId: "local-device" } } as never), store: {} as never,
    })
    const internal = meshHooks(mesh)
    internal.node = {}
    internal.peerInstances = vi.fn(async () => [peer])
    internal.dialDevice = vi.fn(async () => controller.abort())
    const guard = setTimeout(() => controller.abort(), 50)

    await internal.dialLoop(controller.signal)

    clearTimeout(guard)
    expect(internal.dialDevice).toHaveBeenCalledWith([peer], controller.signal)
    expect(internal.peerInstances).toHaveBeenCalled()
    await mesh.dispose()
  })

  it("Given a working instance and an expired sibling on the same board, When reconnect scans retained routes, Then skip the stale sibling but retain live siblings and other board bootstrap", async () => {
    const now = Date.now()
    const route = (workspaceId: string, instanceId: string, expiry: number) => ({
      workspaceId, personId: "remote-person", deviceId: "remote-device", instanceId,
      endpoint: `endpoint-${instanceId}`, transportSecret: "mesh-secret", role: "editor" as const,
      lastSeen: new Date(now - 120_000).toISOString(),
      advertisement: { advertisement: { payload: { issuedAt: new Date(now - 120_000).toISOString(),
        expiresAt: new Date(expiry).toISOString() } } },
    })
    const peers = [route("connected-board", "working", now + 60_000), route("connected-board", "expired", now - 1),
      route("connected-board", "live-sibling", now + 60_000), route("offline-board", "bootstrap", now - 1)]
    const mesh = new DurableMesh({ transport: {} as never, workspaceStore: {} as never, workspace: {} as never,
      getProfile: async () => ({ device: { deviceId: "local-device" } } as never), store: {} as never })
    const internal = meshHooks(mesh)
    internal.instanceId = "local-slot"
    internal.peerInstances = vi.fn(async () => peers)
    internal.dialDevice = vi.fn(async () => {})
    internal.trace = vi.fn()
    const key = { workspaceId: "connected-board", deviceId: "remote-device", instanceId: "working" }
    const admitted = internal.runtime().admitSession({ key,
      connectionId: "working", remoteIssuedAt: new Date(now).toISOString(), direction: "incoming" }, "incoming")
    try {
      await internal.scheduleDials("local-device", new AbortController().signal)
      expect(internal.dialDevice).toHaveBeenCalledTimes(2)
      expect(internal.dialDevice).toHaveBeenCalledWith([peers[2]], expect.any(AbortSignal))
      expect(internal.dialDevice).toHaveBeenCalledWith([peers[3]], expect.any(AbortSignal))
      expect(internal.trace).toHaveBeenCalledWith("route.suppressed.expired", expect.objectContaining({
        workspaceId: "connected-board", targetDeviceId: "remote-device", instanceId: "expired",
        expiresAt: new Date(now - 1).toISOString(), expired: true,
      }))
      await internal.scheduleDials("local-device", new AbortController().signal)
      expect(internal.trace).toHaveBeenCalledOnce()
      if (!admitted.generation) throw new Error("Expected admitted working session")
      internal.runtime().removeSession(key, admitted.generation)
      await internal.scheduleDials("local-device", new AbortController().signal)
      expect(internal.dialDevice).toHaveBeenCalledWith([peers[1]], expect.any(AbortSignal))
    } finally { await mesh.dispose() }
  })

  it("Given two different same-epoch recovery claims, when projected, then conflict pauses automatic recovery", async () => {
    const policy = { payload: { successorPersonId: null, eligibleEditorPersonIds: ["editor-a", "editor-b"] } }
    const credential = {
      version: 1 as const, workspaceId: "workspace-conflict", ownerPersonId: "editor-a", ownerPublicKey: "key-a",
      ownerCertificates: [], transportSecret: "mesh-secret", epoch: 2, updatedAt: new Date().toISOString(),
      catalog: { successionClaims: [
        { signature: "claim-a", payload: { epoch: 2, toOwnerPersonId: "editor-a", policy } },
        { signature: "claim-b", payload: { epoch: 2, toOwnerPersonId: "editor-b", policy } },
      ] },
    }
    const mesh = new DurableMesh({
      transport: {} as never, workspaceStore: {} as never, workspace: {} as never,
      getProfile: async () => ({} as never),
      store: { listWorkspaceCredentials: async () => [credential], listWorkspaceAuthorities: async () => [] } as never,
    })

    await expect(mesh.successionViews()).resolves.toMatchObject([{ workspaceId: "workspace-conflict", conflicted: true }])
    await mesh.dispose()
  })

  it("Given an owner signs two successors for one epoch, when replicas meet, then authority stays put and writes freeze", async () => {
    resetIdentityStorageForTest()
    const owner = await bootstrapIdentity("Owner")
    resetIdentityStorageForTest()
    const first = await bootstrapIdentity("First successor")
    resetIdentityStorageForTest()
    const second = await bootstrapIdentity("Second successor")
    const transfers = await Promise.all([first, second].map(target => createWorkspaceOwnershipTransfer(owner, "workspace-1", {
      personId: target.identity.personId, publicKey: target.identity.publicKey, certificates: [target.certificate],
    }, ["head"], 2)))
    let credential = {
      version: 1 as const, workspaceId: "workspace-1", ownerPersonId: owner.identity.personId,
      ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "secret",
      epoch: 1, updatedAt: new Date().toISOString(), catalog: {},
    }
    const store = {
      putWorkspaceCredential: async (next: typeof credential) => { credential = structuredClone(next) },
      transferWorkspaceCredential: async (_previous: string, next: typeof credential) => { credential = structuredClone(next) },
      getPendingOwnershipTransfer: async () => null,
      listPeers: async () => [],
      listWorkspaceCredentials: async () => [credential], listWorkspaceAuthorities: async () => [],
    }
    const mesh = new DurableMesh({ transport: {} as never, workspaceStore: {} as never, workspace: {} as never,
      getProfile: async () => owner, store: store as never })

    const result = await meshHooks(mesh).mergeOwnershipTransfers(credential, transfers)

    expect(result.ownerPersonId).toBe(owner.identity.personId)
    expect(result.epoch).toBe(1)
    expect(result.catalog?.ownershipTransfers).toHaveLength(2)
    await expect(mesh.successionViews()).resolves.toMatchObject([{ workspaceId: "workspace-1", conflicted: true }])
    await mesh.dispose()
  })

  it("Given partitioned replicas accepted different successors, when their transfer logs meet, then neither authority replaces the other", async () => {
    resetIdentityStorageForTest()
    const owner = await bootstrapIdentity("Owner")
    resetIdentityStorageForTest()
    const first = await bootstrapIdentity("First successor")
    resetIdentityStorageForTest()
    const second = await bootstrapIdentity("Second successor")
    const [toFirst, toSecond] = await Promise.all([first, second].map(target => createWorkspaceOwnershipTransfer(owner, "workspace-1", {
      personId: target.identity.personId, publicKey: target.identity.publicKey, certificates: [target.certificate],
    }, ["shared-head"], 2)))
    const initial = {
      version: 1 as const, workspaceId: "workspace-1", ownerPersonId: owner.identity.personId,
      ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "secret",
      epoch: 1, updatedAt: new Date(0).toISOString(), catalog: {},
    }
    const replica = (profile: LocalProfile) => {
      let credential: TestCredential = structuredClone(initial)
      const store = {
        putWorkspaceCredential: async (next: TestCredential) => { credential = structuredClone(next) },
        transferWorkspaceCredential: async (_previous: string, next: TestCredential) => { credential = structuredClone(next) },
        getPendingOwnershipTransfer: async () => null,
        listPeers: async () => [], listWorkspaceCredentials: async () => [credential], listWorkspaceAuthorities: async () => [],
      }
      const mesh = new DurableMesh({ transport: {} as never, workspaceStore: {} as never, workspace: {} as never,
        getProfile: async () => profile, store: store as never })
      return { mesh, credential: () => credential }
    }
    const a = replica(first)
    const b = replica(second)

    await meshHooks(a.mesh).mergeOwnershipTransfers(a.credential(), [toFirst])
    await meshHooks(b.mesh).mergeOwnershipTransfers(b.credential(), [toSecond])
    expect(a.credential().ownerPersonId).toBe(first.identity.personId)
    expect(b.credential().ownerPersonId).toBe(second.identity.personId)

    await meshHooks(a.mesh).mergeOwnershipTransfers(a.credential(), [toSecond])
    await meshHooks(b.mesh).mergeOwnershipTransfers(b.credential(), [toFirst])

    expect(a.credential().ownerPersonId).toBe(first.identity.personId)
    expect(b.credential().ownerPersonId).toBe(second.identity.personId)
    expect(a.credential().catalog?.ownershipTransfers).toHaveLength(2)
    expect(b.credential().catalog?.ownershipTransfers).toHaveLength(2)
    await expect(a.mesh.successionViews()).resolves.toMatchObject([{ conflicted: true }])
    await expect(b.mesh.successionViews()).resolves.toMatchObject([{ conflicted: true }])
    await Promise.all([a.mesh.dispose(), b.mesh.dispose()])
  })

  it("Given a stored peer with an invalid grant, when the mesh validates its catalog, then it removes the poisoned peer before dialing", async () => {
    const removed: string[] = []
    const credential = {
      version: 1 as const,
      workspaceId: "workspace-1",
      ownerPersonId: "owner-person",
      ownerPublicKey: "owner-key",
      ownerCertificates: [],
      transportSecret: "mesh-secret",
      epoch: 1,
      updatedAt: new Date().toISOString(),
    }
    const store = {
      listPeers: async () => [{
        workspaceId: "workspace-1", personId: "stale-person", deviceId: "stale-device",
        endpoint: "stale-endpoint", transportSecret: "mesh-secret", role: "editor" as const,
        lastSeen: new Date().toISOString(), advertisement: { poisoned: true },
      }],
      removePeer: async (workspaceId: string, deviceId: string) => { removed.push(`${workspaceId}:${deviceId}`); return true },
    }
    const mesh = new DurableMesh({
      transport: {} as never,
      workspaceStore: {} as never,
      workspace: {} as never,
      getProfile: async () => ({ device: { deviceId: "local-device" } } as never),
      store: store as never,
    })

    await meshHooks(mesh).pruneInvalidStoredPeers(credential, "local-device")

    expect(removed).toEqual(["workspace-1:stale-device"])
    await mesh.dispose()
  })

  it("Given this device changed identity, when its own advertisement refreshes, then the stale record is replaced instead of merged", async () => {
    resetIdentityStorageForTest()
    const owner = await bootstrapIdentity("Owner")
    const removed: string[] = []
    const saved: TestPeer[] = []
    const credential = {
      version: 1 as const,
      workspaceId: "workspace-1",
      ownerPersonId: owner.identity.personId,
      ownerPublicKey: owner.identity.publicKey,
      ownerCertificates: [owner.certificate],
      transportSecret: "mesh-secret",
      epoch: 1,
      updatedAt: new Date().toISOString(),
    }
    const store = {
      getWorkspaceAuthority: async () => null,
      getWorkspaceCredential: async () => credential,
      listPeers: async () => [],
      getPeer: async () => ({
        workspaceId: "workspace-1", personId: "previous-person", deviceId: owner.device.deviceId,
        endpoint: "old-endpoint", transportSecret: "mesh-secret", role: "visitor" as const,
        lastSeen: new Date(Date.now() + 60_000).toISOString(), advertisement: { stale: true },
      }),
      removePeer: async (workspaceId: string, deviceId: string) => { removed.push(`${workspaceId}:${deviceId}`); return true },
      upsertPeer: async (peer: TestPeer) => { saved.push(peer); return peer },
      putWorkspaceCredential: async () => {},
    }
    const mesh = new DurableMesh({
      transport: {} as never,
      workspaceStore: {} as never,
      workspace: {} as never,
      getProfile: async () => owner,
      store: store as never,
    })

    await meshHooks(mesh).refreshOwnBundle(credential, owner, "new-endpoint", [owner.certificate])

    expect(removed).toEqual([`workspace-1:${owner.device.deviceId}`])
    expect(saved.at(-1)?.personId).toBe(owner.identity.personId)
    expect(saved.at(-1)?.endpoint).toBe("new-endpoint")
    await mesh.dispose()
  })

  it("Given a workspace guest enrolls as an owner device, when enrollment is approved, then its old peer aliases are removed", async () => {
    const removed: string[] = []
    const closed: string[] = []
    const mesh = new DurableMesh({
      transport: {} as never,
      workspaceStore: {} as never,
      workspace: {} as never,
      getProfile: async () => ({} as never),
      store: {
        removePeer: async (workspaceId: string, deviceId: string) => {
          removed.push(`${workspaceId}:${deviceId}`)
          return true
        },
      } as never,
    })
    const internal = meshHooks(mesh)
    const sessionKey = "workspace-1:guest-device"
    internal.sessions.set(sessionKey, {
      workspaceId: "workspace-1",
      deviceId: "guest-device",
      session: { close: async () => { closed.push("session") } },
      connection: { close: async () => { closed.push("connection") } },
      evict: async () => {
        internal.sessions.delete(sessionKey)
        closed.push("session", "connection")
      },
    })
    internal.runtime().beginRouteAttempt("workspace-1:guest-device", Date.now())
    internal.runtime().scheduleReconnect("workspace-1:guest-device", Date.now(), 5_000, 5 * 60_000)

    await mesh.forgetEnrolledDevice(["workspace-1", "workspace-1", "workspace-2"], "guest-device")

    expect(removed).toEqual(["workspace-1:guest-device", "workspace-2:guest-device"])
    expect(closed).toEqual(["session", "connection"])
    expect(internal.sessions.has("workspace-1:guest-device")).toBe(false)
    expect(internal.runtime().routeAttemptActive("workspace-1:guest-device")).toBe(false)
    expect(internal.runtime().reconnectState("workspace-1:guest-device")).toBeNull()
    await mesh.dispose()
  })

  it("Given one invalid peer record, when a catalog merges, then later valid peers still import", async () => {
    const credential = { workspaceId: "workspace-1" }
    const mesh = new DurableMesh({
      transport: {} as never,
      workspaceStore: {} as never,
      workspace: {} as never,
      getProfile: async () => ({} as never),
      store: { getWorkspaceCredential: async () => credential } as never,
    })
    const imported: string[] = []
    const internal = meshHooks(mesh)
    internal.mergeOwnershipTransfers = async () => credential
    internal.mergeSuccessionState = async () => credential
    internal.mergeRevocations = async () => {}
    internal.putVerifiedBundle = vi.fn(async (_credential: TestCredential, bundle: unknown) => {
      if (!bundle || typeof bundle !== "object" || !("id" in bundle) || typeof bundle.id !== "string") {
        throw new Error("Invalid workspace grant fixture")
      }
      if (bundle.id === "poisoned") throw new Error("Invalid workspace grant signature")
      imported.push(bundle.id)
    })
    internal.notify = async () => {}

    await mesh.mergeWorkspace("workspace-1", {
      version: 1,
      peers: [{ id: "poisoned" }, { id: "owner-phone" }],
      revocations: [],
    })

    expect(imported).toEqual(["owner-phone"])
    await mesh.dispose()
  })

  it("traces a slow catalog effect without changing merge order", async () => {
    const credential = { workspaceId: "workspace-1" }
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({} as never),
      store: { getWorkspaceCredential: async () => credential } as never })
    const state = meshRustRuntime().state
    const validate = vi.spyOn(state, "validateMeshCatalog").mockReturnValue({ version: 1, peers: [], revocations: [] })
    const plan = vi.spyOn(state, "planCatalogMerge").mockReturnValue(["notify"])
    const internal = meshHooks(mesh)
    internal.notify = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 270)) })
    clearMeshTrace()

    try {
      await mesh.mergeWorkspace("workspace-1", {})
      expect(internal.notify).toHaveBeenCalledOnce()
      expect(meshTraceSnapshot()).toContainEqual(expect.objectContaining({
        event: "authority.merge.phase",
        phase: "effect.notify", workspaceId: "workspace-1", elapsedMs: expect.any(Number),
      }))
    } finally {
      validate.mockRestore()
      plan.mockRestore()
      clearMeshTrace()
      await mesh.dispose()
    }
  })

  it("rejects a valid scope ledger that conflicts with the Rust-planned ownership transfer before persisting it", async () => {
    const snapshot = { genesis: {}, grants: [], grantIssuers: [], revocations: [], controlTransfers: [] }
    const catalog = { version: 1 as const, peers: [], revocations: [], scopeAuthoritySnapshot: snapshot }
    const credential = { workspaceId: "workspace-1", ownerPersonId: "owner", ownerPublicKey: "owner-key" }
    const transferWorkspaceCredential = vi.fn()
    const mesh = new DurableMesh({ transport: {} as never, workspaceStore: {} as never, workspace: {} as never,
      getProfile: async () => ({ identity: { personId: "local" } } as never),
      store: { getWorkspaceCredential: async () => credential, getWorkspaceAuthority: async () => ({ scopeAuthoritySnapshot: snapshot }),
        listPeers: async () => [], transferWorkspaceCredential } as never })
    const state = meshRustRuntime().state
    const spies = [
      vi.spyOn(state, "validateMeshCatalog").mockReturnValue(catalog),
      vi.spyOn(state, "mergeScopeAuthoritySnapshots").mockReturnValue(snapshot),
      vi.spyOn(state, "validateScopeAuthority").mockReturnValue({ scopeId: "workspace-1", controlEpoch: 1,
        controller: { personId: "wrong-owner", publicKey: "wrong-key" } }),
      vi.spyOn(state, "planOwnershipMerge").mockReturnValue({ accepted: [], persistCatalog: false, steps: [{
        record: { payload: { toOwnerPersonId: "next-owner", toOwnerPublicKey: "next-key" } }, accepted: [], previousOwnerEpoch: 1,
      }], conflicted: false }),
      vi.spyOn(state, "planOwnershipAdoption").mockReturnValue({ previousOwnerPersonId: "owner",
        credential: { ...credential, ownerPersonId: "next-owner", ownerPublicKey: "next-key" }, peers: [] }),
    ]
    try {
      await expect(mesh.mergeWorkspace("workspace-1", catalog)).rejects.toThrow(/planned workspace owner/)
      expect(transferWorkspaceCredential).not.toHaveBeenCalled()
    } finally {
      spies.forEach(spy => spy.mockRestore())
      await mesh.dispose()
    }
  })

  it("exports a signed scope ledger through Rust catalog validation and imports its merged copy", async () => {
    resetIdentityStorageForTest()
    const profile = await bootstrapIdentity("Owner")
    const workspaceId = "workspace-scope-export"
    const genesis = await signEnvelope(profile.privateKeys.devicePrivateKey, {
      kind: "scope-genesis", version: 1, scopeId: workspaceId,
      creator: { personId: profile.identity.personId, publicKey: profile.identity.publicKey, certificates: [profile.certificate] },
      controlEpoch: 1,
    }, profile.device.deviceId)
    const scopeAuthoritySnapshot = { genesis, grants: [], grantIssuers: [], revocations: [], controlTransfers: [] }
    const credential = { version: 1 as const, workspaceId, ownerPersonId: profile.identity.personId,
      ownerPublicKey: profile.identity.publicKey, ownerCertificates: [profile.certificate], transportSecret: "mesh-secret",
      epoch: 1, updatedAt: new Date().toISOString() }
    let authority = { ...credential, scopeAuthoritySnapshot }
    const sender = new DurableMesh({ transport: {} as never, workspaceStore: {} as never, workspace: {} as never,
      getProfile: async () => profile,
      store: { getWorkspaceCredential: async () => credential, getWorkspaceAuthority: async () => authority,
        listPeers: async () => [] } as never })
    ;meshHooks(sender).peerInstances = async () => []
    const exported = await sender.exportWorkspace(workspaceId)
    const catalog = meshRustRuntime().state.validateMeshCatalog(exported, Date.now()) as typeof exported
    expect(catalog.scopeAuthoritySnapshot).toEqual({ ...scopeAuthoritySnapshot, successionTransfers: [] })

    const order: string[] = []
    const putWorkspaceAuthority = vi.fn(async (next: typeof authority) => { authority = next; order.push("persist") })
    const receiver = new DurableMesh({ transport: {} as never, workspaceStore: {} as never, workspace: {} as never,
      getProfile: async () => profile,
      store: { getWorkspaceCredential: async () => credential, getWorkspaceAuthority: async () => authority,
        listPeers: async () => [],
        putWorkspaceAuthority } as never })
    const internal = meshHooks(receiver)
    internal.mergeOwnershipTransfers = async () => credential
    internal.mergeDeviceRevocations = async () => {}
    internal.mergeDepartures = async () => {}
    internal.mergeRevocations = async () => {}
    internal.mergeSuccessionState = async () => credential
    internal.mergePeerBundles = async () => {}
    const notify = vi.fn(async () => { order.push("notify") })
    internal.notify = notify
    try {
      const revisionBeforeAuthorityChange = await defaultStorage.readWorkspaceRevision(workspaceId)
      await receiver.mergeWorkspace(workspaceId, catalog)
      expect(putWorkspaceAuthority).toHaveBeenCalledWith(expect.objectContaining({
        scopeAuthoritySnapshot: { ...scopeAuthoritySnapshot, successionTransfers: [] },
      }))
      const revisionAfterAuthorityChange = await defaultStorage.readWorkspaceRevision(workspaceId)
      expect(revisionAfterAuthorityChange).not.toBe(revisionBeforeAuthorityChange)
      expect(order).toEqual(["persist", "notify"])
      order.length = 0
      notify.mockClear()
      putWorkspaceAuthority.mockClear()
      await receiver.mergeWorkspace(workspaceId, catalog)
      expect(putWorkspaceAuthority).not.toHaveBeenCalled()
      expect(await defaultStorage.readWorkspaceRevision(workspaceId)).toBe(revisionAfterAuthorityChange)
      expect(order).toEqual(["notify"])
      notify.mockClear()
      order.length = 0
      putWorkspaceAuthority.mockClear()
      authority = { ...authority, scopeAuthoritySnapshot }
      putWorkspaceAuthority.mockRejectedValueOnce(new Error("Ledger commit failed"))
      await expect(receiver.mergeWorkspace(workspaceId, catalog)).rejects.toThrow("Ledger commit failed")
      expect(internal.notify).not.toHaveBeenCalled()
    } finally {
      await sender.dispose()
      await receiver.dispose()
    }
  })

  it("atomically persists accepted succession with a scope bridge and full revocation history", async () => {
    const claim = { signature: "claim-signature", payload: { workspaceId: "scope-succession", fromOwnerPersonId: "owner",
      toOwnerPersonId: "successor", toOwnerPublicKey: "successor-key" } }
    const historicalRevocation = { signature: "old-owner-revocation", payload: { ownerPersonId: "former-owner", personId: "revoked", epoch: 1 } }
    const credential = { workspaceId: "scope-succession", ownerPersonId: "owner", ownerPublicKey: "owner-key",
      ownerCertificates: [], epoch: 2, catalog: { revocations: [historicalRevocation] } }
    const scopeAuthoritySnapshot = { genesis: {}, grants: [], grantIssuers: [], revocations: [], controlTransfers: [] }
    const nextCredential = { ...credential, ownerPersonId: "successor", ownerPublicKey: "successor-key", epoch: 3 }
    const transferWorkspaceCredential = vi.fn(async () => {})
    const store = {
      getWorkspaceAuthority: async () => ({ scopeAuthoritySnapshot }), listPeers: async () => [],
      transferWorkspaceCredential, upsertPeer: vi.fn(async () => {}), putWorkspaceCredential: vi.fn(async () => {}),
      getWorkspaceCredential: async () => nextCredential,
    }
    const state = meshRustRuntime().state
    const spies = [
      vi.spyOn(state, "planSuccessionMerge").mockReturnValue({ noop: false, policy: null, votes: [], claims: [claim],
        transitions: [claim], conflicted: false }),
      vi.spyOn(state, "planOwnershipAdoption").mockReturnValue({ previousOwnerPersonId: "owner", credential: nextCredential, peers: [] }),
      vi.spyOn(state, "planSuccessionCatalog").mockReturnValue({ credential: nextCredential, persist: false, publish: false }),
      vi.spyOn(state, "validateScopeAuthority").mockImplementation((raw: unknown) => {
        const snapshot = raw as { successionTransfers?: unknown[] }
        return { scopeId: "scope-succession", controlEpoch: snapshot.successionTransfers?.length ? 2 : 1,
          controller: { personId: snapshot.successionTransfers?.length ? "successor" : "owner", publicKey: "key" } }
      }),
    ]
    try {
      await mergeSuccessionState(store as never, credential as never,
        async () => ({ identity: { personId: "successor" } } as never), undefined, [], [claim] as never[], false, async () => {}, undefined, operation => operation())
      const bridge = { fromControlEpoch: 1, claim, revocations: [historicalRevocation] } as never
      expect(transferWorkspaceCredential).toHaveBeenCalledWith("owner", nextCredential, expect.objectContaining({
        successionTransfers: [bridge],
      }))
      transferWorkspaceCredential.mockClear()
      await mergeSuccessionState(store as never, credential as never,
        async () => ({ identity: { personId: "successor" } } as never), undefined, [], [claim] as never[], false, async () => {},
        { ...scopeAuthoritySnapshot, successionTransfers: [bridge] }, operation => operation())
      expect(transferWorkspaceCredential).toHaveBeenCalledWith("owner", nextCredential, expect.objectContaining({
        successionTransfers: [bridge],
      }))
    } finally { spies.forEach(spy => spy.mockRestore()) }
  })

  it("Given an enrolled owner device, when it opens an existing workspace, then its certificate can verify new grants", async () => {
    resetIdentityStorageForTest()
    const owner = await bootstrapIdentity("Owner")
    resetIdentityStorageForTest()
    const phone = await bootstrapIdentity("Owner phone")
    const { deviceId, publicKey } = phone.device
    const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
      owner.identity.personId, deviceId, publicKey, await certHashDefault(owner.certificate))
    const enrolledOwner = await adoptEnrolledIdentity(owner.identity, certificate)
    await defaultProofStore.putCertificate(await certHashDefault(owner.certificate), owner.certificate)
    let credential = {
      version: 1 as const,
      workspaceId: "workspace-1",
      ownerPersonId: owner.identity.personId,
      ownerPublicKey: owner.identity.publicKey,
      ownerCertificates: [owner.certificate],
      transportSecret: "mesh-secret",
      epoch: 1,
      updatedAt: new Date(0).toISOString(),
      localGrant: { stale: true },
    }
    const store = {
      getWorkspaceAuthority: async () => null,
      getWorkspaceCredential: async () => structuredClone(credential),
      listPeers: async () => [],
      putWorkspaceCredential: async (next: typeof credential) => { credential = structuredClone(next) },
      getPeer: async () => null,
    }
    const mesh = new DurableMesh({
      transport: {} as never,
      workspaceStore: {} as never,
      workspace: {} as never,
      getProfile: async () => enrolledOwner,
      store: store as never,
    })
    const internal = meshHooks(mesh)
    internal.putVerifiedBundle = vi.fn(async () => {})
    internal.notify = vi.fn(async () => {})

    await mesh.ensureOwnerWorkspaces(["workspace-1"], "owner-phone-endpoint", enrolledOwner)
    const grant = await createWorkspaceGrant(enrolledOwner, "workspace-1", "editor-person", "editor")

    await expect(verifyWorkspaceGrant(grant, {
      workspaceId: "workspace-1",
      personId: "editor-person",
      ownerPersonId: owner.identity.personId,
      ownerPublicKey: owner.identity.publicKey,
      ownerCertificates: credential.ownerCertificates,
    })).resolves.toBe("editor")
    expect(credential.ownerCertificates.map(item => item.payload.deviceId)).toContain(deviceId)
    expect("localGrant" in credential).toBe(false)
    await mesh.dispose()
  })
})

describe("durable runtime cleanup", () => {
  it("reports a failed diagnostic notification without an unhandled rejection", async () => {
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never,
      workspaceStore: {} as never, getProfile: async () => null as never })
    const internal = meshHooks(mesh)
    internal.notify = vi.fn(async () => { throw new Error("storage unavailable") })
    internal.trace = vi.fn()
    const failure = new Error("node closed")
    internal.report("Restart", failure)
    expect(internal.trace).toHaveBeenCalledWith("diagnostic", { stage: "Restart", reason: "node closed" }, "warn", failure)
    await vi.waitFor(() => expect(internal.trace).toHaveBeenCalledWith(
      "diagnostic.notification.failed", { reason: "storage unavailable" }, "warn"))
    expect(internal.notify).toHaveBeenCalledOnce()
  })

  it.each(["sessions", "gossip", "runtime"])("closes detached resources even when %s cleanup fails", async stage => {
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never,
      workspaceStore: {} as never, getProfile: async () => null as never })
    const internal = meshHooks(mesh)
    const node = { close: vi.fn(async () => {}) }
    const acceptor = { close: vi.fn(async () => {}) }
    internal.node = node
    internal.acceptor = acceptor
    internal.dropSessions = vi.fn(async () => { if (stage === "sessions") throw new Error("cleanup failed") })
    if (stage === "gossip") internal.gossip.closeAll = vi.fn(() => { throw new Error("cleanup failed") })
    if (stage === "runtime") internal.runtimeState = { stop: () => { throw new Error("cleanup failed") } }
    internal.notify = vi.fn(async () => {})
    await expect(internal.shutdown()).rejects.toThrow("cleanup failed")
    expect(node.close).toHaveBeenCalledOnce()
    expect(acceptor.close).toHaveBeenCalledOnce()
    expect(internal.node).toBeUndefined()
    expect(internal.acceptor).toBeUndefined()
  })
})


describe("durable node supervision", () => {
  it.each([false, true])("restarts when its acceptor ends (rejects: %s) and cancels that run's dial loop", async rejects => {
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never,
      workspaceStore: {} as never, getProfile: async () => ({}) as never,
      store: { listWorkspaceCredentials: async () => [{}], listWorkspaceAuthorities: async () => [] } as never })
    const internal = meshHooks(mesh)
    const acceptor = { accept: async () => { if (rejects) throw new Error("node closed"); return undefined }, close: vi.fn(async () => {}) }
    internal.adoptedNode = { endpointId: "endpoint", accept: async () => acceptor, close: vi.fn(async () => {}) }
    internal.activeCredentialsForProfile = async () => [{ workspaceId: "workspace" }]
    internal.prepareCredentials = async () => {}
    let cancelled = false
    internal.dialLoop = (signal: AbortSignal) => new Promise<void>(resolve => {
      signal.addEventListener("abort", () => { cancelled = true; resolve() }, { once: true })
    })
    const stop = new AbortController()
    try {
      await expect(internal.runMeshOnce(stop.signal)).rejects.toThrow(/accept.*(closed|failed)/i)
      expect(cancelled).toBe(true)
    } finally { stop.abort() }
  }, 500)
})
