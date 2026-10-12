import type { useTincanban } from "../state"
import type { BlindReplicaConfig } from "./blindReplication"
import type { AutomationWorkerIdentity, AutomationConfiguration } from "./automation"
import { automationEntityId } from "../domain/automationLifecycle"
import { exportAuthorizationBundle } from "../sync/changeAuthorization"
import { encodeBlindBytes } from "../sync/blindEnvelope"

export async function exportApprovedAutomation(tincanban: ReturnType<typeof useTincanban>, config: BlindReplicaConfig, workerIdentity: string, configuration?: AutomationConfiguration) {
  const { prepareAutomationActivation } = await import("../app/automation")
  const profile = tincanban.getCurrentProfile()
  if (!profile) throw new Error("Identity unavailable")
  const doc = await tincanban.readWorkspaceDoc(config.workspaceId)
  const bytes = await tincanban.readWorkspaceBytes(config.workspaceId)
  const authorization = await exportAuthorizationBundle(bytes, profile)
  const packet = await prepareAutomationActivation({ profile, doc, bytes, authorization, blind: config,
    worker: JSON.parse(workerIdentity) as AutomationWorkerIdentity, configuration, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 })
  if (tincanban.getCurrentProfile()?.identity.personId !== profile.identity.personId) throw new Error("Identity changed during automation approval")
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
  packet.initial = { ...packet.initial, document: encodeBlindBytes(currentBytes), authorization: await exportAuthorizationBundle(currentBytes, profile) }
  if (tincanban.getCurrentProfile()?.identity.personId !== profile.identity.personId) throw new Error("Identity changed during automation approval")
  return JSON.stringify(packet, null, 2)
}
