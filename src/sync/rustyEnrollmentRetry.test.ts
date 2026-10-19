import type * as LocalDatabase from "../localDb"
import { afterEach, expect, test, vi } from "vitest"
import { bootstrapIdentity, canonicalizeJson, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url } from "../domain/identity"
import type { LocalProfile } from "../domain/identity"
import * as localDb from "../localDb"
import type { BlindAccess } from "./blindClient"
import { approveRustyScope, readRustyScopePolicyRevision } from "./rustyEnrollment"
import { scopeEnrollmentJournalKey } from "./rustyEnrollmentJournal"

const durableValues = vi.hoisted(() => new Map<string, string>())
vi.mock("../localDb", async importOriginal => {
  const actual = await importOriginal<typeof LocalDatabase>()
  return { ...actual,
    readLocal: vi.fn(async (key: string) => durableValues.get(key) ?? null),
    writeLocal: vi.fn(async (key: string, value: string) => { durableValues.set(key, value) }),
    deleteLocal: vi.fn(async (key: string) => { durableValues.delete(key) }),
    compareAndSwapLocal: vi.fn(async (plan: { conditions: Array<{ key: string; value: string | null }>;
      writes: Array<{ key: string; value: string | null }> }) => {
      if (plan.conditions.some(condition => (durableValues.get(condition.key) ?? null) !== condition.value)) return false
      for (const write of plan.writes) {
        if (write.value === null) durableValues.delete(write.key)
        else durableValues.set(write.key, write.value)
      }
      return true
    }),
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetIdentityStorageForTest()
  durableValues.clear()
})

type HarnessOptions = { retryCapability?: boolean; challenge?: (count: number) => { expectedRevision: number; issuedAt: number; expiresAt: number };
  onPut?: (body: string, count: number, context: {
  profile: LocalProfile; service: CryptoKeyPair; access: BlindAccess; serviceId: string
}) => Promise<Response> }
async function harness(options: HarnessOptions = {}) {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Enrollment retry owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const servicePublicKey = toBase64Url(publicBytes)
  const serviceId = await sha256Base64Url(publicBytes)
  const access: BlindAccess = { origin: "https://rusty.example", scopeId: "retry-scope", servicePublicKey,
    readToken: "r".repeat(43), writeToken: "w".repeat(43), policyRevision: 0 }
  let challengeCount = 0
  const bodies: string[] = []
  let putCount = 0
  const hash = async (value: unknown) => sha256Base64Url(new TextEncoder().encode(canonicalizeJson(value)))
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    if (url.endsWith("/.well-known/mesh-lighthouse")) return Response.json({ protocolVersions: [2], publicOrigin: access.origin,
      service: { serviceId, publicKey: servicePublicKey }, capabilities: { modes: ["blind"], applicationWrites: false,
        classification: false, writerPolicy: { version: 1, maximumWriterVersion: 2 },
        ...(options.retryCapability ? { scopeEnrollmentRetry: { version: 1 } } : {}) } })
    const body = String(init.body)
    if (url.endsWith("/v2/enrollment/challenge")) {
      challengeCount++
      const timing = options.challenge?.(challengeCount) ?? { expectedRevision: 0, issuedAt: Date.now(), expiresAt: Date.now() + 120_000 }
      return Response.json({ challenge: await signEnvelope(service.privateKey, {
        kind: "rusty-enrollment-challenge", version: 1, challengeId: `challenge-${challengeCount}`, nonce: `nonce-${challengeCount}`,
        serviceId, publicOrigin: access.origin, scopeId: access.scopeId, personId: profile.identity.personId,
        deviceId: profile.device.deviceId, deviceKeyId: profile.device.deviceId, ...timing,
      }, serviceId, "RUSTY/2") })
    }
    putCount++
    bodies.push(body)
    if (options.onPut) return options.onPut(body, putCount, { profile, service, access, serviceId })
    const request = JSON.parse(body)
    return Response.json({ receipt: await signEnvelope(service.privateKey, {
      kind: "rusty-scope-policy-receipt", version: 1, serviceId, scopeId: access.scopeId,
      personId: profile.identity.personId, revision: request.authorization.payload.expectedRevision + 1,
      revoked: request.revoked, challengeId: request.challenge.payload.challengeId,
      authorizationHash: await hash(request.authorization),
      ...(request.authorization.payload.minimumWriterVersion === 2 ? { minimumWriterVersion: 2 } : {}),
    }, serviceId, "RUSTY/2") })
  }))
  return { profile, service, access, serviceId, servicePublicKey, bodies, get challengeCount() { return challengeCount },
    get putCount() { return putCount }, disableRetryCapability: () => { options.retryCapability = false } }
}

