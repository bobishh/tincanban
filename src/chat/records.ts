import { validateMessageContext, type MessageContext } from "./context"
import { verifyEnvelope, type SignedEnvelope } from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import { validateDisplayName, normalizeDisplayName } from "./names"
import { peerStore } from "../sync/peerStore"
import { keyId, verifyDeviceChain, type WorkspaceAuthority } from "../sync/meshRecords"
import { canWorkspace } from "../domain/permissions"

export type ChatPayload = {
  kind: "chat-message" | "chat-profile" | "chat-typing"
  version: 1 | 2
  context?: MessageContext
  workspaceId: string
  personId: string
  deviceId: string
  id: string
  createdAt: string
  text: string
  revision: number
}

export type ChatAuthority = {
  publicKey: string
  certificates: DeviceCertificate[]
  grant?: WorkspaceGrant
}

export type ChatRecord = {
  signed: SignedEnvelope<ChatPayload>
  publicKey: string
  certificates: DeviceCertificate[]
  authority: ChatAuthority
}

async function grantSignedBy(grant: WorkspaceGrant, authority: WorkspaceAuthority): Promise<boolean> {
  if (grant.signerKeyId === authority.personId) return verifyEnvelope(grant, authority.publicKey)
  try {
    const certificates = authority.certificates.filter(cert => cert?.payload?.personId === authority.personId)
    const deviceKey = await verifyDeviceChain({ personId: authority.personId, publicKey: authority.publicKey,
      deviceId: grant.signerKeyId, certificates })
    return verifyEnvelope(grant, deviceKey)
  } catch {
    return false
  }
}

function invalidRecord(message = "Invalid chat record"): never {
  throw new Error(message)
}

function validatePayloadIdentity(record: ChatRecord, payload: ChatPayload, workspaceId: string): void {
  if (!["chat-message", "chat-profile", "chat-typing"].includes(payload.kind)) return invalidRecord()
  if (payload.workspaceId !== workspaceId) return invalidRecord()
  if (typeof payload.personId !== "string" || typeof payload.deviceId !== "string") return invalidRecord()
  if (typeof payload.id !== "string" || !payload.id.startsWith(`${payload.deviceId}:`) || payload.id.length > 160) return invalidRecord()
  if (typeof payload.text !== "string" || typeof payload.createdAt !== "string") return invalidRecord()
  if (record.signed.signerKeyId !== payload.deviceId) return invalidRecord()
}

function validatePayloadTimestamp(payload: ChatPayload): void {
  if (!Number.isFinite(Date.parse(payload.createdAt))) return invalidRecord()
  if (new Date(payload.createdAt).toISOString() !== payload.createdAt) return invalidRecord()
  if (Date.parse(payload.createdAt) > Date.now() + 300_000) return invalidRecord()
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 0) return invalidRecord()
}

function validateRecordShape(record: ChatRecord, workspaceId: string): ChatPayload {
  const payload = record?.signed?.payload
  if (!payload || ![1, 2].includes(payload.version)) return invalidRecord()
  if (payload.version === 1 && payload.context !== undefined) return invalidRecord()
  if (payload.version === 2) {
    if (payload.kind !== "chat-message") return invalidRecord()
    validateMessageContext(payload.context, workspaceId, payload.id)
  }
  validatePayloadIdentity(record, payload, workspaceId)
  validatePayloadTimestamp(payload)
  return payload
}

function validatePayloadText(payload: ChatPayload): void {
  if (payload.kind === "chat-profile") {
    if (validateDisplayName(payload.text) || normalizeDisplayName(payload.text) !== payload.text) {
      invalidRecord("Invalid display name")
    }
    return
  }
  if (payload.kind === "chat-typing") {
    if (!["typing", "idle"].includes(payload.text)) invalidRecord("Invalid typing presence")
    return
  }
  if (!payload.text.trim() || [...payload.text].length > 8000) {
    invalidRecord("Message must contain 1–8,000 characters")
  }
}

function workspaceOwners(
  storedAuthority: Awaited<ReturnType<typeof peerStore.getWorkspaceAuthority>>,
  ownerPersonId: string,
  recordAuthority: ChatAuthority,
): WorkspaceAuthority[] {
  if (!storedAuthority) return [{ personId: ownerPersonId, publicKey: recordAuthority.publicKey, certificates: recordAuthority.certificates }]
  return [{
    personId: storedAuthority.ownerPersonId,
    publicKey: storedAuthority.ownerPublicKey,
    certificates: storedAuthority.ownerCertificates as DeviceCertificate[],
  }, ...((storedAuthority.ownerHistory ?? []) as WorkspaceAuthority[])]
}

