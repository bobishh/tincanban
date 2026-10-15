import type { useTincanban } from "../state"
import type { BlindReplicaConfig } from "./blindReplication"
import { canonicalizeJson } from "../domain/identity"
import { assertSigningContextCurrent } from "../domain/signingContext"
import { withLocalStateWriteLock } from "../localStateLock"
import { parseReplicaConfig } from "./blindReplicaConfig"
import { discoverBlindKeeper } from "./blindClient"
import { authorityValidationFingerprint, readWorkspaceSigningAuthority, workspaceRole } from "./changeAuthorization"
import { identityDevicePreferencesChanged } from "./identityDevicePreferenceEvents"
import { createWorkspaceAttachmentIndex } from "./attachmentIndexScope"
import { captureReplicaWriterWorkers, completeReplicaWriterUpgrade, confirmReplicaWriterUpgrade,
  getPrivateReplicaProgress, getReplicaConfigurations, prepareReplicaWriterUpgrade,
  privateReplicaBinding, readReplicaWriterUpgrade } from "./privateReplicaRepository"
import { approveRustyScope } from "./rustyEnrollment"
import { verifyRustyWriterPolicyReceipt } from "./rustyScopePolicy"
import { workspaceSigningContext } from "./workspaceSigning"
import { discoverWorkspaceReplicaWorkers, refreshWorkspaceReplicaWorkers } from "./workspaceReplicaWorkers"
import type { ReplicaWriterUpgrade } from "./privateReplicaPreferences"
import type { LocalProfile } from "../domain/identity"

type WriterApp = Pick<ReturnType<typeof useTincanban>, "getCurrentProfile" | "readWorkspaceDoc">

function assertUpgradeCredentials(owner: string, config: BlindReplicaConfig, upgrade?: ReplicaWriterUpgrade) {
  if (upgrade && privateReplicaBinding(owner, { ...upgrade.config, policyRevision: config.policyRevision,
    preferenceRevision: config.preferenceRevision }) !== privateReplicaBinding(owner, config)) throw new Error("Pending writer upgrade credentials changed")
}

/** Freeze, copy legacy discovery, confirm the monotonic server floor, then atomically activate retained local progress. */
export async function ensureWorkspaceReplicaWriter(app: WriterApp,
  config: BlindReplicaConfig, ensureCurrent: () => void): Promise<BlindReplicaConfig> {
  config = parseReplicaConfig(JSON.stringify(config))
  ensureCurrent()
  const active = app.getCurrentProfile()
  if (!active) throw new Error("Writer upgrade identity is unavailable")
  const profile = { ...active, identity: structuredClone(active.identity), device: structuredClone(active.device),
    certificate: structuredClone(active.certificate), privateKeys: { ...active.privateKeys } }
  const owner = profile.identity.personId
  const guardIdentity = () => {
    ensureCurrent()
    const latest = app.getCurrentProfile()
    if (latest?.identity.personId !== owner || latest.identity.publicKey !== profile.identity.publicKey ||
      latest.device.deviceId !== profile.device.deviceId || latest.device.publicKey !== profile.device.publicKey ||
      latest.certificate.signature !== profile.certificate.signature) throw new Error("Identity changed during Rusty writer upgrade")
  }
  return withLocalStateWriteLock(`rusty-writer-upgrade:${owner}:${config.origin}/${config.scopeId}`, async () => {
    guardIdentity()
    const saved = (await getReplicaConfigurations(owner)).find(value => value.origin === config.origin && value.scopeId === config.scopeId)
    if (!saved || privateReplicaBinding(owner, saved) !== privateReplicaBinding(owner, config)) throw new Error("Writer upgrade credential revision changed")
    const upgrade = await readReplicaWriterUpgrade(owner, config)
    if (config.minimumWriterVersion === 2 && !upgrade) return config
    assertUpgradeCredentials(owner, config, upgrade)
    const service = await discoverBlindKeeper(config.origin)
    guardIdentity()
    if (service.servicePublicKey !== config.servicePublicKey) throw new Error("Rusty writer service pin changed")
    if (service.writerPolicy?.maximumWriterVersion !== 2) {
      if (upgrade) throw new Error("Rusty upgrade required to resume the pending writer policy")
      return config
    }
    // Ordinary replication drains the exact old outbox before a later pass attempts this transition.
    if (!upgrade && (await getPrivateReplicaProgress(owner, config)).pending) return config
    let doc = await app.readWorkspaceDoc(config.workspaceId)
    guardIdentity()
    if (doc.ownerPersonId !== owner) {
      if (upgrade) throw new Error("Current workspace owner must recover the pending writer policy")
      return config
    }
    const { context } = await workspaceSigningContext(doc, profile, "rusty-writer-policy", "workspaceId", undefined, {
      readAuthority: async () => {
        guardIdentity()
        doc = await app.readWorkspaceDoc(config.workspaceId)
        if (doc.id !== config.workspaceId || doc.ownerPersonId !== owner) throw new Error("Workspace owner changed during writer upgrade")
        const authority = await readWorkspaceSigningAuthority(config.workspaceId)
        guardIdentity()
        return authority
      }, authorityFingerprint: authorityValidationFingerprint, workspaceRole: (_captured, signer) => workspaceRole(doc, signer),
    })
    return runWriterTransition(app, config, profile, upgrade, guardIdentity, async () => {
      guardIdentity()
      await assertSigningContextCurrent(context)
      guardIdentity()
    })
  })
}

