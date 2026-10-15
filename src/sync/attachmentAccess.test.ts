import { readFile } from "node:fs/promises"
import { IDBFactory } from "fake-indexeddb"
import * as Automerge from "@automerge/automerge/slim"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { createBlobDescriptor } from "@meta-uber/mesh-blob"
import type { BlindReplicaConfig } from "./blindReplication"

async function loadTestModules() {
  const [crdt, identity, seeds, proofs, changes, meshRecords, peer, access, replicas, local, delivery, codec, index, client] = await Promise.all([
    import("../crdt"), import("../domain/identity"), import("../domain/seeds"), import("../domain/proofs"),
    import("./changeAuthorization"), import("./meshRecords"), import("./peerStore"), import("./attachmentAccess"),
    import("./privateReplicaRepository"), import("../localDb"), import("./rustyAttachmentDelivery"), import("./attachmentCodec"),
    import("./attachmentIndexRepository"), import("./blindClient"),
  ])
  return { ...crdt, ...identity, ...seeds, ...proofs, ...changes, ...meshRecords, ...peer, ...access, ...replicas,
    ...local, ...delivery, ...codec, ...index, ...client }
}

let runtime: Awaited<ReturnType<typeof loadTestModules>>

beforeAll(async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, options: unknown, run?: () => Promise<unknown>) =>
    (run ?? options as () => Promise<unknown>)() } })
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  runtime = await loadTestModules()
  await runtime.initializeAutomerge()
})
afterEach(() => { vi.restoreAllMocks(); runtime.resetIdentityStorageForTest() })
afterAll(() => vi.unstubAllGlobals())

async function fixture(role: "owner" | "editor" | "visitor" | "uninvited" = "owner") {
  runtime.resetIdentityStorageForTest()
  const owner = await runtime.bootstrapIdentity("File owner")
  let profile = owner
  const descriptor = await createBlobDescriptor(new Uint8Array([1, 2]), "private.txt", "text/plain")
  const seed = runtime.createWorkspaceDoc(crypto.randomUUID(), "Files", profile.identity.personId, "blank")
  const board = Object.values(seed.entities).find(entity => entity.kind === "board")!
  seed.entities.file = { id: "file", kind: "document", title: "Private file", placement: { parentId: board.id, rank: "0/1" },
    archivedAt: null, createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z",
    documentKind: "attachment", format: "file", content: null, file: { type: "blob", sha256: descriptor.blobId.slice(7),
      byteLength: descriptor.size, mimeType: descriptor.mediaType, fileName: descriptor.name } }
  const doc = Automerge.from(seed)
  await runtime.recordGenesisAuthority(doc, profile)
  if (role !== "owner") {
    runtime.resetIdentityStorageForTest()
    profile = await runtime.bootstrapIdentity("File recipient")
    const authority = await runtime.peerStore.getWorkspaceAuthority(doc.id)
    if (!authority) throw new Error("Expected fixture owner authority")
    await runtime.peerStore.putWorkspaceAuthority({ ...authority, ...(role === "uninvited" ? {} : {
      localGrant: await runtime.createWorkspaceGrant(owner, doc.id, profile.identity.personId, role),
    }) })
  }
  const token = "A".repeat(43)
  const config: BlindReplicaConfig = { workspaceId: doc.id, origin: "https://rusty.example", scopeId: token,
    contentKey: token, readToken: token, writeToken: token, servicePublicKey: token,
    policyRevision: 1, keyEpoch: 1, cursor: 0, lastUploaded: "" }
  await runtime.setReplicaPreference(profile.identity.personId, config)
  const selected = (await runtime.getReplicaConfigurations(profile.identity.personId))[0]!
  let currentDoc = doc
  const app = { readWorkspaceDoc: async () => currentDoc, getCurrentProfile: () => profile }
  const revoke = async () => {
    const authority = await runtime.peerStore.getWorkspaceAuthority(doc.id)
    if (!authority) throw new Error("Expected fixture owner authority")
    const removal = await runtime.createWorkspaceDeviceRevocation(owner, doc.id, profile.identity.personId,
      profile.device.deviceId, Automerge.getHeads(doc), [profile.certificate])
    await runtime.peerStore.putWorkspaceAuthority({ ...authority, catalog: { ...authority.catalog as object, deviceRevocations: [removal] } })
  }
  return { app, config: selected, descriptor, profile, doc, revoke,
    removeReference: () => { currentDoc = Automerge.change(doc, draft => { delete draft.entities.file }) },
    copyReference: () => { currentDoc = Automerge.change(doc, draft => {
      draft.entities.copy = { ...structuredClone(seed.entities.file!), id: "copy" }
      const file = draft.entities.copy
      if (file.kind === "document" && file.file) file.file.fileName = "copy.txt"
    }) },
    close: () => { Automerge.free(currentDoc) } }
}

