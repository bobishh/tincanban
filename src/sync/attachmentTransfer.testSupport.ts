import { vi } from "vitest"
import { createBlobDescriptor } from "@meta-uber/mesh-blob"
import type { AttachmentPreparation } from "./attachmentPreparationData"
import type { AttachmentProgress, AttachmentTransferRepository } from "./attachmentTransfer"
import { blindHash, blindObjectId, canonicalBlindJson, type BlindAccess } from "./blindClient"
import { encodeBlindBytes, type BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import type { BlindBlobReceipt } from "./blindBlobClient"

export function repository() {
  let state: AttachmentProgress | null = null
  let preparation: AttachmentPreparation | null = null
  const objects = new Map<string, BlindObject>()
  const port: AttachmentTransferRepository = {
    read: async () => structuredClone(state),
    object: async id => structuredClone(objects.get(id) ?? null),
    commit: async (expected, next, records = []) => {
      if ((state?.generation ?? null) !== expected) throw new Error("Attachment progress conflict")
      state = structuredClone(next)
      for (const record of records) objects.set(record.objectId, structuredClone(record.object))
    },
    preparation: {
      read: async () => structuredClone(preparation),
      commit: async (expected, next, record) => {
        if (state || (preparation?.generation ?? null) !== expected) throw new Error("Attachment preparation conflict")
        preparation = structuredClone(next)
        if (record) objects.set(record.objectId, structuredClone(record.object))
      },
      finish: async (expected, next, record) => {
        if (preparation?.generation !== expected) throw new Error("Attachment preparation conflict")
        await port.commit(null, next, [record])
        preparation = null
      },
      discard: async expected => {
        if (state || canonicalBlindJson(preparation) !== canonicalBlindJson(expected)) throw new Error("Attachment preparation conflict")
        for (const chunk of preparation!.chunks) objects.delete(chunk.objectId)
        preparation = null
      },
    },
    migrateBinding: async (expected, previousBinding, next) => {
      if (state?.generation !== expected || state.binding !== previousBinding) throw new Error("Attachment migration conflict")
      await port.commit(expected, next)
    },
  }
  return { port, objects, state: () => structuredClone(state) }
}

export async function fixture(size = 256 * 1024 + 37) {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  const serviceId = await blindHash(raw)
  const access: BlindAccess = { origin: "https://rusty.example", scopeId: "private-scope", servicePublicKey: encodeBlindBytes(raw),
    readToken: "r".repeat(43), writeToken: "w".repeat(43), policyRevision: 1 }
  const scope = { workspaceId: "board", scopeId: access.scopeId, keyEpoch: 1,
    contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))) }
  const bytes = new Uint8Array(size).fill(47)
  const descriptor = await createBlobDescriptor(bytes, "private-attachment.txt", "text/plain")
  const remote = new Map<string, BlindObject>()
  const sign = async (object: BlindObject, requestId: string): Promise<BlindBlobReceipt> => {
    const payload = { kind: "blind-blob-storage-receipt" as const, version: 1 as const, serviceId,
      scopeId: access.scopeId, keyEpoch: scope.keyEpoch, objectId: await blindObjectId(object),
      policyRevision: access.policyRevision, requestId }
    return { payload, signerKeyId: serviceId, signature: encodeBlindBytes(new Uint8Array(await crypto.subtle.sign("Ed25519",
      pair.privateKey, new TextEncoder().encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`)))) }
  }
  const upload = vi.fn(async (_access: BlindAccess, object: BlindObject, requestId: string) => {
    remote.set(await blindObjectId(object), structuredClone(object))
    return sign(object, requestId)
  })
  const download = vi.fn(async (_access: BlindAccess, id: string) => {
    const object = remote.get(id)
    if (!object) throw Object.assign(new Error("Attachment object unavailable"), { status: 404 })
    return structuredClone(object)
  })
  return { access, scope, bytes, descriptor, remote, upload, download, sign }
}