/** Capture dependent Writers before policy mutation; retained evidence makes lost maintenance replies retryable. */
async function runWriterTransition(app: WriterApp, config: BlindReplicaConfig, profile: LocalProfile,
  upgrade: ReplicaWriterUpgrade | undefined, guardIdentity: () => void, guardOwner: () => Promise<void>): Promise<BlindReplicaConfig> {
  const owner = profile.identity.personId
  const discovered = await discoverWorkspaceReplicaWorkers(app, config, guardOwner)
  await guardOwner()
  let intent = upgrade ?? await prepareReplicaWriterUpgrade(owner, config, guardIdentity)
  const guard = async () => {
    await guardOwner()
    const [pending, configurations] = await Promise.all([readReplicaWriterUpgrade(owner, config), getReplicaConfigurations(owner)])
    const selected = configurations.find(value => value.origin === config.origin && value.scopeId === config.scopeId)
    if (canonicalizeJson(pending ?? null) !== canonicalizeJson(intent) || !selected ||
      privateReplicaBinding(owner, selected) !== privateReplicaBinding(owner, config)) throw new Error("Writer upgrade intent or credential revision changed")
    guardIdentity()
  }
  await guard()
  intent = await captureReplicaWriterWorkers(owner, intent, discovered, guardIdentity)
  await guard()
  await createWorkspaceAttachmentIndex(owner, intent.config, guardIdentity).read()
  await guard()
  if (!intent.confirmed || intent.confirmed.payload.revision <= config.policyRevision) {
    await approveRustyScope(intent.config, profile, false, { minimumWriterVersion: 2, ensureCurrent: guard,
      confirmed: async receipt => {
        await guard()
        intent = await confirmReplicaWriterUpgrade(owner, intent, receipt, guardIdentity)
        await guard()
      } })
  }
  await guard()
  if (!intent.confirmed) throw new Error("Rusty writer upgrade has no durable policy confirmation")
  const receipt = await verifyRustyWriterPolicyReceipt(intent.confirmed, intent.config, owner, config.policyRevision + 1)
  await guard()
  // Reinspect after maintenance so Workers introduced during the transition cannot be silently omitted.
  for (let round = 0; round < 4; round++) {
    await refreshWorkspaceReplicaWorkers(profile, intent.config, receipt, intent.workers ?? [], guard)
    await guard()
    const latest = await discoverWorkspaceReplicaWorkers(app, config, guard)
    await guard()
    const captured = await captureReplicaWriterWorkers(owner, intent, latest, guardIdentity)
    const stable = canonicalizeJson(captured.workers) === canonicalizeJson(intent.workers)
    intent = captured
    await guard()
    if (!stable) continue
    const updated = await completeReplicaWriterUpgrade(owner, intent, receipt.payload.revision, guardIdentity)
    guardIdentity()
    identityDevicePreferencesChanged(owner)
    return updated
  }
  throw new Error("Automation Workers kept changing during Rusty writer upgrade; retry the retained transition")
}
