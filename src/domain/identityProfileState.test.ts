import { beforeEach, expect, it } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "./identity"
import { resolveSigningContext, signWithContext } from "./signingContext"
import { certHashDefault, createDelegatedCertificate } from "./proofs"
import { createIdentityProfileOperation, emptyIdentityProfileState, identityProfileValue,
  mergeIdentityProfileState, observeLegacyIdentityProfile, readIdentityProfileState } from "./identityProfileState"

beforeEach(resetIdentityStorageForTest)
const photo = { avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA", changedAt: "2099-01-01T00:00:00.000Z" }
async function context(profile: LocalProfile) {
  return resolveSigningContext({ profile, certificates: [profile.certificate], purpose: "identity-profile-update",
    binding: { personId: profile.identity.personId }, authorityRevision: "current", current: async () => ({
      personId: profile.identity.personId, deviceId: profile.device.deviceId, authorityRevision: "current",
    }) })
}
async function fixture() {
  const profile = await bootstrapIdentity("Owner")
  return { profile, identity: profile.identity, context: await context(profile), state: emptyIdentityProfileState(profile.identity.personId) }
}

async function secondContext(owner: LocalProfile) {
  resetIdentityStorageForTest()
  const fresh = await bootstrapIdentity("Second device")
  const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, fresh.device.deviceId, fresh.device.publicKey, await certHashDefault(owner.certificate))
  const profile = { ...fresh, identity: owner.identity, certificate, privateKeys: { devicePrivateKey: fresh.privateKeys.devicePrivateKey } }
  return resolveSigningContext({ profile, certificates: [certificate, owner.certificate], purpose: "identity-profile-update",
    binding: { personId: owner.identity.personId }, authorityRevision: "current", current: async () => ({
      personId: owner.identity.personId, deviceId: fresh.device.deviceId, authorityRevision: "current",
    }) })
}

it("Given a signed update supersedes an original observation, when transfer omits that history, then reject missing profile evidence", async () => {
  const f = await fixture(), observed = await observeLegacyIdentityProfile(f.state, f.identity, "name", "Original")
  const operation = await createIdentityProfileOperation(f.context, observed, f.identity, "name", "Chosen")
  await expect(readIdentityProfileState({ ...f.state, operations: [operation] }, f.identity)).rejects.toThrow(/missing.*profile.*observation/i)
  await expect(readIdentityProfileState({ ...observed, operations: [operation] }, f.identity)).resolves.toMatchObject({ legacy: observed.legacy })
})

it("Given a valid signer references a name observation from a photo update, when admitting it, then reject the cross-field supersession", async () => {
  const f = await fixture(), observed = await observeLegacyIdentityProfile(f.state, f.identity, "name", "Original")
  const operation = await createIdentityProfileOperation(f.context, observed, f.identity, "name", "Chosen")
  const changed = { ...operation, signed: await signWithContext(f.context, { ...operation.signed.payload, field: "photo" as const, value: photo }) }
  await expect(readIdentityProfileState({ ...observed, operations: [changed] }, f.identity)).rejects.toThrow(/profile.*observation.*field/i)
})

it("Given two certified devices edit independently, when states merge and an explicit save observes both, then preserve concurrent values until the signed resolution", async () => {
  const f = await fixture(), second = await secondContext(f.profile)
  const a = await createIdentityProfileOperation(f.context, f.state, f.identity, "name", "Alpha")
  const b = await createIdentityProfileOperation(second, f.state, f.identity, "name", "Beta")
  const ab = await mergeIdentityProfileState({ ...f.state, operations: [a] }, { ...f.state, operations: [b] }, f.identity)
  expect(identityProfileValue(ab, "name")).toEqual({ status: "conflict", values: ["Alpha", "Beta"] })
  expect(await mergeIdentityProfileState({ ...f.state, operations: [b] }, { ...f.state, operations: [a] }, f.identity)).toEqual(ab)
  const resolution = await createIdentityProfileOperation(f.context, ab, f.identity, "name", "Resolved")
  const resolved = await readIdentityProfileState({ ...ab, operations: [...ab.operations, resolution] }, f.identity)
  expect(identityProfileValue(resolved, "name")).toEqual({ status: "value", values: ["Resolved"] })
  expect(resolved.operations).toHaveLength(3)
})

it("Given one device signs conflicting bytes for the same counter, when merging, then reject equivocation rather than choosing either value", async () => {
  const f = await fixture()
  const a = await createIdentityProfileOperation(f.context, f.state, f.identity, "name", "Alpha")
  const b = await createIdentityProfileOperation(f.context, f.state, f.identity, "name", "Beta")
  await expect(mergeIdentityProfileState({ ...f.state, operations: [a] }, { ...f.state, operations: [b] }, f.identity))
    .rejects.toThrow("Identity profile device equivocation")
})

