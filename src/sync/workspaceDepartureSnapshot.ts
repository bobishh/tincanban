import * as Automerge from "@automerge/automerge/slim"
import { BLOB_CHUNK_BYTES, type BlobDescriptor } from "@meta-uber/mesh-blob"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { canonicalizeJson, fromBase64Url } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { listWorkspaceAttachments } from "./workspaceAttachments"
import { verifyWorkspaceDeparture, type WorkspaceDeparture } from "./meshRecords"
import type { WorkspaceSetStore } from "./workspaceSet"

type Delivery = { version: 1; departure: WorkspaceDeparture; blobs: BlobDescriptor[] }

function documentFiles(bytes: string): { heads: string[]; files: Map<string, BlobDescriptor> } {
  const doc = Automerge.load<WorkspaceDocumentV2>(fromBase64Url(bytes))
  try {
    const descriptors = listWorkspaceAttachments(doc)
    return { heads: Automerge.getHeads(doc).sort(), files: new Map(descriptors.map(value => [canonicalizeJson(value), value])) }
  } finally { Automerge.free(doc) }
}

/** Freeze the sender's actual file obligations; absent bytes do not become invented delivery receipts. */
export async function prepareDepartureSnapshot(snapshot: Uint8Array, departure: WorkspaceDeparture,
  blob: WorkspaceSetStore["blob"]): Promise<Uint8Array> {
  const workspaceId = departure.record.payload.workspaceId
  const entries = meshRustRuntime().state.decodeWorkspaceSet(snapshot, [workspaceId])
  const entry = entries[0]!
  const files = documentFiles(entry.bytes).files
  const available: BlobDescriptor[] = []
  for (const descriptor of files.values()) if (await blob?.read(descriptor)) available.push(descriptor)
  entry.mesh = { ...(entry.mesh as object), pendingDepartureDelivery: { version: 1, departure, blobs: available } }
  return meshRustRuntime().state.encodeWorkspaceSet(entries)
}

/** Called before the durable snapshot receipt, while the existing authenticated data channel is still open. */
export async function receiveDepartureFiles(snapshot: Uint8Array, workspaceId: string, remotePersonId: string,
  persist: (descriptor: BlobDescriptor) => Promise<void>): Promise<void> {
  const entries = meshRustRuntime().state.decodeWorkspaceSet(snapshot, [workspaceId])
  for (const entry of entries) {
    const delivery = (entry.mesh as { pendingDepartureDelivery?: Delivery } | undefined)?.pendingDepartureDelivery
    if (!delivery) continue
    if (delivery.version !== 1 || !Array.isArray(delivery.blobs)) throw new Error("Invalid departure delivery")
    const departure = verifyWorkspaceDeparture(delivery.departure, workspaceId)
    const document = documentFiles(entry.bytes)
    if (departure.record.payload.personId !== remotePersonId ||
      canonicalizeJson([...departure.record.payload.workspaceHeads].sort()) !== canonicalizeJson(document.heads)) {
      throw new Error("Departure delivery differs from the signed final heads")
    }
    if (delivery.blobs.length > document.files.size) throw new Error("Departure file is not referenced by the final document")
    for (const descriptor of delivery.blobs) {
      if (!document.files.has(canonicalizeJson(descriptor))) {
        throw new Error("Departure file is not referenced by the final document")
      }
      await persist(descriptor)
    }
  }
}

export function departureDeliveryTimeout(snapshot: Uint8Array, workspaceId: string): number {
  const entry = meshRustRuntime().state.decodeWorkspaceSet(snapshot, [workspaceId])[0]!
  const delivery = (entry.mesh as { pendingDepartureDelivery: Delivery }).pendingDepartureDelivery
  return 12_000 + 2_000 * delivery.blobs.reduce((chunks, descriptor) => chunks + Math.ceil(descriptor.size / BLOB_CHUNK_BYTES), 0)
}
