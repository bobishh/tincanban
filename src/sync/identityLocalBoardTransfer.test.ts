import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "node:fs/promises"
import { createDeviceAuthorizationApproval, createDeviceAuthorizationRequest, profileFromIdentitySeedForDevice,
  verifyDeviceAuthorizationApproval,
} from "@meta-uber/mesh-identity"
import { initializeAutomerge } from "../crdt"
import { adoptApprovedApplicationDevice, bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createWorkspaceDoc } from "../test/boardFixture"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { executeCommand } from "../domain/commands"
import { peerStore } from "./peerStore"
import { recordGenesisAuthority, workspaceRole } from "./changeAuthorization"
import { completePendingLocalWorkspaceOwnershipTransfer, transferLocallyOwnedWorkspaces } from "./localWorkspaceOwnership"
import type { PeerStore } from "./peerStore"

beforeAll(async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, operation: () => Promise<unknown>) => operation() } })
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
    await readFile("node_modules/@automerge/automerge/dist/automerge.wasm"), { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

beforeEach(resetIdentityStorageForTest)

it.each(["unshared", "connected"])("Given a %s guest-owned edited board and an approved Bo identity for the same app key, When adopting with Add, Then Bo gets signed owner rights and existing board history stays intact", async connection => {
  const guest = await bootstrapIdentity("Local guest")
  const bo = await profileFromIdentitySeedForDevice(new Uint8Array(32).fill(31), "Bo", new Uint8Array(32).fill(32))
  const workspaceId = crypto.randomUUID()
  const doc = Automerge.change(Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(workspaceId, "Guest board",
    guest.identity.personId, "blank")), draft => { draft.title = "Edited guest board" })
  await recordGenesisAuthority(doc, guest)
  const credential = { version: 1 as const, workspaceId, ownerPersonId: guest.identity.personId,
    ownerPublicKey: guest.identity.publicKey, ownerCertificates: [guest.certificate], transportSecret: "A".repeat(32),
    epoch: 1, updatedAt: new Date().toISOString() }
  if (connection === "connected") await peerStore.putWorkspaceCredential(credential)

  const request = await createDeviceAuthorizationRequest(guest, { applicationOrigin: "https://boards.example",
    challenge: "a".repeat(64), expiresAt: Date.now() + 60_000 })
  const approval = await createDeviceAuthorizationApproval(bo, request, { applicationOrigin: "https://boards.example",
    challenge: request.payload.challenge })
  const verified = await verifyDeviceAuthorizationApproval(approval, request, { expectedExistingProfile: guest })
  const originalHeads = Automerge.getHeads(doc).sort()
  const originalChanges = Automerge.getAllChanges(doc)
  const localWorkspaceStore = { read: async (id: string) => {
    if (id !== workspaceId) throw new Error("Unknown workspace")
    return Automerge.save(doc)
  }, readAuthorityHeads: async (id: string) => {
    if (id !== workspaceId) throw new Error("Unknown workspace")
    return Automerge.getHeads(doc).sort()
  } }

  await expect(transferLocallyOwnedWorkspaces({ sourceProfile: guest, approvedTarget: verified,
    workspaceIds: [workspaceId, "missing-workspace"], workspaceStore: localWorkspaceStore }))
    .rejects.toThrow("Unknown workspace")
  expect((await peerStore.getWorkspaceCredential(workspaceId))?.ownerPersonId).toBe(guest.identity.personId)

  let ownerReferences: Awaited<ReturnType<typeof transferLocallyOwnedWorkspaces>> = []
  const adopted = await adoptApprovedApplicationDevice(approval, request, guest, async (approved, ensureCurrent) => {
    ownerReferences = await transferLocallyOwnedWorkspaces({ sourceProfile: guest, approvedTarget: approved,
      workspaceIds: [workspaceId], workspaceStore: localWorkspaceStore, ensureCurrent })
  })

  expect(adopted.identity.personId).toBe(bo.identity.personId)
  expect(adopted.device.deviceId).toBe(guest.device.deviceId)
  expect(adopted.privateKeys.devicePrivateKey).toBe(guest.privateKeys.devicePrivateKey)
  expect(ownerReferences).toEqual([{ workspaceId, ownerGrantHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u) }])
  expect(Automerge.getHeads(doc).sort()).toEqual(originalHeads)
  expect(Automerge.getAllChanges(doc)).toEqual(originalChanges)
  expect(doc.title).toBe("Edited guest board")
  expect(await workspaceRole(doc, adopted)).toBe("owner")
  await completePendingLocalWorkspaceOwnershipTransfer({ profile: adopted, workspaceStore: localWorkspaceStore,
    registerOwnerReference: async () => {} })

  const column = Object.values(doc.entities).find(entity => "kind" in entity && entity.kind === "column")!
  const edit = await executeCommand(doc, { kind: "createItem", parentId: column.id, title: "Bo edit" }, adopted)
  expect(edit.ok).toBe(true)
  if (edit.ok) {
    expect(edit.value.newDoc.id).toBe(workspaceId)
    expect(edit.value.newDoc.title).toBe("Edited guest board")
    expect(Automerge.getAllChanges(edit.value.newDoc)).toEqual(expect.arrayContaining(originalChanges))
    expect(Object.values(edit.value.newDoc.entities).some(entity => !("kind" in entity) && entity.title === "Bo edit")).toBe(true)
  }
  Automerge.free(doc)
})

