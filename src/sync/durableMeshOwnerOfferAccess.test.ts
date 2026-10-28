import { expect, it, vi } from "vitest"
import { encodePairingFrame } from "@meta-uber/mesh-pairing"
import { sha256Base64Url, type LocalProfile } from "../domain/identity"
import { DurableMesh } from "./durableMesh"
import type { WorkspaceMeshCredential, WorkspaceAuthorityRecord } from "./peerStore"
import type { SyncConnection } from "./transport"

const stages = ["active", "before", "encode", "proof", "open", "authority", "authority-encode", "authority-owner", "authority-epoch"] as const
async function fixture(stage: typeof stages[number]) {
  const profile = { identity: { personId: "owner", publicKey: "owner-key" }, device: { deviceId: "host" } } as LocalProfile
  const credential = (workspaceId: string): WorkspaceMeshCredential => ({ version: 1, workspaceId,
    ownerPersonId: "owner", ownerPublicKey: "owner-key", ownerCertificates: [], transportSecret: "secret", epoch: 1,
    updatedAt: new Date().toISOString() })
  const a = credential("board-a"), b = credential("board-b")
  let authority: WorkspaceAuthorityRecord | null = null
  const revoke = () => {
    const catalog = { deviceRevocations: [{ record: { payload: { personId: "owner", deviceId: "phone" } } }] }
    if (stage.startsWith("authority")) authority = { ...b, catalog }
    else b.catalog = catalog
  }
  if (stage === "before") revoke()
  if (stage === "authority") revoke()
  if (stage === "authority-owner") authority = { ...b, ownerPersonId: "another-owner" }
  if (stage === "authority-epoch") authority = { ...b, epoch: 2 }
  const offer = new TextEncoder().encode(JSON.stringify({ workspaceId: "board-b", workspace: { id: "board-b", bytes: "AA",
    ...(stage === "proof" ? { authorization: { kind: "workspace-authorization-manifest", transferId: "approved-proof" } } : {}) } }))
  const receipt = new TextEncoder().encode(await sha256Base64Url(offer))
  const send = vi.fn<(bytes: Uint8Array) => Promise<void>>(async () => {})
  const close = vi.fn(async () => {})
  let releaseOpen!: () => void, opened!: () => void
  const openStarted = new Promise<void>(resolve => { opened = resolve })
  const openGate = new Promise<void>(resolve => { releaseOpen = resolve })
  const connection = { close, openStream: vi.fn(async () => {
    if (stage === "open") { opened(); await openGate }
    return { send, closeSend: async () => {}, reset: async () => {},
      read: async () => encodePairingFrame("mesh-durable-ack", "secret", receipt) }
  }) } as unknown as SyncConnection
  const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never,
    workspaceStore: { readAuthorization: async () => { if (stage === "proof") revoke(); return {} } } as never,
    getProfile: async () => profile, getOwnedWorkspaceIds: async () => ["board-b"],
    store: { getWorkspaceCredential: async (id: string) => id === "board-a" ? a : b,
      getWorkspaceAuthority: async () => authority,
      listWorkspaceCredentials: async () => [a, b], listWorkspaceAuthorities: async () => [] } as never })
  const internal = mesh as unknown as {
    refreshWorkspaceGossip: () => Promise<void>
    encodeOwnerWorkspaceOffer: (id: string) => Promise<Uint8Array>
    afterIncomingInstall: (credential: WorkspaceMeshCredential, remote: { personId: string; deviceId: string },
      ids: string[], connection: SyncConnection, frame: "mesh-owner-workspace-offer") => Promise<void>
  }
  internal.refreshWorkspaceGossip = vi.fn(async () => {})
  internal.encodeOwnerWorkspaceOffer = vi.fn(async () => { if (stage === "encode" || stage === "authority-encode") revoke(); return offer })
  const handshake = (deviceId = "phone", target = connection) =>
    internal.afterIncomingInstall(a, { personId: "owner", deviceId }, [], target, "mesh-owner-workspace-offer")
  return { mesh, internal, handshake, revoke, send, close, connection, offer, receipt, openStarted, releaseOpen }
}

it.each(stages)("Given a same-owner phone on board A with B revocation at %s, when its A handshake omits B, then disclose B only while authorized and preserve A", async stage => {
  const f = await fixture(stage)
  try {
    const completed = f.handshake()
    if (stage === "open") { await f.openStarted; f.revoke(); f.releaseOpen() }
    await completed
    expect(f.internal.encodeOwnerWorkspaceOffer).toHaveBeenCalledTimes(["before", "authority", "authority-owner", "authority-epoch"].includes(stage) ? 0 : 1)
    expect(f.send).toHaveBeenCalledTimes(stage === "active" ? 1 : 0)
    expect(f.close).not.toHaveBeenCalled()
  } finally { await f.mesh.dispose() }
})

it("Given concurrent owner devices and B revocation of only one, when both omit B while its offer is preparing, then keep authorization and delivery separate for each device", async () => {
  const f = await fixture("active")
  let resume!: () => void
  const ready = new Promise<void>(resolve => { resume = resolve })
  f.internal.encodeOwnerWorkspaceOffer = vi.fn(async () => { await ready; return f.offer })
  const send = vi.fn(async () => {})
  const second = { openStream: vi.fn(async () => ({ send, closeSend: async () => {},
    read: async () => encodePairingFrame("mesh-durable-ack", "secret", f.receipt) })) } as unknown as SyncConnection
  const firstDelivery = f.handshake()
  await vi.waitFor(() => expect(f.internal.encodeOwnerWorkspaceOffer).toHaveBeenCalledOnce())
  const secondDelivery = f.handshake("second-phone", second)
  try {
    await vi.waitFor(() => expect(f.internal.encodeOwnerWorkspaceOffer).toHaveBeenCalledTimes(2))
    f.revoke()
    resume()
    await Promise.all([firstDelivery, secondDelivery])
    expect(f.send).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledOnce()
    expect(f.close).not.toHaveBeenCalled()
  } finally { resume(); await Promise.allSettled([firstDelivery, secondDelivery]); await f.mesh.dispose() }
})
