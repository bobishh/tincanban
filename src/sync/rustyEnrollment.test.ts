import { afterEach, expect, test, vi } from "vitest"
import { bootstrapIdentity, canonicalizeJson, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url, verifyEnvelope } from "../domain/identity"
import { approveRustyScope } from "./rustyEnrollment"
import type { BlindAccess } from "./blindClient"
import { RustyManagementRepository } from "./rustyManagementRepository"
import { readScopeEnrollmentIntent } from "./rustyEnrollmentJournal"
import { verifySavedScopeEnrollmentConfirmation } from "./rustyEnrollment"

afterEach(() => { vi.unstubAllGlobals(); resetIdentityStorageForTest() })

test("Given a mismatched private key, when connecting Rusty, then no controller evidence is sent", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const other = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const fetch = vi.fn(async () => { throw new Error("Unexpected request") })
  vi.stubGlobal("fetch", fetch)
  const access: BlindAccess = { origin: "http://localhost:8080", scopeId: "opaque-scope", servicePublicKey: profile.device.publicKey,
    readToken: "read-token", writeToken: "write-token", policyRevision: 1 }
  await expect(approveRustyScope(access, { ...profile, privateKeys: { devicePrivateKey: other.privateKey } })).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled()
})

test("Given a migrated scope, when enrolling storage, then send current capability and sign its management revision without legacy fallback", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const servicePublicKey = toBase64Url(raw), serviceId = await sha256Base64Url(raw)
  const access: BlindAccess = { origin: "https://rusty.example", scopeId: "scope-1", servicePublicKey, readToken: "read-token", writeToken: "write-token", policyRevision: 1 }
  const binding = { origin: access.origin, servicePublicKey, resourceKind: "scope" as const, resourceId: access.scopeId }
  const capability = await signEnvelope(service.privateKey, { kind: "rusty-scope-management-capability" as const, version: 1 as const,
    serviceId, origin: access.origin, personId: profile.identity.personId, resourceKind: "scope" as const, resourceId: access.scopeId,
    revision: 2, operations: ["management.update", "scope.policy"], revokedDeviceIds: [], requestId: "policy-request",
    authorizationHash: "A".repeat(43), issuedAt: Date.now() }, serviceId, "RUSTY/2")
  await new RustyManagementRepository(profile.identity.personId).observe(binding, capability)
  let downgrade = false, mutations = 0
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/.well-known/mesh-lighthouse")) return Response.json({ protocolVersions: [2], publicOrigin: access.origin,
      service: { serviceId, publicKey: servicePublicKey }, capabilities: { modes: ["blind"], applicationWrites: false, classification: false,
        ...(downgrade ? {} : { scopeManagement: { version: 1 } }) } })
    const body = JSON.parse(String(init.body))
    const hash = (value: unknown) => sha256Base64Url(new TextEncoder().encode(canonicalizeJson(value)))
    if (url.endsWith("/status")) return Response.json({ capability, migrationPending: false, receipt: await signEnvelope(service.privateKey, {
      kind: "rusty-management-policy-status-receipt", version: 1, serviceId, origin: access.origin, personId: profile.identity.personId,
      deviceId: profile.device.deviceId, resourceKind: "scope", resourceId: access.scopeId, requestId: body.authorization.payload.requestId,
      authorizationHash: await hash(body.authorization), capabilityHash: await hash(capability), revision: 2, migrationPending: false, issuedAt: Date.now(),
    }, serviceId, "RUSTY/2") })
    expect(body.managementCapability).toEqual(capability)
    if (url.endsWith("/challenge")) {
      const issuedAt = Date.now()
      return Response.json({ challenge: await signEnvelope(service.privateKey, {
      kind: "rusty-enrollment-challenge", version: 1, challengeId: "challenge", nonce: "nonce", serviceId,
      publicOrigin: access.origin, scopeId: access.scopeId, personId: profile.identity.personId, deviceId: profile.device.deviceId,
      deviceKeyId: profile.device.deviceId, expectedRevision: 1, issuedAt, expiresAt: issuedAt + 120_000,
    }, serviceId, "RUSTY/2") })
    }
    mutations++
    expect(body.authorization.payload.managementRevision).toBe(2)
    expect(await verifyEnvelope(body.authorization, profile.device.publicKey)).toBe(true)
    return Response.json({ receipt: await signEnvelope(service.privateKey, {
      kind: "rusty-scope-policy-receipt", version: 1, serviceId, scopeId: access.scopeId, personId: profile.identity.personId,
      revision: 2, revoked: false, challengeId: "challenge", authorizationHash: await hash(body.authorization),
    }, serviceId, "RUSTY/2") })
  }))
  expect(await approveRustyScope(access, profile)).toBe(2)
  downgrade = true
  await expect(approveRustyScope(access, profile)).rejects.toThrow(/upgrade|management/i)
  expect(mutations).toBe(1)
})

