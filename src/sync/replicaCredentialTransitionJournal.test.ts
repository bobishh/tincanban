import { afterEach, expect, it, vi } from "vitest"
import { IDBFactory } from "fake-indexeddb"
import type { RustyManagementCapability } from "./rustyManagementCapability"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function fixture() {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.resetModules()
  const local = await import("../localDb")
  const identity = await import("../domain/identity")
  const profile = await identity.bootstrapIdentity("owner")
  const repository = await import("./privateReplicaRepository")
  const freezeModule = await import("./replicaCredentialFreeze")
  const journalModule = await import("./replicaCredentialTransitionJournal")
  const key = (byte: number) => identity.toBase64Url(new Uint8Array(32).fill(byte))
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const rawServiceKey = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const servicePublicKey = identity.toBase64Url(rawServiceKey)
  const serviceId = await identity.sha256Base64Url(rawServiceKey)
  const config = { purpose: "workspace" as const, workspaceId: "board", scopeId: "scope", origin: "https://rusty.example",
    servicePublicKey, contentKey: key(2), readToken: key(3), writeToken: key(4), keyEpoch: 1, policyRevision: 1,
    cursor: 0, lastUploaded: "", minimumWriterVersion: 2 as const }
  await repository.setReplicaPreference(profile.identity.personId, config)
  const stored = (await repository.getReplicaConfigurations(profile.identity.personId))[0]!
  const pending = await freezeModule.prepareReplicaCredentialFreeze(profile, stored.origin, stored.servicePublicKey,
    "removed-device", () => {})
  return { local, identity, profile, repository, journalModule, pending, service, serviceId,
    access: { origin: stored.origin, servicePublicKey } }
}

async function personCapability(f: Awaited<ReturnType<typeof fixture>>, revokedDeviceIds: string[]) {
  const payload: RustyManagementCapability = {
    kind: "rusty-person-management-capability", version: 1, serviceId: f.serviceId,
    origin: f.access.origin, personId: f.profile.identity.personId, resourceKind: "person",
    resourceId: f.profile.identity.personId, revision: 1, operations: ["management.update"],
    revokedDeviceIds: [...revokedDeviceIds].sort(), requestId: "request-1",
    authorizationHash: await f.identity.sha256Base64Url(new TextEncoder().encode("authorization")), issuedAt: Date.now(),
  }
  return f.identity.signEnvelope(f.service.privateKey, payload, f.serviceId, "RUSTY/2")
}

async function beginAndCaptureWorkspace(f: Awaited<ReturnType<typeof fixture>>) {
  await f.journalModule.beginCredentialTransitionJournal(f.pending, f.profile, () => {})
  for (const resource of f.pending.resources) {
    if (resource.previous.purpose !== "identity") {
      await f.journalModule.captureCredentialTransitionWorkers(f.pending, f.profile, resource.previous.scopeId, [], () => {})
    }
  }
}

