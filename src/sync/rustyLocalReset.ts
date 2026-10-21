import type { useTincanban } from "../state"
import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { compareAndSwapLocal, listLocalKeys, readLocal, type LocalStatePlan } from "../localDb"
import { withLocalStateWriteLock } from "../localStateLock"
import { rustyOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { parseState, scopeKey, stateKey } from "./privateReplicaRepositoryState"
import { changeReplicaPreference } from "./privateReplicaPreferences"
import { replicaCredentialFreezeKey } from "./replicaCredentialFreezeState"
import { RustyManagementRepository } from "./rustyManagementRepository"
import { identityReplicaSetupKey } from "./identityReplicaConnection"
import { workspaceReplicaSetupKey } from "./workspaceReplicaConnection"
import { scopeEnrollmentJournalKey } from "./rustyEnrollmentJournal"
import { identityDevicePreferencesChanged } from "./identityDevicePreferenceEvents"
import { localWorkspaceAdmissionAuthority, workspaceRole } from "./changeAuthorization"

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
  if (raw === null) throw new Error("No saved Rusty settings to forget")
  let next = parseState(raw, owner)
  if (!next.entries.some(entry => entry.origin === origin)) throw new Error("No saved Rusty connection at this origin")
  for (const entry of next.entries.filter(entry => entry.origin === origin)) {
    const previous = entry.operations.find(operation => operation.config)?.config
    if (previous) next = changeReplicaPreference(next, previous, true)
    delete next.progress[scopeKey(entry)]
    if (next.writerUpgrades) delete next.writerUpgrades[scopeKey(entry)]
  }
  const encoded = JSON.stringify(next)
  parseState(encoded, owner)
  const records = await pendingRecords(owner, origin, freezeKey)
  const management = await new RustyManagementRepository(owner).planForgetOrigin(origin)
  const archiveKey = `tincanban.rusty-local-reset.v1.${crypto.randomUUID()}`
  const audit = JSON.stringify({ version: 1, personId: owner, deviceId: profile.device.deviceId, origin,
    records: [{ key, value: raw }, ...records, ...management.conditions] })
  return { conditions: [{ key, value: raw }, { key: profileKey, value: profileRaw }, ...records, ...management.conditions,
    { key: archiveKey, value: null }], writes: [{ key, value: encoded }, ...records.map(record => ({ key: record.key, value: null })),
    ...management.writes, { key: archiveKey, value: audit }] }
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
  await withLocalStateWriteLock(`rusty-device-revocation:${owner}:${origin}`, () => withLocalStateWriteLock(freezeKey, async () => {
    const plan = await resetPlan(profile, origin, freezeKey)
    guard()
    if (!await compareAndSwapLocal(plan, guard)) throw new Error("Rusty settings or pending operation changed; retry reset")
  }))
  guard()
  identityDevicePreferencesChanged(owner)
}