test("Given a trusted device, when connecting or removing Rusty, then device proof and pinned policy receipt cover exact scope and token commitments", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const servicePublicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey)))
  const serviceId = await sha256Base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey)))
  const access: BlindAccess = { origin: "http://localhost:8080", scopeId: "opaque-scope", servicePublicKey, readToken: "read-token", writeToken: "write-token", policyRevision: 1 }
  let badBinding = false, revision = 0, uploads = 0
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/.well-known/mesh-lighthouse")) return Response.json({ protocolVersions: [2], publicOrigin: access.origin,
      service: { serviceId, publicKey: servicePublicKey }, capabilities: { modes: ["blind"], applicationWrites: false, classification: false } })
    expect(init.headers).not.toHaveProperty("Authorization")
    const body = JSON.parse(String(init.body))
    expect(JSON.stringify(body)).not.toContain("contentKey")
    if (url.endsWith("/challenge")) {
      const issuedAt = Date.now()
      return Response.json({ challenge: await signEnvelope(service.privateKey, {
        kind: "rusty-enrollment-challenge", version: 1, challengeId: "challenge", nonce: "nonce", serviceId,
        publicOrigin: access.origin, scopeId: badBinding ? "other-scope" : access.scopeId,
        personId: profile.identity.personId, deviceId: profile.device.deviceId, deviceKeyId: profile.device.deviceId,
        expectedRevision: revision, issuedAt, expiresAt: issuedAt + 120_000,
      }, serviceId, "RUSTY/2") })
    }
    uploads++
    expect(await verifyEnvelope(body.authorization, profile.certificate.payload.devicePublicKey)).toBe(true)
    expect(body.authorization.payload).toMatchObject({ readTokenHash: await sha256Base64Url(new TextEncoder().encode(access.readToken)), revoked: body.revoked })
    return Response.json({ receipt: await signEnvelope(service.privateKey, {
      kind: "rusty-scope-policy-receipt", version: 1, serviceId, scopeId: access.scopeId,
      personId: profile.identity.personId, revision: ++revision, revoked: body.revoked, challengeId: "challenge",
      authorizationHash: await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(body.authorization))),
    }, serviceId, "RUSTY/2") })
  }))
  expect(await approveRustyScope(access, profile)).toBe(1)
  expect(await approveRustyScope(access, profile, true)).toBe(2)
  badBinding = true
  await expect(approveRustyScope(access, profile)).rejects.toThrow(/challenge/i)
  expect(uploads).toBe(2)
})