async function enrollmentEvidence(f: Awaited<ReturnType<typeof fixture>>) {
  const signing = await import("../domain/localSigningContext")
  const signingContext = await import("../domain/signingContext")
  const enrollmentJournal = await import("./rustyEnrollmentJournal")
  const resource = f.pending.resources[0]!
  const config = resource.next
  const access = { origin: config.origin, scopeId: config.scopeId, servicePublicKey: config.servicePublicKey,
    readToken: config.readToken, writeToken: config.writeToken }
  const serviceId = f.serviceId
  const challenge = await f.identity.signEnvelope(f.service.privateKey, {
    kind: "rusty-enrollment-challenge", version: 1, challengeId: "transition-challenge", nonce: "transition-nonce",
    serviceId, publicOrigin: access.origin, scopeId: access.scopeId, personId: f.profile.identity.personId,
    deviceId: f.profile.device.deviceId, deviceKeyId: f.profile.device.deviceId, expectedRevision: resource.previous.policyRevision,
    issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
  }, serviceId, "RUSTY/2")
  const managementPayload: RustyManagementCapability = {
    kind: "rusty-scope-management-capability", version: 1, serviceId, origin: access.origin,
    personId: f.profile.identity.personId, resourceKind: "scope", resourceId: access.scopeId, revision: 1,
    operations: ["management.update", "scope.policy"], revokedDeviceIds: [], requestId: "scope-management-request",
    authorizationHash: await f.identity.sha256Base64Url(new TextEncoder().encode("scope-management")), issuedAt: Date.now(),
  }
  const managementCapability = await f.identity.signEnvelope(f.service.privateKey, managementPayload, serviceId, "RUSTY/2")
  const readTokenHash = await f.identity.sha256Base64Url(new TextEncoder().encode(access.readToken))
  const writeTokenHash = await f.identity.sha256Base64Url(new TextEncoder().encode(access.writeToken))
  const minimumWriterVersion = config.purpose === "identity" ? undefined : 2 as const
  const authorizationContext = await signing.resolveLocalSigningContext(f.profile, "rusty-scope-enrollment", {
    scopeId: access.scopeId, publicOrigin: access.origin, serviceId, personId: f.profile.identity.personId,
    deviceId: f.profile.device.deviceId, challengeId: challenge.payload.challengeId, nonce: challenge.payload.nonce,
    ...(minimumWriterVersion === undefined ? {} : { minimumWriterVersion }),
  }, { expiresAt: challenge.payload.expiresAt })
  const authorization = await signingContext.signWithContext(authorizationContext, {
    kind: "rusty-scope-enrollment", version: 1, challengeId: challenge.payload.challengeId, nonce: challenge.payload.nonce,
    serviceId, publicOrigin: access.origin, scopeId: access.scopeId, personId: f.profile.identity.personId,
    deviceId: f.profile.device.deviceId, deviceKeyId: f.profile.device.deviceId,
    expectedRevision: challenge.payload.expectedRevision, readTokenHash, writeTokenHash, revoked: false,
    expiresAt: challenge.payload.expiresAt, ...(minimumWriterVersion === undefined ? {} : { minimumWriterVersion }),
    managementRevision: managementCapability.payload.revision,
  })
  const certificates = signingContext.signingEvidence(authorizationContext).certificates
  const body = JSON.stringify({ challenge, identity: f.profile.identity, deviceId: f.profile.device.deviceId, certificates,
    managementCapability, readToken: access.readToken, writeToken: access.writeToken, revoked: false, authorization })
  const binding = { origin: access.origin, scopeId: access.scopeId, servicePublicKey: access.servicePublicKey,
    personId: f.profile.identity.personId, deviceId: f.profile.device.deviceId, readTokenHash, writeTokenHash,
    revoked: false, ...(minimumWriterVersion === undefined ? {} : { minimumWriterVersion }) }
  await enrollmentJournal.prepareScopeEnrollmentIntent(binding, body, async () => {})
  const authorizationHash = await f.identity.sha256Base64Url(new TextEncoder().encode(f.identity.canonicalizeJson(authorization)))
  const receipt = await f.identity.signEnvelope(f.service.privateKey, {
    kind: "rusty-scope-policy-receipt" as const, version: 1 as const, serviceId, scopeId: access.scopeId,
    personId: f.profile.identity.personId, revision: challenge.payload.expectedRevision + 1, revoked: false,
    challengeId: challenge.payload.challengeId, authorizationHash, minimumWriterVersion,
  }, serviceId, "RUSTY/2")
  return { access, binding, body, receipt }
}

async function fullyConfirmedTransition(f: Awaited<ReturnType<typeof fixture>>) {
  await beginAndCaptureWorkspace(f)
  const capability = await personCapability(f, [f.pending.revokedDeviceId])
  await f.journalModule.confirmCredentialTransitionPerson(f.pending, f.profile, capability, () => {})
  const evidence = await enrollmentEvidence(f)
  await f.journalModule.confirmCredentialTransitionScope(f.pending, f.profile,
    f.pending.resources[0]!.next.scopeId, evidence.receipt, () => {})
  return evidence
}

it("Given a durable credential freeze, When beginning journal recovery twice, Then bind and resume the same empty transition journal", async () => {
  const f = await fixture()
  const first = await f.journalModule.beginCredentialTransitionJournal(f.pending, f.profile, () => {})
  const retry = await f.journalModule.beginCredentialTransitionJournal(f.pending, f.profile, () => {})
  expect(first).toMatchObject({ version: 1, freeze: f.pending, cohorts: [], workers: [], scopes: [] })
  expect(retry).toEqual(first)
  expect(await f.journalModule.readCredentialTransitionJournal(f.profile, f.pending.origin)).toEqual(first)
})

