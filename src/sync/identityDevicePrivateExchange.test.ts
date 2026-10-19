import { afterEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url } from "../domain/identity"
import { writeLocal } from "../localDb"
import { RustyManagementRepository } from "./rustyManagementRepository"
import { prepareReplicaCredentialFreeze, readReplicaCredentialFreeze, replicaCredentialFreezeKey } from "./replicaCredentialFreeze"
import { changeReplicaPreference, emptyPrivateReplicaState, portableReplicaState } from "./privateReplicaPreferences"
import { capturePrivateReplicaConflict, receivePrivateReplicaState, setReplicaPreference } from "./privateReplicaRepository"
import { buildReplicaCredentialConflictRecovery } from "./replicaCredentialConflictRecovery"
import { assertIdentityDevicePrivateExchangeAllowed } from "./identityDevicePrivateExchange"

afterEach(() => { vi.restoreAllMocks(); resetIdentityStorageForTest() })

async function fixture() {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  await writeLocal("tincanban.local_profile.v1", JSON.stringify(profile))
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const serviceBytes = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const servicePublicKey = toBase64Url(serviceBytes)
  const origin = "https://rusty.example"
  const serviceId = await sha256Base64Url(serviceBytes)
  return { profile, service, servicePublicKey, origin, serviceId }
}

async function personCapability(f: Awaited<ReturnType<typeof fixture>>, revokedDeviceId: string) {
  return signEnvelope(f.service.privateKey, { kind: "rusty-person-management-capability" as const, version: 1 as const,
    serviceId: f.serviceId, origin: f.origin, personId: f.profile.identity.personId, resourceKind: "person" as const,
    resourceId: f.profile.identity.personId, revision: 1, operations: ["management.update"], revokedDeviceIds: [revokedDeviceId],
    requestId: "person-policy", authorizationHash: await sha256Base64Url(new TextEncoder().encode("signed-authorization")),
    issuedAt: Date.now() }, f.serviceId, "RUSTY/2")
}

it("Given a saved signed person policy revoking a peer, When private identity state is considered for exchange, Then reject before transfer", async () => {
  const f = await fixture()
  const binding = { origin: f.origin, servicePublicKey: f.servicePublicKey, resourceKind: "person" as const,
    resourceId: f.profile.identity.personId }
  await new RustyManagementRepository(f.profile.identity.personId).observe(binding, await personCapability(f, "revoked-peer"))
  await expect(assertIdentityDevicePrivateExchangeAllowed(f.profile, "revoked-peer", () => {})).rejects.toThrow(/revok|private.*exchange/i)
})

it("Given only a saved signed scope policy revoking a peer, When private identity state is considered for exchange, Then reject", async () => {
  const f = await fixture()
  const capability = await signEnvelope(f.service.privateKey, { kind: "rusty-scope-management-capability" as const, version: 1 as const,
    serviceId: f.serviceId, origin: f.origin, personId: f.profile.identity.personId, resourceKind: "scope" as const,
    resourceId: "scope-1", revision: 2, operations: ["management.update", "scope.policy"], revokedDeviceIds: ["revoked-peer"],
    requestId: "scope-policy", authorizationHash: await sha256Base64Url(new TextEncoder().encode("signed-authorization")),
    issuedAt: Date.now() }, f.serviceId, "RUSTY/2")
  await new RustyManagementRepository(f.profile.identity.personId).observe({ origin: f.origin,
    servicePublicKey: f.servicePublicKey, resourceKind: "scope", resourceId: "scope-1" }, capability)
  await expect(assertIdentityDevicePrivateExchangeAllowed(f.profile, "revoked-peer", () => {})).rejects.toThrow(/revok|private.*exchange/i)
})

