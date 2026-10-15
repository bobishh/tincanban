import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { adoptEnrolledIdentity, bootstrapIdentity, resetIdentityStorageForTest, signEnvelope, toBase64Url, verifyEnvelope, type LocalProfile } from "../domain/identity"
import { certHashDefault, createDelegatedCertificate, defaultProofStore } from "../domain/proofs"
import { readLocal, writeLocal } from "../localDb"
import type { KeeperDiscovery } from "./keeperDiscovery"
import { signKeeperControllerRequest } from "./keeperPairing"

const domain = "MESH-LIGHTHOUSE/1"
let profile: LocalProfile
let discovery: KeeperDiscovery

beforeEach(async () => {
  resetIdentityStorageForTest()
  profile = await bootstrapIdentity("Controller")
  discovery = { origin: "https://keeper.example", displayName: "Keeper", personId: "service-person",
    publicKey: "service-key", deviceId: "service-device", certificates: [], fingerprint: "fingerprint",
    capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true,
      blobReplication: true, pairing: true } }
})
afterEach(() => vi.restoreAllMocks())

function boundedBody(now = Date.now()) {
  const issuedAt = Math.floor(now / 1000)
  return { operationId: "operation-1", issuedAt, expiresAt: issuedAt + 30 }
}

it("Given an active local controller, when signing, then preserve the protocol envelope and certificate evidence", async () => {
  const request = await signKeeperControllerRequest(profile, discovery, "lighthouse-test-request", boundedBody())
  expect(request.identity).toEqual(profile.identity)
  expect(request.deviceId).toBe(profile.device.deviceId)
  expect(request.certificates).toEqual([profile.certificate])
  expect(request.signed.payload).toMatchObject({ kind: "lighthouse-test-request", version: 1, protocolVersion: 1,
    operationId: "operation-1", servicePersonId: discovery.personId, serviceOrigin: discovery.origin,
    controllerPersonId: profile.identity.personId, controllerDeviceId: profile.device.deviceId })
  expect(Number(request.signed.payload.expiresAt) - Number(request.signed.payload.issuedAt)).toBe(30)
  await expect(verifyEnvelope(request.signed, profile.device.publicKey, domain)).resolves.toBe(true)
})

it("Given an enrolled controller without its root private key, when signing, then send its complete verified chain", async () => {
  const root = profile
  resetIdentityStorageForTest()
  const temporary = await bootstrapIdentity("Enrolled device")
  const certificate = await createDelegatedCertificate(root.privateKeys.devicePrivateKey, root.device.deviceId,
    root.identity.personId, temporary.device.deviceId, temporary.device.publicKey, await certHashDefault(root.certificate))
  profile = await adoptEnrolledIdentity(root.identity, certificate)
  vi.spyOn(defaultProofStore, "listCertificates").mockResolvedValue([root.certificate])

  const request = await signKeeperControllerRequest(profile, discovery, "lighthouse-test-request", boundedBody())
  expect(request.identity).toEqual(root.identity)
  expect(request.certificates).toEqual([certificate, root.certificate])
  await expect(verifyEnvelope(request.signed, profile.device.publicKey, domain)).resolves.toBe(true)
})

it("Given a different controller private key, when signing, then reject instead of returning an invalid request", async () => {
  const other = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const mismatched = { ...profile, privateKeys: { ...profile.privateKeys, devicePrivateKey: other.privateKey } }
  await expect(signKeeperControllerRequest(mismatched, discovery, "lighthouse-test-request", boundedBody()))
    .rejects.toThrow(/key|signer|stale/i)
})

it("Given another tab replaced the durable controller key, when signing, then fail closed", async () => {
  const raw = await readLocal("tincanban.local_profile.v1")
  if (!raw) throw new Error("Test profile was not persisted")
  const stored = JSON.parse(raw) as { privateKeys: Record<string, string> }
  const replacement = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  stored.privateKeys.devicePrivateKeyPkcs8 = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", replacement.privateKey)))
  await writeLocal("tincanban.local_profile.v1", JSON.stringify(stored))

  await expect(signKeeperControllerRequest(profile, discovery, "lighthouse-test-request", boundedBody()))
    .rejects.toThrow(/stale identity|signing key/i)
})