it("Given a valid signed cumulative person capability, When confirming revocation, Then journal the service evidence bound to this frozen person and target", async () => {
  const f = await fixture()
  await beginAndCaptureWorkspace(f)
  const capability = await personCapability(f, ["another-device", f.pending.revokedDeviceId])
  const result = await f.journalModule.confirmCredentialTransitionPerson(f.pending, f.profile, capability, () => {})
  expect(result.person).toEqual(capability)
  expect((await f.journalModule.readCredentialTransitionJournal(f.profile, f.pending.origin))?.person).toEqual(capability)
})

it("Given a signed capability that omits the frozen revoked device, When confirming, Then refuse it without changing the journal", async () => {
  const f = await fixture()
  await beginAndCaptureWorkspace(f)
  const before = await f.journalModule.readCredentialTransitionJournal(f.profile, f.pending.origin)
  const capability = await personCapability(f, ["another-device"])
  await expect(f.journalModule.confirmCredentialTransitionPerson(f.pending, f.profile, capability, () => {}))
    .rejects.toThrow(/revok|target|capability|device/i)
  expect(await f.journalModule.readCredentialTransitionJournal(f.profile, f.pending.origin)).toEqual(before)
})

it("Given a valid service signature for another person, When confirming, Then reject mismatched identity evidence", async () => {
  const f = await fixture()
  await beginAndCaptureWorkspace(f)
  const before = await f.journalModule.readCredentialTransitionJournal(f.profile, f.pending.origin)
  const capability = await personCapability(f, [f.pending.revokedDeviceId])
  const foreign = { ...capability, payload: { ...capability.payload, personId: "another-person", resourceId: "another-person" } }
  // The substituted payload invalidates the signature; verification must fail before journal publication.
  await expect(f.journalModule.confirmCredentialTransitionPerson(f.pending, f.profile, foreign, () => {})).rejects.toThrow()
  expect(await f.journalModule.readCredentialTransitionJournal(f.profile, f.pending.origin)).toEqual(before)
})

it("Given a profile guard that becomes stale, When confirming an otherwise valid capability, Then leave durable journal unchanged", async () => {
  const f = await fixture()
  await beginAndCaptureWorkspace(f)
  const before = await f.journalModule.readCredentialTransitionJournal(f.profile, f.pending.origin)
  const capability = await personCapability(f, [f.pending.revokedDeviceId])
  const guard = () => { throw new Error("Identity changed") }
  await expect(f.journalModule.confirmCredentialTransitionPerson(f.pending, f.profile, capability, guard)).rejects.toThrow("Identity changed")
  expect(await f.journalModule.readCredentialTransitionJournal(f.profile, f.pending.origin)).toEqual(before)
})

it("Given a real saved enrollment request, When a signed receipt confirms its exact rotated tokens, Then retain both request and receipt", async () => {
  const f = await fixture()
  await beginAndCaptureWorkspace(f)
  const capability = await personCapability(f, [f.pending.revokedDeviceId])
  await f.journalModule.confirmCredentialTransitionPerson(f.pending, f.profile, capability, () => {})
  const evidence = await enrollmentEvidence(f)
  const result = await f.journalModule.confirmCredentialTransitionScope(f.pending, f.profile,
    f.pending.resources[0]!.next.scopeId, evidence.receipt, () => {})
  expect(result.scopes).toHaveLength(1)
  expect(result.scopes[0]).toMatchObject({ scopeId: f.pending.resources[0]!.next.scopeId, request: { body: evidence.body }, receipt: evidence.receipt })
})

it("Given a valid receipt for another authorization hash, When confirming the scope, Then reject without consuming its durable exact request", async () => {
  const f = await fixture()
  await beginAndCaptureWorkspace(f)
  const capability = await personCapability(f, [f.pending.revokedDeviceId])
  await f.journalModule.confirmCredentialTransitionPerson(f.pending, f.profile, capability, () => {})
  const evidence = await enrollmentEvidence(f)
  const substituted = await f.identity.signEnvelope(f.service.privateKey,
    { ...evidence.receipt.payload, authorizationHash: await f.identity.sha256Base64Url(new TextEncoder().encode("different-auth")) },
    f.serviceId, "RUSTY/2")
  await expect(f.journalModule.confirmCredentialTransitionScope(f.pending, f.profile,
    f.pending.resources[0]!.next.scopeId, substituted, () => {})).rejects.toThrow(/receipt|confirm|original|authorization/i)
  const stored = await (await import("./rustyEnrollmentJournal")).readScopeEnrollmentIntent(evidence.binding)
  expect(stored?.body).toBe(evidence.body)
  expect((await f.journalModule.readCredentialTransitionJournal(f.profile, f.pending.origin))?.scopes).toEqual([])
})

