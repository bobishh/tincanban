import * as Automerge from "@automerge/automerge/slim"
import { canonicalizeJson } from "../domain/identity"
import { assertLearnedIdentityDeviceActive } from "../domain/identityAuthority"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { WorkspaceAdmissionBase, WorkspaceAdmissionResult, WorkspaceChangeAuthorization } from "../product-replica"
import type { StoredCausalEvidence } from "../storageJournal"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { receivedHistoryBasisIdentity } from "../product-replica/receivedHistoryBasisIdentity"
import { authorityValidationFingerprint } from "./authorityFingerprint"
import type { IncomingWorkspaceAdmissionContext } from "./changeAuthorization"
import { meshTrace } from "./meshTrace"
import { admissionInputHash, createAdmissionCheckpoint, matchesAdmissionCheckpoint,
  type WorkspaceAdmissionCheckpoint } from "./workspaceAdmissionCheckpoint"

// Keep only the latest exact packet result in memory. Durable projection reuse
// uses the separate atomic admission checkpoint, never this network-input cache.
const recent = new Map<string, { key: string; result: WorkspaceAdmissionResult; rawBytes: Uint8Array; documentBytes: number }>()
const maxWorkspaces = 8
const maxDocumentBytes = 16 * 1024 * 1024

export function reusedWorkspaceAdmission(workspaceId: string, key: string): { result: WorkspaceAdmissionResult; rawBytes: Uint8Array } | undefined {
  const entry = recent.get(workspaceId)
  if (entry?.key !== key) return
  return { result: structuredClone(entry.result), rawBytes: entry.rawBytes.slice() }
}

export function rememberWorkspaceAdmission(workspaceId: string, key: string, result: WorkspaceAdmissionResult, rawBytes: Uint8Array): void {
  recent.delete(workspaceId)
  const documentBytes = rawBytes.byteLength + result.authorizedDocument.byteLength
  if (documentBytes > maxDocumentBytes) return
  let retainedBytes = [...recent.values()].reduce((sum, entry) => sum + entry.documentBytes, 0)
  for (const [oldest, entry] of recent) {
    if (recent.size < maxWorkspaces && retainedBytes + documentBytes <= maxDocumentBytes) break
    recent.delete(oldest)
    retainedBytes -= entry.documentBytes
  }
  recent.set(workspaceId, { key, result: structuredClone(result), rawBytes: rawBytes.slice(), documentBytes })
}

/** Open the admission saved for exactly this workspace, local revision and authority. */
export async function retainedAdmissionBase(heads: string[], evidence: StoredCausalEvidence | undefined,
  credentialFingerprint: string,
  localBase?: WorkspaceAdmissionBase & { credentialFingerprint: string }): Promise<WorkspaceAdmissionBase | undefined> {
  if (localBase && localBase.credentialFingerprint === credentialFingerprint) return localBase
  const checkpoint = evidence?.admissionCheckpoint
  const retained = checkpoint?.admittedBase
  const records = evidence?.authorizationEvidence as WorkspaceAdmissionBase["records"] | undefined
  if (!evidence || !checkpoint || !retained || checkpoint.incremental || !records?.length ||
    evidence.decisions.some(decision => decision.status.type !== "admitted")) return
  const evidenceHash = await admissionInputHash(evidence.bytes, { authorityIdentity: retained.authorityIdentity, records })
  if (evidenceHash === retained.evidenceHash &&
    await matchesAdmissionCheckpoint(checkpoint, checkpoint.inputHash, heads, evidence.decisions)) {
    return { document: evidence.bytes, decisions: evidence.decisions, records, authorityIdentity: retained.authorityIdentity }
  }
}

export async function bindAdmittedBase(checkpoint: WorkspaceAdmissionCheckpoint, bytes: Uint8Array,
  records: WorkspaceAdmissionBase["records"], authorityIdentity: string | undefined) {
  if (!authorityIdentity) return checkpoint
  const evidenceHash = await admissionInputHash(bytes, { authorityIdentity, records })
  return { ...checkpoint, admittedBase: { authorityIdentity, evidenceHash } }
}

