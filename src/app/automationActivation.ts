import type { useTincanban } from "../state"
import * as Automerge from "@automerge/automerge/slim"
import type { BlindReplicaConfig } from "./blindReplication"
import type { AutomationWorkerIdentity, AutomationConfiguration } from "./automation"
import { automationEntityId } from "../domain/automationLifecycle"
import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { defaultProofStore } from "../domain/proofs"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { exportAuthorizationBundle, workspaceRole, localWorkspaceAdmissionAuthority } from "../sync/changeAuthorization"
import { encodeBlindBytes } from "../sync/blindEnvelope"
import { assertWorkspaceReplicaPurpose } from "../sync/replicaPurpose"
import { withLocalStateWriteLock } from "../localStateLock"
import { assertReplicaCredentialsUnfrozen, replicaCredentialFreezeKey } from "../sync/replicaCredentialFreeze"
import { privateReplicaBinding } from "../sync/privateReplicaBinding"

export async function exportApprovedAutomation(tincanban: ReturnType<typeof useTincanban>, config: BlindReplicaConfig, workerIdentity: string, configuration?: AutomationConfiguration) {
  config = JSON.parse(canonicalizeJson(config)) as BlindReplicaConfig
  configuration = configuration === undefined ? undefined : JSON.parse(canonicalizeJson(configuration)) as AutomationConfiguration
  assertWorkspaceReplicaPurpose(config)
  const { prepareAutomationActivation } = await import("../app/automation")
  const profile = tincanban.getCurrentProfile()
  if (!profile) throw new Error("Identity unavailable")
  const transitionKey = await replicaCredentialFreezeKey(profile.identity.personId, config.origin)
  return withLocalStateWriteLock(transitionKey, async () => {
  const ensureCurrent = async () => {
    const current = tincanban.getCurrentProfile()
    if (!current || current.identity.personId !== profile.identity.personId || current.device.deviceId !== profile.device.deviceId ||
      current.certificate.signature !== profile.certificate.signature || tincanban.getActiveDoc()?.id !== config.workspaceId) {
      throw new Error("Owner device or workspace changed during automation approval")
    }
    await assertReplicaCredentialsUnfrozen(profile.identity.personId, config)
    const after = tincanban.getCurrentProfile()
    if (!after || after.identity.personId !== profile.identity.personId || after.device.deviceId !== profile.device.deviceId ||
      after.certificate.signature !== profile.certificate.signature || tincanban.getActiveDoc()?.id !== config.workspaceId) {
      throw new Error("Owner device or workspace changed during automation approval")
    }
  }
  const writerConfig = await readCurrentWriterConfig(tincanban, config, profile, ensureCurrent)
  config = writerConfig
  await ensureCurrent()
  const doc = await tincanban.readWorkspaceDoc(config.workspaceId)
  const capturedHeads = Automerge.getHeads(doc).sort().join(",")
  const activeWorkspaceMatches = () => {
    const active = tincanban.getActiveDoc()
    return Boolean(active && active.id === doc.id && Automerge.getHeads(active).sort().join(",") === capturedHeads)
  }
  const currentAuthority = async () => {
    await ensureCurrent()
    if (!activeWorkspaceMatches()) throw new Error("Workspace changed during automation approval")
    if (await workspaceRole(doc, profile) !== "owner") throw new Error("Only the current workspace owner can approve automation")
    await ensureCurrent()
    if (!activeWorkspaceMatches()) throw new Error("Workspace changed during automation approval")
    const evidence = await localWorkspaceAdmissionAuthority(doc, profile)
    await ensureCurrent()
    if (!activeWorkspaceMatches() || evidence.authority.currentOwner.personId !== profile.identity.personId) {
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
  const worker = JSON.parse(workerIdentity) as AutomationWorkerIdentity
  if (config.historicalContentKeyVariants || packet.blind.historicalContentKeyVariants) {
    const { assertAutomationKeyHistorySupported } = await import("./automationInstanceClient")
    await assertAutomationKeyHistorySupported(worker.origin)
    await ensureCurrent()
  }
  const id = automationEntityId(packet.definition.payload.id)
  if (!doc.entities[id]) {
    if (tincanban.getActiveDoc()?.id !== config.workspaceId) throw new Error("Open the automation workspace before approval")
    await ensureCurrent()
    await tincanban.executeCommandAsync({ kind: "createAutomation", definition: packet.definition.payload,
      approval: JSON.stringify({ definition: packet.definition, grant: packet.grant }), executor: { origin: worker.origin, personId: worker.personId } })
    await ensureCurrent()
  }
  else if (configuration) {
    await ensureCurrent()
    await tincanban.executeCommandAsync({ kind: "configureAutomation", definition: packet.definition.payload,
      approval: JSON.stringify({ definition: packet.definition, grant: packet.grant }) })
    await ensureCurrent()
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
  })
}

async function readCurrentWriterConfig(tincanban: ReturnType<typeof useTincanban>, requested: BlindReplicaConfig,
  profile: LocalProfile, ensureCurrent: () => Promise<void>): Promise<BlindReplicaConfig> {
  const [{ getReplicaConfigurations }, { ensureWorkspaceReplicaWriter }] = await Promise.all([
    import("../sync/privateReplicaRepository"), import("../sync/workspaceReplicaWriter"),
  ])
  await ensureCurrent()
  const configs = await getReplicaConfigurations(profile.identity.personId)
  await ensureCurrent()
  const saved = configs.find(value => value.origin === requested.origin &&
    value.scopeId === requested.scopeId && value.workspaceId === requested.workspaceId && !value.removalPending)
  if (!saved || saved.servicePublicKey !== requested.servicePublicKey) throw new Error("Current Rusty workspace access is unavailable")
  const ensureIdentity = () => {
    const current = tincanban.getCurrentProfile()
    if (!current || current.identity.personId !== profile.identity.personId || current.identity.publicKey !== profile.identity.publicKey ||
      current.device.deviceId !== profile.device.deviceId || current.device.publicKey !== profile.device.publicKey ||
      current.certificate.signature !== profile.certificate.signature || tincanban.getActiveDoc()?.id !== requested.workspaceId) {
      throw new Error("Owner device or workspace changed during Rusty policy refresh")
    }
  }
  await assertReplicaCredentialsUnfrozen(profile.identity.personId, saved)
  ensureIdentity()
  const confirmed = await ensureWorkspaceReplicaWriter(tincanban, saved, ensureIdentity)
  await ensureCurrent()
  const refreshed = (await getReplicaConfigurations(profile.identity.personId)).find(value => value.origin === saved.origin &&
    value.scopeId === saved.scopeId && value.workspaceId === saved.workspaceId)
  await ensureCurrent()
  if (!refreshed || refreshed.removalPending || refreshed.minimumWriterVersion !== confirmed.minimumWriterVersion ||
    privateReplicaBinding(profile.identity.personId, refreshed) !== privateReplicaBinding(profile.identity.personId, confirmed)) {
    throw new Error("Rusty workspace policy changed during automation approval; retry with refreshed access")
  }
  await assertReplicaCredentialsUnfrozen(profile.identity.personId, refreshed)
  return refreshed
}
