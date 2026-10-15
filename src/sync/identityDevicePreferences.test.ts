import { afterEach, expect, it, vi } from "vitest"
import { BrowserIdentityStore } from "@meta-uber/mesh-identity"
import { adoptEnrolledIdentity, bootstrapIdentity, resetIdentityStorageForTest, toBase64Url, verifyEnvelope } from "../domain/identity"
import type { DeviceCertificate } from "../domain/model"
import { readLocal, writeLocal } from "../localDb"
import { recordReplicaPreference, readReplicaPreferences, receiveReplicaPreferences, withIdentityDevicePreferences } from "./identityDevicePreferences"
import type { BlindReplicaConfig } from "./blindReplication"
import type { WorkspaceSetStore } from "./workspaceSet"
import { getReplicaConfigurations as loadReplicaConfigs } from "./privateReplicaRepository"
import { persistReplicaCursor } from "./identityDevicePreferences"
import { defaultStorage } from "../storage"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault, createDelegatedCertificate, defaultProofStore } from "../domain/proofs"

afterEach(() => vi.restoreAllMocks())

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const config: BlindReplicaConfig = { origin: "https://rusty.example", workspaceId: "board", scopeId: token,
  readToken: token, writeToken: token, contentKey: token, servicePublicKey: token, policyRevision: 1,
  keyEpoch: 1, cursor: 19, lastUploaded: token }
const settingsKey = (personId: string) => `tincanban.blind-replicas.v1.${personId}`
const stateKey = (personId: string) => `tincanban.private-replica-state.v2.${personId}`

it("Given Rusty settings, when another enrolled device receives them, then it starts its own cursor without resetting an existing cursor", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity()
  await writeLocal(settingsKey(profile.identity.personId), JSON.stringify([config]))
  const preferences = await readReplicaPreferences(profile.identity.personId)
  expect(preferences).toMatchObject({ version: 3, personId: profile.identity.personId })
  // A fresh enrolled device has no repository or legacy cursor.
  await writeLocal(settingsKey(profile.identity.personId), "[]")
  await writeLocal(stateKey(profile.identity.personId), "")
  await receiveReplicaPreferences(profile.identity.personId, preferences)
  const selected = (await loadReplicaConfigs(profile.identity.personId))[0]
  expect(selected).toMatchObject({ ...config, cursor: 0, lastUploaded: "" })
  await persistReplicaCursor(profile.identity.personId, { ...selected, cursor: 19, lastUploaded: token }, () => {})
  await receiveReplicaPreferences(profile.identity.personId, preferences)
  expect((await loadReplicaConfigs(profile.identity.personId))[0].cursor).toBe(19)
  expect(await readLocal(settingsKey(profile.identity.personId))).toBe("[]")
})

it("Given a removed Rusty, when an old device replays its settings, then a durable tombstone prevents resurrection", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity()
  await writeLocal(settingsKey(profile.identity.personId), JSON.stringify([config]))
  const old = await readReplicaPreferences(profile.identity.personId)
  await recordReplicaPreference(profile.identity.personId, { ...config, removalPending: true })
  await recordReplicaPreference(profile.identity.personId, config, true)
  await receiveReplicaPreferences(profile.identity.personId, old)
  expect(await loadReplicaConfigs(profile.identity.personId)).toEqual([])
  expect(await readLocal(settingsKey(profile.identity.personId))).toBe(JSON.stringify([config]))
})

it("Given a migrated repository, when an old device sends a wall-clock preference array, then require an update without mutating credentials", async () => {
  const owner = crypto.randomUUID()
  await recordReplicaPreference(owner, config)
  const before = await readReplicaPreferences(owner)
  await expect(receiveReplicaPreferences(owner, [{ origin: config.origin, scopeId: config.scopeId, changedAt: 9999999999999, config: null }])).rejects.toThrow(/update/i)
  expect(await readReplicaPreferences(owner)).toEqual(before)
})

it("Given a different participant, when the session exports mesh metadata, then private Rusty credentials never enter that participant's stream", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity()
  const store = { readMesh: vi.fn(async () => ({ version: 1, peers: [] })) } as unknown as WorkspaceSetStore
  expect(withIdentityDevicePreferences(store, profile, "other-person", "other-device")).toBe(store)
  await defaultStorage.savePersonalRoot(createPersonalRoot(profile, await certHashDefault(profile.certificate)))
  const samePerson = withIdentityDevicePreferences(store, profile, profile.identity.personId, profile.device.deviceId)
  const packet = await samePerson.readMesh!("board")
  expect(packet).toHaveProperty("identityDevicePreferences")
  expect((packet as { identityDevicePreferences: { payload: { version: number; state: unknown } } }).identityDevicePreferences.payload)
    .toMatchObject({ version: 3, state: { kind: "identity-device-state", version: 1 } })
  await expect(samePerson.mergeMesh!("board", { identityDevicePreferences: { payload: {}, signature: "forged" } })).rejects.toThrow()
})

