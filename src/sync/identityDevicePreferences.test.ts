import { afterEach, expect, it, vi } from "vitest"
import { BrowserIdentityStore } from "@meta-uber/mesh-identity"
import { adoptEnrolledIdentity, bootstrapIdentity, publicKeyId, resetIdentityStorageForTest, signEnvelope, toBase64Url, verifyEnvelope } from "../domain/identity"
import type { DeviceCertificate } from "../domain/model"
import { deleteLocal, readLocal, writeLocal } from "../localDb"
import { recordReplicaPreference, readReplicaPreferences, receiveReplicaPreferences, withIdentityDevicePreferences } from "./identityDevicePreferences"
import type { BlindReplicaConfig } from "./blindReplication"
import type { WorkspaceSetStore } from "./workspaceSet"
import { getReplicaConfigurations as loadReplicaConfigs } from "./privateReplicaRepository"
import { persistReplicaCursor } from "./identityDevicePreferences"
import { defaultStorage } from "../storage"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault, createDelegatedCertificate, defaultProofStore } from "../domain/proofs"
import { confirmIdentityAuthorityFixture, createAuthorizedIdentityDeviceTransferFixture as createIdentityDeviceTransfer } from "./identityAuthority.testSupport"
import * as identityDeviceTransfer from "./identityDeviceTransfer"
import { RustyManagementRepository } from "./rustyManagementRepository"
import { subscribeIdentityDevicePreferences } from "./identityDevicePreferenceEvents"
import { readIdentityStateRevision } from "../identityStateRevision"

afterEach(() => vi.restoreAllMocks())

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const config: BlindReplicaConfig = { origin: "https://rusty.example", workspaceId: "board", scopeId: token,
  readToken: token, writeToken: token, contentKey: token, servicePublicKey: token, policyRevision: 1,
  keyEpoch: 1, cursor: 19, lastUploaded: token }
const stateKey = (personId: string) => `tincanban.private-replica-state.v2.${personId}`

it("Given Rusty settings, when another enrolled device receives them, then it starts its own cursor without resetting an existing cursor", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity()
  await recordReplicaPreference(profile.identity.personId, config)
  const preferences = await readReplicaPreferences(profile.identity.personId)
  expect(preferences).toMatchObject({ version: 3, personId: profile.identity.personId })
  // A fresh enrolled device has no local replica progress.
  await deleteLocal(stateKey(profile.identity.personId))
  await receiveReplicaPreferences(profile.identity.personId, preferences)
  const selected = (await loadReplicaConfigs(profile.identity.personId))[0]
  expect(selected).toMatchObject({ ...config, cursor: 0, lastUploaded: "" })
  await persistReplicaCursor(profile.identity.personId, { ...selected, cursor: 19, lastUploaded: token }, () => {})
  await receiveReplicaPreferences(profile.identity.personId, preferences)
  expect((await loadReplicaConfigs(profile.identity.personId))[0].cursor).toBe(19)
})

it("Given a removed Rusty, when an old device replays its settings, then a durable tombstone prevents resurrection", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity()
  await recordReplicaPreference(profile.identity.personId, config)
  const old = await readReplicaPreferences(profile.identity.personId)
  await recordReplicaPreference(profile.identity.personId, { ...config, removalPending: true })
  await recordReplicaPreference(profile.identity.personId, config, true)
  await receiveReplicaPreferences(profile.identity.personId, old)
  expect(await loadReplicaConfigs(profile.identity.personId)).toEqual([])
})

it("Given the current repository, when an old device sends a wall-clock preference array, then require an update without mutating credentials", async () => {
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
  await confirmIdentityAuthorityFixture((await defaultStorage.loadPersonalRoot())!, [profile.certificate])
  const samePerson = withIdentityDevicePreferences(store, profile, profile.identity.personId, profile.device.deviceId)
  const packet = await samePerson.readMesh!("board")
  expect(packet).toHaveProperty("identityDevicePreferences")
  const record = (packet as { identityDevicePreferences: { payload: { kind: string; version: number; state: unknown; certificates: DeviceCertificate[]; delegation?: unknown }; signerKeyId: string; signature: string } }).identityDevicePreferences
  expect(record.payload)
    .toMatchObject({ version: 3, state: { kind: "identity-device-state", version: 1 } })
  expect(record.payload).not.toHaveProperty("delegation")
  expect(record.signerKeyId).toBe(profile.device.deviceId)
  expect(record.payload.certificates).toContainEqual(profile.certificate)
  expect(await verifyEnvelope(record, profile.device.publicKey)).toBe(true)
  await expect(samePerson.mergeMesh!("board", { identityDevicePreferences: { payload: {}, signature: "forged" } })).rejects.toThrow()
})

