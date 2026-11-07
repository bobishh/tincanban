import { profileFromIdentitySeedForDevice, signEnvelope, type LocalProfile } from "@meta-uber/mesh-identity"
import { createChatRecordFixture } from "../chat/records.testSupport"

/** Signed peer messages for isolated browser admission checks. No fixture identity is used outside tests. */
export async function automationChatFixture(owner: LocalProfile, workspaceId: string, boardId: string,
  columns: { lead: string; interview: string; rejected: string }) {
  const actor = await profileFromIdentitySeedForDevice(crypto.getRandomValues(new Uint8Array(32)), "Automation",
    crypto.getRandomValues(new Uint8Array(32)))
  const grant = await signEnvelope(owner.privateKeys.devicePrivateKey, { kind: "workspace-grant" as const, version: 1 as const,
    workspaceId, grantId: crypto.randomUUID(), personId: actor.identity.personId, role: "automation" as const, accessEpoch: 1,
    automation: { version: 2 as const, boardId, columns, fieldIds: [], expiresAt: Date.now() + 60_000 } }, owner.device.deviceId)
  const valid = await createChatRecordFixture(actor, [actor.certificate], { publicKey: owner.identity.publicKey,
    certificates: [owner.certificate], grant }, `${owner.identity.personId}:${boardId}`, "chat-message", "Verified automated summary")
  const forged = structuredClone(valid)
  forged.signed.payload.id += ":forged"
  forged.signed.payload.text = "Forged automated summary"
  return { valid, forged }
}
