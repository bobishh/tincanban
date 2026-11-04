import { applyChanges, clone, decodeChange, free, getChanges, getHeads, hasHeads, load, save, view } from "@automerge/automerge/slim"
import { decodeBlindBytes, encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { canonicalizeJson } from "../domain/identityCrypto"
import type { AttachmentLocator } from "./attachmentLocator"

export type WorkspaceReplicaSnapshot<Authorization = unknown, Chat = unknown> = {
  version: 1 | 2; workspaceId: string; document: string; authorization: Authorization; chat: Chat
  attachments?: AttachmentLocator[]; history?: unknown
}
type DocumentChanges = Omit<WorkspaceReplicaSnapshot, "version" | "document" | "history"> & {
  version: 3; kind: "document-changes"; heads: string[]; changes: string[]
}
const invalidSnapshot = "Encrypted snapshot does not match this workspace"

/** Board payloads belong to the product; encryption, delivery and receipts belong to the SDK. */
export function encodeWorkspaceDocumentChanges(previous: WorkspaceReplicaSnapshot, next: WorkspaceReplicaSnapshot): Uint8Array | undefined {
  if (next.history !== undefined || canonicalizeJson(metadata(previous)) !== canonicalizeJson(metadata(next))) return
  let before: ReturnType<typeof load> | undefined, after: ReturnType<typeof load> | undefined
  try {
    before = load(decodeBlindBytes(previous.document))
    after = load(decodeBlindBytes(next.document))
    if (!hasHeads(after, getHeads(before))) return
    const heads = getHeads(after)
    if (!heads.length || heads.length > 256) return
    const changes = getChanges(before, after)
    if (!changes.length) return
    const payload: DocumentChanges = { version: 3, kind: "document-changes", workspaceId: next.workspaceId,
      authorization: next.authorization, chat: next.chat, heads, changes: changes.map(encodeBlindBytes),
      ...(next.attachments === undefined ? {} : { attachments: next.attachments }) }
    return new TextEncoder().encode(canonicalizeJson(payload))
  } catch { return }
  finally { if (before) free(before); if (after) free(after) }
}

/** Decode a current board without admitting it; each host must still verify signed causal authority. */
export async function readWorkspaceReplicaSnapshot<Authorization = unknown, Chat = unknown>(plaintext: Uint8Array,
  workspaceId: string, readDocument: () => Promise<Uint8Array>): Promise<WorkspaceReplicaSnapshot<Authorization, Chat>> {
  const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext))
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error(invalidSnapshot)
  const value = decoded as Record<string, unknown>
  if (value.workspaceId !== workspaceId || !value.authorization) throw new Error(invalidSnapshot)
  if (value.kind === "document-changes") return applyDocumentChanges(value as DocumentChanges,
    readDocument) as Promise<WorkspaceReplicaSnapshot<Authorization, Chat>>
  if (value.kind !== undefined || typeof value.document !== "string" || value.changes !== undefined ||
      value.version !== (value.history === undefined ? 1 : 2)) throw new Error(invalidSnapshot)
  return value as WorkspaceReplicaSnapshot<Authorization, Chat>
}

async function applyDocumentChanges(value: DocumentChanges & { document?: unknown; history?: unknown },
  readDocument: () => Promise<Uint8Array>): Promise<WorkspaceReplicaSnapshot> {
  if (value.version !== 3 || value.document !== undefined || value.history !== undefined || !Array.isArray(value.changes) ||
      !value.changes.length || value.changes.some(change => typeof change !== "string") || !Array.isArray(value.heads) ||
      !value.heads.length || value.heads.length > 256 || value.heads.some(head => typeof head !== "string" || !/^[a-f0-9]{64}$/.test(head))) throw new Error(invalidSnapshot)
  const changes = value.changes.map(decodeBlindBytes)
  let document = load(await readDocument())
  try {
    ;[document] = applyChanges(document, changes)
    const hashes = changes.map(change => decodeChange(change).hash)
    if (!hasHeads(document, [...hashes, ...value.heads])) throw new Error("Document change dependencies are unavailable")
    // A local union is not proof that the sender retained our unpublished edits.
    const source = clone(view(document, value.heads))
    try {
      if (!hasHeads(source, hashes)) throw new Error(invalidSnapshot)
      return { version: 1, workspaceId: value.workspaceId, document: encodeBlindBytes(save(source)),
        authorization: value.authorization, chat: value.chat, ...(value.attachments === undefined ? {} : { attachments: value.attachments }) }
    } finally { free(source) }
  } finally { free(document) }
}

function metadata(snapshot: WorkspaceReplicaSnapshot): unknown {
  const rest = { ...snapshot } as Partial<WorkspaceReplicaSnapshot>
  delete rest.document
  const authorization = snapshot.authorization
  if (!authorization || typeof authorization !== "object" || !("authority" in authorization)) return rest
  const policy = { ...authorization } as Record<string, unknown>
  if (policy.version === 1 && Array.isArray(policy.records)) delete policy.records
  else if (policy.version === 2 && Array.isArray(policy.pages)) delete policy.pages
  return { ...rest, authorization: policy }
}