async function enrolledPreferenceFixture() {
  resetIdentityStorageForTest()
  const recipientDevice = await bootstrapIdentity("Enrolled device")
  const values = new Map<string, string>()
  const owner = await new BrowserIdentityStore({ storageKey: "isolated-preference-owner", storage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  } }).bootstrap("Owner")
  const recipientCertificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, recipientDevice.device.deviceId, recipientDevice.device.publicKey, await certHashDefault(owner.certificate))
  await defaultProofStore.putCertificate(await certHashDefault(owner.certificate), owner.certificate)
  const profile = await adoptEnrolledIdentity(owner.identity, recipientCertificate)
  const root = createPersonalRoot(profile, await certHashDefault(recipientCertificate))

  const extraKeys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const extraPublicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", extraKeys.publicKey)))
  const extraDeviceId = await publicKeyId(extraPublicKey)
  const extraCertificate = await signEnvelope(owner.privateKeys.identityPrivateKey!, {
    kind: "device-certificate" as const, version: 1 as const, personId: profile.identity.personId,
    deviceId: extraDeviceId, devicePublicKey: extraPublicKey, issuerCertificateHash: null, canEnrollDevices: false,
  }, profile.identity.personId) as unknown as DeviceCertificate
  root.devices[extraDeviceId] = { deviceId: extraDeviceId, publicKey: extraPublicKey, displayName: "Recovered device",
    certificateHash: await certHashDefault(extraCertificate), addedAt: new Date(0).toISOString() }
  await defaultStorage.savePersonalRoot(root)

  const state = await createIdentityDeviceTransfer(root, [owner.certificate, recipientCertificate, extraCertificate])
  const makeRecord = async (delegation: unknown) => signEnvelope(owner.privateKeys.devicePrivateKey, {
    kind: "identity-device-preferences" as const, version: 3 as const, personId: profile.identity.personId,
    certificates: [owner.certificate], state, delegation,
  }, owner.device.deviceId)
  return { profile, owner, recipientCertificate, extraCertificate, extraDeviceId, makeRecord }
}

async function revokeRustyDevice(profile: Awaited<ReturnType<typeof bootstrapIdentity>>, remoteDeviceId: string) {
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const servicePublicKey = toBase64Url(publicBytes)
  const serviceId = await (await import("../domain/identity")).sha256Base64Url(publicBytes)
  const origin = "https://rusty.example"
  const capability = await signEnvelope(service.privateKey, { kind: "rusty-person-management-capability" as const, version: 1 as const,
    serviceId, origin, personId: profile.identity.personId, resourceKind: "person" as const,
    resourceId: profile.identity.personId, revision: 1, operations: ["management.update"], revokedDeviceIds: [remoteDeviceId],
    requestId: "exchange-revocation", authorizationHash: await (await import("../domain/identity")).sha256Base64Url(new TextEncoder().encode("authorization")),
    issuedAt: Date.now() }, serviceId, "RUSTY/2")
  await new RustyManagementRepository(profile.identity.personId).observe({ origin, servicePublicKey,
    resourceKind: "person", resourceId: profile.identity.personId }, capability)
}

it("Given an already applied signed identity transfer, When a mesh session repeats it, Then retain authority checks without notifying another Rusty sync", async () => {
  const fixture = await enrolledPreferenceFixture()
  const session = withIdentityDevicePreferences({ mergeMesh: async () => {} } as unknown as WorkspaceSetStore,
    fixture.profile, fixture.profile.identity.personId, fixture.owner.device.deviceId)
  const packet = { peers: [], identityDevicePreferences: await fixture.makeRecord({ obsolete: "ignored" }) }
  await session.mergeMesh!("board", packet)
  const revision = await readIdentityStateRevision()
  const changed = vi.fn()
  const stop = subscribeIdentityDevicePreferences(changed)
  try {
    await session.mergeMesh!("board", packet)
    expect(await readIdentityStateRevision()).toBe(revision)
    expect(changed).not.toHaveBeenCalled()
  } finally { stop() }
})

it("Given a saved person revocation, when reading mesh for that peer, then preserve ordinary mesh while omitting private identity state", async () => {
  const fixture = await enrolledPreferenceFixture()
  await revokeRustyDevice(fixture.profile, fixture.owner.device.deviceId)
  const mesh = { version: 1, peers: [{ id: "board-peer" }] }
  const store = { readMesh: vi.fn(async () => mesh) } as unknown as WorkspaceSetStore
  const session = withIdentityDevicePreferences(store, fixture.profile, fixture.profile.identity.personId, fixture.owner.device.deviceId)
  const value = await session.readMesh!("board") as Record<string, unknown>
  expect(value).toEqual(mesh)
  expect(value).not.toHaveProperty("identityDevicePreferences")
})

it("Given a signed incoming private transfer from a revoked peer, when merging mesh, then skip private activation but retain ordinary mesh merge", async () => {
  const fixture = await enrolledPreferenceFixture()
  await revokeRustyDevice(fixture.profile, fixture.owner.device.deviceId)
  const ordinaryMesh = { version: 1, peers: [{ id: "board-peer" }] }
  const mergeMesh = vi.fn(async () => {})
  const activation = vi.spyOn(identityDeviceTransfer, "applyIdentityDeviceTransfer")
  const session = withIdentityDevicePreferences({ mergeMesh } as unknown as WorkspaceSetStore,
    fixture.profile, fixture.profile.identity.personId, fixture.owner.device.deviceId)
  const record = await fixture.makeRecord({ obsolete: "ignored" })
  await session.mergeMesh!("board", { ...ordinaryMesh, identityDevicePreferences: record })
  expect(mergeMesh).toHaveBeenCalledWith("board", ordinaryMesh)
  expect(activation).not.toHaveBeenCalled()
})

