import { canonicalizeJson, type SignedEnvelope } from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"

export type WorkspaceChangeAuthorization = {
  signed: SignedEnvelope<{ kind: "workspace-changes"; version: 1; workspaceId: string; hashes: string[]; personId: string; deviceId: string }>
  publicKey: string
  certificates: DeviceCertificate[]
  grant?: WorkspaceGrant
  ownerPublicKey: string
  ownerCertificates: DeviceCertificate[]
}

function canonicalChoice<T>(left: T, right: T): T {
  return canonicalizeJson(left) <= canonicalizeJson(right) ? left : right
}

function mergeCertificates(left: DeviceCertificate[] | undefined, right: DeviceCertificate[] | undefined): DeviceCertificate[] {
  const merged = new Map<string, DeviceCertificate>()
  for (const certificate of [...(left ?? []), ...(right ?? [])]) {
    const current = merged.get(certificate.signature)
    merged.set(certificate.signature, current ? canonicalChoice(current, certificate) : certificate)
  }
  return [...merged.values()].sort((a, b) => a.signature.localeCompare(b.signature))
}

function mergeRequiredText(left: string | undefined, right: string | undefined): string {
  if (!left) return right ?? ""
  if (!right) return left
  return canonicalChoice(left, right)
}

function mergeAuthorization(current: WorkspaceChangeAuthorization, incoming: WorkspaceChangeAuthorization): WorkspaceChangeAuthorization {
  return { signed: canonicalChoice(current.signed, incoming.signed), publicKey: canonicalChoice(current.publicKey, incoming.publicKey),
    certificates: mergeCertificates(current.certificates, incoming.certificates),
    ...(current.grant || incoming.grant ? { grant: current.grant && incoming.grant ? canonicalChoice(current.grant, incoming.grant) : current.grant ?? incoming.grant } : {}),
    ownerPublicKey: mergeRequiredText(current.ownerPublicKey, incoming.ownerPublicKey),
    ownerCertificates: mergeCertificates(current.ownerCertificates, incoming.ownerCertificates) }
}

function authorizationVariantKey(record: WorkspaceChangeAuthorization): string {
  return `${record.signed.signature}:${canonicalizeJson(record.grant ?? null)}`
}

export function mergeAuthorizationRecords(existing: WorkspaceChangeAuthorization[], incoming: WorkspaceChangeAuthorization[]) {
  const result = new Map<string, WorkspaceChangeAuthorization>()
  for (const record of [...existing, ...incoming]) {
    const key = authorizationVariantKey(record)
    const current = result.get(key)
    result.set(key, current ? mergeAuthorization(current, record) : {
      ...record,
      certificates: mergeCertificates([], record.certificates),
      ownerCertificates: mergeCertificates([], record.ownerCertificates),
    })
  }
  return [...result.values()].sort((left, right) => left.signed.signature.localeCompare(right.signed.signature) ||
    canonicalizeJson(left.grant ?? null).localeCompare(canonicalizeJson(right.grant ?? null)))
}
