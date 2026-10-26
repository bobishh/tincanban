import { beforeEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault } from "../domain/proofs"
import { resolveSigningContext } from "../domain/signingContext"
import { createAuthorizedIdentityDeviceTransferFixture as createIdentityDeviceTransfer } from "./identityAuthority.testSupport"
import { createIdentityReplicaRecord, readIdentityReplicaRecord } from "./identityReplicaProtocol"

beforeEach(() => resetIdentityStorageForTest())

async function fixture() {
  const profile = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(profile, await certHashDefault(profile.certificate))
  root.photo = { avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA", changedAt: "2026-10-14T10:00:00.000Z" }
  const state = await createIdentityDeviceTransfer(root, [profile.certificate])
  const binding = { personId: profile.identity.personId, origin: "https://rusty.example", scopeId: "identity-scope", keyEpoch: 1,
    servicePublicKey: "A".repeat(43) }
  const context = await resolveSigningContext({ profile, certificates: [profile.certificate], purpose: "identity-replica-state",
    binding: { personId: binding.personId, origin: binding.origin, scopeId: binding.scopeId, keyEpoch: binding.keyEpoch },
    authorityRevision: "management-1", current: async () => ({ personId: profile.identity.personId, deviceId: profile.device.deviceId,
      authorityRevision: "management-1" }) })
  return { profile, root, state, binding, context }
}

it("Given an authenticated private snapshot, when the source is unavailable, then validate its complete person state from retained bytes", async () => {
  const f = await fixture()
  const record = await createIdentityReplicaRecord(f.context, f.binding, f.state, 1)
  const persistedBytes = JSON.stringify(record)
  const authorize = vi.fn(async () => {})
  const parsed = await readIdentityReplicaRecord(JSON.parse(persistedBytes), f.binding, authorize)
  expect(parsed.transfer.personalRoot.photo).toEqual(f.root.photo)
  expect(parsed.transfer.manifest.components).toHaveProperty("privateConnections")
  expect(authorize).toHaveBeenCalledWith(f.profile.device.deviceId, 1)
  expect(persistedBytes).not.toMatch(/identityPrivateKey|devicePrivateKey|recoveryKey|privateKeys/)
})

it("Given a snapshot for another person, service, scope or epoch, when receiving, then reject before private-state activation", async () => {
  const f = await fixture()
  const record = await createIdentityReplicaRecord(f.context, f.binding, f.state, 1)
  for (const replacement of [{ personId: "B".repeat(43) }, { origin: "https://other.example" },
    { scopeId: "workspace-scope" }, { keyEpoch: 2 }, { servicePublicKey: "B".repeat(42) + "A" }]) {
    await expect(readIdentityReplicaRecord(record, { ...f.binding, ...replacement }, async () => {})).rejects.toThrow(/binding|scope|identity|service/i)
  }
})

it("Given a revoked signer or altered manifest, when admitting, then reject without returning portable credentials", async () => {
  const f = await fixture()
  const record = await createIdentityReplicaRecord(f.context, f.binding, f.state, 1)
  await expect(readIdentityReplicaRecord(record, f.binding, async () => { throw new Error("device revoked") })).rejects.toThrow("device revoked")
  const forged = structuredClone(record)
  forged.payload.state.components.profileObservations.value.observations = []
  await expect(readIdentityReplicaRecord(forged, f.binding, async () => {})).rejects.toThrow(/signature/i)
})