async function incomingAdmissionCheckpoint(bytes: Uint8Array, context: unknown, plan: WorkspaceAdmissionResult) {
  if (!plan.authorizedHeads || !plan.decisions) return
  const checkpoint = await createAdmissionCheckpoint(await admissionInputHash(bytes, context), plan.authorizedHeads, plan.decisions)
  return bindAdmittedBase(checkpoint, bytes, plan.verifiedAuthorizations, plan.authorityIdentity)
}

function rawAdmissionSnapshot(local: Automerge.Doc<WorkspaceDocumentV2> | undefined, remote: Automerge.Doc<WorkspaceDocumentV2>,
  base: WorkspaceAdmissionBase | undefined, heads: string[] | null) {
  if (!local || local === remote) return Automerge.save(remote)
  // A fully admitted local document has no hidden or pending changes to merge.
  if (base && heads && Automerge.hasHeads(remote, heads)) return Automerge.save(remote)
  const merged = Automerge.merge(Automerge.clone(local), remote)
  try { return Automerge.save(merged) }
  finally { Automerge.free(merged) }
}

/** A learned Identity revocation applies to newly received commands before reusable admission results. */
async function guardNewChangesAgainstLearnedIdentityRevocations(local: Automerge.Doc<WorkspaceDocumentV2> | undefined,
  remote: Automerge.Doc<WorkspaceDocumentV2>, authorizations: WorkspaceChangeAuthorization[]) {
  const knownHashes = new Set(local ? Automerge.getChangesMetaSince(local, []).map(change => change.hash) : [])
  const incomingHashes = new Set(Automerge.getChangesMetaSince(remote, []).map(change => change.hash)
    .filter(hash => !knownHashes.has(hash)))
  const devicesByPerson = new Map<string, Set<string>>()
  for (const authorization of authorizations) {
    const { personId, deviceId, hashes } = authorization.signed.payload
    if (!hashes.some(hash => incomingHashes.has(hash))) continue
    const devices = devicesByPerson.get(personId) ?? new Set<string>()
    devices.add(deviceId)
    devicesByPerson.set(personId, devices)
  }
  const learned: Record<string, { digest: string | null; devices: string[] }> = {}
  for (const [personId, devices] of [...devicesByPerson.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    let digest: string | null = null
    for (const deviceId of [...devices].sort()) {
      const current = await assertLearnedIdentityDeviceActive(personId, deviceId)
      if (digest !== null && current !== digest) throw new Error("Identity authority changed during workspace admission")
      digest = current
    }
    learned[personId] = { digest, devices: [...devices].sort() }
  }
  return learned
}

async function assertLearnedIdentityAuthoritiesUnchanged(
  learned: Record<string, { digest: string | null; devices: string[] }>): Promise<void> {
  for (const [personId, authority] of Object.entries(learned)) {
    for (const deviceId of authority.devices) {
      const current = await assertLearnedIdentityDeviceActive(personId, deviceId)
      if (current !== authority.digest) throw new Error("Identity authority changed during workspace admission")
    }
  }
}

function traceAdmissionAuthority(workspaceId: string, credential: { epoch: number } | null,
  currentCredential: { epoch: number } | null, frozenCredential: string, startedAt: number, plan: WorkspaceAdmissionResult): void {
  const changedFields = authorityChangedFields(credential, currentCredential)
  if (authorityValidationFingerprint(currentCredential) !== frozenCredential ||
    (currentCredential && meshRustRuntime().state.hasAuthorityConflict(currentCredential))) {
    meshTrace("workspace.admission.authority-changed", { workspaceId,
      elapsedMs: Math.round(performance.now() - startedAt), changedFields,
      previousEpoch: credential?.epoch ?? null, currentEpoch: currentCredential?.epoch ?? null }, "warn")
    throw new Error("Workspace authority changed during validation. Retry synchronization.")
  }
  meshTrace(changedFields.length ? "workspace.admission.authority-refreshed" : "workspace.admission.completed", {
    workspaceId, elapsedMs: Math.round(performance.now() - startedAt), changedFields,
    admitted: plan.admittedHashes?.length ?? 0, pending: plan.pendingHashes?.length ?? 0,
    quarantined: plan.quarantinedHashes?.length ?? 0,
  })
}

function authorityChangedFields(before: object | null, after: object | null): string[] {
  const left = (before ?? {}) as Record<string, unknown>
  const right = (after ?? {}) as Record<string, unknown>
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    .filter(key => canonicalizeJson(left[key] ?? null) !== canonicalizeJson(right[key] ?? null))
}

export async function evaluateReceivedWorkspace(local: Automerge.Doc<WorkspaceDocumentV2> | undefined,
  remote: Automerge.Doc<WorkspaceDocumentV2>,
  { credential, frozenCredential, knownAuthority, combinedBundle, context }: IncomingWorkspaceAdmissionContext,
  readCredential: () => Promise<IncomingWorkspaceAdmissionContext["credential"]>,
  receivedBasis?: WasmVerifiedReceivedHistoryBaseline, storedEvidence?: StoredCausalEvidence,
  localBase?: WorkspaceAdmissionBase & { credentialFingerprint: string }) {
  const learnedIdentityAuthorities = await guardNewChangesAgainstLearnedIdentityRevocations(local, remote, combinedBundle.records)
  const startedAt = performance.now()
  meshTrace("workspace.admission.started", { workspaceId: remote.id, epoch: credential?.epoch ?? null })
  // Heads identify the exact documents. A repeated check can skip building their raw union.
  const sourceHeads = { remote: Automerge.getHeads(remote).sort(), local: local && local !== remote ? Automerge.getHeads(local).sort() : null }
  const reuseKey = canonicalizeJson({ sourceHeads, ...context, receivedBasis: receivedHistoryBasisIdentity(receivedBasis), learnedIdentityAuthorities })
  const reused = reusedWorkspaceAdmission(remote.id, reuseKey)
  const base = await retainedAdmissionBase(sourceHeads.local ?? sourceHeads.remote, storedEvidence, frozenCredential, localBase)
  const rawBytes = reused?.rawBytes ?? rawAdmissionSnapshot(local, remote, base, sourceHeads.local)
  // Causal admission uses signed change-time authority, not receiver wall time.
  const plan = reused?.result ?? await (await import("./workspaceAdmissionClient")).runWorkspaceAdmission({ workspaceId: remote.id,
    receivedBasis, remote: rawBytes.slice(), authorization: combinedBundle, knownAuthority, now: Date.now(),
    admittedBase: base,
  })
  if (reused) meshTrace("workspace.admission.reused", { workspaceId: remote.id, elapsedMs: Math.round(performance.now() - startedAt) })
  else if (plan.profile) meshTrace("workspace.admission.profile", { workspaceId: remote.id, ...plan.profile, baseAvailable: Boolean(base) })
  const admissionCheckpoint = await incomingAdmissionCheckpoint(rawBytes, context, plan)
  // Authority may change while either policy computation or hashing yields.
  const currentCredential = await readCredential()
  traceAdmissionAuthority(remote.id, credential, currentCredential, frozenCredential, startedAt, plan)
  await assertLearnedIdentityAuthoritiesUnchanged(learnedIdentityAuthorities)
  if (!reused) rememberWorkspaceAdmission(remote.id, reuseKey, plan, rawBytes)
  return { ...structuredClone(plan), rawBytes, credentialFingerprint: frozenCredential, admissionCheckpoint, authorizationEvidence: structuredClone(plan.verifiedAuthorizations) }
}