it("Given the signer certificate has a missing ancestor, when signing, then reject before returning controller evidence", async () => {
  const certificate = await signEnvelope(profile.privateKeys.devicePrivateKey,
    { ...profile.certificate.payload, issuerCertificateHash: "missing-ancestor" }, profile.device.deviceId)
  const withMissingAncestor = { ...profile, certificate }
  const raw = await readLocal("tincanban.local_profile.v1")
  if (!raw) throw new Error("Test profile was not persisted")
  await writeLocal("tincanban.local_profile.v1", JSON.stringify({ ...JSON.parse(raw), certificate }))

  await expect(signKeeperControllerRequest(withMissingAncestor, discovery, "lighthouse-test-request", boundedBody()))
    .rejects.toThrow(/ancestor|certificate|chain/i)
})

it("Given caller objects mutate during certificate resolution, when signing, then retain the original request snapshot", async () => {
  let resolveCertificates!: (value: LocalProfile["certificate"][]) => void
  const certificates = new Promise<LocalProfile["certificate"][]>(resolve => { resolveCertificates = resolve })
  vi.spyOn(defaultProofStore, "listCertificates").mockReturnValueOnce(certificates)
  const inputProfile = structuredClone(profile)
  const inputDiscovery = structuredClone(discovery)
  const inputBody = boundedBody()
  const pending = signKeeperControllerRequest(inputProfile, inputDiscovery, "lighthouse-test-request", inputBody)
  inputProfile.identity.personId = "changed-person"
  inputProfile.device.deviceId = "changed-device"
  inputDiscovery.origin = "https://changed.example"
  inputBody.operationId = "changed-operation"
  resolveCertificates([profile.certificate])

  const request = await pending
  expect(request.identity.personId).toBe(profile.identity.personId)
  expect(request.deviceId).toBe(profile.device.deviceId)
  expect(request.signed.payload).toMatchObject({ operationId: "operation-1", serviceOrigin: discovery.origin,
    controllerPersonId: profile.identity.personId, controllerDeviceId: profile.device.deviceId })
})

it("Given the durable key changes during the actual request signature, when signing completes, then return no stale request", async () => {
  const raw = await readLocal("tincanban.local_profile.v1")
  if (!raw) throw new Error("Test profile was not persisted")
  const stored = JSON.parse(raw) as { privateKeys: Record<string, string> }
  const replacement = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const changed = JSON.stringify({ ...stored,
    privateKeys: { ...stored.privateKeys, devicePrivateKeyPkcs8: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", replacement.privateKey))) } })
  const originalSign = crypto.subtle.sign.bind(crypto.subtle)
  let call = 0
  vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
    const result = await originalSign(...args)
    call++
    if (call === 2) await writeLocal("tincanban.local_profile.v1", changed)
    return result
  })

  await expect(signKeeperControllerRequest(profile, discovery, "lighthouse-test-request", boundedBody()))
    .rejects.toThrow(/stale identity|signing key|authority/i)
  expect(await readLocal("tincanban.local_profile.v1")).toBe(changed)
})

it("Given the signed request expires during crypto, when signing resumes, then return no successful signature", async () => {
  const initialNow = Date.now()
  const issuedAt = Math.floor(initialNow / 1000)
  const expiresAt = issuedAt + 3
  let now = initialNow
  vi.spyOn(Date, "now").mockImplementation(() => now)
  const originalSign = crypto.subtle.sign.bind(crypto.subtle)
  let call = 0
  vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
    const result = await originalSign(...args)
    call++
    if (call === 2) now = expiresAt * 1000
    return result
  })

  await expect(signKeeperControllerRequest(profile, discovery, "lighthouse-test-request", { operationId: "expiring",
    issuedAt, expiresAt })).rejects.toThrow(/expired|timestamp/i)
})