it("Given a crash after owner credential commit, When the approved transfer resumes, Then peer authority and root reference finish idempotently", async () => {
  const guest = await bootstrapIdentity("Local guest")
  const bo = await profileFromIdentitySeedForDevice(new Uint8Array(32).fill(41), "Bo", new Uint8Array(32).fill(42))
  const workspaceId = crypto.randomUUID()
  const doc = Automerge.change(Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(workspaceId, "Guest board",
    guest.identity.personId, "blank")), draft => { draft.title = "Edited guest board" })
  await recordGenesisAuthority(doc, guest)
  const credential = { version: 1 as const, workspaceId, ownerPersonId: guest.identity.personId,
    ownerPublicKey: guest.identity.publicKey, ownerCertificates: [guest.certificate], transportSecret: "B".repeat(32),
    epoch: 1, updatedAt: new Date().toISOString() }
  await peerStore.putWorkspaceCredential(credential)
  const guestPeer = { workspaceId, deviceId: "guest-peer", personId: guest.identity.personId,
    endpoint: "iroh://guest", transportSecret: "C".repeat(32), role: "owner" as const,
    lastSeen: new Date().toISOString() }
  await peerStore.upsertPeer(guestPeer)
  const request = await createDeviceAuthorizationRequest(guest, { applicationOrigin: "https://boards.example",
    challenge: "b".repeat(64), expiresAt: Date.now() + 60_000 })
  const approval = await createDeviceAuthorizationApproval(bo, request, { applicationOrigin: "https://boards.example",
    challenge: request.payload.challenge })
  const verified = await verifyDeviceAuthorizationApproval(approval, request, { expectedExistingProfile: guest })
  const localWorkspaceStore = { read: async (id: string) => {
    if (id !== workspaceId) throw new Error("Unknown workspace")
    return Automerge.save(doc)
  }, readAuthorityHeads: async (id: string) => {
    if (id !== workspaceId) throw new Error("Unknown workspace")
    return Automerge.getHeads(doc).sort()
  } }
  let failFirstPeerWrite = true
  const interruptedStore = new Proxy(peerStore, { get(target, property) {
    if (property === "upsertPeer") return async (peer: Parameters<PeerStore["upsertPeer"]>[0]) => {
      if (failFirstPeerWrite) { failFirstPeerWrite = false; throw new Error("simulated interruption after credential commit") }
      return target.upsertPeer(peer)
    }
    const value = Reflect.get(target, property, target) as unknown
    return typeof value === "function" ? value.bind(target) : value
  } }) as PeerStore

  await expect(transferLocallyOwnedWorkspaces({ sourceProfile: guest, approvedTarget: verified, workspaceIds: [workspaceId],
    workspaceStore: localWorkspaceStore, store: interruptedStore })).rejects.toThrow("simulated interruption")
  expect((await peerStore.getWorkspaceCredential(workspaceId))?.ownerPersonId).toBe(bo.identity.personId)
  expect((await peerStore.getPeer(workspaceId, guestPeer.deviceId))?.role).toBe("owner")
  expect(await completePendingLocalWorkspaceOwnershipTransfer({ profile: guest, workspaceStore: localWorkspaceStore,
    registerOwnerReference: async () => {} })).toEqual([])

  const references = await transferLocallyOwnedWorkspaces({ sourceProfile: guest, approvedTarget: verified,
    workspaceIds: [workspaceId], workspaceStore: localWorkspaceStore })
  expect((await peerStore.getPeer(workspaceId, guestPeer.deviceId))?.role).toBe("editor")
  const adopted = await adoptApprovedApplicationDevice(approval, request, guest, async () => {})
  const registered: Array<{ workspaceId: string; ownerGrantHash: string }> = []
  const wrongTarget = { ...adopted, identity: { ...adopted.identity, publicKey: "wrong-public-key" } }
  await expect(completePendingLocalWorkspaceOwnershipTransfer({ profile: wrongTarget, workspaceStore: localWorkspaceStore,
    registerOwnerReference: async () => { throw new Error("must not register") } })).rejects.toThrow("approved Identity adoption")
  const finalized = await completePendingLocalWorkspaceOwnershipTransfer({ profile: adopted, workspaceStore: localWorkspaceStore,
    registerOwnerReference: async reference => { registered.push(reference) } })
  expect(finalized).toEqual(references)
  expect(registered).toEqual(references)
  expect(await completePendingLocalWorkspaceOwnershipTransfer({ profile: adopted, workspaceStore: localWorkspaceStore,
    registerOwnerReference: async () => {} })).toEqual([])
  Automerge.free(doc)
})
