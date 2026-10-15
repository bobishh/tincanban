import type { LocalProfile } from "./identity"
import type { ActorBinding, ActorId, ChangeProof, Hash } from "./model"
import { signWithContext, type VerifiedSigningContext } from "./signingContext"

export async function createActorBinding(
  profile: LocalProfile,
  documentId: string,
  actorId: ActorId,
  context?: VerifiedSigningContext,
): Promise<ActorBinding> {
  const payload = {
    kind: "actor-binding" as const,
    version: 1 as const,
    personId: profile.identity.personId,
    deviceId: profile.device.deviceId,
    documentId,
    actorId,
  }
  const signer = await transactionSigner(profile, "actor-binding", { documentId, actorId }, context)
  return await signWithContext(signer, payload) as ActorBinding
}

export async function createChangeProof(
  profile: LocalProfile,
  documentId: string,
  changeHash: Hash,
  actorBindingHash: Hash,
  context?: VerifiedSigningContext,
): Promise<ChangeProof> {
  const signer = await transactionSigner(profile, "change-proof", { documentId, changeHash, actorBindingHash }, context)
  return await signWithContext(signer, {
    kind: "change-proof" as const,
    version: 1 as const,
    documentId,
    changeHash,
    actorBindingHash,
  }) as ChangeProof
}

async function transactionSigner(profile: LocalProfile, purpose: string, binding: Record<string, string | number>,
  context?: VerifiedSigningContext) {
  if (context) {
    if (context.personId !== profile.identity.personId || context.deviceId !== profile.device.deviceId) {
      throw new Error("Transaction signing context belongs to another device")
    }
    return context
  }
  const { resolveLocalSigningContext } = await import("./localSigningContext")
  return resolveLocalSigningContext(profile, purpose, binding)
}
