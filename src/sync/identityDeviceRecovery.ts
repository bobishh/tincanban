import { createIdentityAuthorityView, verifyIdentityAuthorityView, identitySeedFromPrivateKey, sealIdentitySeed, type IdentityAdoptionCommitPlan, type IdentitySecurity } from "@meta-uber/mesh-identity"
import { bootstrapIdentity, canonicalizeJson, isCurrentIdentityProfile, refreshIdentityPresentation, restoreIdentityRecovery } from "../domain/identity"
import type { PersonalRootDocumentV1 } from "../domain/model"
import { rootIdentityProfileState } from "../domain/identityProfileRoot"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault, defaultProofStore } from "../domain/proofs"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { assertSigningContextCurrent } from "../domain/signingContext"
import { compareAndSwapLocal, readLocal, type LocalStatePlan } from "../localDb"
import { readIdentityStateRevision, identityStateRevisionKey } from "../identityStateRevision"
import { chatStore } from "../chat/store"
import { getChatScope } from "../chat/service"
import { WorkspaceUnavailableError } from "../workspaceAvailability"
import { createIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { readIdentityDeviceTransfer } from "./identityDeviceTransferReader"
import { activateIdentityDeviceTransfer, resumeIdentityDeviceActivation } from "./identityDeviceActivation"
import { identityDevicePreferencesChanged } from "./identityDevicePreferenceEvents"
import { planIdentityRecoveryImport, validateIdentityRecoveryEvidence } from "./identityRecoveryState"
import { openIdentityDeviceRecovery, parseIdentityRecoveryFile, sealIdentityDeviceRecovery, type IdentityRecoveryFile } from "./identityDeviceRecoveryCodec"

async function profileRevisions(root: PersonalRootDocumentV1): Promise<string> {
  if (typeof indexedDB === "undefined") return "[]"
  const references = Object.values(root.workspaces).filter(reference => !reference.forgotten).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
  return canonicalizeJson(await Promise.all(references.map(async reference => {
    try {
      const scope = await getChatScope(reference.workspaceId)
      return [reference.workspaceId, scope, await chatStore.readContentRevision(scope)]
    } catch (cause) {
      if (cause instanceof WorkspaceUnavailableError) return [reference.workspaceId, "unavailable"]
      throw cause
    }
  })))
}

async function currentRoot(personId: string): Promise<PersonalRootDocumentV1 | undefined> {
  const raw = await readLocal("tincanban.v1.personal_roots")
  if (raw === null) return undefined
  const map = JSON.parse(raw) as Record<string, PersonalRootDocumentV1>
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("Saved identity catalog is invalid")
  const roots = Object.values(map).filter(root => root?.identity?.personId === personId)
  if (roots.length > 1) throw new Error("Conflicting saved identity catalogs require recovery")
  return roots[0]
}

async function adoptionPlan(adoption: IdentityAdoptionCommitPlan, expectedRaw: string | null): Promise<LocalStatePlan> {
  if (adoption.previousProfile !== expectedRaw) throw new Error("Identity changed before recovery commit")
  const plan: LocalStatePlan = { conditions: [{ key: adoption.storageKey, value: adoption.previousProfile }],
    writes: [{ key: adoption.storageKey, value: adoption.candidateProfile }] }
  if (adoption.backup) {
    plan.conditions.push({ key: adoption.backup.key, value: await readLocal(adoption.backup.key) })
    plan.writes.push(adoption.backup)
  }
  return plan
}

/** Export the same portable state used by device enrollment, under a fresh encrypted recovery envelope. */
export async function createIdentityDeviceRecovery(security: IdentitySecurity = "better") {
  const profile = await bootstrapIdentity()
  if (!profile.privateKeys.identityPrivateKey) throw new Error("This device cannot back up the identity root. Use a device holding your recovery key.")
  const context = await resolveLocalSigningContext(profile, "identity-device-recovery", { personId: profile.identity.personId })
  const seed = await identitySeedFromPrivateKey(profile.privateKeys.identityPrivateKey, profile.identity.personId)
  try {
    const { generateIdentityRecovery } = await import("@meta-uber/mesh-identity/recovery")
    const recoveryKey = generateIdentityRecovery(security)
    const envelope = await sealIdentitySeed(seed, profile.identity.personId, recoveryKey, security)
    for (let attempt = 0; attempt < 8; attempt++) {
      await assertSigningContextCurrent(context)
      const revision = await readIdentityStateRevision()
      const rawRevision = await readLocal(identityStateRevisionKey)
      const rawProfile = await readLocal("tincanban.local_profile.v1")
      const root = await currentRoot(profile.identity.personId) ?? createPersonalRoot(profile, await certHashDefault(profile.certificate))
      const beforeProfiles = await profileRevisions(root)
      const certificates = [profile.certificate, ...await defaultProofStore.listCertificates()]
        .filter(certificate => certificate.payload.personId === profile.identity.personId)
      const manifest = await createIdentityDeviceTransfer(root, certificates)
      const recoveryPlan = await planIdentityRecoveryImport(profile.identity.personId, { personId: profile.identity.personId, envelopes: [envelope] })
      const evidence = validateIdentityRecoveryEvidence(profile.identity.personId, manifest.components.recoveryEvidence.value)
      manifest.components.recoveryEvidence.value = { personId: profile.identity.personId,
        envelopes: [...evidence.filter(value => canonicalizeJson(value) !== canonicalizeJson(envelope)), envelope] }
      const file = await sealIdentityDeviceRecovery(manifest, envelope, seed)
      await assertSigningContextCurrent(context)
      if (revision !== await readIdentityStateRevision() || beforeProfiles !== await profileRevisions(root)) continue
      const plan = { conditions: [...recoveryPlan.conditions, { key: identityStateRevisionKey, value: rawRevision },
        { key: "tincanban.local_profile.v1", value: rawProfile }], writes: recoveryPlan.writes }
      if (!await compareAndSwapLocal(plan, () => {
        if (!isCurrentIdentityProfile(profile)) throw new Error("Identity changed during backup")
      })) continue
      identityDevicePreferencesChanged(profile.identity.personId)
      return { recoveryKey, file }
    }
    throw new Error("Identity changed repeatedly during backup. Retry when synchronization settles.")
  } finally { seed.fill(0) }
}

/** No component is published until decryption, every embedded proof, and replacement consent have passed. */
export async function restoreIdentityDeviceRecovery(input: IdentityRecoveryFile, words: string, displayName: string,
  replaceExisting = false, beforeRestore?: () => Promise<void>) {
  const file = parseIdentityRecoveryFile(JSON.stringify(input))
  const previous = await bootstrapIdentity()
  const previousRaw = await readLocal("tincanban.local_profile.v1")
  const ensurePrevious = async () => {
    if (!isCurrentIdentityProfile(previous) || await readLocal("tincanban.local_profile.v1") !== previousRaw) {
      throw new Error("Identity changed during recovery. Reopen the recovery file and try again.")
    }
  }
  const prepare = async () => { await ensurePrevious(); await beforeRestore?.(); await ensurePrevious() }
  if (file.kind === "mesh-identity-recovery") return restoreIdentityRecovery(file, words, displayName, replaceExisting, prepare,
    async (adoption, ensureCurrent) => {
      const plan = await adoptionPlan(adoption, previousRaw)
      if (!await compareAndSwapLocal(plan, ensureCurrent)) throw new Error("Identity changed before recovery commit")
    })
  const opened = await openIdentityDeviceRecovery(file, words)
  await ensurePrevious()
  const recovered = await restoreIdentityRecovery(opened.recovery, words, opened.transfer.personalRoot.identity.displayName,
    replaceExisting, prepare, async (adoption, ensureCurrent) => {
      if (adoption.previousProfile !== previousRaw) throw new Error("Identity changed before recovery commit")
      const manifest = structuredClone(opened.transfer.manifest)
      const catalog = manifest.components.identityCatalog.value as { personalRoot: PersonalRootDocumentV1; certificates: typeof adoption.publicProfile.certificate[] }
      const device = adoption.publicProfile.device
      const existing = catalog.personalRoot.devices[device.deviceId]
      if (existing && existing.publicKey !== device.publicKey) throw new Error("Recovery device conflicts with the saved catalog")
      const certificateHash = await certHashDefault(adoption.publicProfile.certificate)
      catalog.personalRoot.devices[device.deviceId] = { ...device, certificateHash, addedAt: existing?.addedAt ?? new Date().toISOString() }
      if (!catalog.certificates.some(certificate => canonicalizeJson(certificate) === canonicalizeJson(adoption.publicProfile.certificate))) {
        catalog.certificates.push(adoption.publicProfile.certificate)
      }
      const retainedAuthority = await verifyIdentityAuthorityView(manifest.components.identityAuthority.value.authorityView)
      manifest.components.identityAuthority.value.authorityView = await createIdentityAuthorityView(catalog.personalRoot.identity,
        { certificates: catalog.certificates, revocations: retainedAuthority.revocations },
        await rootIdentityProfileState(catalog.personalRoot))
      const transfer = await readIdentityDeviceTransfer(manifest, file.personId)
      const plan = await adoptionPlan(adoption, previousRaw)
      ensureCurrent()
      await activateIdentityDeviceTransfer(transfer, ensureCurrent, { adoption: plan, deferEffects: true })
    })
  const guard = () => { if (!isCurrentIdentityProfile(recovered)) throw new Error("Identity changed during recovery activation") }
  await resumeIdentityDeviceActivation(recovered.identity.personId, guard, true)
  guard()
  const refreshed = await refreshIdentityPresentation()
  identityDevicePreferencesChanged(refreshed.identity.personId)
  return refreshed
}
