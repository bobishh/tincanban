import { afterEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { readLocal, writeLocal } from "../localDb"
import { getIdentityReplicaConfigurations, getReplicaConfigurations, setReplicaPreference } from "./privateReplicaRepository"
import type { IdentityReplicaConfig } from "./blindReplication"

const service = { origin: "https://rusty.example", servicePublicKey: "A".repeat(43), scopeManagement: 1 as const }
const remote = vi.hoisted(() => ({
  status: vi.fn(async () => ({ capability: null as unknown, migrationPending: false })),
  update: vi.fn(async () => ({ payload: { revision: 1 } })),
  retry: vi.fn(async () => ({ payload: { revision: 1 } })),
  approve: vi.fn(async (config: IdentityReplicaConfig) => { void config; return 1 }),
}))
vi.mock("./rustyManagementClient", () => ({ readRustyManagementStatus: remote.status, updateRustyManagementPolicy: remote.update,
  retryRustyManagementUpdate: remote.retry }))
vi.mock("./rustyEnrollment", () => ({ approveRustyScope: remote.approve }))

import { ensureIdentityReplicaConnection, identityReplicaSetupKey } from "./identityReplicaConnection"

afterEach(() => {
  resetIdentityStorageForTest()
  remote.status.mockReset().mockResolvedValue({ capability: null, migrationPending: false })
  remote.update.mockReset().mockResolvedValue({ payload: { revision: 1 } })
  remote.retry.mockClear()
  remote.approve.mockReset().mockResolvedValue(1)
})

it("Given a Rusty connection, when private profile setup succeeds, then register a separate identity scope without a workspace credential", async () => {
  const profile = await bootstrapIdentity("Profile setup")
  const result = await ensureIdentityReplicaConnection(service, profile, () => {})
  expect(result).toMatchObject({ purpose: "identity", personId: profile.identity.personId, cursor: 0, lastUploaded: "" })
  expect(result).not.toHaveProperty("workspaceId")
  expect(await getIdentityReplicaConfigurations(profile.identity.personId)).toEqual([result])
  expect(await getReplicaConfigurations(profile.identity.personId)).toEqual([])
  expect(await readLocal(await identityReplicaSetupKey(profile.identity.personId, service.origin))).toBeNull()
  await ensureIdentityReplicaConnection(service, profile, () => {})
  expect(remote.approve).toHaveBeenCalledTimes(1)
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

it("Given another tab replaces the durable profile during enrollment, then atomic activation fails and retry preserves its enrolled credentials", async () => {
  const profile = await bootstrapIdentity("Concurrent tab")
  const profileKey = "tincanban.local_profile.v1"
  const original = (await readLocal(profileKey))!
  remote.approve.mockImplementationOnce(async () => {
    const changed = JSON.parse(original) as { identity: { displayName: string } }
    changed.identity.displayName = "Updated in another tab"
    await writeLocal(profileKey, JSON.stringify(changed))
    return 1
  })
  await expect(ensureIdentityReplicaConnection(service, profile, () => {})).rejects.toThrow("activation changed")
  expect(await getIdentityReplicaConfigurations(profile.identity.personId)).toEqual([])
  const key = await identityReplicaSetupKey(profile.identity.personId, service.origin)
  expect(JSON.parse((await readLocal(key))!) as unknown).toMatchObject({ stage: "activate" })
  await ensureIdentityReplicaConnection(service, profile, () => {})
  expect(remote.approve).toHaveBeenCalledTimes(1)
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
