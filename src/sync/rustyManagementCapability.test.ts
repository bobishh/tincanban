import { describe, expect, it, vi } from "vitest"
import { sha256Base64Url, signEnvelope, toBase64Url, type SignedEnvelope } from "../domain/identity"
import { verifyRustyManagementCapability, verifyRustyManagementEvidence, type RustyManagementCapability } from "./rustyManagementCapability"

const origin = "https://rusty.example"
const personId = "person-1"
const deviceId = "device-1"
const resourceId = "scope-1"
const expected = { personId, deviceId, resourceKind: "scope" as const, resourceId, operation: "scope.policy", minimumRevision: 2 }

async function fixture() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
  const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)))
  const serviceId = await sha256Base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)))
  const access = { origin, servicePublicKey: publicKey }
  const payload: RustyManagementCapability = {
    kind: "rusty-scope-management-capability", version: 1, serviceId, origin, personId,
    resourceKind: "scope", resourceId, revision: 2,
    operations: ["management.update", "scope.policy"], revokedDeviceIds: [],
    requestId: "request-1", authorizationHash: "A".repeat(43), issuedAt: 1_800_000_000_000,
  }
  const sign = (body: RustyManagementCapability | (RustyManagementCapability & Record<string, unknown>) = payload) =>
    signEnvelope(pair.privateKey, body, serviceId, "RUSTY/2")
  return { access, pair, serviceId, payload, sign }
}