it("Given the signer device appears in the service revocation set, When confirming person policy, Then reject self-revocation", async () => {
  const f = await fixture()
  await beginAndCaptureWorkspace(f)
  const before = await f.journalModule.readCredentialTransitionJournal(f.profile, f.pending.origin)
  const capability = await personCapability(f, [f.pending.revokedDeviceId, f.profile.device.deviceId])
  await expect(f.journalModule.confirmCredentialTransitionPerson(f.pending, f.profile, capability, () => {})).rejects.toThrow(/authorize|device|revok/i)
  expect(await f.journalModule.readCredentialTransitionJournal(f.profile, f.pending.origin)).toEqual(before)
})

it("Given an incomplete transition journal, When activation is attempted, Then retain the freeze and do not publish credentials", async () => {
  const f = await fixture()
  await beginAndCaptureWorkspace(f)
  const before = await f.repository.getReplicaConfigurations(f.profile.identity.personId)
  await expect(f.journalModule.activateCredentialTransitionJournal(f.profile, f.pending.origin, () => {})).rejects.toThrow()
  expect(await f.repository.getReplicaConfigurations(f.profile.identity.personId)).toEqual(before)
  expect(await (await import("./replicaCredentialFreeze")).readReplicaCredentialFreeze(f.profile.identity.personId, f.pending.origin)).toEqual(f.pending)
  expect((await f.journalModule.readCredentialTransitionJournal(f.profile, f.pending.origin))?.activated).toBeUndefined()
})

it("Given all required signed confirmations, When activation commits, Then publish rotated keys and remove the freeze atomically", async () => {
  const f = await fixture()
  await fullyConfirmedTransition(f)
  const result = await f.journalModule.activateCredentialTransitionJournal(f.profile, f.pending.origin, () => {})
  const [config] = await f.repository.getReplicaConfigurations(f.profile.identity.personId)
  expect(config).toMatchObject({ scopeId: f.pending.resources[0]!.next.scopeId, keyEpoch: 2,
    historicalContentKeys: { "1": f.pending.resources[0]!.previous.contentKey }, lastUploaded: "" })
  expect(config?.readToken).toBe(f.pending.resources[0]!.next.readToken)
  expect(config?.writeToken).toBe(f.pending.resources[0]!.next.writeToken)
  expect(config?.cursor).toBe(f.pending.resources[0]!.previous.cursor)
  expect(result.activated).toEqual([config])
  expect(await (await import("./replicaCredentialFreeze")).readReplicaCredentialFreeze(f.profile.identity.personId, f.pending.origin)).toBeUndefined()
  expect((await f.journalModule.readCredentialTransitionJournal(f.profile, f.pending.origin))?.activated).toEqual([config])
})

it("Given activation storage loses its compare-and-swap, When publishing confirmed credentials, Then preserve source preferences, journal and freeze", async () => {
  const f = await fixture()
  await fullyConfirmedTransition(f)
  const beforeConfigs = await f.repository.getReplicaConfigurations(f.profile.identity.personId)
  const beforeJournal = await f.journalModule.readCredentialTransitionJournal(f.profile, f.pending.origin)
  vi.spyOn(f.local, "compareAndSwapLocal").mockResolvedValueOnce(false)
  await expect(f.journalModule.activateCredentialTransitionJournal(f.profile, f.pending.origin, () => {})).rejects.toThrow(/changed|retry|persist/i)
  expect(await f.repository.getReplicaConfigurations(f.profile.identity.personId)).toEqual(beforeConfigs)
  expect(await f.journalModule.readCredentialTransitionJournal(f.profile, f.pending.origin)).toEqual(beforeJournal)
  expect(await (await import("./replicaCredentialFreeze")).readReplicaCredentialFreeze(f.profile.identity.personId, f.pending.origin)).toEqual(f.pending)
})