it("Given a current owner with a referenced attachment and private connection, then authorize both read and upload", async () => {
  const f = await fixture()
  try {
    expect((await indexedDB.databases()).map(database => database.name)).toContain("tincanban-local-state-v1")
    await (await runtime.createAttachmentAccessGuard(f.app as never, f.config, f.descriptor, "read"))()
    await (await runtime.createAttachmentAccessGuard(f.app as never, f.config, f.descriptor, "upload"))()
  } finally { f.close() }
})

it("Given a signed device revocation after preparation, then deny attachment read and upload before transport", async () => {
  const f = await fixture()
  try {
    const read = await runtime.createAttachmentAccessGuard(f.app as never, f.config, f.descriptor, "read")
    const upload = await runtime.createAttachmentAccessGuard(f.app as never, f.config, f.descriptor, "upload")
    await f.revoke()
    await expect(read()).rejects.toThrow(/revok|permission|authority/i)
    await expect(upload()).rejects.toThrow(/revok|permission|authority/i)
  } finally { f.close() }
})

it("Given the durable key changed while public metadata stayed equal, then reject the old file access context", async () => {
  const f = await fixture()
  try {
    const guard = await runtime.createAttachmentAccessGuard(f.app as never, f.config, f.descriptor, "read")
    const raw = await runtime.readLocal("tincanban.local_profile.v1")
    if (!raw) throw new Error("Expected local identity")
    const saved = JSON.parse(raw)
    const replacement = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    saved.privateKeys.devicePrivateKeyPkcs8 = runtime.toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", replacement.privateKey)))
    await runtime.writeLocal("tincanban.local_profile.v1", JSON.stringify(saved))
    await expect(guard()).rejects.toThrow(/stale|key|identity/i)
  } finally { f.close() }
})

it("Given the private connection is removed after preparation, then reject its file access context", async () => {
  const f = await fixture()
  try {
    const guard = await runtime.createAttachmentAccessGuard(f.app as never, f.config, f.descriptor, "read")
    await runtime.setReplicaPreference(f.profile.identity.personId, f.config, true)
    await expect(guard()).rejects.toThrow(/credential|revision|connection/i)
  } finally { f.close() }
})

it("Given a file reference is removed or differs from the requested descriptor, then deny the stale reference", async () => {
  const f = await fixture()
  try {
    await expect(runtime.createAttachmentAccessGuard(f.app as never, f.config, { ...f.descriptor, name: "forged.txt" }, "read"))
      .rejects.toThrow(/reference|attachment/i)
    const guard = await runtime.createAttachmentAccessGuard(f.app as never, f.config, f.descriptor, "read")
    f.removeReference()
    await expect(guard()).rejects.toThrow(/reference|attachment/i)
  } finally { f.close() }
})

it.each(["editor", "visitor", "uninvited"] as const)(
  "Given a %s with real current grant evidence, then attachment access follows that role", async role => {
    const f = await fixture(role)
    try {
      if (role === "uninvited") {
        await expect(runtime.createAttachmentAccessGuard(f.app as never, f.config, f.descriptor, "read")).rejects.toThrow(/permission/i)
      } else {
        await (await runtime.createAttachmentAccessGuard(f.app as never, f.config, f.descriptor, "read"))()
      }
      if (role === "editor") await (await runtime.createAttachmentAccessGuard(f.app as never, f.config, f.descriptor, "upload"))()
      else await expect(runtime.createAttachmentAccessGuard(f.app as never, f.config, f.descriptor, "upload")).rejects.toThrow(/permission/i)
    } finally { f.close() }
  },
)

