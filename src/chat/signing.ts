import { bootstrapIdentity, canonicalizeJson, type LocalProfile } from "../domain/identity"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { signingEvidence, signWithContext, type VerifiedSigningContext } from "../domain/signingContext"
import { canWorkspace } from "../domain/permissions"
import { defaultProofStore } from "../domain/proofs"
import type { MessageContext } from "./context"
import { chatStore } from "./store"
import { verifyChatRecord, type ChatAuthority, type ChatRecord } from "./records"
import { peerStore } from "../sync/peerStore"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"

export type ChatSigningAccess = {
  readOwner: (workspaceId: string) => Promise<string>
  readScope: (workspaceId: string) => Promise<string>
}

export async function createChatRecord(profile: LocalProfile, authority: ChatAuthority, workspaceId: string,
  kind: ChatRecord["signed"]["payload"]["kind"], text: string, revision = 0,
  context?: MessageContext, signingContext?: VerifiedSigningContext): Promise<ChatRecord> {
  if (!signingContext || signingContext.purpose !== kind || signingContext.personId !== profile.identity.personId ||
      signingContext.deviceId !== profile.device.deviceId) {
    throw new Error("Chat signing context does not match the record author")
  }
  const evidence = signingEvidence(signingContext)
  if (evidence.identity.personId !== profile.identity.personId || evidence.identity.publicKey !== profile.identity.publicKey ||
      evidence.signerKeyId !== profile.device.deviceId) throw new Error("Chat signing context does not match the record author")
  const payload: ChatRecord["signed"]["payload"] = {
    kind, version: context ? 2 : 1, ...(context ? { context } : {}), workspaceId,
    personId: profile.identity.personId, deviceId: profile.device.deviceId,
    id: `${profile.device.deviceId}:${crypto.randomUUID()}`, createdAt: new Date().toISOString(), text, revision,
  }
  const signed = await signWithContext(signingContext, payload)
  return { signed, publicKey: evidence.identity.publicKey, certificates: evidence.certificates, authority }
}

async function credentials(workspaceId: string, profile: LocalProfile, access: ChatSigningAccess): Promise<ChatAuthority> {
  const credential = typeof indexedDB === "undefined" ? null : await peerStore.getWorkspaceCredential(workspaceId)
  const authority = (typeof indexedDB === "undefined" ? null : await peerStore.getWorkspaceAuthority(workspaceId)) ?? credential
  const owner = authority?.ownerPersonId ?? await access.readOwner(workspaceId)
  const certificates = await defaultProofStore.listCertificates()
  if (owner === profile.identity.personId) return {
    publicKey: authority?.ownerPublicKey ?? profile.identity.publicKey,
    certificates: authority ? authority.ownerCertificates as DeviceCertificate[] : certificates.filter(c => c.payload.personId === owner),
  }
  const saved = await chatStore.load(await access.readScope(workspaceId))
  const source = saved.profiles.map(p => p.record as ChatRecord).find(r => r?.authority?.publicKey)
  const grant = (authority?.localGrant as WorkspaceGrant | undefined) ??
    (await defaultProofStore.listGrants(workspaceId)).find(g => g.payload.personId === profile.identity.personId)
  if (!grant) throw new Error("Connect to the workspace owner once to enable chat")
  if (authority) return { publicKey: authority.ownerPublicKey,
    certificates: authority.ownerCertificates as DeviceCertificate[], grant }
  if (!source) throw new Error("Connect to the workspace owner once to enable chat")
  return { ...source.authority, grant }
}

async function chatSigningAuthority(workspaceId: string, profile: LocalProfile, kind: ChatRecord["signed"]["payload"]["kind"],
  access: ChatSigningAccess): Promise<{ authority: ChatAuthority; scope: string; revision: string }> {
  const [scope, ownerPersonId, authority, credential, peers] = await Promise.all([
    access.readScope(workspaceId), access.readOwner(workspaceId),
    typeof indexedDB === "undefined" ? Promise.resolve(null) : peerStore.getWorkspaceAuthority(workspaceId),
    typeof indexedDB === "undefined" ? Promise.resolve(null) : peerStore.getWorkspaceCredential(workspaceId),
    typeof indexedDB === "undefined" ? Promise.resolve([]) : peerStore.listPeers(workspaceId),
  ])
  const chatAuthority = await credentials(workspaceId, profile, access)
  const grant = chatAuthority.grant
  const revoked = peers.some(peer => peer.personId === profile.identity.personId && peer.revokedAt)
  if (revoked) throw new Error("Workspace access revoked")
  if (ownerPersonId !== profile.identity.personId) {
    const capability = kind === "chat-profile" ? "chat.profile" : "chat.write"
    if (!grant || grant.payload.personId !== profile.identity.personId || grant.payload.workspaceId !== workspaceId ||
        !canWorkspace(grant.payload.role, capability)) throw new Error("No permission to write to this chat")
  }
  return {
    authority: chatAuthority,
    scope,
    revision: canonicalizeJson({ ownerPersonId, scope, authority: authority ?? credential, grant: grant ?? null,
      revoked: revoked ? profile.identity.personId : null, kind }),
  }
}

export async function createSignedChatRecord(workspaceId: string, kind: ChatRecord["signed"]["payload"]["kind"], text: string,
  access: ChatSigningAccess, revision = 0, context?: MessageContext): Promise<ChatRecord> {
  const profile = await bootstrapIdentity()
  const chain = (await defaultProofStore.listCertificates()).filter(c => c.payload.personId === profile.identity.personId)
  if (!chain.some(c => c.payload.deviceId === profile.device.deviceId)) chain.push(profile.certificate)
  const policy = await chatSigningAuthority(workspaceId, profile, kind, access)
  const signingContext = await resolveLocalSigningContext(profile, kind, { workspaceId: policy.scope }, {
    certificates: chain,
    expectedAuthority: policy.revision,
    currentAuthority: async () => (await chatSigningAuthority(workspaceId, profile, kind, access)).revision,
  })
  const record = await createChatRecord(profile, policy.authority, policy.scope, kind, text, revision, context, signingContext)
  return verifyChatRecord(record, policy.scope, await access.readOwner(workspaceId), workspaceId)
}
