import type { useTincanban } from "../state"
import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { compareAndSwapLocal, listLocalKeys, readLocal, type LocalStatePlan } from "../localDb"
import { withLocalStateWriteLock } from "../localStateLock"
import { rustyOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { parseState, scopeKey, stateKey } from "./privateReplicaRepositoryState"
import { changeReplicaPreference, emptyPrivateReplicaState, removeReplicaScopePreference } from "./privateReplicaPreferences"
import { replicaCredentialFreezeKey } from "./replicaCredentialFreezeState"
import { RustyManagementRepository } from "./rustyManagementRepository"
import { identityReplicaSetupKey } from "./identityReplicaConnection"
import { workspaceReplicaSetupKey } from "./workspaceReplicaConnection"
import { scopeEnrollmentJournalKey } from "./rustyEnrollmentJournal"
import { identityDevicePreferencesChanged } from "./identityDevicePreferenceEvents"
import { localWorkspaceAdmissionAuthority, workspaceRole } from "./changeAuthorization"
import { myDeviceRemovalsKey, withoutDeviceRemovalOrigin, type MyDeviceRemoval } from "./myDeviceRemoval"

type App = Pick<ReturnType<typeof useTincanban>, "getCurrentProfile" | "readWorkspaceDoc">
const profileKey = "tincanban.local_profile.v1"
const freezePrefix = "tincanban.replica-credential-freeze.v1."
type RecordSnapshot = LocalStatePlan["conditions"][number]

function assertProfile(raw: string | null, profile: LocalProfile) {
  const stored = raw === null ? undefined : JSON.parse(raw) as LocalProfile
  const binding = (value: LocalProfile) => canonicalizeJson([value.identity, value.device, value.certificate])
  if (!stored || binding(stored) !== binding(profile)) throw new Error("Rusty reset signing profile changed; retry required")
}

async function pendingRecords(owner: string, origin: string, freezeKey: string): Promise<RecordSnapshot[]> {
  const keys = [freezeKey, freezeKey.replace(freezePrefix, "tincanban.replica-credential-transition.v1."),
    freezeKey.replace(freezePrefix, "tincanban.replica-credential-conflict.v1."), await identityReplicaSetupKey(owner, origin)]
  const records = await Promise.all(keys.map(async key => ({ key, value: await readLocal(key) })))
  for (const key of await listLocalKeys()) {
    if (keys.some(active => key.startsWith(`${active}.completed.`))) {
      records.push({ key, value: await readLocal(key) })
      continue
    }
    if (!key.startsWith("tincanban.workspace-replica-setup.v1.") && !key.startsWith("tincanban.rusty-enrollment.v1.")) continue
    const value = await readLocal(key)
    if (value === null) continue
    const saved = JSON.parse(value) as { personId?: string; config?: { origin: string; workspaceId: string }; binding?: { origin: string; personId: string; scopeId: string } }
    if (saved.personId === owner && saved.config?.origin === origin && key === await workspaceReplicaSetupKey(owner, origin, saved.config.workspaceId)) records.push({ key, value })
    if (saved.binding?.personId === owner && saved.binding.origin === origin && key === await scopeEnrollmentJournalKey(owner, origin, saved.binding.scopeId)) records.push({ key, value })
  }
  return records
}

async function resetPlan(profile: LocalProfile, origin: string, freezeKey: string): Promise<LocalStatePlan> {
  const owner = profile.identity.personId, key = stateKey(owner)
  const raw = await readLocal(key), profileRaw = await readLocal(profileKey)
  assertProfile(profileRaw, profile)
  let next = raw === null ? emptyPrivateReplicaState(owner, crypto.randomUUID()) : parseState(raw, owner)
  const records = await pendingRecords(owner, origin, freezeKey)
  const management = await new RustyManagementRepository(owner).planForgetOrigin(origin)
  if (!next.entries.some(entry => entry.origin === origin) && !records.some(record => record.value !== null) &&
    !hasOriginManagement(management.conditions, origin)) throw new Error("No saved Rusty connection or intent at this origin")
  for (const entry of next.entries.filter(entry => entry.origin === origin)) {
    const previous = entry.operations.find(operation => operation.config)?.config
    if (previous) next = changeReplicaPreference(next, previous, true)
    delete next.progress[scopeKey(entry)]
    if (next.writerUpgrades) delete next.writerUpgrades[scopeKey(entry)]
  }
  for (const reference of retainedScopeReferences(records, owner, origin)) next = removeReplicaScopePreference(next, reference, reference.purpose)
  const encoded = JSON.stringify(next)
  parseState(encoded, owner)
  const archiveKey = `tincanban.rusty-local-reset.v1.${crypto.randomUUID()}`
  const removalKey = myDeviceRemovalsKey(owner), removalRaw = await readLocal(removalKey)
  const removal = { key: removalKey, value: removalRaw }
  const removalWrites = removalRaw === null ? [] : [{ key: removalKey,
    value: JSON.stringify(withoutDeviceRemovalOrigin(JSON.parse(removalRaw) as MyDeviceRemoval[], owner, origin)) }]
  const audit = JSON.stringify({ version: 1, personId: owner, deviceId: profile.device.deviceId, origin,
    records: [{ key, value: raw }, ...records, ...management.conditions, removal] })
  return { conditions: [{ key, value: raw }, { key: profileKey, value: profileRaw }, ...records, ...management.conditions, removal,
    { key: archiveKey, value: null }], writes: [{ key, value: encoded }, ...records.map(record => ({ key: record.key, value: null })),
    ...management.writes, ...removalWrites, { key: archiveKey, value: audit }] }
}

function hasOriginManagement(records: RecordSnapshot[], origin: string): boolean {
  return records.some(record => record.value !== null &&
    (JSON.parse(record.value) as { records: Array<{ binding: { origin: string } }> }).records.some(value => value.binding.origin === origin))
}

function retainedScopeReferences(records: RecordSnapshot[], owner: string, origin: string) {
  type Reference = { origin: string; scopeId: string; purpose: "workspace" | "identity" }
  const scopes = new Map<string, Reference>()
  const capture = (value: unknown) => {
    const config = value as { origin?: string; scopeId?: string; purpose?: string; personId?: string } | undefined
    if (!config || config.origin !== origin || typeof config.scopeId !== "string") return
    if (config.purpose === "identity" && config.personId !== owner) throw new Error("Saved Rusty identity scope binding changed")
    const purpose = config.purpose === "identity" ? "identity" : "workspace"
    scopes.set(config.scopeId, { origin, scopeId: config.scopeId, purpose })
  }
  for (const record of records) {
    if (record.value === null) continue
    const saved = JSON.parse(record.value) as { personId?: string; origin?: string; config?: unknown; freeze?: unknown;
      resources?: Array<{ previous: unknown; next: unknown }>; proposal?: { previousVariants?: unknown[]; next?: unknown } }
    if (saved.personId === owner) capture(saved.config)
    const frozen = (saved.freeze ?? saved) as typeof saved
    if (frozen.personId !== owner || frozen.origin !== origin) continue
    for (const resource of frozen.resources ?? []) { capture(resource.previous); capture(resource.next) }
    for (const previous of frozen.proposal?.previousVariants ?? []) capture(previous)
    capture(frozen.proposal?.next)
  }
  return [...scopes.values()]
}

/** Forget this device's delivery access. Board/profile documents and bytes are not rewritten. */
export async function forgetRustyOrigin(app: App, origin: string, workspaceId: string, guard: () => void): Promise<void> {
  origin = rustyOrigin(origin)
  guard()
  const profile = app.getCurrentProfile()
  if (!profile) throw new Error("Current identity is unavailable")
  const owner = profile.identity.personId
  const document = await app.readWorkspaceDoc(workspaceId)
  if (document.id !== workspaceId) throw new Error("Rusty reset workspace changed")
  await localWorkspaceAdmissionAuthority(document, profile)
  if (await workspaceRole(document, profile) === "automation") throw new Error("Board participant access required")
  guard()
  const freezeKey = await replicaCredentialFreezeKey(owner, origin)
  await withLocalStateWriteLock(`my-device-removal:${owner}`, () => withLocalStateWriteLock(`rusty-device-revocation:${owner}:${origin}`, () => withLocalStateWriteLock(freezeKey, async () => {
    const plan = await resetPlan(profile, origin, freezeKey)
    guard()
    if (!await compareAndSwapLocal(plan, guard)) throw new Error("Rusty settings or pending operation changed; retry reset")
  })))
  guard()
  identityDevicePreferencesChanged(owner)
}