async function journal(h: Awaited<ReturnType<typeof harness>>) {
  const key = await scopeEnrollmentJournalKey(h.profile.identity.personId, h.access.origin, h.access.scopeId)
  return { key, raw: await localDb.readLocal(key) }
}

test("Given a signed current scope challenge, when reading its revision, then authenticate the pin without replacing tokens or storing an enrollment", async () => {
  const h = await harness({ challenge: () => {
    const issuedAt = Date.now()
    return { expectedRevision: 9, issuedAt, expiresAt: issuedAt + 120_000 }
  } })
  expect(await readRustyScopePolicyRevision(h.access, h.profile, () => {})).toBe(9)
  expect(h.putCount).toBe(0)
  expect(h.challengeCount).toBe(1)
  expect((await journal(h)).raw).toBeNull()
})

test("Given a stale or replaced service pin, when reading scope revision, then reject without policy mutation", async () => {
  const h = await harness()
  await expect(readRustyScopePolicyRevision({ ...h.access, servicePublicKey: "A".repeat(43) }, h.profile, () => {})).rejects.toThrow(/pin|signature/i)
  expect(h.putCount).toBe(0)
})

test("Given a frozen scope revision, When the signed challenge reports a concurrent policy, Then refuse token replacement before saving or uploading the new request", async () => {
  const h = await harness({ retryCapability: true, challenge: () => ({ expectedRevision: 3,
    issuedAt: Date.now(), expiresAt: Date.now() + 120_000 }) })
  await expect(approveRustyScope(h.access, h.profile, false, { requireExactRetry: true, expectedPolicyRevision: 0 }))
    .rejects.toThrow(/revision|concurrent/i)
  expect(h.putCount).toBe(0)
  expect((await journal(h)).raw).toBeNull()
})

test("Given an exact interrupted rotation, When its signed original request matches the frozen revision, Then retain exact retry semantics", async () => {
  const h = await harness({ retryCapability: true, onPut: async () => { throw new Error("Reply lost") } })
  await expect(approveRustyScope(h.access, h.profile, false, { requireExactRetry: true, expectedPolicyRevision: 0 })).rejects.toThrow("Reply lost")
  const original = (await journal(h)).raw
  await expect(approveRustyScope(h.access, h.profile, false, { requireExactRetry: true, expectedPolicyRevision: 1 })).rejects.toThrow(/revision|concurrent/i)
  expect(h.putCount).toBe(1)
  expect((await journal(h)).raw).toBe(original)
})

test("Given an enrollment reply is lost, when a restarted client retries after challenge expiry, then resend the exact saved request", async () => {
  const h = await harness({ retryCapability: true, onPut: async (_body, count, context) => {
    if (count === 1) throw new Error("Reply lost after durable approval")
    const request = JSON.parse(_body)
    return Response.json({ receipt: await signEnvelope(context.service.privateKey, {
      kind: "rusty-scope-policy-receipt", version: 1, serviceId: context.serviceId, scopeId: context.access.scopeId,
      personId: context.profile.identity.personId, revision: 1, revoked: false, challengeId: request.challenge.payload.challengeId,
      authorizationHash: await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(request.authorization))),
    }, context.serviceId, "RUSTY/2") })
  } })
  await expect(approveRustyScope(h.access, h.profile, false, { requireExactRetry: true })).rejects.toThrow(/lost/i)
  const stored = await journal(h)
  expect(stored.raw).not.toBeNull()
  const firstRequest = JSON.parse(stored.raw!).body

  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(Date.now() + 121_000)
  vi.resetModules()
  const restarted = await import("./rustyEnrollment")
  await expect(restarted.approveRustyScope(h.access, h.profile, false, { requireExactRetry: true })).resolves.toBe(1)

  expect(h.challengeCount).toBe(1)
  expect(h.putCount).toBe(2)
  expect(h.bodies[0]).toBe(firstRequest)
  expect(h.bodies[1]).toBe(firstRequest)
  expect((await journal(h)).raw).toBeNull()
})

test("Given local journal preparation fails, when enrollment is attempted, then do not send the scope mutation", async () => {
  const h = await harness({ retryCapability: true })
  const failedWrite = vi.spyOn(localDb, "compareAndSwapLocal").mockRejectedValueOnce(new Error("Journal storage unavailable"))
  try { await expect(approveRustyScope(h.access, h.profile, false, { requireExactRetry: true })).rejects.toThrow(/journal storage/i) }
  finally { failedWrite.mockRestore() }
  expect(h.challengeCount).toBe(1)
  expect(h.putCount).toBe(0)
})

