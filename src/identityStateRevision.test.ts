import { expect, it, vi } from "vitest"
import * as local from "./localDb"
import { identityStateRevisionKey, readIdentityStateRevision } from "./identityStateRevision"

it("Given one private bundle, when publishing its components, then advance one revision in the same transaction", async () => {
  const key = `tincanban.rusty-management.v1.${crypto.randomUUID()}`
  const before = await readIdentityStateRevision()
  const old = await local.readLocal(key)
  expect(await local.compareAndSwapLocal({ conditions: [{ key, value: old }], writes: [
    { key, value: JSON.stringify({ records: [{ binding: "resource", capability: { revision: 1 } }] }) },
    { key: `tincanban.identity-recovery-evidence.v1.${crypto.randomUUID()}`, value: JSON.stringify({ envelopes: ["wrapped"] }) },
  ] })).toBe(true)
  const next = await readIdentityStateRevision()
  expect(next).not.toBe(before)
  expect(Number(next.split(":").at(-1)) - Number(before.split(":").at(-1))).toBe(1)
})

it("Given local cursor or pending-request progress changes, when saved, then retain the portable-content revision", async () => {
  const owner = crypto.randomUUID()
  const key = `tincanban.private-replica-state.v2.${owner}`
  await local.writeLocal(key, JSON.stringify({ version: 3, personId: owner, entries: [], clock: {}, progress: {} }))
  const before = await readIdentityStateRevision()
  await local.updateLocal(key, raw => JSON.stringify({ ...JSON.parse(raw!), progress: { cursor: 18, pending: "ciphertext" } }))
  expect(await readIdentityStateRevision()).toBe(before)
})

it("Given an unrelated workspace proof changes, when persisted, then invalidate only changes to portable certificates", async () => {
  const key = "tincanban.v1.proof_store"
  const original = await local.readLocal(key)
  try {
    await local.writeLocal(key, JSON.stringify({ certificates: {}, changeProofs: {} }))
    const before = await readIdentityStateRevision()
    await local.updateLocal(key, raw => JSON.stringify({ ...JSON.parse(raw!), changeProofs: { change: "historical-proof" } }))
    expect(await readIdentityStateRevision()).toBe(before)
    await local.updateLocal(key, raw => JSON.stringify({ ...JSON.parse(raw!), certificates: { device: "certificate" } }))
    expect(await readIdentityStateRevision()).not.toBe(before)
  } finally {
    if (original === null) await local.deleteLocal(key)
    else await local.writeLocal(key, original)
  }
})

it("Given a stale bundle or throwing mutation, when publication fails, then preserve both content and its revision", async () => {
  const key = `tincanban.rusty-management.v1.${crypto.randomUUID()}`
  const before = await readIdentityStateRevision()
  expect(await local.compareAndSwapLocal({ conditions: [{ key, value: "stale" }], writes: [{ key, value: "new" }] })).toBe(false)
  await expect(local.updateLocal(key, () => { throw new Error("cancelled") })).rejects.toThrow("cancelled")
  expect(await readIdentityStateRevision()).toBe(before)
  expect(await local.readLocal(key)).toBeNull()
})

it("Given a cached revision is read repeatedly, when polling without changes, then perform no writes", async () => {
  await readIdentityStateRevision()
  const writes = vi.spyOn(local, "updateLocal")
  try {
    const before = await readIdentityStateRevision()
    expect(await readIdentityStateRevision()).toBe(before)
    expect(writes).not.toHaveBeenCalled()
    expect(await local.readLocal(identityStateRevisionKey)).not.toBeNull()
  } finally { writes.mockRestore() }
})
