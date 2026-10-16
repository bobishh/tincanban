import { publicKeyId, verifyEnvelope, type SignedEnvelope } from "./identityCrypto"
import { validateCertificateChain } from "./proofValidation"
import type { DeviceCertificate } from "./model"
import { parseAutomationDefinition, type AutomationDefinition } from "./automationContract"

export async function verifyAutomationDefinition(
  signed: SignedEnvelope<AutomationDefinition>,
  expected: { workspaceId: string; boardId: string; grantId: string; signerKeyId: string },
  owner: { personId: string; publicKey: string; certificates: DeviceCertificate[] },
): Promise<AutomationDefinition> {
  const definition = parseAutomationDefinition(signed?.payload)
  if (definition.scope.workspaceId !== expected.workspaceId || definition.scope.boardId !== expected.boardId
    || definition.scope.grantId !== expected.grantId || signed.signerKeyId !== expected.signerKeyId) {
    throw new Error("Automation definition does not match its signed grant scope")
  }
  if (await publicKeyId(owner.publicKey) !== owner.personId) throw new Error("Automation owner key is invalid")
  const certificate = owner.certificates.find(value => value.payload.deviceId === signed.signerKeyId)
  let publicKey = owner.publicKey
  if (signed.signerKeyId !== owner.personId) {
    if (!certificate || certificate.payload.personId !== owner.personId
      || !(await validateCertificateChain(certificate, owner.publicKey, owner.certificates)).ok) {
      throw new Error("Automation definition signer is not an authorized owner device")
    }
    publicKey = certificate.payload.devicePublicKey
  }
  if (!(await verifyEnvelope(signed, publicKey))) throw new Error("Automation definition signature is invalid")
  return definition
}