it("Given a valid legacy delegation extra, when receiving same-person state, then keep the enrolled device identity and activate the complete manifest", async () => {
  const fixture = await enrolledPreferenceFixture()
  const { profile, owner, recipientCertificate } = fixture
  const beforeDevice = profile.device
  const beforeDeviceKey = profile.privateKeys.devicePrivateKey
  const beforeRootKey = profile.privateKeys.identityPrivateKey
  const legacyCertificate = await signEnvelope(owner.privateKeys.devicePrivateKey, {
    kind: "device-certificate" as const, version: 1 as const, personId: profile.identity.personId,
    deviceId: profile.device.deviceId, devicePublicKey: profile.device.publicKey,
    issuerCertificateHash: await certHashDefault(owner.certificate), canEnrollDevices: false,
  }, owner.device.deviceId) as unknown as DeviceCertificate
  const record = await fixture.makeRecord({ certificate: legacyCertificate, certificates: [owner.certificate] })
  expect(await verifyEnvelope(record, owner.device.publicKey)).toBe(true)
  const mergeMesh = vi.fn(async () => {})
  const session = withIdentityDevicePreferences({ mergeMesh } as unknown as WorkspaceSetStore,
    profile, profile.identity.personId, owner.device.deviceId)

  await session.mergeMesh!("board", { peers: [], identityDevicePreferences: record })

  expect(profile.certificate).toEqual(recipientCertificate)
  expect(profile.device).toBe(beforeDevice)
  expect(profile.privateKeys.devicePrivateKey).toBe(beforeDeviceKey)
  expect(profile.privateKeys.identityPrivateKey).toBe(beforeRootKey)
  expect((await defaultStorage.loadPersonalRoot())?.devices[fixture.extraDeviceId]).toMatchObject({
    deviceId: fixture.extraDeviceId, certificateHash: await certHashDefault(fixture.extraCertificate),
  })
  expect(mergeMesh).toHaveBeenCalledOnce()
})

it("Given a signed packet with a forged obsolete delegation extra, when receiving it, then verify the packet but grant no certificate authority", async () => {
  const fixture = await enrolledPreferenceFixture()
  const { profile, owner, recipientCertificate } = fixture
  const forgedCertificate = { payload: { kind: "device-certificate", version: 1, personId: profile.identity.personId,
    deviceId: profile.device.deviceId, devicePublicKey: profile.device.publicKey, issuerCertificateHash: null, canEnrollDevices: true },
    signerKeyId: owner.device.deviceId, signature: "forged-signature" }
  const record = await fixture.makeRecord({ certificate: forgedCertificate, certificates: [owner.certificate] })
  expect(await verifyEnvelope(record, owner.device.publicKey)).toBe(true)
  const mergeMesh = vi.fn(async () => {})
  const session = withIdentityDevicePreferences({ mergeMesh } as unknown as WorkspaceSetStore,
    profile, profile.identity.personId, owner.device.deviceId)

  await session.mergeMesh!("board", { peers: [], identityDevicePreferences: record })

  expect(profile.certificate).toEqual(recipientCertificate)
  expect((await defaultProofStore.listCertificates()).some(certificate => certificate.signature === "forged-signature")).toBe(false)
  expect((await defaultStorage.loadPersonalRoot())?.devices[fixture.extraDeviceId]).toBeDefined()
  expect(mergeMesh).toHaveBeenCalledOnce()
})

it.each([1, 2])("Given a v%i private preference packet, when receiving it, then require an update before shared mesh side effects", async version => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity()
  const mergeMesh = vi.fn(async () => {})
  const session = withIdentityDevicePreferences({ mergeMesh } as unknown as WorkspaceSetStore,
    profile, profile.identity.personId, "old-device")
  const record = { signerKeyId: "old-device", signature: "legacy-signature",
    payload: { kind: "identity-device-preferences", version, personId: profile.identity.personId,
      ...(version === 1 ? { replicas: [] } : { state: {} }) } }

  await expect(session.mergeMesh!("board", { peers: [], identityDevicePreferences: record }))
    .rejects.toThrow(/needs an update/i)
  expect(mergeMesh).not.toHaveBeenCalled()
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
  await confirmIdentityAuthorityFixture((await defaultStorage.loadPersonalRoot())!, [owner.certificate, certificate])
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
  await confirmIdentityAuthorityFixture((await defaultStorage.loadPersonalRoot())!, [profile.certificate])
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
  await confirmIdentityAuthorityFixture((await defaultStorage.loadPersonalRoot())!, [profile.certificate])
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
  await confirmIdentityAuthorityFixture((await defaultStorage.loadPersonalRoot())!, [profile.certificate])
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
  await confirmIdentityAuthorityFixture((await defaultStorage.loadPersonalRoot())!, [profile.certificate])
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