it("Given an active credential freeze targeting a peer before server confirmation, When private state is exchanged, Then block its new credentials", async () => {
  const f = await fixture()
  const key = (byte: number) => toBase64Url(new Uint8Array(32).fill(byte))
  const config = { purpose: "workspace" as const, workspaceId: "board", scopeId: "scope-1", origin: f.origin,
    servicePublicKey: f.servicePublicKey, contentKey: key(2), readToken: key(3), writeToken: key(4), keyEpoch: 1,
    policyRevision: 1, cursor: 0, lastUploaded: "", minimumWriterVersion: 2 as const }
  await setReplicaPreference(f.profile.identity.personId, config)
  await prepareReplicaCredentialFreeze(f.profile, f.origin, f.servicePublicKey, "revoked-peer", () => {})
  await expect(assertIdentityDevicePrivateExchangeAllowed(f.profile, "revoked-peer", () => {})).rejects.toThrow(/revok|transition|private.*exchange/i)
})

it("Given a strictly validated conflict freeze, When profile state is published to another device, Then allow exchange without unfreezing ordinary replication", async () => {
  const f = await fixture(), owner = f.profile.identity.personId
  await new RustyManagementRepository(owner).observe({ origin: f.origin, servicePublicKey: f.servicePublicKey,
    resourceKind: "person", resourceId: owner }, await personCapability(f, "different-device"))
  const key = (byte: number) => toBase64Url(new Uint8Array(32).fill(byte))
  const config = { purpose: "workspace" as const, workspaceId: "board", scopeId: "scope-1", origin: f.origin,
    servicePublicKey: f.servicePublicKey, contentKey: key(2), readToken: key(3), writeToken: key(4), keyEpoch: 1,
    policyRevision: 2, cursor: 0, lastUploaded: "", minimumWriterVersion: 2 as const }
  await setReplicaPreference(owner, config)
  await receivePrivateReplicaState(owner, portableReplicaState(changeReplicaPreference(emptyPrivateReplicaState(owner, "remote"),
    { ...config, contentKey: key(5) })))
  const capture = await capturePrivateReplicaConflict(owner, f.origin, config.scopeId)
  const proposal = buildReplicaCredentialConflictRecovery(capture.sourceWire, { origin: f.origin, scopeId: config.scopeId,
    servicePublicKey: f.servicePublicKey, expectedPolicyRevision: 4, freshContentKey: key(6), freshReadToken: key(7), freshWriteToken: key(8) })
  await writeLocal(await replicaCredentialFreezeKey(owner, f.origin), JSON.stringify({ kind: "rusty-credential-conflict-freeze",
    version: 2, id: crypto.randomUUID(), personId: owner, signerDeviceId: f.profile.device.deviceId,
    origin: f.origin, scopeId: config.scopeId, proposal }))

  await expect(assertIdentityDevicePrivateExchangeAllowed(f.profile, "other-device")).resolves.toBeUndefined()
  await expect(setReplicaPreference(owner, config)).rejects.toThrow(/frozen|pending/i)
  const saved = await readReplicaCredentialFreeze(owner, f.origin)
  expect(saved).toMatchObject({ kind: "rusty-credential-conflict-freeze", version: 2 })
  await writeLocal(await replicaCredentialFreezeKey(owner, f.origin), JSON.stringify({ ...saved, version: 99 }))
  await expect(assertIdentityDevicePrivateExchangeAllowed(f.profile, "other-device")).rejects.toThrow(/invalid/i)
})

it("Given a remote session ends during a policy read, When private exchange authorization resumes, Then refuse to publish", async () => {
  const f = await fixture()
  let current = true
  const guard = () => { if (!current) throw new Error("Device session is no longer authorized") }
  const originalExport = RustyManagementRepository.prototype.export
  vi.spyOn(RustyManagementRepository.prototype, "export").mockImplementation(async function (this: RustyManagementRepository) {
    const result = await originalExport.call(this)
    current = false
    return result
  })
  await expect(assertIdentityDevicePrivateExchangeAllowed(f.profile, "peer", guard)).rejects.toThrow(/session.*authorized/i)
})
