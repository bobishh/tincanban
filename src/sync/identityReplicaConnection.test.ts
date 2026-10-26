import { afterEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { RustyScopePurposeError } from "@meta-uber/mesh-replication/rusty-scope-purpose"
import * as localDb from "../localDb"
import { readLocal, writeLocal } from "../localDb"
import { exportPrivateReplicaState, getIdentityReplicaConfigurations, getReplicaConfigurations, setReplicaPreference } from "./privateReplicaRepository"
import { prepareReplicaCredentialFreeze } from "./replicaCredentialFreeze"
import type { IdentityReplicaConfig } from "./blindReplication"
import type { EnsureRustyPersonScopeOptions } from "./rustyIdentityTransport"

const service = { origin: "https://rusty.example", servicePublicKey: "A".repeat(43), scopeManagement: 1 as const }
const remote = vi.hoisted(() => ({
  status: vi.fn(async () => ({ capability: null as unknown, migrationPending: false })),
  update: vi.fn(async () => ({ payload: { revision: 1 } })),
  personPolicy: vi.fn(async (...args: unknown[]) => { void args; return { payload: { revision: 1 } } }),
  retry: vi.fn(async () => ({ payload: { revision: 1 } })),
  approve: vi.fn(async (config: IdentityReplicaConfig) => { void config; return 1 }),
  classifyPersonScope: vi.fn(async (options: EnsureRustyPersonScopeOptions) => { void options }),
}))
vi.mock("./rustyManagementClient", () => ({ readRustyManagementStatus: remote.status, updateRustyManagementPolicy: remote.update,
  retryRustyManagementUpdate: remote.retry, ensureRustyPersonPolicy: remote.personPolicy }))
vi.mock("./rustyEnrollment", () => ({ approveRustyScope: remote.approve }))
vi.mock("./rustyIdentityTransport", () => ({ ensureRustyPersonIdentityScope: remote.classifyPersonScope,
  ensureRustyIdentityAuthorityPublished: vi.fn(async () => ({})) }))

import { ensureIdentityReplicaConnection, identityReplicaSetupKey } from "./identityReplicaConnection"

afterEach(() => {
  resetIdentityStorageForTest()
  remote.status.mockReset().mockResolvedValue({ capability: null, migrationPending: false })
  remote.update.mockReset().mockResolvedValue({ payload: { revision: 1 } })
  remote.personPolicy.mockReset().mockResolvedValue({ payload: { revision: 1 } })
  remote.retry.mockClear()
  remote.approve.mockReset().mockResolvedValue(1)
  remote.classifyPersonScope.mockReset().mockResolvedValue(undefined)
})

it("Given a forgotten profile scope, When the owner explicitly adds Rusty again, Then generate a distinct scope while retaining its tombstone", async () => {
  const profile = await bootstrapIdentity("Fresh Rusty profile")
  const old = await ensureIdentityReplicaConnection(service, profile, () => {})
  await setReplicaPreference(profile.identity.personId, old, true)
  await expect(ensureIdentityReplicaConnection(service, profile, () => {})).rejects.toThrow(/removed/i)
  const fresh = await ensureIdentityReplicaConnection(service, profile, () => {}, { allowNewScopeAfterRemoval: true })
  expect(fresh.scopeId).not.toBe(old.scopeId)
  expect(fresh.contentKey).not.toBe(old.contentKey)
  expect(await getIdentityReplicaConfigurations(profile.identity.personId)).toEqual([fresh])
})

it("Given Rusty lost the saved Identity scope policy, when the owner explicitly reconnects, then tombstone it and provision a fresh scope", async () => {
  const profile = await bootstrapIdentity("Missing Rusty profile scope")
  const old = await ensureIdentityReplicaConnection(service, profile, () => {})
  remote.classifyPersonScope.mockRejectedValueOnce(new RustyScopePurposeError(400, "scope-unavailable",
    "Rusty scope classification failed with HTTP 400"))

  const fresh = await ensureIdentityReplicaConnection(service, profile, () => {}, { allowNewScopeAfterRemoval: true })
  const state = await exportPrivateReplicaState(profile.identity.personId)
  const retired = state.entries.find(entry => entry.scopeId === old.scopeId)

  expect(fresh.scopeId).not.toBe(old.scopeId)
  expect(fresh.contentKey).not.toBe(old.contentKey)
  expect(retired?.operations.at(-1)).toMatchObject({ purpose: "identity", config: null })
  expect(await getIdentityReplicaConfigurations(profile.identity.personId)).toEqual([fresh])
})

it("Given a Rusty connection, when private profile setup succeeds, then register a separate identity scope without a workspace credential", async () => {
  const profile = await bootstrapIdentity("Profile setup")
  const compareAndSwap = localDb.compareAndSwapLocal.bind(localDb)
  const plans: Array<{ conditions: Array<{ key: string; value: string | null }>; writes: Array<{ key: string; value: string | null }> }> = []
  vi.spyOn(localDb, "compareAndSwapLocal").mockImplementation(async (plan, guard) => {
    plans.push(structuredClone(plan))
    return compareAndSwap(plan, guard)
  })
  const result = await ensureIdentityReplicaConnection(service, profile, () => {})
  expect(result).toMatchObject({ purpose: "identity", personId: profile.identity.personId, cursor: 0, lastUploaded: "" })
  expect(result).not.toHaveProperty("workspaceId")
  expect(await getIdentityReplicaConfigurations(profile.identity.personId)).toEqual([result])
  expect(await getReplicaConfigurations(profile.identity.personId)).toEqual([])
  const activation = plans.find(plan => plan.writes.some(write => write.key.startsWith("tincanban.identity-replica-setup.v1.") && write.value === null))
  expect(activation?.conditions).toContainEqual(expect.objectContaining({
    key: expect.stringMatching(/^tincanban\.replica-credential-freeze\.v1\./), value: null,
  }))
  expect(await readLocal(await identityReplicaSetupKey(profile.identity.personId, service.origin))).toBeNull()
  await ensureIdentityReplicaConnection(service, profile, () => {})
  expect(remote.approve).toHaveBeenCalledTimes(1)
  expect(remote.classifyPersonScope).toHaveBeenCalledTimes(2)
  expect(remote.classifyPersonScope.mock.calls.map(([options]) => options.access.scopeId)).toEqual([result.scopeId, result.scopeId])
})

it("Given a newly approved Identity device, when Add Rusty initializes private storage, then explicitly establish person policy after publishing its authority view", async () => {
  const profile = await bootstrapIdentity("First Rusty connection")
  const orderedService = { ...service, personManagement: 1 as const }

  await ensureIdentityReplicaConnection(orderedService, profile, () => {})

  expect(remote.personPolicy).toHaveBeenCalledWith(orderedService, profile, true,
    expect.objectContaining({ allowLegacyMigration: true, ensureCurrent: expect.any(Function) }))
})

it("Given storage enrollment lost its reply, when setup retries, then retain and reuse exact scope, tokens and content key", async () => {
  const profile = await bootstrapIdentity("Lost reply")
  remote.approve.mockRejectedValueOnce(new Error("reply lost"))
  await expect(ensureIdentityReplicaConnection(service, profile, () => {})).rejects.toThrow("reply lost")
  const pendingRaw = await readLocal(await identityReplicaSetupKey(profile.identity.personId, service.origin))
  expect(pendingRaw).not.toBeNull()
  expect(await getIdentityReplicaConfigurations(profile.identity.personId)).toEqual([])
  await ensureIdentityReplicaConnection(service, profile, () => {})
  expect(remote.approve.mock.calls[1][0]).toEqual(remote.approve.mock.calls[0][0])
})

it("Given an identity scope was removed, when board connectivity triggers setup again, then its tombstone prevents automatic resurrection", async () => {
  const profile = await bootstrapIdentity("Removed profile")
  const config = await ensureIdentityReplicaConnection(service, profile, () => {})
  await setReplicaPreference(profile.identity.personId, config, true)
  remote.approve.mockClear()
  await expect(ensureIdentityReplicaConnection(service, profile, () => {})).rejects.toThrow("removed")
  expect(remote.approve).not.toHaveBeenCalled()
  expect(await getIdentityReplicaConfigurations(profile.identity.personId)).toEqual([])
})

it("Given setup is interrupted and the service key changes, then the old setup stays recoverable and new credentials are not enrolled", async () => {
  const profile = await bootstrapIdentity("Pinned setup")
  remote.approve.mockRejectedValueOnce(new Error("offline"))
  await expect(ensureIdentityReplicaConnection(service, profile, () => {})).rejects.toThrow("offline")
  const key = await identityReplicaSetupKey(profile.identity.personId, service.origin)
  const before = await readLocal(key)
  await expect(ensureIdentityReplicaConnection({ ...service, servicePublicKey: "B".repeat(42) + "A" }, profile, () => {}))
    .rejects.toThrow("pin")
  expect(await readLocal(key)).toBe(before)
  expect(remote.approve).toHaveBeenCalledTimes(1)
})

it("Given private scope setup becomes stale after a network step, then neither credentials nor another identity are activated", async () => {
  const profile = await bootstrapIdentity("Stale setup")
  let current = true
  remote.approve.mockImplementationOnce(async () => { current = false; return 1 })
  await expect(ensureIdentityReplicaConnection(service, profile, () => { if (!current) throw new Error("identity replaced") }))
    .rejects.toThrow("identity replaced")
  expect(await getIdentityReplicaConfigurations(profile.identity.personId)).toEqual([])
  expect(await readLocal(await identityReplicaSetupKey(profile.identity.personId, service.origin))).not.toBeNull()
})

it("Given another tab replaces the durable profile during enrollment, then atomic activation fails and an exact enrollment retry preserves its credentials", async () => {
  const profile = await bootstrapIdentity("Concurrent tab")
  const profileKey = "tincanban.local_profile.v1"
  const original = (await readLocal(profileKey))!
  remote.approve.mockImplementationOnce(async () => {
    const changed = JSON.parse(original) as { identity: { displayName: string } }
    changed.identity.displayName = "Updated in another tab"
    await writeLocal(profileKey, JSON.stringify(changed))
    return 1
  })
  await expect(ensureIdentityReplicaConnection(service, profile, () => {})).rejects.toThrow(/changed.*activation/i)
  expect(await getIdentityReplicaConfigurations(profile.identity.personId)).toEqual([])
  const key = await identityReplicaSetupKey(profile.identity.personId, service.origin)
  expect(JSON.parse((await readLocal(key))!) as unknown).toMatchObject({ stage: "policy" })
  await ensureIdentityReplicaConnection(service, profile, () => {})
  expect(remote.approve).toHaveBeenCalledTimes(2)
  expect(remote.approve.mock.calls[1][0]).toEqual(remote.approve.mock.calls[0][0])
  expect(await readLocal(key)).toBeNull()
  expect((JSON.parse((await readLocal(profileKey))!) as { identity: { displayName: string } }).identity.displayName).toBe("Updated in another tab")
})

it("Given saved identity evidence is malformed or differs from the signer, then refuse setup before allocating or sending credentials", async () => {
  const profile = await bootstrapIdentity("Invalid saved signer")
  const profileKey = "tincanban.local_profile.v1"
  const original = (await readLocal(profileKey))!
  const altered = JSON.parse(original) as { certificate: { payload: { canEnrollDevices: boolean } } }
  altered.certificate.payload.canEnrollDevices = !altered.certificate.payload.canEnrollDevices
  for (const raw of ["malformed", "{}", JSON.stringify(altered)]) {
    await writeLocal(profileKey, raw)
    await expect(ensureIdentityReplicaConnection(service, profile, () => {})).rejects.toThrow(/identity.*(read|stale)/i)
    expect(await readLocal(await identityReplicaSetupKey(profile.identity.personId, service.origin))).toBeNull()
  }
  expect(remote.status).not.toHaveBeenCalled()
  expect(remote.approve).not.toHaveBeenCalled()
})

it("Given another private scope at the origin is frozen, when background profile setup runs, then do not query or mutate Rusty policy", async () => {
  const profile = await bootstrapIdentity("Frozen profile setup")
  const owner = profile.identity.personId
  const workspace = { purpose: "workspace" as const, workspaceId: "board", scopeId: "workspace-scope", origin: service.origin,
    servicePublicKey: service.servicePublicKey, contentKey: "A".repeat(43), readToken: "B".repeat(43), writeToken: "C".repeat(43),
    keyEpoch: 1, policyRevision: 1, cursor: 0, lastUploaded: "", minimumWriterVersion: 2 as const }
  await setReplicaPreference(owner, workspace)
  await prepareReplicaCredentialFreeze(profile, service.origin, service.servicePublicKey, "revoked-device", () => {})
  remote.status.mockClear(); remote.update.mockClear(); remote.retry.mockClear(); remote.approve.mockClear()

  await expect(ensureIdentityReplicaConnection(service, profile, () => {})).rejects.toThrow(/transition|frozen/i)
  expect(remote.status).not.toHaveBeenCalled()
  expect(remote.update).not.toHaveBeenCalled()
  expect(remote.retry).not.toHaveBeenCalled()
  expect(remote.approve).not.toHaveBeenCalled()
  expect(await getIdentityReplicaConfigurations(owner)).toEqual([])
})