test("Given a confirmed receipt callback fails, when retry succeeds, then keep and reuse the saved request until callback completes", async () => {
  const h = await harness({ retryCapability: true })
  const callback = vi.fn().mockRejectedValueOnce(new Error("Atomic activation failed")).mockResolvedValue(undefined)
  await expect(approveRustyScope(h.access, h.profile, false, { requireExactRetry: true, confirmed: callback }))
    .rejects.toThrow(/activation failed/i)
  const firstBody = h.bodies[0]
  expect((await journal(h)).raw).not.toBeNull()

  await expect(approveRustyScope(h.access, h.profile, false, { requireExactRetry: true, confirmed: callback })).resolves.toBe(1)

  expect(h.challengeCount).toBe(1)
  expect(h.putCount).toBe(2)
  expect(h.bodies[1]).toBe(firstBody)
  expect(callback).toHaveBeenCalledTimes(2)
  expect((await journal(h)).raw).toBeNull()
})

test("Given a signed receipt does not cover the connection, when the service retry returns a valid receipt, then retain and resend the original request", async () => {
  const h = await harness({ retryCapability: true, onPut: async (body, count, context) => {
    const request = JSON.parse(body)
    return Response.json({ receipt: await signEnvelope(context.service.privateKey, {
      kind: "rusty-scope-policy-receipt", version: 1, serviceId: context.serviceId,
      scopeId: count === 1 ? "substituted-scope" : context.access.scopeId, personId: context.profile.identity.personId,
      revision: 1, revoked: false, challengeId: request.challenge.payload.challengeId,
      authorizationHash: await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(request.authorization))),
    }, context.serviceId, "RUSTY/2") })
  } })
  await expect(approveRustyScope(h.access, h.profile, false, { requireExactRetry: true })).rejects.toThrow(/receipt/i)
  const pending = await journal(h)
  expect(pending.raw).not.toBeNull()

  await expect(approveRustyScope(h.access, h.profile, false, { requireExactRetry: true })).resolves.toBe(1)

  expect(h.challengeCount).toBe(1)
  expect(h.putCount).toBe(2)
  expect(h.bodies[1]).toBe(JSON.parse(pending.raw!).body)
  expect((await journal(h)).raw).toBeNull()
})

test("Given an unfinished request, when credentials, device, revocation or writer intent changes, then leave its exact journal entry intact", async () => {
  const h = await harness({ retryCapability: true, onPut: async () => { throw new Error("Lost reply") } })
  await expect(approveRustyScope(h.access, h.profile, false, { requireExactRetry: true })).rejects.toThrow(/lost reply/i)
  const before = await journal(h)
  expect(before.raw).not.toBeNull()
  const changedDevice = { ...h.profile, device: { ...h.profile.device, deviceId: "other-device" } } as LocalProfile
  const changedPin = { ...h.access, servicePublicKey: toBase64Url(new Uint8Array(32).fill(9)) }
  const attempts: Array<() => Promise<unknown>> = [
    () => approveRustyScope({ ...h.access, readToken: "x".repeat(43) }, h.profile, false, { requireExactRetry: true }),
    () => approveRustyScope(h.access, h.profile, true, { requireExactRetry: true }),
    () => approveRustyScope(h.access, h.profile, false, { requireExactRetry: true, minimumWriterVersion: 2 }),
    () => approveRustyScope(changedPin, h.profile, false, { requireExactRetry: true }),
    () => approveRustyScope(h.access, changedDevice, false, { requireExactRetry: true }),
  ]
  for (const attempt of attempts) {
    await expect(attempt()).rejects.toThrow()
    expect((await journal(h)).raw).toBe(before.raw)
  }
  expect(h.challengeCount).toBe(1)
  expect(h.putCount).toBe(1)
  h.disableRetryCapability()
  await expect(approveRustyScope(h.access, h.profile)).rejects.toThrow(/retry|upgrade|pending/i)
  expect(h.challengeCount).toBe(1)
  expect(h.putCount).toBe(1)
  expect((await journal(h)).raw).toBe(before.raw)
})

test("Given corrupt saved intent, when exact retry is required, then reject before challenge or mutation", async () => {
  const h = await harness({ retryCapability: true })
  const key = await scopeEnrollmentJournalKey(h.profile.identity.personId, h.access.origin, h.access.scopeId)
  await localDb.writeLocal(key, JSON.stringify({ version: 1, binding: "invalid-binding", body: "not valid request JSON" }))
  await expect(approveRustyScope(h.access, h.profile, false, { requireExactRetry: true })).rejects.toThrow()
  expect(h.challengeCount).toBe(0)
  expect(h.putCount).toBe(0)
})

