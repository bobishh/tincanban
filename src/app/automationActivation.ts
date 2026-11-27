import type { prepareAutomationActivation as prepareActivation } from "./automation"
import type { useTincanban } from "../state"
import * as Automerge from "@automerge/automerge/slim"
import type { BlindReplicaConfig } from "./blindReplication"
import type { AutomationWorkerIdentity, AutomationConfiguration } from "./automation"
import { automationEntityId, automationLifecycle } from "../domain/automationLifecycle"
import { isLegacyAutomationGrant, parseAutomationApproval, type LegacyAutomationGrant } from "../domain/automationApproval"
import { hasEntityKind, type WorkspaceDocumentV2 } from "../domain/model"
import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { defaultProofStore } from "../domain/proofs"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { exportAuthorizationBundle, workspaceRole, localWorkspaceAdmissionAuthority } from "../sync/changeAuthorization"
import { encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { assertWorkspaceReplicaPurpose } from "../sync/replicaPurpose"
import { withLocalStateWriteLock } from "../localStateLock"
import { assertReplicaCredentialsUnfrozen, replicaCredentialFreezeKey } from "../sync/replicaCredentialFreeze"
import { privateReplicaBinding } from "../sync/privateReplicaBinding"

type ApprovedGrant = LegacyAutomationGrant
type RenewalBinding = {
  grant: ReturnType<typeof parseAutomationApproval>["grant"]
  storage: Pick<BlindReplicaConfig, "origin" | "scopeId" | "keyEpoch" | "servicePublicKey">
}

/** Use one configured writer for this board; no keys or bootstrap enter the navigation handoff. */
export async function exportAutomationConnectionPacket(tincanban: ReturnType<typeof useTincanban>,
  identity: AutomationWorkerIdentity, workspaceId: string, expectedFingerprint: string, configuration: AutomationConfiguration,
  renewal?: RenewalBinding): Promise<string> {
  const { automationBoardDescription } = await import("./automation")
  const { getReplicaConfigurations } = await import("../sync/privateReplicaRepository")
  const profile = tincanban.getCurrentProfile()
  if (!profile || tincanban.getActiveDoc()?.id !== workspaceId) throw new Error("Open the selected board before approving automation")
  const doc = await tincanban.readWorkspaceDoc(workspaceId)
  if (automationBoardDescription(doc, configuration).fingerprint !== expectedFingerprint) throw new Error("Board automation settings changed. Review the updated access before approving.")
  const configs = (await getReplicaConfigurations(profile.identity.personId))
    .filter(config => config.workspaceId === workspaceId && !config.removalPending && Boolean(config.writeToken))
    .filter(config => !renewal || sameRenewalStorage(config, renewal.storage))
    .sort((left, right) => left.origin.localeCompare(right.origin))
  if (!configs[0]) throw new Error("Connect Rusty for this board in Sync, then retry this connection.")
  return exportApprovedAutomation(tincanban, configs[0], JSON.stringify(identity), configuration, renewal, true)
}

export async function exportApprovedAutomation(tincanban: ReturnType<typeof useTincanban>, config: BlindReplicaConfig, workerIdentity: string, configuration?: AutomationConfiguration, renewal?: RenewalBinding, standing = false) {
  config = JSON.parse(canonicalizeJson(config)) as BlindReplicaConfig
  configuration = configuration === undefined ? undefined : JSON.parse(canonicalizeJson(configuration)) as AutomationConfiguration
  assertWorkspaceReplicaPurpose(config)
  const { prepareAutomationActivation } = await import("../app/automation")
  const profile = tincanban.getCurrentProfile()
  if (!profile) throw new Error("Identity unavailable")
  const transitionKey = await replicaCredentialFreezeKey(profile.identity.personId, config.origin)
  return withLocalStateWriteLock(transitionKey, async () => {
  const verifyOwnerDevice = () => {
    const current = tincanban.getCurrentProfile()
    if (!current || current.identity.personId !== profile.identity.personId || current.device.deviceId !== profile.device.deviceId ||
      current.certificate.signature !== profile.certificate.signature || tincanban.getActiveDoc()?.id !== config.workspaceId) {
      throw new Error("Owner device or workspace changed during automation approval")
    }
  }
  const ensureCurrent = async () => {
    verifyOwnerDevice()
    await assertReplicaCredentialsUnfrozen(profile.identity.personId, config)
    verifyOwnerDevice()
  }
  const writerConfig = await readCurrentWriterConfig(tincanban, config, profile, ensureCurrent)
  config = writerConfig
  await ensureCurrent()
  const doc = await tincanban.readWorkspaceDoc(config.workspaceId)
  const worker = JSON.parse(workerIdentity) as AutomationWorkerIdentity
  if (renewal) requireRenewalBinding(doc, worker.definitionId, config, renewal)
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
  const service = standing ? await import("./automationServiceAccess") : undefined
  const serviceIssuerKeyId = await service?.automationCredentialIssuer(config)
  if (service) assertNoOtherLegacyAutomation(doc, worker)
  const packet = await prepareAutomationActivation({ profile, doc, bytes, authorization, blind: config,
    worker, configuration, serviceIssuerKeyId, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    signingContext: async (purpose, binding) => {
      const stored = await defaultProofStore.listCertificates()
      const certificates = [...authorization.authority.currentOwner.certificates,
        ...stored.filter(value => value.payload.personId === profile.identity.personId)]
      return resolveLocalSigningContext(profile, purpose, binding, {
        certificates, ensureCurrent, currentAuthority, expiresAt: Date.now() + 60_000,
      })
    } })
  await ensureCurrent()
  if (renewal && !standing) requireLegacyRenewal(renewal, packet.grant)
  if (config.historicalContentKeyVariants || packet.blind.historicalContentKeyVariants) {
    const { assertAutomationKeyHistorySupported } = await import("./automationInstanceClient")
    await assertAutomationKeyHistorySupported(worker.origin)
    await ensureCurrent()
  }
  packet.initial = await recordBoardApproval(tincanban, doc, packet, profile, worker, Boolean(configuration || standing), ensureCurrent)
  await ensureCurrent()
  if (!service) return JSON.stringify(packet, null, 2)
  const scopeAuthoritySnapshot = await service.readServiceScopeAuthority(profile, config, ensureCurrent)
  return JSON.stringify({ ...packet, blind: { ...packet.blind, readToken: "", writeToken: "" },
    initial: { ...packet.initial, scopeAuthoritySnapshot } }, null, 2)
  })
}

function assertNoOtherLegacyAutomation(doc: WorkspaceDocumentV2, worker: AutomationWorkerIdentity) {
  const own = automationEntityId(worker.definitionId ?? worker.integrationId ?? worker.personId)
  if (Object.values(doc.entities).some(entity => hasEntityKind(entity, "automation") && entity.id !== own &&
    automationLifecycle(entity).state !== "deleted" && isLegacyAutomationGrant(parseAutomationApproval(entity.approval).grant))) {
    throw new Error("Another automation on this board still uses expiring access. Review its access before continuing.")
  }
}

type ActivationPacket = Awaited<ReturnType<typeof prepareActivation<Awaited<ReturnType<typeof exportAuthorizationBundle>>, BlindReplicaConfig>>>

async function recordBoardApproval(tincanban: ReturnType<typeof useTincanban>, doc: WorkspaceDocumentV2,
  packet: ActivationPacket, profile: LocalProfile, worker: AutomationWorkerIdentity, replaceExisting: boolean, ensureCurrent: () => Promise<void>) {
  const id = automationEntityId(packet.definition.payload.id)
  const existing = doc.entities[id]
  const approval = JSON.stringify({ definition: packet.definition, grant: packet.grant })
  if (!existing) {
    if (tincanban.getActiveDoc()?.id !== packet.workspaceId) throw new Error("Open the automation workspace before approval")
    await ensureCurrent()
    await tincanban.executeCommandAsync({ kind: "createAutomation", definition: packet.definition.payload,
      approval, executor: { origin: worker.origin, personId: worker.personId } })
    await ensureCurrent()
  }
  else if (replaceExisting && hasEntityKind(existing, "automation") &&
    canonicalizeJson(JSON.parse(existing.approval)) !== canonicalizeJson(JSON.parse(approval))) {
    await ensureCurrent()
    await tincanban.executeCommandAsync({ kind: "configureAutomation", definition: packet.definition.payload,
      approval })
    await ensureCurrent()
  }
  const currentBytes = await tincanban.readWorkspaceBytes(packet.workspaceId)
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
  return { ...packet.initial, document: encodeBlindBytes(currentBytes), authorization: currentAuthorization }
}

function requireLegacyRenewal(renewal: RenewalBinding, grant: ActivationPacket["grant"]) {
  if (!isLegacyAutomationGrant(renewal.grant)) throw new Error("This automation already has standing access")
  const scope = grant.payload.automation
  if (!scope || !("expiresAt" in scope)) throw new Error("This approval has no expiration to extend")
  requireRenewedScope(renewal.grant.payload.automation, scope)
}

export async function registerConnectionServiceAccess(tincanban: ReturnType<typeof useTincanban>,
  identity: AutomationWorkerIdentity, value: unknown, ensureIdentity: () => void) {
  const packet = value as { workspaceId: string; definition: unknown; grant: unknown; blind: BlindReplicaConfig;
    initial: { scopeAuthoritySnapshot: unknown } }
  const { definition, grant } = parseAutomationApproval(JSON.stringify({ definition: packet.definition, grant: packet.grant }))
  const profile = tincanban.getCurrentProfile()
  if (!profile || isLegacyAutomationGrant(grant) || grant.payload.personId !== identity.personId ||
    packet.workspaceId !== grant.payload.workspaceId || packet.blind.workspaceId !== packet.workspaceId ||
    packet.blind.readToken !== "" || packet.blind.writeToken !== "") throw new Error("Retained service approval is invalid")
  const ensureCurrent = async () => {
    ensureIdentity()
    const doc = await tincanban.readWorkspaceDoc(packet.workspaceId)
    const entity = doc.entities[automationEntityId(definition.payload.id)]
    if (!hasEntityKind(entity, "automation") || automationLifecycle(entity).state === "deleted" ||
      entity.executor.personId !== identity.personId || entity.executor.origin !== identity.origin ||
      canonicalizeJson(parseAutomationApproval(entity.approval)) !== canonicalizeJson({ definition, grant }) ||
      await workspaceRole(doc, profile) !== "owner") throw new Error("Workspace approval changed before registering service access")
    ensureIdentity()
  }
  const { registerAutomationServiceAccess } = await import("./automationServiceAccess")
  await registerAutomationServiceAccess(profile, packet.blind, identity, grant, packet.initial.scopeAuthoritySnapshot, ensureCurrent)
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

function sameRenewalStorage(config: BlindReplicaConfig, expected: RenewalBinding["storage"]): boolean {
  return config.origin === expected.origin && config.scopeId === expected.scopeId &&
    config.keyEpoch === expected.keyEpoch && config.servicePublicKey === expected.servicePublicKey
}

function requireRenewalBinding(doc: WorkspaceDocumentV2, definitionId: string | undefined, config: BlindReplicaConfig, renewal: RenewalBinding) {
  const current = doc.entities[automationEntityId(definitionId ?? "")]
  if (!hasEntityKind(current, "automation") || !sameRenewalStorage(config, renewal.storage) ||
      canonicalizeJson(parseAutomationApproval(current.approval).grant) !== canonicalizeJson(renewal.grant)) {
    throw new Error("The existing automation or its storage changed. Review the access again.")
  }
}

function requireRenewedScope(previous: ApprovedGrant["payload"]["automation"], next: ApprovedGrant["payload"]["automation"]) {
  const { expiresAt: previousExpiry, ...previousScope } = previous
  const { expiresAt: nextExpiry, ...nextScope } = next
  if (nextExpiry <= previousExpiry || canonicalizeJson(previousScope) !== canonicalizeJson(nextScope)) {
    throw new Error("The board no longer has the same automation permissions. Review the changed access first.")
  }
}