test("Given writer policy v2, when enrolling a scope, then authorization and signed receipt bind the minimum writer version", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Writer v2 owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const servicePublicKey = toBase64Url(raw), serviceId = await sha256Base64Url(raw)
  const access: BlindAccess = { origin: "https://rusty.example", scopeId: "scope-writer-v2", servicePublicKey,
    readToken: "read-token", writeToken: "write-token", policyRevision: 1 }
  let writerPolicy: unknown = { version: 1, maximumWriterVersion: 2 }
  let receiptMinimumWriterVersion: unknown = 2
  let expectedRevision = 1
  let requestedRevoked = false
  const requests: string[] = []
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    requests.push(url)
    if (url.endsWith("/.well-known/mesh-lighthouse")) return Response.json({ protocolVersions: [2], publicOrigin: access.origin,
      service: { serviceId, publicKey: servicePublicKey }, capabilities: { modes: ["blind"], applicationWrites: false,
        classification: false, writerPolicy } })
    const body = JSON.parse(String(init.body))
    if (url.endsWith("/challenge")) return Response.json({ challenge: await signEnvelope(service.privateKey, {
      kind: "rusty-enrollment-challenge", version: 1, challengeId: "writer-challenge", nonce: "writer-nonce", serviceId,
      publicOrigin: access.origin, scopeId: access.scopeId, personId: profile.identity.personId, deviceId: profile.device.deviceId,
      deviceKeyId: profile.device.deviceId, expectedRevision, issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
    }, serviceId, "RUSTY/2") })
    expect(body).not.toHaveProperty("minimumWriterVersion")
    expect(body.revoked).toBe(requestedRevoked)
    if (expectedRevision === 1) expect(body.authorization.payload.minimumWriterVersion).toBe(2)
    else expect(body.authorization.payload).not.toHaveProperty("minimumWriterVersion")
    expect(await verifyEnvelope(body.authorization, profile.device.publicKey)).toBe(true)
    return Response.json({ receipt: await signEnvelope(service.privateKey, {
      kind: "rusty-scope-policy-receipt", version: 1, serviceId, scopeId: access.scopeId, personId: profile.identity.personId,
      revision: expectedRevision + 1, revoked: requestedRevoked, challengeId: "writer-challenge", authorizationHash: await sha256Base64Url(
        new TextEncoder().encode(canonicalizeJson(body.authorization))),
      ...(receiptMinimumWriterVersion === undefined ? {} : { minimumWriterVersion: receiptMinimumWriterVersion }),
    }, serviceId, "RUSTY/2") })
  }))
  try {
    expect(await approveRustyScope(access, profile, false, { minimumWriterVersion: 2 })).toBe(2)
    expectedRevision = 2
    requestedRevoked = true
    expect(await approveRustyScope(access, profile, true)).toBe(3)
    requestedRevoked = false
    expectedRevision = 1
    writerPolicy = undefined
    await expect(approveRustyScope(access, profile, false, { minimumWriterVersion: 2 })).rejects.toThrow(/writer|upgrade/i)
    expect(requests.filter(url => url.endsWith("/challenge"))).toHaveLength(2)
    writerPolicy = { version: 1, maximumWriterVersion: 2 }
    receiptMinimumWriterVersion = undefined
    await expect(approveRustyScope(access, profile, false, { minimumWriterVersion: 2 })).rejects.toThrow(/receipt|connection/i)
    expect(requests.filter(url => url.endsWith("/challenge"))).toHaveLength(3)
    expectedRevision = 2
    requestedRevoked = true
    for (const unsupported of [null, 1, 3]) {
      receiptMinimumWriterVersion = unsupported
      await expect(approveRustyScope(access, profile, true)).rejects.toThrow(/receipt|connection/i)
    }
  } finally { vi.unstubAllGlobals() }
})

test("Given an already-v2 Rusty scope, when the owner reaffirms the same policy, then only the exact current-revision receipt is accepted", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("V2 policy owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const servicePublicKey = toBase64Url(raw), serviceId = await sha256Base64Url(raw)
  const access: BlindAccess = { origin: "https://rusty.example", scopeId: "scope-v2-noop", servicePublicKey,
    readToken: "read-token", writeToken: "write-token", policyRevision: 8 }
  let receiptRevision = 8, receiptFloor: unknown = 2, receiptRevoked = false, currentChallenge = "v2-noop"
  let receiptChallenge = currentChallenge, receiptHash: string | undefined
  let receiptServiceId = serviceId, receiptScopeId = access.scopeId, receiptPersonId = profile.identity.personId
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/.well-known/mesh-lighthouse")) return Response.json({ protocolVersions: [2], publicOrigin: access.origin,
      service: { serviceId, publicKey: servicePublicKey }, capabilities: { modes: ["blind"], applicationWrites: false,
        classification: false, writerPolicy: { version: 1, maximumWriterVersion: 2 } } })
    const body = JSON.parse(String(init.body))
    if (url.endsWith("/challenge")) return Response.json({ challenge: await signEnvelope(service.privateKey, {
      kind: "rusty-enrollment-challenge", version: 1, challengeId: currentChallenge, nonce: `nonce-${currentChallenge}`, serviceId,
      publicOrigin: access.origin, scopeId: access.scopeId, personId: profile.identity.personId, deviceId: profile.device.deviceId,
      deviceKeyId: profile.device.deviceId, expectedRevision: 8, issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
    }, serviceId, "RUSTY/2") })
    expect(body.authorization.payload).toMatchObject({ expectedRevision: 8, minimumWriterVersion: 2, revoked: false })
    const exactHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(body.authorization)))
    return Response.json({ receipt: await signEnvelope(service.privateKey, {
      kind: "rusty-scope-policy-receipt", version: 1, serviceId: receiptServiceId, scopeId: receiptScopeId,
      personId: receiptPersonId, revision: receiptRevision, revoked: receiptRevoked,
      challengeId: receiptChallenge, authorizationHash: receiptHash ?? exactHash,
      ...(receiptFloor === undefined ? {} : { minimumWriterVersion: receiptFloor }),
    }, serviceId, "RUSTY/2") })
  }))

  expect(await approveRustyScope(access, profile, false, { minimumWriterVersion: 2 })).toBe(8)
  receiptRevision = 9
  expect(await approveRustyScope(access, profile, false, { minimumWriterVersion: 2 })).toBe(9)
  for (const invalid of [
    () => { receiptRevision = 7 },
    () => { receiptRevision = 10 },
    () => { receiptRevision = 8; receiptFloor = 1 },
    () => { receiptFloor = 2; receiptRevoked = true },
    () => { receiptRevoked = false; receiptServiceId = "C".repeat(43) },
    () => { receiptServiceId = serviceId; receiptScopeId = "other-scope" },
    () => { receiptScopeId = access.scopeId; receiptPersonId = "other-person" },
    () => { receiptPersonId = profile.identity.personId; receiptChallenge = "wrong-challenge" },
    () => { receiptChallenge = crypto.randomUUID(); receiptHash = "A".repeat(43) },
  ]) {
    receiptRevision = 8
    receiptFloor = 2
    receiptRevoked = false
    receiptHash = undefined
    receiptServiceId = serviceId
    receiptScopeId = access.scopeId
    receiptPersonId = profile.identity.personId
    currentChallenge = crypto.randomUUID()
    receiptChallenge = currentChallenge
    invalid()
    await expect(approveRustyScope(access, profile, false, { minimumWriterVersion: 2 })).rejects.toThrow(/receipt|connection/i)
  }
})

