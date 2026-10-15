import { beforeEach, describe, expect, it, vi } from "vitest"
import * as local from "../localDb"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "../domain/identity"
import { type ChatAuthority, type ChatRecord } from "../chat/records"
import { createChatRecordFixture as createChatRecord } from "../chat/records.testSupport"
import * as profileObservation from "../chat/privateProfileObservation"
import {
  acknowledgeIdentityProfileProjection,
  planIdentityProfileImport,
  readIdentityProfileQueue,
  type PrivateProfileObservation,
} from "./identityProfileProjectionQueue"
import { identityProfileProjectionKey } from "./identityProfileProjectionState"

beforeEach(() => resetIdentityStorageForTest())

async function signedProfile(): Promise<{ profile: LocalProfile; observation: PrivateProfileObservation }> {
  const profile = await bootstrapIdentity("Alice")
  const authority: ChatAuthority = { publicKey: profile.identity.publicKey, certificates: [profile.certificate] }
  const record = await createChatRecord(profile, [profile.certificate], authority, "chat-room-scope", "chat-profile", "Alice")
  return { profile, observation: { workspaceId: "entitled-document-id", record } }
}

async function publish(plan: Awaited<ReturnType<typeof planIdentityProfileImport>>): Promise<void> {
  expect(await local.compareAndSwapLocal(plan)).toBe(true)
}

describe("identity profile projection queue", () => {
  it("plans the same signed observation as an exact no-op after first publication", async () => {
    const { profile, observation } = await signedProfile()
    const first = await planIdentityProfileImport(profile.identity, [observation])
    expect(first.writes).toHaveLength(1)
    await publish(first)
    const raw = await local.readLocal(identityProfileProjectionKey(profile.identity.personId))

    const duplicate = await planIdentityProfileImport(profile.identity, [observation])
    expect(duplicate.writes).toEqual([])
    expect(duplicate.conditions).toEqual([{ key: identityProfileProjectionKey(profile.identity.personId), value: raw }])
    expect(await local.readLocal(identityProfileProjectionKey(profile.identity.personId))).toBe(raw)
  })

  it("retains the same signed profile separately for distinct entitled document references", async () => {
    const { profile, observation } = await signedProfile()
    const second = { ...observation, workspaceId: "another-entitled-document" }
    await publish(await planIdentityProfileImport(profile.identity, [observation, second]))

    const queue = await readIdentityProfileQueue(profile.identity)
    expect(queue).toHaveLength(2)
    expect(queue.map(item => item.workspaceId).sort()).toEqual([
      "another-entitled-document",
      "entitled-document-id",
    ])
    expect(queue.every(item => item.record.signed.payload.workspaceId === "chat-room-scope")).toBe(true)
  })

  it("retries an acknowledgment CAS after a concurrent import and preserves the other observation", async () => {
    const { profile, observation: first } = await signedProfile()
    const second = { ...first, workspaceId: "second-entitled-document" }
    await publish(await planIdentityProfileImport(profile.identity, [first]))
    const originalCompareAndSwap = local.compareAndSwapLocal
    let imported = false
    const race = vi.spyOn(local, "compareAndSwapLocal").mockImplementation(async (plan, ensureCurrent) => {
      if (!imported) {
        imported = true
        const concurrent = await planIdentityProfileImport(profile.identity, [second])
        expect(await originalCompareAndSwap(concurrent, ensureCurrent)).toBe(true)
      }
      return await originalCompareAndSwap(plan, ensureCurrent)
    })
    try {
      await acknowledgeIdentityProfileProjection(profile.identity, first, () => {})
    } finally {
      race.mockRestore()
    }

    await expect(readIdentityProfileQueue(profile.identity)).resolves.toMatchObject([{ workspaceId: second.workspaceId }])
  })

  it("keeps pending bytes when the identity guard goes stale before acknowledgment commit", async () => {
    const { profile, observation } = await signedProfile()
    await publish(await planIdentityProfileImport(profile.identity, [observation]))
    const key = identityProfileProjectionKey(profile.identity.personId)
    const original = await local.readLocal(key)
    let checks = 0

    await expect(acknowledgeIdentityProfileProjection(profile.identity, observation, () => {
      checks += 1
      if (checks === 2) throw new Error("identity changed")
    })).rejects.toThrow("identity changed")
    expect(checks).toBe(2)
    expect(await local.readLocal(key)).toBe(original)
  })

  it("preserves malformed and newer registry bytes when a reader cannot safely interpret them", async () => {
    const { profile, observation } = await signedProfile()
    const key = identityProfileProjectionKey(profile.identity.personId)
    for (const raw of [
      "{not-json",
      JSON.stringify({ version: 2, personId: profile.identity.personId, futureLayout: { retained: true } }),
    ]) {
      await local.writeLocal(key, raw)
      await expect(planIdentityProfileImport(profile.identity, [observation])).rejects.toThrow()
      await expect(readIdentityProfileQueue(profile.identity)).rejects.toThrow()
      expect(await local.readLocal(key)).toBe(raw)
    }
  })

  it("snapshots identity and observation before waiting on local storage", async () => {
    const { profile, observation } = await signedProfile()
    const identity = { personId: profile.identity.personId, publicKey: profile.identity.publicKey }
    const incoming = [structuredClone(observation)]
    const originalRead = local.readLocal
    let markReadStarted!: () => void
    let releaseRead!: () => void
    const readStarted = new Promise<void>(resolve => { markReadStarted = resolve })
    const readGate = new Promise<void>(resolve => { releaseRead = resolve })
    const delayedRead = vi.spyOn(local, "readLocal").mockImplementation(async key => {
      markReadStarted()
      await readGate
      return await originalRead(key)
    })
    const pending = planIdentityProfileImport(identity, incoming)
    try {
      await readStarted
      identity.personId = "mutated-person"
      identity.publicKey = "mutated-public-key"
      incoming[0]!.workspaceId = "mutated-document"
      incoming[0]!.record.signed.payload.text = "Mallory"
    } finally {
      releaseRead()
    }
    const plan = await pending
    delayedRead.mockRestore()

    expect(plan.writes).toHaveLength(1)
    const stored = JSON.parse(plan.writes[0]!.value!) as { personId: string; observations: PrivateProfileObservation[] }
    expect(stored.personId).toBe(profile.identity.personId)
    expect(stored.observations[0]).toMatchObject({
      workspaceId: observation.workspaceId,
      record: { signed: { payload: { personId: profile.identity.personId, text: "Alice" } } },
    })
  })

  it("rejects an over-quota plan without replacing retained queue bytes", async () => {
    const { profile, observation } = await signedProfile()
    const key = identityProfileProjectionKey(profile.identity.personId)
    const before = "opaque retained queue bytes"
    await local.writeLocal(key, before)
    const verify = vi.spyOn(profileObservation, "verifyPrivateProfileObservation")
      .mockImplementation(async value => structuredClone(value) as ChatRecord)
    try {
      const oversized = Array.from({ length: 513 }, (_, index) => ({
        ...observation,
        workspaceId: `workspace-${index}`,
      }))
      await expect(planIdentityProfileImport(profile.identity, oversized)).rejects.toThrow("Too many pending private profile observations")
    } finally {
      verify.mockRestore()
    }
    expect(await local.readLocal(key)).toBe(before)
  })
})
