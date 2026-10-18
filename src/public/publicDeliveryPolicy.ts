import { canonicalizeJson, sha256Base64Url, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import { hasEntityKind, type DeviceCertificate, type WorkspaceDocumentV2, type WorkspaceGrant } from "../domain/model"
import { parseAutomationApproval } from "../domain/automationApproval"
import { automationLifecycle } from "../domain/automationLifecycle"
import { defaultProofStore, validateCertificateChain, verifyWorkspaceGrant } from "../domain/proofs"
import { signWithContext, signingEvidence } from "../domain/signingContext"
import { workspaceOwnerSigningContext } from "../sync/workspaceOwnerSigning"
import { deviceRevocations, hasLeftWorkspace, isGrantRevoked } from "../sync/durableMeshBase"
import { peerStore } from "../sync/peerStore"

type PublicBoardDeliveryPolicy = {
  kind: "rusty-public-board-delivery-policy"; version: 1; workspaceId: string; boardId: string
  generation: number; accessEpoch: number; enabled: true; acceptedGrants: WorkspaceGrant[]
  revokedGrantIds: string[]; revokedDeviceIds: string[]
}
export type PublicBoardDeliveryPolicyEvidence = {
  policy: SignedEnvelope<PublicBoardDeliveryPolicy>; ownerCertificates: DeviceCertificate[]
}
const encoder = new TextEncoder()
export function publicBoardDeliveryPolicyHash(evidence: PublicBoardDeliveryPolicyEvidence) {
  return sha256Base64Url(encoder.encode(canonicalizeJson(evidence)))
}
/** Compare policy meaning; CryptoKit can produce different Ed25519 signatures for identical input. */
export function publicBoardDeliveryPolicyContentHash(evidence: PublicBoardDeliveryPolicyEvidence) {
  return sha256Base64Url(encoder.encode(canonicalizeJson({
    policy: { payload: evidence.policy.payload, signerKeyId: evidence.policy.signerKeyId },
    ownerCertificates: evidence.ownerCertificates,
  })))
}

function assertOwnerAuthority(credential: Awaited<ReturnType<typeof peerStore.getWorkspaceCredential>>,
  authority: Awaited<ReturnType<typeof peerStore.getWorkspaceAuthority>>, profile: LocalProfile, workspaceId: string, generation: number) {
  if (!credential || !authority || credential.workspaceId !== workspaceId || authority.workspaceId !== workspaceId ||
      credential.ownerPersonId !== profile.identity.personId || credential.ownerPublicKey !== profile.identity.publicKey ||
      authority.ownerPersonId !== profile.identity.personId || authority.ownerPublicKey !== profile.identity.publicKey ||
      !Number.isSafeInteger(generation) || generation < 1) throw new Error("Current owner authority is unavailable for public delivery policy")
}

function isRevoked(credential: NonNullable<Awaited<ReturnType<typeof peerStore.getWorkspaceCredential>>>, grant: WorkspaceGrant) {
  return isGrantRevoked(credential, grant.payload.personId, grant) || hasLeftWorkspace(credential, grant.payload.personId, grant)
}

async function grantSigningKey(grant: WorkspaceGrant, credential: NonNullable<Awaited<ReturnType<typeof peerStore.getWorkspaceCredential>>>, certificates: DeviceCertificate[]) {
  if (grant.signerKeyId === credential.ownerPersonId) return credential.ownerPublicKey
  const certificate = certificates.find(item => item.payload.deviceId === grant.signerKeyId)
  if (!certificate || !(await validateCertificateChain(certificate, credential.ownerPublicKey, certificates)).ok) return undefined
  return certificate.payload.devicePublicKey
}

async function collectActiveGrants(workspaceId: string, boardId: string, grants: WorkspaceGrant[], credential: NonNullable<Awaited<ReturnType<typeof peerStore.getWorkspaceCredential>>>, certificates: DeviceCertificate[]) {
  const acceptedGrants: WorkspaceGrant[] = [], revokedGrantIds = new Set<string>()
  for (const grant of grants) {
    const disposition = grantDisposition(grant, workspaceId, boardId, credential)
    if (disposition === "revoked") { revokedGrantIds.add(grant.payload.grantId); continue }
    if (disposition === "skip") continue
    const key = await grantSigningKey(grant, credential, certificates)
    if (key && await verifyWorkspaceGrant(grant, key)) acceptedGrants.push(structuredClone(grant))
  }
  const byId = new Map<string, WorkspaceGrant>(), conflicts = new Set<string>()
  for (const grant of acceptedGrants) {
    const id = grant.payload.grantId, previous = byId.get(id)
    if (previous && canonicalizeJson(previous) !== canonicalizeJson(grant)) conflicts.add(id)
    else byId.set(id, grant)
  }
  const uniqueGrants = [...byId].filter(([id]) => !conflicts.has(id)).map(([, grant]) => grant)
  uniqueGrants.sort((left, right) => left.payload.grantId < right.payload.grantId ? -1 : left.payload.grantId > right.payload.grantId ? 1 : 0)
  if (uniqueGrants.length > 4096) throw new Error("Public delivery policy has too many active grants")
  return { acceptedGrants: uniqueGrants, revokedGrantIds: [...revokedGrantIds].sort() }
}
function grantDisposition(grant: WorkspaceGrant, workspaceId: string, boardId: string,
  credential: NonNullable<Awaited<ReturnType<typeof peerStore.getWorkspaceCredential>>>) {
  const payload = grant.payload
  if (payload.workspaceId !== workspaceId || !["editor", "automation"].includes(payload.role) || (payload.accessEpoch ?? 1) !== credential.epoch) return "skip"
  if (isRevoked(credential, grant)) return "revoked"
  if (payload.role === "automation" && (!payload.automation || payload.automation.boardId !== boardId || payload.automation.expiresAt <= Date.now())) return "skip"
  return "active"
}

function admittedAutomationGrants(document: WorkspaceDocumentV2 | undefined, workspaceId: string, boardId: string): WorkspaceGrant[] {
  if (!document) return []
  if (document.id !== workspaceId || !hasEntityKind(document.entities[boardId], "board")) throw new Error("Public delivery policy source does not match its board")
  const grants: WorkspaceGrant[] = []
  for (const entity of Object.values(document.entities)) {
    if (!hasEntityKind(entity, "automation") || entity.placement.parentId !== boardId || entity.archivedAt ||
      automationLifecycle(entity).state === "deleted") continue
    const { grant } = parseAutomationApproval(entity.approval)
    if (grant.payload.workspaceId !== workspaceId || grant.payload.automation.boardId !== boardId ||
      grant.payload.personId !== entity.executor.personId) throw new Error("Public delivery automation approval does not match its board")
    grants.push(grant)
  }
  return grants
}

/** Peer grants and admitted automation approvals share the same signature, expiry and revocation filters. */
export async function buildPublicBoardDeliveryPolicy(profile: LocalProfile, workspaceId: string, boardId: string,
  generation: number, ensureCurrent: () => void | Promise<void> = () => {}, document?: WorkspaceDocumentV2): Promise<PublicBoardDeliveryPolicyEvidence> {
  // Capture signed metadata before awaits; Automerge documents are proxy-backed.
  const automationGrants = admittedAutomationGrants(document, workspaceId, boardId)
  await ensureCurrent()
  const credential = await peerStore.getWorkspaceCredential(workspaceId)
  const authority = await peerStore.getWorkspaceAuthority(workspaceId)
  assertOwnerAuthority(credential, authority, profile, workspaceId, generation)
  if (!credential || !authority) throw new Error("Workspace credential unavailable")
  const [grants, storedCertificates] = await Promise.all([defaultProofStore.listGrants(workspaceId), defaultProofStore.listCertificates()])
  await ensureCurrent()
  const ownerCerts = await verifiedOwnerCertificates(credential.ownerPersonId, credential.ownerPublicKey,
    [...credential.ownerCertificates as DeviceCertificate[], ...authority.ownerCertificates as DeviceCertificate[],
      ...storedCertificates, profile.certificate])
  const { acceptedGrants, revokedGrantIds } = await collectActiveGrants(workspaceId, boardId, [...grants, ...automationGrants], credential, ownerCerts)
  const revokedDeviceIds = [...new Set(deviceRevocations(credential).map(item => item.record.payload.deviceId))].sort()
  const payload: PublicBoardDeliveryPolicy = { kind: "rusty-public-board-delivery-policy", version: 1, workspaceId, boardId,
    generation, accessEpoch: credential.epoch, enabled: true, acceptedGrants, revokedGrantIds, revokedDeviceIds }
  const context = await workspaceOwnerSigningContext(profile, workspaceId, "rusty-public-board-delivery-policy", { boardId, generation }, async () =>
    await peerStore.getWorkspaceAuthority(workspaceId) ?? await peerStore.getWorkspaceCredential(workspaceId))
  await ensureCurrent()
  const policy = await signWithContext(context, payload)
  await ensureCurrent()
  if (canonicalizeJson(policy.payload) !== canonicalizeJson(payload)) throw new Error("Public delivery policy signer changed its payload")
  const certificates = await verifiedOwnerCertificates(credential.ownerPersonId, credential.ownerPublicKey,
    [...ownerCerts, ...signingEvidence(context).certificates])
  return { policy, ownerCertificates: certificates.sort((left, right) => left.signature < right.signature ? -1 : left.signature > right.signature ? 1 : 0) }
}

async function verifiedOwnerCertificates(ownerPersonId: string, ownerPublicKey: string, certificates: DeviceCertificate[]) {
  const unique = [...new Map(certificates.filter(certificate => certificate.payload.personId === ownerPersonId)
    .map(certificate => [certificate.signature, certificate])).values()]
  const verified: DeviceCertificate[] = []
  for (const certificate of unique) {
    if ((await validateCertificateChain(certificate, ownerPublicKey, unique)).ok) verified.push(certificate)
  }
  return verified
}
