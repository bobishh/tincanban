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

export async function matchesAdmissionCheckpoint(checkpoint: WorkspaceAdmissionCheckpoint | undefined,
  inputHash: string, heads: string[], decisions: unknown): Promise<boolean> {
  return Boolean(checkpoint && checkpoint.policy === admissionPolicy() && checkpoint.inputHash === inputHash &&
    checkpoint.projectionHeads.join() === [...heads].sort().join() && checkpoint.decisionsHash === await jsonHash(decisions))
}
