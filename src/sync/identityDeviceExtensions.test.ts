import { beforeEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault } from "../domain/proofs"
import { defaultStorage } from "../storage"
import * as local from "../localDb"
import { readIdentityStateRevision } from "../identityStateRevision"
import { applyIdentityDeviceTransfer, createIdentityDeviceTransfer, readIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { planIdentityDeviceExtensionsImport } from "./identityDeviceExtensions"

beforeEach(() => resetIdentityStorageForTest())

async function fixture() {
  const owner = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  await defaultStorage.savePersonalRoot(root)
  const manifest = await createIdentityDeviceTransfer(root, [owner.certificate])
  return { owner, root, manifest }
}

it("Given an authenticated optional future component, when activating and later exporting, then preserve its exact schema and value", async () => {
  const { owner, root, manifest } = await fixture()
  const future = { schema: "future-settings@7", required: false, value: { personId: owner.identity.personId,
    marker: "retained", nested: { observations: ["one", "two"] } } }
  manifest.components.futureSettings = future
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(manifest, owner.identity.personId), () => {})
  const exported = await createIdentityDeviceTransfer(root, [owner.certificate])
  expect(exported.components.preservedExtensions).toEqual({ schema: "preserved-identity-components@1", required: false,
    value: { personId: owner.identity.personId, extensions: [{ name: "futureSettings", component: future }] } })
  expect(exported.components.futureSettings).toBeUndefined()
})

it("Given concurrent incompatible optional variants, when importing in either order and repeating delivery, then retain both with one stable representation", async () => {
  const { owner, root, manifest } = await fixture()
  const first = structuredClone(manifest), second = structuredClone(manifest)
  first.components.futureSettings = { schema: "future-settings@1", required: false, value: { setting: "first" } }
  second.components.futureSettings = { schema: "future-settings@2", required: false, value: { setting: "second" } }
  const activate = async (value: typeof manifest) => applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(value, owner.identity.personId), () => {})
  await activate(first); await activate(second)
  const exported = await createIdentityDeviceTransfer(root, [owner.certificate])
  expect(exported.components.preservedExtensions.value.extensions).toHaveLength(2)
  await activate(exported); await activate(first)
  expect(await createIdentityDeviceTransfer(root, [owner.certificate])).toEqual(exported)
  await local.deleteLocal(`tincanban.identity-device-extensions.v1.${owner.identity.personId}`)
  await activate(second); await activate(first)
  expect(await createIdentityDeviceTransfer(root, [owner.certificate])).toEqual(exported)
})

it("Given activation aborts, when installing optional state, then retain previous extensions and all required state", async () => {
  const { owner, root, manifest } = await fixture()
  manifest.components.futureSettings = { schema: "future-settings@1", required: false, value: { marker: "incoming" } }
  const key = `tincanban.identity-device-extensions.v1.${owner.identity.personId}`
  const before = await local.readLocal(key)
  const transfer = await readIdentityDeviceTransfer(manifest, owner.identity.personId)
  const failure = vi.spyOn(local, "compareAndSwapLocal").mockRejectedValueOnce(new Error("transaction aborted"))
  try { await expect(applyIdentityDeviceTransfer(transfer, () => {})).rejects.toThrow("transaction aborted") }
  finally { failure.mockRestore() }
  expect(await local.readLocal(key)).toBe(before)
  expect(await defaultStorage.loadPersonalRoot(root.rootId)).toEqual(root)
})

it("Given malformed stored optional state, when importing, then fail without overwriting the retained bytes or catalog", async () => {
  const { owner, root, manifest } = await fixture()
  const key = `tincanban.identity-device-extensions.v1.${owner.identity.personId}`
  await local.writeLocal(key, "unreadable retained component")
  const transfer = await readIdentityDeviceTransfer(manifest, owner.identity.personId)
  await expect(applyIdentityDeviceTransfer(transfer, () => {})).rejects.toThrow(/extension|component/i)
  expect(await local.readLocal(key)).toBe("unreadable retained component")
  expect(await defaultStorage.loadPersonalRoot(root.rootId)).toEqual(root)
})

