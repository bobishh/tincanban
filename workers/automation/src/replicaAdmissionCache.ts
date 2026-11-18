import { canonicalizeJson, sha256Base64Url, signEnvelope, verifyEnvelope, type SignedEnvelope } from "../../../src/domain/identityCrypto";
import type { LocalProfile } from "../../../src/domain/identity";
import type { WorkspaceAdmissionResult } from "../../../src/product-replica";

declare const __TINCANBAN_BUILD_COMMIT__: string;

type Classification = Pick<WorkspaceAdmissionResult, "decisions">;
export type ReplicaAdmissionCache = SignedEnvelope<{ kind: "automation-admission-checkpoint"; version: 1;
  inputHash: string; classification: Classification }>;

/** No unversioned build may reuse classifications persisted by other code. */
function policy(nativePolicy: string): string | undefined {
  return typeof __TINCANBAN_BUILD_COMMIT__ === "undefined" ? undefined : `${nativePolicy}:${__TINCANBAN_BUILD_COMMIT__}`;
}

async function inputHash(nativePolicy: string, evidence: unknown) {
  const revision = policy(nativePolicy);
  return revision && sha256Base64Url(new TextEncoder().encode(canonicalizeJson({
    purpose: "local-automation-admission", policy: revision, evidence,
  })));
}

export async function sealReplicaAdmission(nativePolicy: string, profile: LocalProfile, evidence: unknown,
  admission: WorkspaceAdmissionResult): Promise<ReplicaAdmissionCache | undefined> {
  const hash = await inputHash(nativePolicy, evidence);
  if (!hash || admission.pendingHashes.length || admission.quarantinedHashes.length) return undefined;
  const classification = { decisions: admission.decisions };
  return signEnvelope(profile.privateKeys.devicePrivateKey, { kind: "automation-admission-checkpoint", version: 1,
    inputHash: hash, classification }, profile.device.deviceId);
}

/** A peer-supplied marker cannot substitute for a locally sealed classification. */
export async function openReplicaAdmission(nativePolicy: string, profile: LocalProfile, evidence: unknown,
  cache: ReplicaAdmissionCache | undefined): Promise<Classification | undefined> {
  if (!cache || cache.payload?.kind !== "automation-admission-checkpoint" || cache.payload.version !== 1 ||
    cache.signerKeyId !== profile.device.deviceId) return undefined;
  const hash = await inputHash(nativePolicy, evidence);
  if (!hash || hash !== cache.payload.inputHash || !Array.isArray(cache.payload.classification?.decisions) ||
    cache.payload.classification.decisions.some(decision => !decision || typeof decision.hash !== "string" || decision.status?.type !== "admitted")) return undefined;
  return await verifyEnvelope(cache, profile.device.publicKey) ? cache.payload.classification : undefined;
}
