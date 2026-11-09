/* global __TINCANBAN_BUILD_COMMIT__ */
import { canonicalizeJson, sha256Base64Url } from "../domain/identity"

/** Local commit metadata. Never accept this marker from a peer or import. */
export type WorkspaceAdmissionCheckpoint = {
  policy: string
  inputHash: string
  projectionHeads: string[]
  decisionsHash: string
  /** Integrity chain stored only in the local delta journal. */
  incremental?: true
}

export function admissionPolicy() {
  return typeof __TINCANBAN_BUILD_COMMIT__ === "undefined" ? "test" : __TINCANBAN_BUILD_COMMIT__
}

async function jsonHash(value: unknown) {
  return sha256Base64Url(new TextEncoder().encode(canonicalizeJson(value)))
}

export async function admissionInputHash(bytes: Uint8Array, context: unknown): Promise<string> {
  return jsonHash({ rawHash: await sha256Base64Url(bytes), context })
}

export async function createAdmissionCheckpoint(inputHash: string, heads: string[], decisions: unknown): Promise<WorkspaceAdmissionCheckpoint> {
  return { policy: admissionPolicy(), inputHash, projectionHeads: [...heads].sort(), decisionsHash: await jsonHash(decisions) }
}

/** A repeat may omit stored proofs. An additional proof may change the classification. */
export function hasOnlyStoredAdmissionProofs(incoming: unknown[], stored: readonly unknown[]): boolean {
  const verified = new Set(stored.map(proofIdentity))
  return incoming.every(proof => verified.has(proofIdentity(proof)))
}

function proofIdentity(record: unknown): string {
  const value = record as { signed?: unknown; publicKey?: unknown; certificates?: unknown; grant?: unknown }
  return canonicalizeJson({ signed: value.signed ?? null, publicKey: value.publicKey ?? null,
    certificates: value.certificates ?? null, grant: value.grant ?? null })
}

export async function matchesAdmissionCheckpoint(checkpoint: WorkspaceAdmissionCheckpoint | undefined,
  inputHash: string, heads: string[], decisions: unknown): Promise<boolean> {
  return Boolean(checkpoint && checkpoint.policy === admissionPolicy() && checkpoint.inputHash === inputHash &&
    checkpoint.projectionHeads.join() === [...heads].sort().join() && checkpoint.decisionsHash === await jsonHash(decisions))
}
