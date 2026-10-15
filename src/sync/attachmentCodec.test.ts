import { beforeEach, describe, expect, it, vi } from "vitest"
import { BLOB_CHUNK_BYTES, createBlobDescriptor } from "@meta-uber/mesh-blob"
import { decodeBlindBytes, encodeBlindBytes, encryptPurposeBoundObject, type BlindObject } from "./blindEnvelope"
import { blindObjectId } from "./blindClient"
import { openAttachmentChunk, openAttachmentManifest, sealAttachment, type AttachmentScope } from "./attachmentCodec"

const scope: AttachmentScope = {
  workspaceId: "workspace-one",
  scopeId: "scope_one",
  keyEpoch: 4,
  contentKey: encodeBlindBytes(new Uint8Array(32).fill(17)),
}
const key = decodeBlindBytes(scope.contentKey)
const transferId = "transfer-one"

function fixtureBytes(size = BLOB_CHUNK_BYTES + 37): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => (index * 29) % 256)
}

async function sealedFixture(bytes = fixtureBytes()) {
  const descriptor = await createBlobDescriptor(bytes, "private-name.txt", "text/plain")
  const sealed = await sealAttachment(scope, descriptor, bytes, transferId)
  const manifest = await openAttachmentManifest(scope, descriptor, sealed.locator, sealed.manifest)
  return { bytes, descriptor, sealed, manifest }
}

