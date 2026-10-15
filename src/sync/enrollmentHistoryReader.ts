import { sha256Base64Url } from "../domain/identity"
import { captureArchiveTreeContext } from "@meta-uber/mesh-replication/history-archive"
import type { WorkspaceSetStore } from "./workspaceSet"
import { capturePeerHistoryBaselineDescriptor, type PeerHistoryObjectReader } from "./workspaceSetHistory"
import type { PeerHistoryObjectBinding } from "./peerHistoryTransport"
import { EnrollmentHistorySelection } from "./enrollmentHistorySelection"

const MAX_DOCUMENT_PART_BYTES = 256 * 1024
const MAX_HISTORY_DOCUMENT_BYTES = 256 * 1024 * 1024
const OBJECT_ID = /^[A-Za-z0-9_-]{43}$/

type EnrollmentHistoryStore = Pick<WorkspaceSetStore,
  "readHistoryBaseline" | "readHistoryBaselineDocument" | "readHistoryArchiveObject">

function captureBinding(value: PeerHistoryObjectBinding, workspaceId: string): PeerHistoryObjectBinding {
  const binding = structuredClone(value)
  if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
      Object.keys(binding).length !== 6 || binding.workspaceId !== workspaceId ||
      !Number.isSafeInteger(binding.historyEpoch) || binding.historyEpoch < 1 ||
      !["page", "record", "part"].includes(binding.objectKind) ||
      !Number.isSafeInteger(binding.partIndex) || binding.partIndex < 0 ||
      !Number.isSafeInteger(binding.partCount) || binding.partCount < 1 || binding.partIndex >= binding.partCount) {
    throw new Error("Enrollment archive binding is invalid")
  }
  const context = captureArchiveTreeContext({ workspaceId: binding.workspaceId, historyEpoch: binding.historyEpoch, indexId: binding.indexId })
  return { ...context, objectKind: binding.objectKind, partIndex: binding.partIndex, partCount: binding.partCount }
}

/** Reads only an already-owned local history source while the authenticated enrollment session is active. */
export function createEnrollmentHistoryReader(store: EnrollmentHistoryStore, workspaceIds: string[], remoteDeviceId: string,
  ensureCurrent: () => void | Promise<void>): PeerHistoryObjectReader {
  const selected = new Set(workspaceIds)
  if (!selected.size || selected.size !== workspaceIds.length || workspaceIds.some(id => typeof id !== "string" || id.length === 0) ||
      typeof remoteDeviceId !== "string" || remoteDeviceId.length === 0) {
    throw new Error("Enrollment history reader requires selected workspaces and an authenticated peer")
  }

  const guard = async () => { await ensureCurrent() }
  const requireSelected = (workspaceId: string) => {
    if (!selected.has(workspaceId)) throw new Error("Enrollment history workspace is not selected")
  }
  const selection = new EnrollmentHistorySelection(store, selected, ensureCurrent)

  return {
    ensureCurrent,
    authorizeHistoryAncestor: basis => selection.authorizeAncestor(basis),
    async readBaseline(workspaceId, baselineId) {
      return selection.read(workspaceId, baselineId)
    },
    async readDocument(descriptorValue, workspaceId) {
      requireSelected(workspaceId)
      const descriptor = capturePeerHistoryBaselineDescriptor(descriptorValue)
      await selection.assertDescriptor(descriptor, workspaceId)
      if (!store.readHistoryBaselineDocument) throw new Error("Local enrollment history document is unavailable")
      const document = new Uint8Array(descriptor.documentLength)
      for (let offset = 0; offset < descriptor.documentLength; offset += MAX_DOCUMENT_PART_BYTES) {
        const length = Math.min(MAX_DOCUMENT_PART_BYTES, descriptor.documentLength - offset)
        await guard()
        const part = await store.readHistoryBaselineDocument({ workspaceId, baselineId: descriptor.baselineId,
          documentDigest: descriptor.documentDigest, offset, length }, remoteDeviceId)
        await guard()
        if (!(part instanceof Uint8Array) || part.length !== length) throw new Error("Local enrollment history document is unavailable or incomplete")
        document.set(part, offset)
      }
      await guard()
      const documentDigest = await sha256Base64Url(document)
      await guard()
      if (document.length > MAX_HISTORY_DOCUMENT_BYTES || documentDigest !== descriptor.documentDigest) {
        throw new Error("Local enrollment history document does not match its descriptor")
      }
      await selection.assertDescriptor(descriptor, workspaceId)
      return document
    },
    async read(objectId, bindingValue, baselineId) {
      if (typeof objectId !== "string" || !OBJECT_ID.test(objectId) || typeof baselineId !== "string" || !OBJECT_ID.test(baselineId)) {
        throw new Error("Enrollment history object requires a verified baseline")
      }
      const binding = captureBinding(bindingValue, bindingValue.workspaceId)
      requireSelected(binding.workspaceId)
      const descriptor = await selection.read(binding.workspaceId, baselineId)
      if (!descriptor || descriptor.baselineId !== baselineId) throw new Error("Local enrollment history baseline changed")
      if (!store.readHistoryArchiveObject) throw new Error("Local enrollment history object is unavailable")
      await guard()
      const bytes = await store.readHistoryArchiveObject(binding.workspaceId, baselineId, objectId, binding, remoteDeviceId)
      await guard()
      if (!(bytes instanceof Uint8Array)) throw new Error("Local enrollment history object is unavailable")
      await selection.assertDescriptor(descriptor, binding.workspaceId)
      return bytes.slice()
    },
  }
}
