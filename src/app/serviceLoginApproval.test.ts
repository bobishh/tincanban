import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { reactive } from "vue"
import { adoptEnrolledIdentity, bootstrapIdentity, resetIdentityStorageForTest, signEnvelope, verifyEnvelope,
  type LocalProfile } from "../domain/identity"
import { certHashDefault, createDelegatedCertificate, defaultProofStore } from "../domain/proofs"
import { snapshotServiceLoginRequest, type ServiceLoginRequest } from "./serviceLogin"
import { assertServiceLoginSession, createServiceLoginApproval } from "./serviceLoginApproval"

let owner: LocalProfile
const request = (): ServiceLoginRequest => ({ origin: "https://sink.example", challenge: "a".repeat(64),
  expires_at: Math.floor(Date.now() / 1000) + 120 })
const workspaces = [{ workspace: "workspace-1", name: "Hiring", grant: null, policy: { scope: { value: 1 } } }]

it("Given a reactive sign-in request, when taking the approval snapshot, then produce cloneable request data", () => {
  const reactiveRequest = reactive(request())
  const snapshot = snapshotServiceLoginRequest(reactiveRequest)
  expect(structuredClone(snapshot)).toEqual(requestWithValues(reactiveRequest))
})

function requestWithValues(value: ServiceLoginRequest): ServiceLoginRequest {
  return { origin: value.origin, challenge: value.challenge, expires_at: value.expires_at }
}

beforeEach(async () => { resetIdentityStorageForTest(); owner = await bootstrapIdentity("Owner") })
afterEach(() => { vi.restoreAllMocks(); resetIdentityStorageForTest() })

it("Given an active profile, when approving TinSink, then sign the unchanged public payload with full device evidence", async () => {
  const current = request()
  const approval = await createServiceLoginApproval(owner, current, workspaces)
  expect(approval.identity).toEqual(owner.identity)
  expect(approval.deviceId).toBe(owner.device.deviceId)
  expect(approval.certificates).toEqual([owner.certificate])
  expect(approval.workspaces).toEqual(workspaces)
  expect(approval.proof.payload).toMatchObject({ kind: "tinsink-login", version: 2, origin: current.origin,
    challenge: current.challenge, expiresAt: current.expires_at * 1000, boards: [{ workspace: "workspace-1", name: "Hiring" }] })
  expect(await verifyEnvelope(approval.proof, owner.device.publicKey, "TINSINK/1")).toBe(true)
  expect(JSON.stringify(approval)).not.toMatch(/privateKey|pkcs8|identitySeed|transportSecret/i)
})

it("Given a mismatched local private key, when creating approval, then reject before producing evidence", async () => {
  const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
  await expect(createServiceLoginApproval({ ...owner, privateKeys: { devicePrivateKey: other.privateKey } }, request(), workspaces))
    .rejects.toThrow(/key|signer/i)
})

it("Given an enrolled profile, when approving, then include and verify its complete delegated certificate chain", async () => {
  const issuer = owner
  resetIdentityStorageForTest()
  const temporary = await bootstrapIdentity("Temporary device")
  const certificate = await createDelegatedCertificate(issuer.privateKeys.devicePrivateKey, issuer.device.deviceId,
    issuer.identity.personId, temporary.device.deviceId, temporary.device.publicKey, await certHashDefault(issuer.certificate))
  const device = await adoptEnrolledIdentity(issuer.identity, certificate)
  await defaultProofStore.putCertificate(await certHashDefault(issuer.certificate), issuer.certificate)
  const approval = await createServiceLoginApproval(device as LocalProfile, request(), workspaces)
  expect(approval.certificates).toEqual([certificate, issuer.certificate])
  expect(await verifyEnvelope(approval.proof, device.device.publicKey, "TINSINK/1")).toBe(true)
})

it("Given a delegated profile with a missing issuer, when approving, then refuse to emit incomplete evidence", async () => {
  const issuer = owner
  resetIdentityStorageForTest()
  const temporary = await bootstrapIdentity("Temporary device")
  const certificate = await signEnvelope(issuer.privateKeys.devicePrivateKey, {
    ...temporary.certificate.payload, personId: issuer.identity.personId,
    issuerCertificateHash: "Z".repeat(43), canEnrollDevices: false,
  }, issuer.device.deviceId)
  const device = await adoptEnrolledIdentity(issuer.identity, certificate)
  await expect(createServiceLoginApproval(device as LocalProfile, request(), workspaces)).rejects.toThrow(/ancestor|certificate|chain/i)
})

it("Given mutable request/workspace inputs, when crypto yields, then reject before returning or posting redirected approval", async () => {
  const original = request()
  const input = structuredClone(original)
  const rows = structuredClone(workspaces)
  const originalSign = crypto.subtle.sign.bind(crypto.subtle)
  const sign = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
    const result = await originalSign(...args)
    input.challenge = "b".repeat(64)
    rows[0]!.name = "Changed"
    return result
  })
  try {
    await expect(createServiceLoginApproval(owner, input, rows, {
      ensureCurrent: () => {
        if (input.challenge !== original.challenge || rows[0]!.name !== "Hiring") throw new Error("TinSink approval changed")
      },
    })).rejects.toThrow(/changed/i)
  } finally { sign.mockRestore() }
})

it("Given a challenge expiry or live authority change during signing, when approving, then do not return a proof", async () => {
  const current = request()
  const expired = { ...current, expires_at: Math.floor(Date.now() / 1000) - 1 }
  await expect(createServiceLoginApproval(owner, expired, workspaces)).rejects.toThrow(/expired/i)

  let revision = "owner-1"
  const originalSign = crypto.subtle.sign.bind(crypto.subtle)
  const sign = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
    const result = await originalSign(...args)
    revision = "owner-2"
    return result
  })
  try {
    await expect(createServiceLoginApproval(owner, current, workspaces, {
      currentAuthority: async () => revision,
    })).rejects.toThrow(/stale|authority/i)
  } finally { sign.mockRestore() }
})

it("Given an opener/request substitution or an expiry crossed during async work, when posting approval, then reject the stale session", async () => {
  const expected = request()
  const opener = {} as Window
  expect(() => assertServiceLoginSession(expected, expected, opener, opener)).not.toThrow()
  expect(() => assertServiceLoginSession({ ...expected, challenge: "b".repeat(64) }, expected, opener, opener)).toThrow(/changed/i)
  expect(() => assertServiceLoginSession(expected, expected, {} as Window, opener)).toThrow(/changed/i)
  expect(() => assertServiceLoginSession(expected, expected, opener, opener, expected.expires_at)).toThrow(/expired/i)

  const start = Math.floor(Date.now() / 1000)
  const clock = vi.spyOn(Date, "now").mockReturnValue(start * 1000)
  const originalSign = crypto.subtle.sign.bind(crypto.subtle)
  const sign = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
    const result = await originalSign(...args)
    clock.mockReturnValue((start + 2) * 1000)
    return result
  })
  try {
    await expect(createServiceLoginApproval(owner, { ...expected, expires_at: start + 1 }, workspaces))
      .rejects.toThrow(/expired/i)
  } finally { sign.mockRestore(); clock.mockRestore() }
})