it("Given an enrolled device without a root private key, when exporting private state, then include its complete verified issuer chain", async () => {
  resetIdentityStorageForTest()
  const recipient = await bootstrapIdentity("Enrolled device")
  const values = new Map<string, string>()
  const owner = await new BrowserIdentityStore({ storageKey: "isolated-owner", storage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  } }).bootstrap("Owner")
  const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, recipient.device.deviceId, recipient.device.publicKey, await certHashDefault(owner.certificate))
  await defaultProofStore.putCertificate(await certHashDefault(owner.certificate), owner.certificate)
  const profile = await adoptEnrolledIdentity(owner.identity, certificate)
  await defaultStorage.savePersonalRoot(createPersonalRoot(profile, await certHashDefault(certificate)))
  const session = withIdentityDevicePreferences({ readMesh: async () => ({ peers: [] }) } as unknown as WorkspaceSetStore,
    profile, profile.identity.personId, profile.device.deviceId)

  const { identityDevicePreferences: record } = await session.readMesh!("board") as {
    identityDevicePreferences: { payload: { kind: "identity-device-preferences"; certificates: DeviceCertificate[] }; signerKeyId: string; signature: string }
  }
  expect(profile.privateKeys.identityPrivateKey).toBeUndefined()
  expect(record.payload.certificates).toEqual([certificate, owner.certificate])
  expect(await verifyEnvelope(record, recipient.device.publicKey)).toBe(true)
})

it("Given a revoked device session, when private metadata is requested, then disclose no packet and do not read shared metadata", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity()
  const readMesh = vi.fn(async () => ({ peers: [] }))
  const store = { readMesh } as unknown as WorkspaceSetStore
  const revoked = withIdentityDevicePreferences(store, profile, profile.identity.personId, profile.device.deviceId, () => false)
  await expect(revoked.readMesh!("board")).rejects.toThrow(/session|authorized/i)
  expect(readMesh).not.toHaveBeenCalled()
})

it("Given authorization expires while metadata is read, when export resumes, then return no private state", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity()
  await defaultStorage.savePersonalRoot(createPersonalRoot(profile, await certHashDefault(profile.certificate)))
  let current = true
  const store = { readMesh: async () => { current = false; return { peers: [] } } } as unknown as WorkspaceSetStore
  const session = withIdentityDevicePreferences(store, profile, profile.identity.personId, profile.device.deviceId, () => current)
  await expect(session.readMesh!("board")).rejects.toThrow(/session|authorized/i)
})

async function replaceDurableDeviceKey() {
  const raw = await readLocal("tincanban.local_profile.v1")
  if (!raw) throw new Error("Expected persisted local profile")
  const stored = JSON.parse(raw) as { privateKeys: { devicePrivateKeyPkcs8: string } }
  const replacement = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  stored.privateKeys.devicePrivateKeyPkcs8 = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", replacement.privateKey)))
  await writeLocal("tincanban.local_profile.v1", JSON.stringify(stored))
}

it("Given a cached device profile whose durable key was replaced, when exporting private settings, then return no signed packet or shared metadata", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity()
  await defaultStorage.savePersonalRoot(createPersonalRoot(profile, await certHashDefault(profile.certificate)))
  const readMesh = vi.fn(async () => ({ peers: [] }))
  const session = withIdentityDevicePreferences({ readMesh } as unknown as WorkspaceSetStore,
    profile, profile.identity.personId, profile.device.deviceId)
  await replaceDurableDeviceKey()

  await expect(session.readMesh!("board")).rejects.toThrow(/stale|key|identity/i)
  expect(readMesh).not.toHaveBeenCalled()
})

it("Given the durable key changes during private settings signing, when crypto completes, then emit no private packet", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity()
  await defaultStorage.savePersonalRoot(createPersonalRoot(profile, await certHashDefault(profile.certificate)))
  const nativeSign = crypto.subtle.sign.bind(crypto.subtle)
  let replaced = false
  vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
    const payload = new TextDecoder().decode(args[2] as Uint8Array)
    if (payload.includes('"kind":"identity-device-preferences"')) {
      replaced = true
      await replaceDurableDeviceKey()
    }
    return nativeSign(...args)
  })
  const session = withIdentityDevicePreferences({ readMesh: async () => ({ peers: [] }) } as unknown as WorkspaceSetStore,
    profile, profile.identity.personId, profile.device.deviceId)

  await expect(session.readMesh!("board")).rejects.toThrow(/stale|key|identity/i)
  expect(replaced).toBe(true)
})

it("Given shared metadata acquisition switches the active identity, when exporting private settings, then emit no packet for the former identity", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity()
  await defaultStorage.savePersonalRoot(createPersonalRoot(profile, await certHashDefault(profile.certificate)))
  const readMesh = vi.fn(async () => {
    resetIdentityStorageForTest()
    await bootstrapIdentity("Replacement identity")
    return { peers: [] }
  })
  const session = withIdentityDevicePreferences({ readMesh } as unknown as WorkspaceSetStore,
    profile, profile.identity.personId, profile.device.deviceId)

  await expect(session.readMesh!("board")).rejects.toThrow(/stale|key|identity/i)
  expect(readMesh).toHaveBeenCalledOnce()
})

it("Given a forged private packet alongside valid mesh data, when receiving metadata, then reject before merging any side effects", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity()
  const mergeMesh = vi.fn(async () => {})
  const store = { mergeMesh } as unknown as WorkspaceSetStore
  const session = withIdentityDevicePreferences(store, profile, profile.identity.personId, profile.device.deviceId)
  await expect(session.mergeMesh!("board", { peers: [], identityDevicePreferences: { payload: {}, signature: "forged" } })).rejects.toThrow()
  expect(mergeMesh).not.toHaveBeenCalled()
})
