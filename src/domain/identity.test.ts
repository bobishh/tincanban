import { createActorBinding, createChangeProof } from "./transactionProofs"
import { describe, expect, it, beforeEach, vi } from "vitest"
import { certificateHash, createDeviceAuthorizationApproval, createDeviceAuthorizationRequest,
  createDelegatedCertificate, createRecoverableIdentity, verifyDeviceCertificateChain } from "@meta-uber/mesh-identity"
import {
  bootstrapIdentity,
  verifyEnvelope,
  canonicalizeJson,
  resetIdentityStorageForTest,
  clearInMemoryProfileForReloadTest,
  createIdentityRecovery,
  restoreIdentityRecovery,
  renameIdentity,
  adoptApprovedApplicationDevice,
} from "./identity"
import { defaultProofStore } from "./proofs"
import { resolveLocalSigningContext } from "./localSigningContext"

describe("Local identity, signing, and bootstrap (Requirement 1.2)", () => {
  beforeEach(() => {
    resetIdentityStorageForTest()
  })

  it("canonicalizeJson produces deterministic RFC 8785 output and rejects non-finite numbers", () => {
    const obj1 = { b: 2, a: 1, c: { y: "hello", x: [3, 1, 2] } }
    const obj2 = { a: 1, c: { x: [3, 1, 2], y: "hello" }, b: 2 }

    expect(canonicalizeJson(obj1)).toEqual(canonicalizeJson(obj2))
    expect(canonicalizeJson(obj1)).toBe('{"a":1,"b":2,"c":{"x":[3,1,2],"y":"hello"}}')

    expect(() => canonicalizeJson({ invalid: Infinity })).toThrow(/non-finite/i)
    expect(() => canonicalizeJson({ invalid: NaN })).toThrow(/non-finite/i)
  })

  it("bootstraps a fresh local profile with Ed25519 identity and device certificates", async () => {
    const profile = await bootstrapIdentity("Alice Test")

    expect(profile.identity.personId).toBeTruthy()
    expect(profile.identity.displayName).toBe("Alice Test")
    expect(profile.device.deviceId).toBeTruthy()
    expect(profile.certificate.payload.kind).toBe("device-certificate")
    expect(profile.certificate.payload.personId).toBe(profile.identity.personId)
    expect(profile.certificate.payload.deviceId).toBe(profile.device.deviceId)
    expect(profile.certificate.signerKeyId).toBe(profile.identity.personId)

    // Verify certificate signature with the identity public key
    const isValid = await verifyEnvelope(profile.certificate, profile.identity.publicKey)
    expect(isValid).toBe(true)

    // Private keys must not be present in public structures
    expect(JSON.stringify(profile.identity)).not.toContain("privateKey")
    expect(JSON.stringify(profile.certificate)).not.toContain("privateKey")
  })

  it("Given a portal approves this app key through a delegated Identity device, when adopting, then persist the complete verified certificate chain", async () => {
    const app = await bootstrapIdentity("Application device")
    const root = (await createRecoverableIdentity("better", "Identity root")).profile
    const authorizingDevice = (await createRecoverableIdentity("better", "Identity device")).profile
    const delegatedCertificate = await createDelegatedCertificate(root.privateKeys.devicePrivateKey,
      root.device.deviceId, root.identity.personId, authorizingDevice.device.deviceId,
      authorizingDevice.device.publicKey, await certificateHash(root.certificate))
    const delegatedProfile = { ...authorizingDevice, identity: root.identity, certificate: delegatedCertificate,
      privateKeys: { devicePrivateKey: authorizingDevice.privateKeys.devicePrivateKey } }
    const challenge = "c".repeat(64)
    const request = await createDeviceAuthorizationRequest(app, { applicationOrigin: "https://boards.example",
      challenge, expiresAt: Date.now() + 120_000 })
    const approval = await createDeviceAuthorizationApproval(delegatedProfile, request, {
      applicationOrigin: "https://boards.example", challenge, certificates: [root.certificate, delegatedCertificate],
    })

    const failFirstCertificateWrite = vi.spyOn(defaultProofStore, "putCertificate")
      .mockRejectedValueOnce(new Error("Proof storage unavailable"))
    await expect(adoptApprovedApplicationDevice(approval, request, app)).rejects.toThrow("Proof storage unavailable")
    failFirstCertificateWrite.mockRestore()
    expect((await bootstrapIdentity()).identity.personId).toBe(app.identity.personId)

    const adopted = await adoptApprovedApplicationDevice(approval, request, app)
    expect(adopted.device.publicKey).toBe(app.device.publicKey)
    expect(adopted.privateKeys.devicePrivateKey).toBe(app.privateKeys.devicePrivateKey)
    expect(adopted.privateKeys.identityPrivateKey).toBeUndefined()
    const certificates = await defaultProofStore.listCertificates()
    const signatures = new Set(certificates.map(certificate => certificate.signature))
    expect(signatures).toContain(root.certificate.signature)
    expect(signatures).toContain(delegatedCertificate.signature)
    expect(signatures).toContain(approval.certificate.signature)
    await expect(verifyDeviceCertificateChain(adopted.identity, adopted.device.deviceId, certificates))
      .resolves.toBe(adopted.device.publicKey)
    const context = await resolveLocalSigningContext(adopted, "device-authorization-test", { boardId: "board-proof" })
    expect(context.deviceId).toBe(adopted.device.deviceId)
    clearInMemoryProfileForReloadTest()
    const reloaded = await bootstrapIdentity()
    await expect(resolveLocalSigningContext(reloaded, "device-authorization-test", { boardId: "board-proof" }))
      .resolves.toMatchObject({ personId: reloaded.identity.personId, deviceId: reloaded.device.deviceId })
  })

  it("Given a fresh identity without a chosen name, when bootstrapped and reloaded, then retain neutral protocol metadata and no chosen name", async () => {
    const fresh = await bootstrapIdentity()
    expect(fresh.identity.displayName).toBe("Participant")
    const { identityNameIsProvided } = await import("./identityNameChoice")
    expect(await identityNameIsProvided(fresh.identity)).toBe(false)
    clearInMemoryProfileForReloadTest()
    const loaded = await bootstrapIdentity()
    expect(loaded.identity).toEqual(fresh.identity)
    expect(loaded.certificate).toEqual(fresh.certificate)
    expect(await identityNameIsProvided(loaded.identity)).toBe(false)
    await renameIdentity("Participant")
    clearInMemoryProfileForReloadTest()
    expect(await identityNameIsProvided((await bootstrapIdentity()).identity)).toBe(true)
  })

  it.each(["tincanban User", "Match User", "Valiant Squirrel", "Participant"])("Given deliberate name %s, when bootstrapped again, then preserve it as explicitly chosen", async name => {
    const { identityNameIsProvided } = await import("./identityNameChoice")
    const profile = await bootstrapIdentity(name)
    clearInMemoryProfileForReloadTest()
    expect((await bootstrapIdentity()).identity.displayName).toBe(name)
    expect(await identityNameIsProvided(profile.identity)).toBe(true)
  })

  it("simultaneous first-open tabs create one profile atomically", async () => {
    // Simulate two concurrent tabs opening at the same time
    const [tabA, tabB] = await Promise.all([
      bootstrapIdentity("Tab A"),
      bootstrapIdentity("Tab B"),
    ])

    // Both tabs must share the winning profile personId and identity
    expect(tabA.identity.personId).toEqual(tabB.identity.personId)
    expect(tabA.identity.publicKey).toEqual(tabB.identity.publicKey)
  })

  it("reads a cached identity while another tab blocks the bootstrap lock", async () => {
    const request = vi.fn(async (_name: string, operation: () => Promise<unknown>) => operation())
    vi.stubGlobal("navigator", { locks: { request } })
    try {
      const profile = await bootstrapIdentity("Cached owner")
      expect(request).toHaveBeenCalledTimes(1)
      request.mockImplementation(async () => { throw new Error("Another tab holds the bootstrap lock") })
      await renameIdentity("Updated owner")
      const cached = await bootstrapIdentity()
      expect(cached.identity.personId).toBe(profile.identity.personId)
      expect(cached.identity.displayName).toBe("Updated owner")
      expect(request).toHaveBeenCalledTimes(1)
      clearInMemoryProfileForReloadTest()
      await expect(bootstrapIdentity()).rejects.toThrow("Another tab holds the bootstrap lock")
    } finally { vi.unstubAllGlobals() }
  })

  it("coalesces cold bootstrap and retries after a failed lock acquisition", async () => {
    const request = vi.fn(async (_name: string, operation: () => Promise<unknown>) => operation())
      .mockRejectedValueOnce(new Error("Lock acquisition failed"))
    vi.stubGlobal("navigator", { locks: { request } })
    try {
      await expect(bootstrapIdentity()).rejects.toThrow("Lock acquisition failed")
      const profiles = await Promise.all([bootstrapIdentity("Owner"), bootstrapIdentity("Other name")])
      expect(profiles[0].identity.personId).toBe(profiles[1].identity.personId)
      expect(request).toHaveBeenCalledTimes(2)
    } finally { vi.unstubAllGlobals() }
  })

  it("signs and verifies actor bindings and change proofs", async () => {
    const profile = await bootstrapIdentity("Signer")
    const documentId = "doc_123"
    const actorId = "actor_456"

    const actorBinding = await createActorBinding(profile, documentId, actorId)
    expect(actorBinding.payload.kind).toBe("actor-binding")
    expect(actorBinding.payload.documentId).toBe(documentId)
    expect(actorBinding.payload.actorId).toBe(actorId)

    const bindingValid = await verifyEnvelope(actorBinding, profile.device.publicKey)
    expect(bindingValid).toBe(true)

    const changeHash = "hash_change_789"
    const actorBindingHash = "hash_binding_abc"
    const changeProof = await createChangeProof(profile, documentId, changeHash, actorBindingHash)

    expect(changeProof.payload.kind).toBe("change-proof")
    expect(changeProof.payload.changeHash).toBe(changeHash)
    expect(changeProof.payload.actorBindingHash).toBe(actorBindingHash)

    const proofValid = await verifyEnvelope(changeProof, profile.device.publicKey)
    expect(proofValid).toBe(true)
  })

  it("persists local profile and keys in durable storage across reloads", async () => {
    const profile1 = await bootstrapIdentity("Durable User")
    const personId = profile1.identity.personId
    const deviceId = profile1.device.deviceId

    // Simulate page reload by clearing only in-memory cache
    clearInMemoryProfileForReloadTest()

    const profile2 = await bootstrapIdentity("Durable User")
    expect(profile2.identity.personId).toBe(personId)
    expect(profile2.device.deviceId).toBe(deviceId)
    expect(profile2.device.publicKey).toBe(profile1.device.publicKey)

    // And private keys are still functional for signing
    const binding = await createActorBinding(profile2, "doc_1", "actor_1")
    const valid = await verifyEnvelope(binding, profile2.device.publicKey)
    expect(valid).toBe(true)
  })

  it("renames presentation metadata without replacing the identity or device keys", async () => {
    const before = await bootstrapIdentity("Original name")
    const renamed = await renameIdentity("Renamed user")

    expect(renamed.identity.personId).toBe(before.identity.personId)
    expect(renamed.identity.publicKey).toBe(before.identity.publicKey)
    expect(renamed.device.deviceId).toBe(before.device.deviceId)
    expect(renamed.identity.displayName).toBe("Renamed user")
  })

  it("exports the existing root and restores it only after replacement is confirmed", async () => {
    const original = await bootstrapIdentity("Backup owner")
    const backup = await createIdentityRecovery("better")
    expect(backup.recoveryKey.split(" ")).toHaveLength(12)
    expect(backup.recoveryEnvelope.personId).toBe(original.identity.personId)

    await expect(restoreIdentityRecovery(backup.recoveryEnvelope, "wrong recovery words", "Backup owner", true))
      .rejects.toThrow(/Invalid recovery words/)
    await expect(restoreIdentityRecovery({ ...backup.recoveryEnvelope, ciphertext: "invalid" }, backup.recoveryKey, "Backup owner", true))
      .rejects.toThrow(/Recovery words do not open this identity/)
  })

  it("fails cleanly when unsupported crypto is detected", async () => {
    const spy = vi.spyOn(crypto.subtle, "generateKey").mockRejectedValue(
      new DOMException("The algorithm is not supported", "NotSupportedError")
    )

    try {
      await expect(bootstrapIdentity("Unsupported")).rejects.toThrow(/unsupported.*algorithm|unsupported_format/i)
    } finally {
      spy.mockRestore()
    }
  })
})