test("Given a retained v2 enrollment request, when verifying its signed no-op receipt after restart, then accept only its exact request binding", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Retained no-op owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const servicePublicKey = toBase64Url(raw), serviceId = await sha256Base64Url(raw)
  const access: BlindAccess = { origin: "https://rusty.example", scopeId: "scope-v2-retry", servicePublicKey,
    readToken: "read-token", writeToken: "write-token", policyRevision: 8 }
  const managementBinding = { origin: access.origin, servicePublicKey, resourceKind: "scope" as const, resourceId: access.scopeId }
  const capability = await signEnvelope(service.privateKey, { kind: "rusty-scope-management-capability" as const, version: 1 as const,
    serviceId, origin: access.origin, personId: profile.identity.personId, resourceKind: "scope" as const, resourceId: access.scopeId,
    revision: 2, operations: ["management.update", "scope.policy"], revokedDeviceIds: [], requestId: "saved-policy",
    authorizationHash: "A".repeat(43), issuedAt: Date.now() }, serviceId, "RUSTY/2")
  await new RustyManagementRepository(profile.identity.personId).observe(managementBinding, capability)
  let savedReceipt: Awaited<ReturnType<typeof signEnvelope>> | undefined
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/.well-known/mesh-lighthouse")) return Response.json({ protocolVersions: [2], publicOrigin: access.origin,
      service: { serviceId, publicKey: servicePublicKey }, capabilities: { modes: ["blind"], applicationWrites: false,
        classification: false, scopeManagement: { version: 1 }, scopeEnrollmentRetry: { version: 1 },
        writerPolicy: { version: 1, maximumWriterVersion: 2 } } })
    const body = JSON.parse(String(init.body))
    const hash = (value: unknown) => sha256Base64Url(new TextEncoder().encode(canonicalizeJson(value)))
    if (url.endsWith("/status")) return Response.json({ capability, migrationPending: false, receipt: await signEnvelope(service.privateKey, {
      kind: "rusty-management-policy-status-receipt", version: 1, serviceId, origin: access.origin, personId: profile.identity.personId,
      deviceId: profile.device.deviceId, resourceKind: "scope", resourceId: access.scopeId,
      requestId: body.authorization.payload.requestId, authorizationHash: await hash(body.authorization),
      capabilityHash: await hash(capability), revision: 2, migrationPending: false, issuedAt: Date.now(),
    }, serviceId, "RUSTY/2") })
    if (url.endsWith("/challenge")) return Response.json({ challenge: await signEnvelope(service.privateKey, {
      kind: "rusty-enrollment-challenge", version: 1, challengeId: "retained-noop", nonce: "retained-noop-nonce", serviceId,
      publicOrigin: access.origin, scopeId: access.scopeId, personId: profile.identity.personId, deviceId: profile.device.deviceId,
      deviceKeyId: profile.device.deviceId, expectedRevision: 8, issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
    }, serviceId, "RUSTY/2") })
    const authorizationHash = await hash(body.authorization)
    savedReceipt = await signEnvelope(service.privateKey, { kind: "rusty-scope-policy-receipt", version: 1, serviceId,
      scopeId: access.scopeId, personId: profile.identity.personId, revision: 8, revoked: false,
      challengeId: "retained-noop", authorizationHash, minimumWriterVersion: 2 }, serviceId, "RUSTY/2")
    return Response.json({ receipt: savedReceipt })
  }))
  await expect(approveRustyScope(access, profile, false, { minimumWriterVersion: 2, confirmed: () => {
    throw new Error("simulate interrupted receipt persistence")
  } })).rejects.toThrow(/interrupted/i)
  const binding = { origin: access.origin, scopeId: access.scopeId, servicePublicKey, personId: profile.identity.personId,
    deviceId: profile.device.deviceId, readTokenHash: await sha256Base64Url(new TextEncoder().encode(access.readToken)),
    writeTokenHash: await sha256Base64Url(new TextEncoder().encode(access.writeToken)), revoked: false, minimumWriterVersion: 2 as const }
  const saved = await readScopeEnrollmentIntent(binding)
  expect(saved).toBeDefined()
  expect(await verifySavedScopeEnrollmentConfirmation(access, profile, saved!, savedReceipt)).toEqual(savedReceipt)
})