async function storedWorkspaceAuthority(grantWorkspaceId: string) {
  if (typeof indexedDB === "undefined") return null
  return await peerStore.getWorkspaceCredential(grantWorkspaceId) ?? peerStore.getWorkspaceAuthority(grantWorkspaceId)
}

function isCurrentOwner(
  payload: ChatPayload,
  signingOwner: WorkspaceAuthority,
  storedAuthority: Awaited<ReturnType<typeof storedWorkspaceAuthority>>,
  ownerPersonId: string,
  recordAuthority: ChatAuthority,
): boolean {
  const currentOwnerId = storedAuthority?.ownerPersonId ?? ownerPersonId
  return payload.personId === currentOwnerId && signingOwner.personId === currentOwnerId && !recordAuthority.grant
}

async function assertGrantPermission(
  payload: ChatPayload,
  grantWorkspaceId: string,
  grant: WorkspaceGrant | undefined,
  owners: WorkspaceAuthority[],
  recordAuthority: ChatAuthority,
): Promise<void> {
  const revoked = typeof indexedDB !== "undefined" &&
    (await peerStore.listPeers(grantWorkspaceId)).some(peer => peer.personId === payload.personId && peer.revokedAt)
  if (revoked) invalidRecord("Workspace access revoked")
  if (!grant && owners.slice(1).some(owner => owner.personId === payload.personId)) return
  if (!grant || grant.payload.kind !== "workspace-grant" || grant.payload.version !== 1) {
    invalidRecord("No permission to write to this chat")
  }
  if (grant.payload.personId !== payload.personId || grant.payload.workspaceId !== grantWorkspaceId) {
    invalidRecord("No permission to write to this chat")
  }
  const capability = payload.kind === "chat-profile" ? "chat.profile" : "chat.write"
  if (!canWorkspace(grant.payload.role, capability)) invalidRecord("No permission to write to this chat")
  for (const owner of owners) {
    const certificates = owner.publicKey === recordAuthority.publicKey
      ? [...new Map([...owner.certificates, ...recordAuthority.certificates].map(cert => [cert.signature, cert])).values()]
      : owner.certificates
    if (await grantSignedBy(grant, { ...owner, certificates })) return
  }
  invalidRecord("Invalid workspace grant")
}

export async function verifyChatRecord(value: unknown, workspaceId: string, ownerPersonId: string, grantWorkspaceId = workspaceId): Promise<ChatRecord> {
  const record = await verifyChatRecordSignature(value, workspaceId)
  const payload = record.signed.payload
  const recordAuthority = record.authority
  if (!recordAuthority) throw new Error("Invalid workspace authority")
  const storedAuthority = await storedWorkspaceAuthority(grantWorkspaceId)
  const owners = workspaceOwners(storedAuthority, ownerPersonId, recordAuthority)
  const authorityPersonId = await keyId(recordAuthority.publicKey)
  const signingOwner = owners.find(owner => owner.personId === authorityPersonId && owner.publicKey === recordAuthority.publicKey)
  if (!signingOwner) throw new Error("Invalid workspace authority")
  const actsAsCurrentOwner = isCurrentOwner(payload, signingOwner, storedAuthority, ownerPersonId, recordAuthority)
  if (!actsAsCurrentOwner) await assertGrantPermission(payload, grantWorkspaceId, recordAuthority.grant, owners, recordAuthority)
  return record
}

function detachedChatRecord(value: unknown): ChatRecord {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return invalidRecord()
  }
  if (typeof serialized !== "string") return invalidRecord()
  if (new TextEncoder().encode(serialized).byteLength > 32768) throw new Error("Chat record too large")
  try {
    return JSON.parse(serialized) as ChatRecord
  } catch {
    return invalidRecord()
  }
}

export async function verifyChatRecordSignature(value: unknown, workspaceId: string): Promise<ChatRecord> {
  const record = detachedChatRecord(value)
  const payload = validateRecordShape(record, workspaceId)
  validatePayloadText(payload)
  const key = await verifyDeviceChain({
    personId: payload.personId,
    publicKey: record.publicKey,
    deviceId: payload.deviceId,
    certificates: record.certificates,
  })
  if (!await verifyEnvelope(record.signed, key)) throw new Error("Invalid message signature")
  return record
}