it("Given only optional portable content changes, when activating, then invalidate identity replication once and retain the revision on duplicate delivery", async () => {
  const { owner, manifest } = await fixture()
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(manifest, owner.identity.personId), () => {})
  const before = await readIdentityStateRevision()
  manifest.components.futureSettings = { schema: "future-settings@1", required: false, value: { marker: "new" } }
  const transfer = await readIdentityDeviceTransfer(manifest, owner.identity.personId)
  await applyIdentityDeviceTransfer(transfer, () => {})
  const next = await readIdentityStateRevision()
  expect(next).not.toBe(before)
  expect(Number(next.split(":").at(-1)) - Number(before.split(":").at(-1))).toBe(1)
  await applyIdentityDeviceTransfer(transfer, () => {})
  expect(await readIdentityStateRevision()).toBe(next)
})

it("Given an optional container smuggles required state or raw keys, when preflighting, then reject the complete bundle", async () => {
  const { owner, manifest } = await fixture()
  manifest.components.preservedExtensions = { schema: "preserved-identity-components@1", required: false,
    value: { personId: owner.identity.personId, extensions: [{ name: "identityCatalog", component: manifest.components.identityCatalog }] } }
  await expect(readIdentityDeviceTransfer(manifest, owner.identity.personId)).rejects.toThrow(/extension|component/i)
  manifest.components.preservedExtensions.value.extensions = [{ name: "future", component: {
    schema: "future@1", required: false, value: { privateKey: "secret" } } }]
  await expect(readIdentityDeviceTransfer(manifest, owner.identity.personId)).rejects.toThrow(/private key/i)
})

it("Given the extension registry has 256 distinct variants, when repeating the full manifest, then retain exact state without a false quota failure", async () => {
  const { owner, root, manifest } = await fixture()
  for (let index = 0; index < 256; index++) manifest.components[`future${index}`] = {
    schema: "future@1", required: false, value: { marker: index },
  }
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(manifest, owner.identity.personId), () => {})
  const exported = await createIdentityDeviceTransfer(root, [owner.certificate])
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(exported, owner.identity.personId), () => {})
  expect(await createIdentityDeviceTransfer(root, [owner.certificate])).toEqual(exported)
  const overflow = structuredClone(exported)
  overflow.components.oneMore = { schema: "future@1", required: false, value: { marker: "overflow" } }
  await expect(readIdentityDeviceTransfer(overflow, owner.identity.personId)).rejects.toThrow(/extension|limit/i)
  expect(await createIdentityDeviceTransfer(root, [owner.certificate])).toEqual(exported)
})

it("Given optional names and nested values contain __proto__ data, when importing and exporting, then retain it without prototype mutation", async () => {
  const { owner, root, manifest } = await fixture()
  const future = JSON.parse('{"schema":"future@1","required":false,"value":{"__proto__":{"marker":"retained"}}}') as typeof manifest.components[string]
  manifest.components = Object.fromEntries([...Object.entries(manifest.components), ["__proto__", future]])
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(manifest, owner.identity.personId), () => {})
  const exported = await createIdentityDeviceTransfer(root, [owner.certificate])
  expect(exported.components.preservedExtensions.value.extensions).toEqual([{ name: "__proto__", component: future }])
  expect(Object.getPrototypeOf(exported.components)).toBe(Object.prototype)
  expect(Object.prototype).not.toHaveProperty("marker")
})

it("Given retained extensions use a newer storage version, when an older reader imports or exports, then preserve bytes and request an upgrade", async () => {
  const { owner, root, manifest } = await fixture()
  const key = `tincanban.identity-device-extensions.v1.${owner.identity.personId}`
  const raw = JSON.stringify({ version: 2, personId: owner.identity.personId, futureLayout: { marker: "retained" } })
  await local.writeLocal(key, raw)
  const transfer = await readIdentityDeviceTransfer(manifest, owner.identity.personId)
  await expect(applyIdentityDeviceTransfer(transfer, () => {})).rejects.toMatchObject({ code: "identity-device-state-upgrade-required" })
  await expect(createIdentityDeviceTransfer(root, [owner.certificate])).rejects.toMatchObject({ code: "identity-device-state-upgrade-required" })
  expect(await local.readLocal(key)).toBe(raw)
})

