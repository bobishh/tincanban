import { afterEach, expect, it, vi } from "vitest"
import * as localDb from "../localDb"
import { deleteLocal, readLocal, writeLocal } from "../localDb"
import { exportIdentityRecoveryEvidence, importIdentityRecoveryEvidence, planIdentityRecoveryImport, validateIdentityRecoveryEvidence } from "./identityRecoveryState"

const personId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const otherPersonId = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
const legacyKey = "tincanban.identity_recovery.v1"
const stateKey = (id: string) => `tincanban.identity-recovery-evidence.v1.${id}`
const base64 = (length: number) => Buffer.from(new Uint8Array(length)).toString("base64url")

function envelope(id = personId, saltByte = 0) {
  return {
    kind: "mesh-identity-recovery",
    version: 3,
    personId: id,
    security: "better",
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600_000, salt: base64(16).replace(/^./, String.fromCharCode(65 + saltByte)) },
    cipher: { name: "AES-GCM", iv: base64(12) },
    ciphertext: base64(48),
  }
}

afterEach(async () => {
  await Promise.all([deleteLocal(legacyKey), deleteLocal(stateKey(personId)), deleteLocal(stateKey(otherPersonId))])
})

it("Given a valid matching legacy envelope, when evidence is exported, then it migrates idempotently and retains the legacy backup", async () => {
  const legacy = envelope()
  await writeLocal(legacyKey, JSON.stringify(legacy))

  expect(await exportIdentityRecoveryEvidence(personId)).toEqual({ personId, envelopes: [legacy] })
  expect(JSON.parse((await readLocal(stateKey(personId)))!).envelopes).toEqual([legacy])
  expect(await readLocal(legacyKey)).toBe(JSON.stringify(legacy))
  expect(await exportIdentityRecoveryEvidence(personId)).toEqual({ personId, envelopes: [legacy] })
})

it("Given a legacy envelope for another identity, when evidence is exported, then it remains private and is not migrated", async () => {
  const legacy = envelope(otherPersonId)
  await writeLocal(legacyKey, JSON.stringify(legacy))

  expect(await exportIdentityRecoveryEvidence(personId)).toEqual({ personId, envelopes: [] })
  expect(await readLocal(stateKey(personId))).toBeNull()
  expect(await readLocal(legacyKey)).toBe(JSON.stringify(legacy))
})

it("Given malformed or future same-person legacy evidence, when exported, then fail visibly and preserve raw evidence", async () => {
  for (const legacy of [
    { ...envelope(), ciphertext: base64(47) },
    { ...envelope(), version: 4 },
  ]) {
    await writeLocal(legacyKey, JSON.stringify(legacy))
    await expect(exportIdentityRecoveryEvidence(personId)).rejects.toThrow()
    expect(await readLocal(legacyKey)).toBe(JSON.stringify(legacy))
    expect(await readLocal(stateKey(personId))).toBeNull()
    await deleteLocal(legacyKey)
  }
})

it("Given no legacy evidence or already migrated evidence, when exported, then perform no storage writes", async () => {
  const updateSpy = vi.spyOn(localDb, "updateLocal")
  expect(await exportIdentityRecoveryEvidence(personId)).toEqual({ personId, envelopes: [] })
  expect(updateSpy).not.toHaveBeenCalled()

  await writeLocal(legacyKey, JSON.stringify(envelope()))
  await exportIdentityRecoveryEvidence(personId)
  updateSpy.mockClear()
  await exportIdentityRecoveryEvidence(personId)
  expect(updateSpy).not.toHaveBeenCalled()
  updateSpy.mockRestore()
})

it("Given a required recovery component, when preflight validates it, then return validated cloned envelopes without storage access", async () => {
  const item = envelope()
  const input = { personId, envelopes: [item] }
  const readSpy = vi.spyOn(localDb, "readLocal")
  const updateSpy = vi.spyOn(localDb, "updateLocal")
  const validated = validateIdentityRecoveryEvidence(personId, input)
  item.ciphertext = base64(47)
  expect(validated).toEqual([envelope()])
  expect(readSpy).not.toHaveBeenCalled()
  expect(updateSpy).not.toHaveBeenCalled()
  readSpy.mockRestore()
  updateSpy.mockRestore()
})