it("Given identical file bytes referenced with different names, then authorize each exact reference", async () => {
  const f = await fixture()
  try {
    f.copyReference()
    await (await runtime.createAttachmentAccessGuard(f.app as never, f.config, { ...f.descriptor, name: "copy.txt" }, "read"))()
    await (await runtime.createAttachmentAccessGuard(f.app as never, f.config, f.descriptor, "read"))()
  } finally { f.close() }
})

it("Given a connection is removed while the document read waits, then do not return a usable transfer guard", async () => {
  const f = await fixture()
  try {
    const guard = await runtime.createAttachmentAccessGuard(f.app as never, f.config, f.descriptor, "read")
    vi.spyOn(f.app, "readWorkspaceDoc").mockImplementationOnce(async () => {
      await runtime.setReplicaPreference(f.profile.identity.personId, f.config, true)
      return f.doc
    })
    await expect(guard()).rejects.toThrow(/credential|revision|connection/i)
  } finally { f.close() }
})

async function remoteFile(f: Awaited<ReturnType<typeof fixture>>) {
  const { workspaceId, scopeId, keyEpoch, contentKey } = f.config
  const sealed = await runtime.sealAttachment({ workspaceId, scopeId, keyEpoch, contentKey }, f.descriptor, new Uint8Array([1, 2]))
  const index = runtime.createAttachmentIndexRepository(runtime.privateReplicaBinding(f.profile.identity.personId, f.config), () => {})
  await index.merge([sealed.locator])
  const objects = new Map(await Promise.all([...sealed.chunks, sealed.manifest].map(async object => [await runtime.blindObjectId(object), object] as const)))
  const network = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input))
    const object = objects.get(url.pathname.split("/").at(-1)!)
    if (!object) throw new Error("Unexpected attachment request")
    return new Response(JSON.stringify(object), { headers: { "content-type": "application/json" } })
  })
  vi.stubGlobal("fetch", network)
  return network
}

it("Given a private locator with source devices unavailable, then the application fetches verified bytes from Rusty", async () => {
  const f = await fixture()
  try {
    const network = await remoteFile(f)
    const peer = vi.fn(async () => { throw new Error("Source device closed") })
    expect(await runtime.fetchRustyAttachment(f.app as never, f.doc.id, f.descriptor, () => {}, peer)).toEqual(new Uint8Array([1, 2]))
    expect(network).toHaveBeenCalledTimes(2)
    expect(peer).not.toHaveBeenCalled()
    expect(await runtime.fetchRustyAttachment(f.app as never, f.doc.id, { ...f.descriptor, ticket: "replacement-peer-route" }, () => {}, peer))
      .toEqual(new Uint8Array([1, 2]))
    expect(network).toHaveBeenCalledTimes(2)
  } finally { f.close() }
})

it("Given Rusty is unavailable but current authority permits a peer read, then use the peer fallback", async () => {
  const f = await fixture()
  try {
    await remoteFile(f)
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Rusty offline") }))
    const peer = vi.fn(async () => new Uint8Array([1, 2]))
    expect(await runtime.fetchRustyAttachment(f.app as never, f.doc.id, f.descriptor, () => {}, peer)).toEqual(new Uint8Array([1, 2]))
    expect(peer).toHaveBeenCalledTimes(1)
  } finally { f.close() }
})

it("Given device authority is revoked while Rusty reads, then neither return bytes nor attempt peer fallback", async () => {
  const f = await fixture()
  try {
    const network = await remoteFile(f)
    network.mockImplementationOnce(async () => { await f.revoke(); throw new Error("Interrupted connection") })
    const peer = vi.fn(async () => new Uint8Array([1, 2]))
    await expect(runtime.fetchRustyAttachment(f.app as never, f.doc.id, f.descriptor, () => {}, peer)).rejects.toThrow(/revok|permission|authority/i)
    expect(peer).not.toHaveBeenCalled()
  } finally { f.close() }
})