describe("Rusty management capability codec", () => {
  it("Given a person capability, When its person target and creation right are current, Then verifies it without granting scope rights", async () => {
    const value = await fixture()
    const personPayload = { ...value.payload, kind: "rusty-person-management-capability", resourceKind: "person", resourceId: personId,
      operations: ["management.update", "resource.create"] } as unknown as RustyManagementCapability
    const signed = await value.sign(personPayload)
    const target = { personId, deviceId, resourceKind: "person", resourceId: personId, operation: "resource.create", minimumRevision: 2 } as const
    await expect(verifyRustyManagementCapability(signed, value.access, target as never)).resolves.toMatchObject({
      kind: "rusty-person-management-capability", resourceKind: "person", resourceId: personId,
    })
    await expect(verifyRustyManagementCapability(signed, value.access, { ...target, resourceId: "other-person" } as never)).rejects.toThrow()
    await expect(verifyRustyManagementCapability(signed, value.access, { ...target, resourceKind: "scope", resourceId } as never)).rejects.toThrow()
    await expect(verifyRustyManagementCapability(signed, value.access, { ...target, operation: "scope.policy" } as never)).rejects.toThrow()
    const wrongKind = await value.sign({ ...personPayload, kind: "rusty-scope-management-capability" } as unknown as RustyManagementCapability)
    await expect(verifyRustyManagementCapability(wrongKind, value.access, target as never)).rejects.toThrow()
    const noCreate = await value.sign({ ...personPayload, operations: ["management.update"] })
    await expect(verifyRustyManagementCapability(noCreate, value.access, target as never)).rejects.toThrow()
    const revoked = await value.sign({ ...personPayload, revokedDeviceIds: [deviceId] })
    await expect(verifyRustyManagementCapability(revoked, value.access, target as never)).rejects.toThrow()
  })

  it("Given a service-signed current capability, When pinned bindings match, Then returns verified immutable evidence", async () => {
    const value = await fixture()
    const verified = await verifyRustyManagementCapability(await value.sign(), value.access, expected)
    expect(verified).toMatchObject({ serviceId: value.serviceId, personId, resourceKind: "scope", resourceId, revision: 2 })
  })

  it("Given malformed or extended capability schemas, When decoded, Then fails closed", async () => {
    const value = await fixture()
    await expect(verifyRustyManagementCapability(null, value.access, expected)).rejects.toThrow()
    await expect(verifyRustyManagementCapability(await value.sign({ ...value.payload, injected: true }), value.access, expected)).rejects.toThrow()
    await expect(verifyRustyManagementCapability({ ...await value.sign(), extra: true }, value.access, expected)).rejects.toThrow()
  })

  it("Given a valid signature with mismatched pin, identity, resource, operation, or revision, When checked, Then rejects it", async () => {
    const value = await fixture()
    const signed = await value.sign()
    const anotherPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
    const otherKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", anotherPair.publicKey)))
    await expect(verifyRustyManagementCapability(signed, { ...value.access, servicePublicKey: otherKey }, expected)).rejects.toThrow()
    await expect(verifyRustyManagementCapability(signed, value.access, { ...expected, personId: "other-person" })).rejects.toThrow()
    await expect(verifyRustyManagementCapability(signed, value.access, { ...expected, resourceId: "other-scope" })).rejects.toThrow()
    await expect(verifyRustyManagementCapability(signed, value.access, { ...expected, operation: "snapshot.checkpoint" })).rejects.toThrow()
    await expect(verifyRustyManagementCapability(signed, value.access, { ...expected, minimumRevision: 3 })).rejects.toThrow()
  })

  it("Given stale, revoked, unsorted, duplicate, or unsupported rights, When checked, Then rejects the capability", async () => {
    const value = await fixture()
    const revoked = { ...value.payload, revokedDeviceIds: [deviceId] }
    await expect(verifyRustyManagementCapability(await value.sign(revoked), value.access, expected)).rejects.toThrow()
    for (const operations of [
      ["scope.policy", "management.update"],
      ["management.update", "management.update"],
      ["management.update", "unsupported"],
      ["scope.policy"],
    ]) {
      await expect(verifyRustyManagementCapability(await value.sign({ ...value.payload, operations }), value.access, expected)).rejects.toThrow()
    }
    await expect(verifyRustyManagementCapability(await value.sign({ ...value.payload, revokedDeviceIds: ["z-device", "a-device"] }), value.access, expected)).rejects.toThrow()
    await expect(verifyRustyManagementCapability(await value.sign({ ...value.payload, revision: Number.MAX_SAFE_INTEGER + 1 }), value.access, expected)).rejects.toThrow()
  })

  it("Given payload altered after signing, When verified, Then rejects invalid Ed25519 signature", async () => {
    const value = await fixture()
    const signed = await value.sign()
    const tampered = structuredClone(signed) as SignedEnvelope<RustyManagementCapability>
    tampered.payload.revision += 1
    await expect(verifyRustyManagementCapability(tampered, value.access, expected)).rejects.toThrow(/signature/i)
  })

  it("Given a signed capability revoking this device, When importing evidence, Then accepts the record while authority verification rejects use", async () => {
    const value = await fixture()
    const revoked = await value.sign({ ...value.payload, revokedDeviceIds: [deviceId] })
    const evidence = await verifyRustyManagementEvidence(revoked, value.access, {
      personId, resourceKind: "scope", resourceId, minimumRevision: 2,
    })
    expect(evidence.revokedDeviceIds).toEqual([deviceId])
    await expect(verifyRustyManagementCapability(revoked, value.access, expected)).rejects.toThrow()
    await expect(verifyRustyManagementEvidence({ ...revoked, payload: { ...revoked.payload, injected: true } }, value.access, {
      personId, resourceKind: "scope", resourceId, minimumRevision: 2,
    })).rejects.toThrow()
    await expect(verifyRustyManagementEvidence(await value.sign({ ...value.payload, origin: "https://foreign.example" }), value.access, {
      personId, resourceKind: "scope", resourceId, minimumRevision: 2,
    })).rejects.toThrow()
  })

  it("Given caller-owned capability and expectation mutated during crypto, When verification completes, Then returns the exact validated snapshot", async () => {
    const value = await fixture()
    const signed = await value.sign()
    let entered!: () => void
    const verifying = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const originalVerify = crypto.subtle.verify.bind(crypto.subtle)
    const spy = vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
      const valid = await originalVerify(...args)
      entered()
      await paused
      return valid
    })
    const mutableExpected = { ...expected }
    try {
      const pending = verifyRustyManagementCapability(signed, value.access, mutableExpected)
      await verifying
      signed.payload.resourceId = "other-scope"
      mutableExpected.resourceId = "other-scope"
      release()
      await expect(pending).resolves.toMatchObject({ resourceId, revision: 2 })
    } finally {
      release()
      spy.mockRestore()
    }
  })
})
