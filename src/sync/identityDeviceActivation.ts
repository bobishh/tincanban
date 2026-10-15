import type { PersonalRootDocumentV1 } from "../domain/model"
import { certHashDefault, defaultProofStore } from "../domain/proofs"
import { compareAndSwapLocal, readLocal, type LocalStatePlan } from "../localDb"
import { planPersonalRootUpdate } from "../storagePersonalRoot"
import { mergeIdentityProfileRoots } from "../domain/identityProfileRoot"
import { planPrivateReplicaImport } from "./privateReplicaRepository"
import { RustyManagementRepository } from "./rustyManagementRepository"
import { planIdentityRecoveryImport } from "./identityRecoveryState"
import { readIdentityDeviceTransfer } from "./identityDeviceTransferReader"
import { canonicalizeJson, refreshIdentityPresentation } from "../domain/identity"
import { planIdentityDeviceExtensionsImport } from "./identityDeviceExtensions"
import { identityDeviceActivationKey as activationKey } from "./identityDeviceActivationState"
import { planIdentityProfileImport } from "./identityProfileProjectionQueue"
import { resumeIdentityProfileProjections } from "./identityProfileProjection"
import { planIdentityProfilePresentation } from "./identityProfilePresentationPlan"

type Transfer = Awaited<ReturnType<typeof readIdentityDeviceTransfer>>
type ActivationOptions = { adoption?: LocalStatePlan; deferEffects?: boolean }

async function mergeRoot(current: PersonalRootDocumentV1 | null, incoming: PersonalRootDocumentV1): Promise<PersonalRootDocumentV1> {
  if (!current) return mergeIdentityProfileRoots(null, incoming)
  for (const [id, device] of Object.entries(incoming.devices)) {
    if (current.devices[id] && current.devices[id].publicKey !== device.publicKey) throw new Error("Device-state certificate catalog conflict")
  }
  return { ...await mergeIdentityProfileRoots(current, incoming),
    devices: { ...current.devices, ...incoming.devices },
    workspaces: { ...incoming.workspaces, ...current.workspaces },
    keeperIntegrations: { ...incoming.keeperIntegrations, ...current.keeperIntegrations },
    pendingKeeperWithdrawals: { ...incoming.pendingKeeperWithdrawals, ...current.pendingKeeperWithdrawals } }
}

/** All asynchronous validation finishes before the one local-state transaction. */
async function activationPlan(transfer: Transfer, options: ActivationOptions, previousActivation: string | null): Promise<LocalStatePlan> {
  const personId = transfer.manifest.personId
  const profileKey = "tincanban.local_profile.v1"
  const profileRaw = options.adoption ? undefined : await readLocal(profileKey)
  if (profileRaw === null) throw new Error("Durable identity profile is missing. Restore this device before importing private state.")
  if (profileRaw && (JSON.parse(profileRaw) as { identity?: { personId?: string } }).identity?.personId !== personId) {
    throw new Error("Identity changed before device-state activation")
  }
  if (profileRaw !== undefined && profileRaw !== null) await refreshIdentityPresentation(profileRaw)
  let projectedRoot = transfer.personalRoot
  const plans = await Promise.all([
    planPersonalRootUpdate(personId, async current => { projectedRoot = await mergeRoot(current, transfer.personalRoot); return projectedRoot }),
    planPrivateReplicaImport(personId, transfer.replicas),
    new RustyManagementRepository(personId).planImport(transfer.capabilities),
    planIdentityRecoveryImport(personId, transfer.recoveryEvidence),
    planIdentityDeviceExtensionsImport(transfer.manifest),
    planIdentityProfileImport(transfer.personalRoot.identity, transfer.observations),
  ])
  const profilePlan = planIdentityProfilePresentation(profileRaw ?? null, projectedRoot.identity, options.adoption)
  return { conditions: [...plans.flatMap(plan => plan.conditions), ...profilePlan.conditions,
    { key: activationKey(personId), value: previousActivation }],
    writes: [...plans.flatMap(plan => plan.writes), ...profilePlan.writes, { key: activationKey(personId),
      value: JSON.stringify({ version: 1, personId, manifest: transfer.manifest }) }] }
}

/** Secondary stores are idempotent projections. Durable intent survives a tab close or a failed projection. */
export async function resumeIdentityDeviceActivation(personId: string, ensureCurrent: () => void, certificatesOnly = false): Promise<void> {
  const key = activationKey(personId)
  const raw = await readLocal(key)
  if (raw === null) { await resumeIdentityProfileProjections(personId, ensureCurrent); return }
  ensureCurrent()
  const pending = JSON.parse(raw) as { version: number; personId: string; manifest: unknown }
  if (pending.version !== 1 || pending.personId !== personId ||
    Object.keys(pending).some(field => !["version", "personId", "manifest"].includes(field))) throw new Error("Invalid pending device-state activation")
  const transfer = await readIdentityDeviceTransfer(pending.manifest, personId)
  for (const certificate of transfer.certificates) {
    ensureCurrent()
    await defaultProofStore.putCertificate(await certHashDefault(certificate), certificate)
  }
  ensureCurrent()
  await compareAndSwapLocal({ conditions: [{ key, value: raw }], writes: [{ key, value: null }] }, ensureCurrent)
  if (!certificatesOnly) await resumeIdentityProfileProjections(personId, ensureCurrent)
}

/** Caller must authenticate the envelope. Never accept derived component fields independently of its manifest. */
export async function activateIdentityDeviceTransfer(input: Transfer, ensureCurrent: () => void, options: ActivationOptions = {}): Promise<void> {
  const manifest = structuredClone(input.manifest)
  options = structuredClone(options)
  ensureCurrent()
  const transfer = await readIdentityDeviceTransfer(manifest, manifest.personId)
  for (let attempt = 0; attempt < 8; attempt++) {
    ensureCurrent()
    if (!options.deferEffects) await resumeIdentityDeviceActivation(manifest.personId, ensureCurrent)
    const previous = await readLocal(activationKey(manifest.personId))
    if (previous !== null && canonicalizeJson((JSON.parse(previous) as { manifest?: unknown }).manifest) !== canonicalizeJson(manifest)) {
      throw new Error("Previous device-state activation is unfinished")
    }
    const plan = await activationPlan(transfer, options, previous)
    ensureCurrent()
    if (!await compareAndSwapLocal(plan, ensureCurrent)) continue
    if (!options.adoption && profileRawAvailable(plan)) await refreshIdentityPresentation()
    if (!options.deferEffects) await resumeIdentityDeviceActivation(manifest.personId, ensureCurrent)
    return
  }
  throw new Error("Device state changed repeatedly; retry required")
}

function profileRawAvailable(plan: LocalStatePlan): boolean {
  return plan.conditions.some(condition => condition.key === "tincanban.local_profile.v1" && condition.value !== null)
}