test("Given exact retry is required, when discovery lacks the capability, then fail before challenge; legacy enrollment still works by default", async () => {
  const required = await harness({ retryCapability: false })
  await expect(approveRustyScope(required.access, required.profile, false, { requireExactRetry: true })).rejects.toThrow(/retry|upgrade|capability/i)
  expect(required.challengeCount).toBe(0)
  expect(required.putCount).toBe(0)

  vi.unstubAllGlobals()
  const legacy = await harness({ retryCapability: false })
  await expect(approveRustyScope(legacy.access, legacy.profile)).resolves.toBe(1)
  expect(legacy.challengeCount).toBe(1)
  expect(legacy.putCount).toBe(1)
  expect((await journal(legacy)).raw).toBeNull()
})

test("Given an expired pending request was never committed, when Rusty proves the same revision and post-expiry issuance, then replace once and retry", async () => {
  const baseTime = 1_800_000_000_000
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(baseTime)
  let replacementWasDurableBeforePut = false
  const h = await harness({ retryCapability: true, challenge: count => count === 1
    ? { expectedRevision: 0, issuedAt: baseTime, expiresAt: baseTime + 120_000 }
    : { expectedRevision: 0, issuedAt: Date.now(), expiresAt: Date.now() + 120_000 },
  onPut: async (body, count, context) => {
    if (count === 1) throw new Error("Reply lost after server decision")
    if (count === 2) return Response.json({ error: "challenge expired" }, { status: 410 })
    const key = await scopeEnrollmentJournalKey(context.profile.identity.personId, context.access.origin, context.access.scopeId)
    const stored = await localDb.readLocal(key)
    replacementWasDurableBeforePut = stored !== null && JSON.parse(stored).body === body
    const request = JSON.parse(body)
    return Response.json({ receipt: await signEnvelope(context.service.privateKey, {
      kind: "rusty-scope-policy-receipt", version: 1, serviceId: context.serviceId, scopeId: context.access.scopeId,
      personId: context.profile.identity.personId, revision: 1, revoked: false, challengeId: request.challenge.payload.challengeId,
      authorizationHash: await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(request.authorization))),
    }, context.serviceId, "RUSTY/2") })
  } })
  await expect(approveRustyScope(h.access, h.profile, false, { requireExactRetry: true })).rejects.toThrow(/server decision/i)
  const original = JSON.parse((await journal(h)).raw!).body
  vi.setSystemTime(baseTime + 121_000)

  await expect(approveRustyScope(h.access, h.profile, false, { requireExactRetry: true })).resolves.toBe(1)

  expect(h.bodies[1]).toBe(original)
  expect(h.challengeCount).toBe(2)
  expect(h.putCount).toBe(3)
  expect(replacementWasDurableBeforePut).toBe(true)
  expect((await journal(h)).raw).toBeNull()
})

test.each([
  ["revision advanced", (base: number) => ({ expectedRevision: 1, issuedAt: base + 121_000, expiresAt: base + 241_000 })],
  ["fresh challenge predates expiry", (base: number) => ({ expectedRevision: 0, issuedAt: base + 119_999, expiresAt: base + 239_999 })],
] as const)("Given an expired pending request, when fresh challenge evidence says %s, then retain original intent without another mutation", async (_reason, freshTiming) => {
  const baseTime = 1_800_000_000_000
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(baseTime)
  const h = await harness({ retryCapability: true, challenge: count => count === 1
    ? { expectedRevision: 0, issuedAt: baseTime, expiresAt: baseTime + 120_000 }
    : freshTiming(baseTime),
  onPut: async (_body, count) => {
    if (count === 1) throw new Error("Reply lost after server decision")
    if (count === 2) return Response.json({ error: "challenge expired" }, { status: 410 })
    throw new Error("Unexpected replacement request")
  } })
  await expect(approveRustyScope(h.access, h.profile, false, { requireExactRetry: true })).rejects.toThrow(/server decision/i)
  const before = await journal(h)
  expect(before.raw).not.toBeNull()
  vi.setSystemTime(baseTime + 121_000)

  await expect(approveRustyScope(h.access, h.profile, false, { requireExactRetry: true })).rejects.toThrow(/unresolved|retained|original request/i)

  expect(h.bodies[1]).toBe(JSON.parse(before.raw!).body)
  expect(h.challengeCount).toBe(2)
  expect(h.putCount).toBe(2)
  expect((await journal(h)).raw).toBe(before.raw)
})