describe("attachment codec", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("round-trips multiple bounded chunks while Rusty objects reveal no plaintext file data", async () => {
    const { bytes, descriptor, sealed, manifest } = await sealedFixture()
    expect(sealed.chunks).toHaveLength(2)
    expect(manifest.chunks.map(chunk => chunk.bytes)).toEqual([BLOB_CHUNK_BYTES, 37])
    for (const [index, object] of sealed.chunks.entries()) {
      expect(new TextDecoder().decode(decodeBlindBytes(object.ciphertext))).not.toContain("private-name.txt")
      expect(JSON.stringify(object)).not.toContain(descriptor.blobId.slice("sha256:".length))
      expect(await openAttachmentChunk(scope, descriptor, sealed.locator, manifest, index, object)).toEqual(
        bytes.slice(index * BLOB_CHUNK_BYTES, (index + 1) * BLOB_CHUNK_BYTES),
      )
      expect(await blindObjectId(object)).toBe(manifest.chunks[index]!.objectId)
    }
    expect(JSON.stringify(sealed.manifest)).not.toContain("private-name.txt")
    expect(JSON.stringify(sealed.manifest)).not.toContain("text/plain")
    expect(JSON.stringify(sealed.manifest)).not.toContain(descriptor.blobId.slice("sha256:".length))
  })

  it("rejects missing, reordered, substituted, truncated, or corrupted chunks", async () => {
    const { descriptor, sealed, manifest } = await sealedFixture()
    await expect(openAttachmentChunk(scope, descriptor, sealed.locator, manifest, 2, sealed.chunks[0]!)).rejects.toThrow()
    await expect(openAttachmentChunk(scope, descriptor, sealed.locator, manifest, 0, sealed.chunks[1]!)).rejects.toThrow()
    const chunkCipher = sealed.chunks[0]!.ciphertext
    const corrupted = { ...sealed.chunks[0]!, ciphertext: `${chunkCipher[0] === "A" ? "B" : "A"}${chunkCipher.slice(1)}` }
    await expect(openAttachmentChunk(scope, descriptor, sealed.locator, manifest, 0, corrupted)).rejects.toThrow()
    const shortened = await encryptPurposeBoundObject({
      purpose: "attachment",
      subjectId: JSON.stringify([scope.workspaceId, descriptor.blobId, sealed.locator.transferId, "chunk", 0, manifest.chunks.length]),
      scopeId: scope.scopeId,
      keyEpoch: scope.keyEpoch,
    }, key, fixtureBytes(BLOB_CHUNK_BYTES - 1))
    await expect(openAttachmentChunk(scope, descriptor, sealed.locator, manifest, 0, shortened)).rejects.toThrow()
  })

  it("binds scope, epoch, purpose, workspace, attachment, and transfer identity", async () => {
    const { descriptor, sealed } = await sealedFixture()
    await expect(openAttachmentManifest({ ...scope, scopeId: "scope_two" }, descriptor, sealed.locator, sealed.manifest)).rejects.toThrow()
    await expect(openAttachmentManifest({ ...scope, keyEpoch: 5 }, descriptor, sealed.locator, sealed.manifest)).rejects.toThrow()
    await expect(openAttachmentManifest({ ...scope, workspaceId: "workspace-two" }, descriptor, sealed.locator, sealed.manifest)).rejects.toThrow()
    await expect(openAttachmentManifest(scope, descriptor, { ...sealed.locator, transferId: "other-transfer" }, sealed.manifest)).rejects.toThrow()
    await expect(openAttachmentManifest(scope, descriptor, { ...sealed.locator, manifestId: "A".repeat(43) }, sealed.manifest)).rejects.toThrow()
    const wrongPurpose = await encryptPurposeBoundObject({
      purpose: "archive", subjectId: JSON.stringify([scope.workspaceId, descriptor.blobId, transferId, "manifest"]),
      scopeId: scope.scopeId, keyEpoch: scope.keyEpoch,
    }, key, new TextEncoder().encode("{}"))
    await expect(openAttachmentManifest(scope, descriptor, {
      ...sealed.locator,
      manifestId: await blindObjectId(wrongPurpose),
    }, wrongPurpose)).rejects.toThrow()
  })

  it("rejects forged manifest descriptors, changed sizes, and invalid caller scope", async () => {
    const { descriptor, sealed, manifest } = await sealedFixture()
    await expect(openAttachmentManifest(scope, { ...descriptor, name: "forged.txt" }, sealed.locator, sealed.manifest)).rejects.toThrow()
    await expect(openAttachmentChunk(scope, descriptor, sealed.locator, { ...manifest, descriptor: { ...manifest.descriptor, size: descriptor.size + 1 } }, 0, sealed.chunks[0]!)).rejects.toThrow()
    const malformed = await encryptPurposeBoundObject({
      purpose: "attachment",
      subjectId: JSON.stringify([scope.workspaceId, descriptor.blobId, sealed.locator.transferId, "manifest"]),
      scopeId: scope.scopeId,
      keyEpoch: scope.keyEpoch,
    }, key, new TextEncoder().encode(JSON.stringify({ ...manifest, extra: "unsupported" })))
    await expect(openAttachmentManifest(scope, descriptor, {
      ...sealed.locator,
      manifestId: await blindObjectId(malformed),
    }, malformed)).rejects.toThrow()
    await expect(sealAttachment({ ...scope, keyEpoch: 0 }, descriptor, fixtureBytes(), transferId)).rejects.toThrow()
    await expect(sealAttachment(scope, descriptor, fixtureBytes(0), transferId)).rejects.toThrow()
  })

  it("opens epoch-three manifests and chunks with retained key while new preparations use active epoch four", async () => {
    const oldKey = new Uint8Array(32).fill(31)
    const oldScope: AttachmentScope = { ...scope, keyEpoch: 3, contentKey: encodeBlindBytes(oldKey) }
    const bytes = fixtureBytes()
    const descriptor = await createBlobDescriptor(bytes, "rotated.bin", "application/octet-stream")
    const oldSealed = await sealAttachment(oldScope, descriptor, bytes, transferId)
    const rotatedScope = { ...scope, keyEpoch: 4, contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))),
      historicalContentKeys: { "3": oldScope.contentKey } } as AttachmentScope

    const manifest = await openAttachmentManifest(rotatedScope, descriptor, oldSealed.locator, oldSealed.manifest)
    expect(oldSealed.manifest.keyEpoch).toBe(3)
    for (const [index, object] of oldSealed.chunks.entries()) {
      expect(await openAttachmentChunk(rotatedScope, descriptor, oldSealed.locator, manifest, index, object))
        .toEqual(bytes.slice(index * BLOB_CHUNK_BYTES, (index + 1) * BLOB_CHUNK_BYTES))
    }

    const newSealed = await sealAttachment(rotatedScope, descriptor, bytes, "new-transfer")
    expect(newSealed.manifest.keyEpoch).toBe(4)
    expect(newSealed.chunks.every(object => object.keyEpoch === 4)).toBe(true)
  })

  it.each(["missing-history", "future-epoch", "wrong-history-key"] as const)(
    "rejects old attachment ciphertext when %s", async scenario => {
      const oldKey = new Uint8Array(32).fill(31)
      const oldScope: AttachmentScope = { ...scope, keyEpoch: 3, contentKey: encodeBlindBytes(oldKey) }
      const bytes = fixtureBytes()
      const descriptor = await createBlobDescriptor(bytes, "rotated.bin", "application/octet-stream")
      const oldSealed = await sealAttachment(oldScope, descriptor, bytes, transferId)
      const activeScope = { ...scope, keyEpoch: 4, contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))),
        ...(scenario === "missing-history" ? {} : { historicalContentKeys: {
          "3": encodeBlindBytes(scenario === "wrong-history-key" ? new Uint8Array(32).fill(99) : oldKey),
        } }) } as AttachmentScope

      if (scenario === "future-epoch") {
        const opened = await openAttachmentManifest(oldScope, descriptor, oldSealed.locator, oldSealed.manifest)
        const futureKey = crypto.getRandomValues(new Uint8Array(32))
        const futureObject = await encryptPurposeBoundObject({ purpose: "attachment",
          subjectId: JSON.stringify([activeScope.workspaceId, descriptor.blobId, oldSealed.locator.transferId, "manifest"]),
          scopeId: activeScope.scopeId, keyEpoch: 5 }, futureKey, new TextEncoder().encode(JSON.stringify(opened)))
        const locator = { ...oldSealed.locator, manifestId: await blindObjectId(futureObject) }
        await expect(openAttachmentManifest(activeScope, descriptor, locator, futureObject)).rejects.toThrow(/update required/i)
        const futureChunk = await encryptPurposeBoundObject({ purpose: "attachment",
          subjectId: JSON.stringify([activeScope.workspaceId, descriptor.blobId, oldSealed.locator.transferId,
            "chunk", 0, opened.chunks.length]), scopeId: activeScope.scopeId, keyEpoch: 5 }, futureKey, bytes.slice(0, BLOB_CHUNK_BYTES))
        const futureChunkManifest = structuredClone(opened)
        futureChunkManifest.chunks[0]!.objectId = await blindObjectId(futureChunk)
        await expect(openAttachmentChunk(activeScope, descriptor, oldSealed.locator, futureChunkManifest, 0, futureChunk))
          .rejects.toThrow(/update required/i)
        return
      }

      await expect(openAttachmentManifest(activeScope, descriptor, oldSealed.locator, oldSealed.manifest)).rejects.toThrow()
      const manifest = await openAttachmentManifest(oldScope, descriptor, oldSealed.locator, oldSealed.manifest)
      await expect(openAttachmentChunk(activeScope, descriptor, oldSealed.locator, manifest, 0, oldSealed.chunks[0]!)).rejects.toThrow()
    })

  it("captures scope, descriptor, and file bytes before asynchronous hashing", async () => {
    const bytes = fixtureBytes()
    const descriptor = await createBlobDescriptor(bytes, "captured.txt", "text/plain")
    const mutableBytes = new Uint8Array(bytes)
    const mutableDescriptor = { ...descriptor }
    const mutableScope = { ...scope }
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle)
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      await gate
      return originalDigest(...args)
    })
    const sealing = sealAttachment(mutableScope, mutableDescriptor, mutableBytes, transferId)
    mutableScope.workspaceId = "changed-workspace"
    mutableScope.contentKey = encodeBlindBytes(new Uint8Array(32).fill(99))
    mutableDescriptor.name = "changed-after-call.txt"
    mutableDescriptor.blobId = `sha256:${"A".repeat(43)}`
    mutableBytes.fill(0)
    release()
    const sealed = await sealing
    expect(digest).toHaveBeenCalled()
    const manifest = await openAttachmentManifest(scope, descriptor, sealed.locator, sealed.manifest)
    expect(manifest.descriptor.name).toBe("captured.txt")
  })

  it("strips peer tickets and rejects bytes that do not match the original descriptor", async () => {
    const bytes = fixtureBytes()
    const descriptor = { ...(await createBlobDescriptor(bytes, "private-name.txt", "text/plain")), ticket: "peer-only-ticket" }
    const sealed = await sealAttachment(scope, descriptor, bytes, transferId)
    const manifest = await openAttachmentManifest(scope, descriptor, sealed.locator, sealed.manifest)
    expect(manifest.descriptor).not.toHaveProperty("ticket")
    await expect(sealAttachment(scope, descriptor, new Uint8Array(bytes.length).fill(3), transferId)).rejects.toThrow()
  })

  it("rejects changed manifest ciphertext before trusting its entries", async () => {
    const { descriptor, sealed } = await sealedFixture()
    const cipher = sealed.manifest.ciphertext
    const malformed = { ...sealed.manifest, ciphertext: `${cipher[0] === "A" ? "B" : "A"}${cipher.slice(1)}` } as BlindObject
    await expect(openAttachmentManifest(scope, descriptor, sealed.locator, malformed)).rejects.toThrow()
  })
})

it('Given a file encrypted by one of two same-epoch historical keys, when restored after conflict recovery, then authenticate its manifest and chunks with the matching candidate', async () => {
  const { bytes, descriptor, sealed } = await sealedFixture()
  const recovered: AttachmentScope = { ...scope, keyEpoch: 5, contentKey: encodeBlindBytes(new Uint8Array(32).fill(22)),
    historicalContentKeyVariants: { '4': [encodeBlindBytes(new Uint8Array(32).fill(16)), scope.contentKey].sort() } }
  const manifest = await openAttachmentManifest(recovered, descriptor, sealed.locator, sealed.manifest)
  const first = await openAttachmentChunk(recovered, descriptor, sealed.locator, manifest, 0, sealed.chunks[0]!)
  expect(first).toEqual(bytes.slice(0, BLOB_CHUNK_BYTES))
})
