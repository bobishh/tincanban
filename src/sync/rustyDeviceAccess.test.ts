import type * as BlindClient from "./blindClient"
import { afterEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { setReplicaPreference } from "./privateReplicaRepository"
import { migrateRustyDeviceAccess } from "./rustyDeviceAccess"

const service = vi.hoisted(() => ({ discover: vi.fn(), person: vi.fn(), scope: vi.fn() }))
vi.mock("./blindClient", async original => ({ ...await original<typeof BlindClient>(), discoverBlindKeeper: service.discover }))
vi.mock("./rustyManagementClient", () => ({ ensureRustyPersonPolicy: service.person, resolveRustyManagementAuthority: service.scope }))
afterEach(() => { vi.clearAllMocks(); resetIdentityStorageForTest() })

async function fixture() {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const config = { origin: "https://rusty.example", workspaceId: "board", scopeId: "preserved-scope",
    servicePublicKey: profile.device.publicKey, readToken: "A".repeat(43), writeToken: "B".repeat(43), contentKey: "A".repeat(43),
    keyEpoch: 3, policyRevision: 4, cursor: 19, lastUploaded: "A".repeat(43) }
  await setReplicaPreference(profile.identity.personId, config)
  const doc = { id: "board", ownerPersonId: profile.identity.personId }
  const app = { getCurrentProfile: () => profile, readWorkspaceDoc: vi.fn(async () => doc) }
  service.discover.mockResolvedValue({ ...config, personManagement: 1, scopeManagement: 1 })
  service.person.mockResolvedValue({ payload: { revision: 1 } })
  service.scope.mockResolvedValue({ payload: { revision: 1 } })
  return { profile, config, doc, app }
}

it("Given explicit device-access migration on a pinned connection, when the owner confirms, then update only person/scope authority and preserve credentials/cursors/device identity", async () => {
  const f = await fixture()
  const { getReplicaConfigurations } = await import("./privateReplicaRepository")
  const before = await getReplicaConfigurations(f.profile.identity.personId)
  await migrateRustyDeviceAccess(f.app as never, f.config.origin, "board", () => {})
  expect(service.person).toHaveBeenCalledWith(expect.objectContaining({ origin: f.config.origin, servicePublicKey: f.config.servicePublicKey }),
    f.profile, true, expect.objectContaining({ allowLegacyMigration: true }))
  expect(service.scope).toHaveBeenCalledWith({ origin: f.config.origin, servicePublicKey: f.config.servicePublicKey,
    resourceKind: "scope", resourceId: f.config.scopeId }, f.profile, "scope.policy", true, expect.any(Object))
  expect(await getReplicaConfigurations(f.profile.identity.personId)).toEqual(before)
  expect((await bootstrapIdentity()).certificate).toEqual(f.profile.certificate)
})

it("Given a changed server pin or lost workspace ownership, when migration is requested, then do not publish any permission update", async () => {
  const f = await fixture()
  service.discover.mockResolvedValueOnce({ origin: f.config.origin, servicePublicKey: "A".repeat(43), personManagement: 1, scopeManagement: 1 })
  await expect(migrateRustyDeviceAccess(f.app as never, f.config.origin, "board", () => {})).rejects.toThrow(/pin/i)
  expect(service.person).not.toHaveBeenCalled()
  f.doc.ownerPersonId = "another-owner"
  await expect(migrateRustyDeviceAccess(f.app as never, f.config.origin, "board", () => {})).rejects.toThrow(/owner/i)
  expect(service.person).not.toHaveBeenCalled()
})

it("Given ownership changes after person migration, when scope migration continues, then retain the confirmed person policy but refuse the obsolete workspace action", async () => {
  const f = await fixture()
  service.person.mockImplementationOnce(async () => { f.doc.ownerPersonId = "new-owner" })
  await expect(migrateRustyDeviceAccess(f.app as never, f.config.origin, "board", () => {})).rejects.toThrow(/owner/i)
  expect(service.scope).not.toHaveBeenCalled()
})

it("Given connection credentials change during person migration, when scope migration continues, then stop rather than approving a superseded connection", async () => {
  const f = await fixture()
  service.person.mockImplementationOnce(async () => { await setReplicaPreference(f.profile.identity.personId, { ...f.config, readToken: "C".repeat(43) }) })
  await expect(migrateRustyDeviceAccess(f.app as never, f.config.origin, "board", () => {})).rejects.toThrow(/connection changed/i)
  expect(service.scope).not.toHaveBeenCalled()
})
