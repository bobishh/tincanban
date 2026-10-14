import { expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { readLocal, writeLocal } from "../localDb"
import { recordReplicaPreference, readReplicaPreferences, receiveReplicaPreferences, withIdentityDevicePreferences } from "./identityDevicePreferences"
import type { BlindReplicaConfig } from "./blindReplication"
import type { WorkspaceSetStore } from "./workspaceSet"

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const config: BlindReplicaConfig = { origin: "https://rusty.example", workspaceId: "board", scopeId: token,
  readToken: token, writeToken: token, contentKey: token, servicePublicKey: token, policyRevision: 1,
  keyEpoch: 1, cursor: 19, lastUploaded: token }
const settingsKey = (personId: string) => `tincanban.blind-replicas.v1.${personId}`

it("Given Rusty settings, when another enrolled device receives them, then it starts its own cursor without resetting an existing cursor", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity()
  await writeLocal(settingsKey(profile.identity.personId), JSON.stringify([config]))
  const preferences = await readReplicaPreferences(profile.identity.personId)
  await writeLocal(settingsKey(profile.identity.personId), "[]")
  await receiveReplicaPreferences(profile.identity.personId, preferences)
  expect(JSON.parse((await readLocal(settingsKey(profile.identity.personId)))!)).toEqual([{ ...config, cursor: 0, lastUploaded: "" }])
  await writeLocal(settingsKey(profile.identity.personId), JSON.stringify([config]))
  await receiveReplicaPreferences(profile.identity.personId, preferences)
  expect(JSON.parse((await readLocal(settingsKey(profile.identity.personId)))!)[0].cursor).toBe(19)
})

it("Given a removed Rusty, when an old device replays its settings, then a durable tombstone prevents resurrection", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity()
  await writeLocal(settingsKey(profile.identity.personId), JSON.stringify([config]))
  const old = await readReplicaPreferences(profile.identity.personId)
  await recordReplicaPreference(profile.identity.personId, { ...config, removalPending: true })
  await recordReplicaPreference(profile.identity.personId, config, true)
  await receiveReplicaPreferences(profile.identity.personId, old)
  expect(JSON.parse((await readLocal(settingsKey(profile.identity.personId)))!)).toEqual([])
})

it("Given a different participant, when the session exports mesh metadata, then private Rusty credentials never enter that participant's stream", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity()
  const store = { readMesh: vi.fn(async () => ({ version: 1, peers: [] })) } as unknown as WorkspaceSetStore
  expect(withIdentityDevicePreferences(store, profile, "other-person", "other-device")).toBe(store)
  const samePerson = withIdentityDevicePreferences(store, profile, profile.identity.personId, profile.device.deviceId)
  const packet = await samePerson.readMesh!("board")
  expect(packet).toHaveProperty("identityDevicePreferences")
  await expect(samePerson.mergeMesh!("board", { identityDevicePreferences: { payload: {}, signature: "forged" } })).rejects.toThrow()
})