it("Given a clock-skewed legacy photo, when an explicit causal removal follows it, then removal wins and replay cannot resurrect the image", async () => {
  const f = await fixture()
  const observed = await observeLegacyIdentityProfile(f.state, f.identity, "photo", photo)
  expect(observed.operations).toEqual([])
  const operation = await createIdentityProfileOperation(f.context, observed, f.identity, "photo", { avatarData: null, changedAt: "2000-01-01T00:00:00.000Z" })
  const changed = await mergeIdentityProfileState(observed, { ...observed, operations: [operation] }, f.identity)
  expect(identityProfileValue(changed, "photo")).toMatchObject({ status: "value", values: [{ avatarData: null }] })
  const replayed = await mergeIdentityProfileState(changed, observed, f.identity)
  expect(identityProfileValue(replayed, "photo")).toEqual(identityProfileValue(changed, "photo"))
})

it("Given incompatible legacy names, when merging in either order, then preserve an explicit conflict without assigning them invented causal revisions", async () => {
  const f = await fixture()
  const a = await observeLegacyIdentityProfile(f.state, f.identity, "name", "First")
  const b = await observeLegacyIdentityProfile(f.state, f.identity, "name", "Second")
  const ab = await mergeIdentityProfileState(a, b, f.identity)
  const ba = await mergeIdentityProfileState(b, a, f.identity)
  expect(ab).toEqual(ba)
  expect(ab.operations).toEqual([])
  expect(identityProfileValue(ab, "name")).toMatchObject({ status: "conflict", values: ["First", "Second"] })
  const resolution = await createIdentityProfileOperation(f.context, ab, f.identity, "name", "Chosen")
  const resolved = await mergeIdentityProfileState(ab, { ...ab, operations: [resolution] }, f.identity)
  expect(identityProfileValue(resolved, "name")).toEqual({ status: "value", values: ["Chosen"] })
})

it("Given concurrent signed profile values, when canonicalizing on a runtime with different locale collation, then produce the same ordinal order", async () => {
  const f = await fixture(), second = await secondContext(f.profile)
  const a = await createIdentityProfileOperation(f.context, f.state, f.identity, "name", "Zeta")
  const b = await createIdentityProfileOperation(second, f.state, f.identity, "name", "Alpha")
  const original = Object.getOwnPropertyDescriptor(String.prototype, "localeCompare")!
  Object.defineProperty(String.prototype, "localeCompare", { configurable: true, value() {
    throw new Error("Locale-dependent sorting is forbidden for portable profile state")
  } })
  try {
    const merged = await mergeIdentityProfileState({ ...f.state, operations: [a] }, { ...f.state, operations: [b] }, f.identity)
    expect(merged.operations.map(operation => operation.signed.payload.deviceId)).toEqual(
      [...merged.operations.map(operation => operation.signed.payload.deviceId)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0))
    expect(identityProfileValue(merged, "name").values).toEqual(["Alpha", "Zeta"])
  } finally {
    Object.defineProperty(String.prototype, "localeCompare", original)
  }
})

it("Given a signed name update, when the next update observes it, then retain original signed evidence and select only the causal successor", async () => {
  const f = await fixture()
  const first = await createIdentityProfileOperation(f.context, f.state, f.identity, "name", "First")
  const initial = await mergeIdentityProfileState(f.state, { ...f.state, operations: [first] }, f.identity)
  const second = await createIdentityProfileOperation(f.context, initial, f.identity, "name", "Second")
  const next = await mergeIdentityProfileState(initial, { ...initial, operations: [first, second] }, f.identity)
  expect(next.operations).toHaveLength(2)
  expect(identityProfileValue(next, "name")).toEqual({ status: "value", values: ["Second"] })
  expect(await mergeIdentityProfileState(next, initial, f.identity)).toEqual(next)
})

it("Given forged signed bytes, missing causal evidence or newer state, when reading, then reject without modifying the supplied recovery bytes", async () => {
  const f = await fixture()
  const first = await createIdentityProfileOperation(f.context, f.state, f.identity, "name", "First")
  const state = { ...f.state, operations: [first] }
  const forged = structuredClone(state)
  forged.operations[0].signed.payload.value = "Tampered"
  await expect(readIdentityProfileState(forged, f.identity)).rejects.toThrow(/signature/i)
  const second = await createIdentityProfileOperation(f.context, state, f.identity, "name", "Second")
  await expect(readIdentityProfileState({ ...f.state, operations: [second] }, f.identity)).rejects.toThrow(/causal evidence/i)
  const future = { ...state, version: 2 }
  const before = JSON.stringify(future)
  await expect(readIdentityProfileState(future, f.identity)).rejects.toMatchObject({ code: "identity-profile-upgrade-required" })
  expect(JSON.stringify(future)).toBe(before)
})
