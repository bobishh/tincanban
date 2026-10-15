import type { useTincanban } from "../state"
import type { BlindReplicaConfig } from "./blindReplication"
import type { AutomationWorkerIdentity, AutomationConfiguration } from "./automation"
import { automationEntityId } from "../domain/automationLifecycle"
import { canonicalizeJson } from "../domain/identity"
import { defaultProofStore } from "../domain/proofs"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { exportAuthorizationBundle, workspaceRole, localWorkspaceAdmissionAuthority } from "../sync/changeAuthorization"
import { encodeBlindBytes } from "../sync/blindEnvelope"
import { assertWorkspaceReplicaPurpose } from "../sync/replicaPurpose"

export async function exportApprovedAutomation(tincanban: ReturnType<typeof useTincanban>, config: BlindReplicaConfig, workerIdentity: string, configuration?: AutomationConfiguration) {
  assertWorkspaceReplicaPurpose(config)
  const { prepareAutomationActivation } = await import("../app/automation")
  const profile = tincanban.getCurrentProfile()
  if (!profile) throw new Error("Identity unavailable")
  const ensureCurrent = async () => {
    const current = tincanban.getCurrentProfile()
    if (!current || current.identity.personId !== profile.identity.personId || current.device.deviceId !== profile.device.deviceId ||
      current.certificate.signature !== profile.certificate.signature || tincanban.getActiveDoc()?.id !== config.workspaceId) {
      throw new Error("Owner device or workspace changed during automation approval")
    }
  }
  await ensureCurrent()
  const doc = await tincanban.readWorkspaceDoc(config.workspaceId)
  const currentAuthority = async () => {
    await ensureCurrent()
    if (tincanban.getActiveDoc() !== doc) throw new Error("Workspace changed during automation approval")
    if (await workspaceRole(doc, profile) !== "owner") throw new Error("Only the current workspace owner can approve automation")
    const evidence = await localWorkspaceAdmissionAuthority(doc, profile)
    await ensureCurrent()
    if (tincanban.getActiveDoc() !== doc || evidence.authority.currentOwner.personId !== profile.identity.personId) {
      throw new Error("Workspace owner authority changed during automation approval")
    }
    return canonicalizeJson([evidence.fingerprint, evidence.authority.currentEpoch])
  }
  await currentAuthority()
  const bytes = await tincanban.readWorkspaceBytes(config.workspaceId)
  const authorization = await exportAuthorizationBundle(bytes, profile)
  const packet = await prepareAutomationActivation({ profile, doc, bytes, authorization, blind: config,
    worker: JSON.parse(workerIdentity) as AutomationWorkerIdentity, configuration, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    signingContext: async (purpose, binding) => {
      const stored = await defaultProofStore.listCertificates()
      const certificates = [...authorization.authority.currentOwner.certificates,
        ...stored.filter(value => value.payload.personId === profile.identity.personId)]
      return resolveLocalSigningContext(profile, purpose, binding, {
        certificates, ensureCurrent, currentAuthority, expiresAt: Date.now() + 60_000,
      })
    } })
  await ensureCurrent()
  const id = automationEntityId(packet.definition.payload.id)
  if (!doc.entities[id]) {
    if (tincanban.getActiveDoc()?.id !== config.workspaceId) throw new Error("Open the automation workspace before approval")
    const worker = JSON.parse(workerIdentity) as AutomationWorkerIdentity
    await tincanban.executeCommandAsync({ kind: "createAutomation", definition: packet.definition.payload,
      approval: JSON.stringify({ definition: packet.definition, grant: packet.grant }), executor: { origin: worker.origin, personId: worker.personId } })
  }
  else if (configuration) {
    await tincanban.executeCommandAsync({ kind: "configureAutomation", definition: packet.definition.payload,
      approval: JSON.stringify({ definition: packet.definition, grant: packet.grant }) })
  }
  const currentBytes = await tincanban.readWorkspaceBytes(config.workspaceId)
  const latestAuthorization = await exportAuthorizationBundle(currentBytes, profile)
  const previousCertificates = packet.initial.authorization.authority.currentOwner.certificates ?? []
  if (latestAuthorization.authority.currentOwner.personId !== profile.identity.personId ||
    latestAuthorization.authority.currentEpoch !== packet.grant.payload.accessEpoch) {
    throw new Error("Workspace owner authority changed before automation export")
  }
  const certificates = new Map([...latestAuthorization.authority.currentOwner.certificates, ...previousCertificates]
    .map(certificate => [canonicalizeJson(certificate), certificate]))
  const currentAuthorization = { ...latestAuthorization, authority: { ...latestAuthorization.authority,
    currentOwner: { ...latestAuthorization.authority.currentOwner, certificates: [...certificates.values()] } } }
  packet.initial = { ...packet.initial, document: encodeBlindBytes(currentBytes), authorization: currentAuthorization }
  await ensureCurrent()
  return JSON.stringify(packet, null, 2)
}
