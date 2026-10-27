import "fake-indexeddb/auto"
import { bootstrapConfirmedIdentityFixture as bootstrapIdentity } from "./identityAuthority.testSupport"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createIdentityRecovery, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot, registerWorkspaceInRoot } from "../domain/personalRoot"
import { certHashDefault, defaultProofStore } from "../domain/proofs"
import { defaultStorage } from "../storage"
import * as local from "../localDb"
import { recordReplicaPreference } from "./identityDevicePreferences"
import { getReplicaConfigurations } from "./privateReplicaRepository"
import { createIdentityDeviceRecovery, restoreIdentityDeviceRecovery } from "./identityDeviceRecovery"
import { identityDeviceActivationKey } from "./identityDeviceActivationState"
import { recoverPendingIdentityDeviceActivation } from "./identityDeviceActivationLoader"
import { peerStore } from "./peerStore"

beforeEach(async () => { resetIdentityStorageForTest(); await peerStore.clear() })
afterEach(async () => { await peerStore.clear() })

async function source() {
  const owner = await bootstrapIdentity("Backup owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  registerWorkspaceInRoot(root, "saved-board", "saved-board", "genesis")
  await defaultStorage.savePersonalRoot(root)
  const config = { origin: "https://rusty.example", workspaceId: "saved-board", scopeId: "saved-scope",
    readToken: "A".repeat(43), writeToken: "B".repeat(43), contentKey: "A".repeat(43),
    servicePublicKey: owner.device.publicKey, keyEpoch: 1, policyRevision: 1, cursor: 17, lastUploaded: "D".repeat(43) }
  await recordReplicaPreference(owner.identity.personId, config)
  const backup = await createIdentityDeviceRecovery()
  return { owner, root, config, backup }
}

async function removeSourceState(personId: string) {
  for (const key of await local.listLocalKeys()) {
    if (key.endsWith(personId) || key === "tincanban.v1.personal_roots") await local.deleteLocal(key)
  }
  resetIdentityStorageForTest()
}

it("Given a cold recipient with a different identity, when full recovery is explicitly confirmed, then atomically restore profile/catalog/private connections while retaining recipient-local progress", async () => {
  const { owner, root, config, backup } = await source()
  await removeSourceState(owner.identity.personId)
  const previous = await bootstrapIdentity("Previous local identity")
  const before = await local.readLocal("tincanban.local_profile.v1")
  const restored = await restoreIdentityDeviceRecovery(backup.file, backup.recoveryKey, "Ignored", true)
  expect(restored.identity.personId).toBe(owner.identity.personId)
  expect(restored.device.deviceId).not.toBe(owner.device.deviceId)
  expect(restored.privateKeys.identityPrivateKey).toBeDefined()
  const savedRoot = await defaultStorage.loadPersonalRoot(root.rootId)
  expect(savedRoot?.workspaces["saved-board"]).toEqual(root.workspaces["saved-board"])
  expect(savedRoot?.devices[restored.device.deviceId]?.certificateHash).toBe(await certHashDefault(restored.certificate))
  expect(await getReplicaConfigurations(owner.identity.personId)).toEqual([expect.objectContaining({ ...config, cursor: 0, lastUploaded: "" })])
  expect(await local.readLocal(`tincanban.local_profile.v1.backup.${previous.identity.personId}`)).toBe(before)
})

it("Given a valid backup and unrelated local identity, when replacement is unconfirmed or the atomic transaction aborts, then retain exact old profile and all private state", async () => {
  const { owner, backup } = await source()
  await removeSourceState(owner.identity.personId)
  await bootstrapIdentity("Recipient")
  const before = await local.readLocal("tincanban.local_profile.v1")
  await expect(restoreIdentityDeviceRecovery(backup.file, backup.recoveryKey, "Owner")).rejects.toThrow(/confirm/i)
  const fail = vi.spyOn(local, "compareAndSwapLocal").mockRejectedValueOnce(new Error("atomic commit failed"))
  try {
    await expect(restoreIdentityDeviceRecovery(backup.file, backup.recoveryKey, "Owner", true)).rejects.toThrow("atomic commit failed")
  } finally { fail.mockRestore() }
  expect(await local.readLocal("tincanban.local_profile.v1")).toBe(before)
  expect(await local.readLocal(`tincanban.private-replica-state.v2.${owner.identity.personId}`)).toBeNull()
})

it("Given recovery commits but certificate projection fails, when startup resumes, then finish the durable activation without replacing the recovered device", async () => {
  const { owner, backup } = await source()
  await removeSourceState(owner.identity.personId)
  await bootstrapIdentity("Recipient")
  const fail = vi.spyOn(defaultProofStore, "putCertificate").mockRejectedValueOnce(new Error("proof store unavailable"))
  try { await expect(restoreIdentityDeviceRecovery(backup.file, backup.recoveryKey, "Owner", true)).rejects.toThrow("proof store unavailable") }
  finally { fail.mockRestore() }
  const recovered = await bootstrapIdentity()
  expect(recovered.identity.personId).toBe(owner.identity.personId)
  expect(await local.readLocal(identityDeviceActivationKey(owner.identity.personId))).not.toBeNull()
  await recoverPendingIdentityDeviceActivation(owner.identity.personId, () => {})
  expect(await local.readLocal(identityDeviceActivationKey(owner.identity.personId))).toBeNull()
  expect((await bootstrapIdentity()).device.deviceId).toBe(recovered.device.deviceId)
})

it("Given an older seed-only recovery file, when restoring, then retain its identity-only scope without claiming missing private state", async () => {
  const original = await bootstrapIdentity("Legacy owner")
  const legacy = await createIdentityRecovery()
  resetIdentityStorageForTest()
  await bootstrapIdentity("Recipient")
  const restored = await restoreIdentityDeviceRecovery(legacy.recoveryEnvelope, legacy.recoveryKey, "Legacy owner", true)
  expect(restored.identity.personId).toBe(original.identity.personId)
})
