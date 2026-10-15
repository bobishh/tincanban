import { describe, expect, it, vi } from "vitest"
import { canonicalizeJson, sha256Base64Url, signEnvelope, toBase64Url, type SignedEnvelope } from "../domain/identity"
import type { RustyManagementCapability } from "./rustyManagementCapability"
import { verifyRustyManagementStatus, type RustyManagementStatusResponse, type ManagementStatusAuthorization, type ManagementStatusReceipt } from "./rustyManagementStatus"

const origin = "https://rusty.example"
const personId = "person-1"
const deviceId = "device-1"
const resourceId = "scope-1"
const expected = { personId, deviceId, resourceKind: "scope" as const, resourceId, operation: "scope.policy", minimumRevision: 1 }
const encoder = new TextEncoder()

async function fixture(resourceKind: "scope" | "board" | "person" = "scope") {
  const servicePair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
  const serviceRaw = new Uint8Array(await crypto.subtle.exportKey("raw", servicePair.publicKey))
  const servicePublicKey = toBase64Url(serviceRaw)
  const serviceId = await sha256Base64Url(serviceRaw)
  const devicePair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
  const access = { origin, servicePublicKey }
  const now = Date.now()
  const targetId = resourceKind === "person" ? personId : resourceId
  const authorizationPayload: ManagementStatusAuthorization = {
    kind: "rusty-management-policy-status", version: 1, serviceId, origin, personId, deviceId,
    resourceKind, resourceId: targetId, requestId: "status-request-1", issuedAt: now - 1, expiresAt: now + 60_000,
  }
  const authorization = await signEnvelope(devicePair.privateKey, authorizationPayload, deviceId, "MATCH/1")
  const capabilityPayload: RustyManagementCapability = {
    kind: resourceKind === "person" ? "rusty-person-management-capability" : "rusty-scope-management-capability", version: 1, serviceId, origin, personId,
    resourceKind, resourceId: targetId, revision: 1,
    operations: resourceKind === "person" ? ["management.update", "resource.create"] : ["management.update", "scope.policy"], revokedDeviceIds: [],
    requestId: "update-request-1", authorizationHash: "A".repeat(43), issuedAt: now - 100,
  }
  const capability = await signEnvelope(servicePair.privateKey, capabilityPayload, serviceId, "RUSTY/2")
  const hash = async (value: unknown) => sha256Base64Url(encoder.encode(canonicalizeJson(value)))
  const response = async (cap: SignedEnvelope<RustyManagementCapability> | null = capability, migrationPending = false) => {
    const receiptPayload: ManagementStatusReceipt = {
      kind: "rusty-management-policy-status-receipt", version: 1, serviceId, origin, personId, deviceId,
      resourceKind, resourceId: targetId, requestId: authorizationPayload.requestId,
      authorizationHash: await hash(authorization), capabilityHash: cap ? await hash(cap) : null,
      revision: cap?.payload.revision ?? 0, migrationPending, issuedAt: now,
    }
    return {
      capability: cap,
      migrationPending,
      receipt: await signEnvelope(servicePair.privateKey, receiptPayload, serviceId, "RUSTY/2"),
    } satisfies RustyManagementStatusResponse
  }
  return { servicePair, access, authorization, authorizationPayload, capability, response, servicePublicKey }
}

describe("Rusty management status verifier", () => {
  it("Given a person-target status request and receipt, When person capability matches exact person ID, Then verifies creation authority", async () => {
    const value = await fixture("person")
    const target = { personId, deviceId, resourceKind: "person", resourceId: personId, operation: "resource.create", minimumRevision: 1 } as const
    await expect(verifyRustyManagementStatus(await value.response(), value.access, target as never, value.authorization))
      .resolves.toMatchObject({ revision: 1, capability: { kind: "rusty-person-management-capability", resourceId: personId } })
    await expect(verifyRustyManagementStatus(await value.response(), value.access, { ...target, resourceId: "another-person" } as never, value.authorization)).rejects.toThrow()
    await expect(verifyRustyManagementStatus(await value.response(), value.access, { ...target, operation: "scope.policy" } as never, value.authorization)).rejects.toThrow()
  })

  it("Given a pinned signed response to the exact status request, When verified, Then returns the confirmed capability and state", async () => {
    const value = await fixture()
    const result = await verifyRustyManagementStatus(await value.response(), value.access, expected, value.authorization)
    expect(result).toMatchObject({ revision: 1, migrationPending: false, capability: { resourceId, revision: 1 } })
  })

  it("Given no capability, When status confirms revision zero, Then allows bootstrap only without a persisted minimum", async () => {
    const value = await fixture()
    const pending = await value.response(null, true)
    await expect(verifyRustyManagementStatus(pending, value.access, { ...expected, minimumRevision: 0 }, value.authorization))
      .resolves.toMatchObject({ capability: null, revision: 0, migrationPending: true })
    await expect(verifyRustyManagementStatus(pending, value.access, expected, value.authorization)).rejects.toThrow()
  })

  it("Given a valid receipt for different authorization or capability bytes, When checked, Then rejects it", async () => {
    const value = await fixture()
    const response = await value.response()
    const changedAuthorization = await signEnvelope(value.servicePair.privateKey, {
      ...value.authorizationPayload, requestId: "different-request",
    }, value.authorization.signerKeyId, "RUSTY/2")
    await expect(verifyRustyManagementStatus(response, value.access, expected, changedAuthorization)).rejects.toThrow()
    const changedCapability = structuredClone(response)
    changedCapability.capability!.payload.revision = 2
    await expect(verifyRustyManagementStatus(changedCapability, value.access, expected, value.authorization)).rejects.toThrow()
  })

  it("Given altered receipt, stale bindings, or an untrusted signer, When checked, Then fails closed", async () => {
    const value = await fixture()
    const response = await value.response()
    const altered = structuredClone(response)
    altered.receipt.payload.deviceId = "other-device"
    await expect(verifyRustyManagementStatus(altered, value.access, expected, value.authorization)).rejects.toThrow()
    await expect(verifyRustyManagementStatus(response, value.access, { ...expected, deviceId: "other-device" }, value.authorization)).rejects.toThrow()
    const unknown = { ...response, extra: true }
    await expect(verifyRustyManagementStatus(unknown, value.access, expected, value.authorization)).rejects.toThrow()
  })

  it("Given status inputs mutated during signature verification, When verification completes, Then returns the original verified snapshot", async () => {
    const value = await fixture()
    const response = await value.response()
    const mutableExpected = { ...expected }
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
    try {
      const pending = verifyRustyManagementStatus(response, value.access, mutableExpected, value.authorization)
      await verifying
      response.receipt.payload.personId = "other-person"
      response.capability!.payload.resourceId = "other-scope"
      value.authorization.payload.requestId = "other-request"
      mutableExpected.resourceId = "other-scope"
      release()
      await expect(pending).resolves.toMatchObject({ revision: 1, capability: { resourceId } })
    } finally {
      release()
      spy.mockRestore()
    }
  })
})