it("Given persisted and legacy evidence, when an import plan is built, then return exact CAS conditions and merged write without mutating storage", async () => {
  const existing = envelope(personId, 0)
  const incoming = { ...envelope(personId, 1), ciphertext: base64(48).replace(/^./, "B") }
  const persisted = JSON.stringify({ version: 1, personId, envelopes: [existing] })
  const legacy = JSON.stringify(incoming)
  await writeLocal(stateKey(personId), persisted)
  await writeLocal(legacyKey, legacy)

  const plan = await planIdentityRecoveryImport(personId, { personId, envelopes: [existing] })

  expect(plan.conditions).toEqual([
    { key: stateKey(personId), value: persisted },
    { key: legacyKey, value: legacy },
  ])
  expect(plan.writes).toHaveLength(1)
  expect(plan.writes[0]?.key).toBe(stateKey(personId))
  expect(JSON.parse(plan.writes[0]!.value!).envelopes).toHaveLength(2)
  expect(await readLocal(stateKey(personId))).toBe(persisted)
})

it("Given a malformed incoming bundle, when a plan is requested, then reject before reading local state", async () => {
  const readSpy = vi.spyOn(localDb, "readLocal")
  await expect(planIdentityRecoveryImport(personId, { personId, envelopes: [envelope(otherPersonId)] })).rejects.toThrow()
  expect(readSpy).not.toHaveBeenCalled()
  readSpy.mockRestore()
})

it("Given caller-owned evidence changes while local reads are pending, when planning, then use the invocation snapshot", async () => {
  const originalRead = localDb.readLocal
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const readSpy = vi.spyOn(localDb, "readLocal").mockImplementation(async key => {
    await blocked
    return originalRead(key)
  })
  const input = { personId, envelopes: [envelope()] }
  const planning = planIdentityRecoveryImport(personId, input)
  input.envelopes[0]!.ciphertext = base64(47)
  release()

  const plan = await planning
  expect(plan.writes).toHaveLength(1)
  expect(JSON.parse(plan.writes[0]!.value!).envelopes).toEqual([envelope()])
  readSpy.mockRestore()
})

it("Given an already imported evidence set, when a plan is requested, then return conditions without redundant writes", async () => {
  const item = envelope()
  const raw = JSON.stringify({ version: 1, personId, envelopes: [item] })
  await writeLocal(stateKey(personId), raw)

  const plan = await planIdentityRecoveryImport(personId, { personId, envelopes: [item] })

  expect(plan.conditions).toContainEqual({ key: stateKey(personId), value: raw })
  expect(plan.writes).toEqual([])
})

it("Given two distinct valid envelopes, when imported repeatedly, then both are retained in deterministic order without mutating input", async () => {
  const first = envelope(personId, 0)
  const second = { ...envelope(personId, 1), ciphertext: base64(48).replace(/^./, "B") }
  const bundle = { personId, envelopes: [second, first] }
  const before = structuredClone(bundle)

  await importIdentityRecoveryEvidence(personId, bundle)
  await importIdentityRecoveryEvidence(personId, bundle)

  expect(bundle).toEqual(before)
  const exported = await exportIdentityRecoveryEvidence(personId)
  expect(exported.envelopes).toHaveLength(2)
  expect(new Set(exported.envelopes.map(item => JSON.stringify(item))).size).toBe(2)
  await deleteLocal(stateKey(personId))
  await importIdentityRecoveryEvidence(personId, { personId, envelopes: [first, second] })
  expect((await exportIdentityRecoveryEvidence(personId)).envelopes).toEqual(exported.envelopes)
})

it("Given a bundle with one malformed or foreign envelope, when imported, then reject the whole bundle without writing valid entries", async () => {
  const good = envelope()
  for (const bad of [
    { ...envelope(), version: 2 },
    envelope(otherPersonId),
    { ...envelope(), kdf: { ...envelope().kdf, iterations: 1 } },
    { ...envelope(), ciphertext: base64(47) },
  ]) {
    await expect(importIdentityRecoveryEvidence(personId, { personId, envelopes: [good, bad] })).rejects.toThrow()
    expect(await readLocal(stateKey(personId))).toBeNull()
  }
})

it("Given a pre-existing envelope and an import exceeding local bounds, when imported, then the prior set remains intact", async () => {
  const first = envelope()
  await importIdentityRecoveryEvidence(personId, { personId, envelopes: [first] })
  const before = await readLocal(stateKey(personId))
  const tooMany = Array.from({ length: 33 }, (_, index) => ({
    ...envelope(), ciphertext: Buffer.from(`cipher-${index}`).toString("base64url").padEnd(64, "A"),
  }))

  await expect(importIdentityRecoveryEvidence(personId, { personId, envelopes: tooMany })).rejects.toThrow()
  expect(await readLocal(stateKey(personId))).toBe(before)
})