it("Given another tab imports optional state during activation planning, when compare-and-swap retries, then merge both versions without lost state", async () => {
  const { owner, root, manifest } = await fixture()
  manifest.components.future = { schema: "future@1", required: false, value: { marker: "incoming" } }
  const key = `tincanban.identity-device-extensions.v1.${owner.identity.personId}`
  const concurrent = { name: "future", component: { schema: "future@1", required: false, value: { marker: "other tab" } } }
  const transfer = await readIdentityDeviceTransfer(manifest, owner.identity.personId)
  const original = local.compareAndSwapLocal
  const race = vi.spyOn(local, "compareAndSwapLocal").mockImplementationOnce(async (plan, guard) => {
    await local.writeLocal(key, JSON.stringify({ version: 1, personId: owner.identity.personId, extensions: [concurrent] }))
    return original(plan, guard)
  })
  try { await applyIdentityDeviceTransfer(transfer, () => {}) }
  finally { race.mockRestore() }
  const exported = await createIdentityDeviceTransfer(root, [owner.certificate])
  expect(exported.components.preservedExtensions.value.extensions).toEqual(expect.arrayContaining([
    concurrent, { name: "future", component: manifest.components.future },
  ]))
  expect(exported.components.preservedExtensions.value.extensions).toHaveLength(2)
})

it("Given a future preservation-container schema is optional, when an older device forwards it repeatedly, then keep it opaque without nesting current containers", async () => {
  const { owner, root, manifest } = await fixture()
  const future = { schema: "preserved-identity-components@2", required: false, value: { futureFormat: ["retained"] } }
  manifest.components.preservedExtensions = future
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(manifest, owner.identity.personId), () => {})
  const exported = await createIdentityDeviceTransfer(root, [owner.certificate])
  expect(exported.components.preservedExtensions.value.extensions).toEqual([{ name: "preservedExtensions", component: future }])
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(exported, owner.identity.personId), () => {})
  expect(await createIdentityDeviceTransfer(root, [owner.certificate])).toEqual(exported)
})

it("Given optional data has unsigned extra component fields or another container person, when preflighting, then reject before writes", async () => {
  const { owner, manifest } = await fixture()
  manifest.components.future = { schema: "future@1", required: false, value: { marker: "data" },
    privateKey: "secret outside value" } as typeof manifest.components[string]
  await expect(readIdentityDeviceTransfer(manifest, owner.identity.personId)).rejects.toThrow(/component/i)
  delete manifest.components.future
  manifest.components.preservedExtensions = { schema: "preserved-identity-components@1", required: false,
    value: { personId: "another-person", extensions: [] } }
  await expect(readIdentityDeviceTransfer(manifest, owner.identity.personId)).rejects.toThrow(/extension/i)
})

it("Given caller mutates a manifest while storage is read, when an extension import plan completes, then keep the original person and opaque content binding", async () => {
  const { owner, manifest } = await fixture()
  manifest.components.future = { schema: "future@1", required: false, value: { marker: "original" } }
  const pending = planIdentityDeviceExtensionsImport(manifest)
  manifest.personId = "mutated-person"
  manifest.components.future.value.marker = "mutated value"
  const plan = await pending
  const key = `tincanban.identity-device-extensions.v1.${owner.identity.personId}`
  expect(plan.conditions).toEqual([{ key, value: null }])
  expect(plan.writes).toEqual([{ key, value: expect.any(String) }])
  expect(JSON.parse(plan.writes[0].value!)).toMatchObject({ personId: owner.identity.personId,
    extensions: [{ name: "future", component: { value: { marker: "original" } } }] })
})