test("Given identity changes while the challenge is in flight, when enrolling, then scope credentials are never submitted", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Guarded owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const servicePublicKey = toBase64Url(raw), serviceId = await sha256Base64Url(raw)
  const access: BlindAccess = { origin: "https://rusty.example", scopeId: "guarded-scope", servicePublicKey,
    readToken: "read-token", writeToken: "write-token", policyRevision: 1 }
  let current = true
  let puts = 0
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/.well-known/mesh-lighthouse")) return Response.json({ protocolVersions: [2], publicOrigin: access.origin,
      service: { serviceId, publicKey: servicePublicKey }, capabilities: { modes: ["blind"], applicationWrites: false, classification: false } })
    if (url.endsWith("/challenge")) {
      current = false
      return Response.json({ challenge: await signEnvelope(service.privateKey, {
        kind: "rusty-enrollment-challenge", version: 1, challengeId: "guarded-challenge", nonce: "guarded-nonce", serviceId,
        publicOrigin: access.origin, scopeId: access.scopeId, personId: profile.identity.personId,
        deviceId: profile.device.deviceId, deviceKeyId: profile.device.deviceId, expectedRevision: 0,
        issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
      }, serviceId, "RUSTY/2") })
    }
    puts++
    return Response.json({})
  }))
  await expect(approveRustyScope(access, profile, false, { ensureCurrent: () => {
    if (!current) throw new Error("Identity changed")
  } })).rejects.toThrow(/identity changed/i)
  expect(puts).toBe(0)
})

test("Given identity changes after the scope response, when enrollment completes, then it does not report success", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Post-response guard")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const servicePublicKey = toBase64Url(raw), serviceId = await sha256Base64Url(raw)
  const access: BlindAccess = { origin: "https://rusty.example", scopeId: "post-response-scope", servicePublicKey,
    readToken: "read-token", writeToken: "write-token", policyRevision: 1 }
  let current = true
  let puts = 0
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/.well-known/mesh-lighthouse")) return Response.json({ protocolVersions: [2], publicOrigin: access.origin,
      service: { serviceId, publicKey: servicePublicKey }, capabilities: { modes: ["blind"], applicationWrites: false, classification: false } })
    if (url.endsWith("/challenge")) return Response.json({ challenge: await signEnvelope(service.privateKey, {
      kind: "rusty-enrollment-challenge", version: 1, challengeId: "complete-challenge", nonce: "complete-nonce", serviceId,
      publicOrigin: access.origin, scopeId: access.scopeId, personId: profile.identity.personId,
      deviceId: profile.device.deviceId, deviceKeyId: profile.device.deviceId, expectedRevision: 0,
      issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
    }, serviceId, "RUSTY/2") })
    puts++
    const body = JSON.parse(String(init.body))
    return Response.json({ receipt: await signEnvelope(service.privateKey, {
      kind: "rusty-scope-policy-receipt", version: 1, serviceId, scopeId: access.scopeId,
      personId: profile.identity.personId, revision: 1, revoked: false, challengeId: "complete-challenge",
      authorizationHash: await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(body.authorization))),
    }, serviceId, "RUSTY/2").then(receipt => { current = false; return receipt }) })
  }))
  await expect(approveRustyScope(access, profile, false, { ensureCurrent: () => {
    if (!current) throw new Error("Identity changed")
  } })).rejects.toThrow(/identity changed/i)
  expect(puts).toBe(1)
})
