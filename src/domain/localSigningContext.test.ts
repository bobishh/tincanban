import { afterEach, beforeEach, expect, it } from "vitest"
import { BrowserIdentityStore } from "@meta-uber/mesh-identity"
import { bootstrapIdentity, resetIdentityStorageForTest, toBase64Url, verifyEnvelope, type LocalProfile } from "./identity"
import { resolveLocalSigningContext } from "./localSigningContext"
import { signingEvidence, signWithContext } from "./signingContext"
import { deleteLocal, readLocal, writeLocal } from "../localDb"
import { applyReleaseObservation, resetReleaseStateForTest } from "../release/runtimeRelease"

let profile: LocalProfile
beforeEach(async () => { resetIdentityStorageForTest(); profile = await bootstrapIdentity("Owner") })
afterEach(resetReleaseStateForTest)

it("Given an already prepared local writer, when a newer incompatible cohort appears, then reject its final signature", async () => {
  const context = await resolveLocalSigningContext(profile, "owner-request", { scopeId: "scope" })
  applyReleaseObservation({ kind: "tincanban-release-cohort", version: 1, cohortId: "a".repeat(64),
    components: { frontend: { sourceSha: "b".repeat(40), candidateId: "new-build", artifactSha256: "b".repeat(64) } },
    contract: { minimumWriterVersion: 3, readers: { frontend: { privateReplicas: 4 } } } }, "a".repeat(40))
  await expect(signWithContext(context, { kind: "owner-request", scopeId: "scope" })).rejects.toThrow(/Update required/)
})

it("Given the active local identity, when resolving a bound owner request, then sign with verified evidence", async () => {
  const context = await resolveLocalSigningContext(profile, "owner-request", { scopeId: "scope" })
  const signed = await signWithContext(context, { kind: "owner-request", scopeId: "scope" })
  expect(await verifyEnvelope(signed, profile.device.publicKey)).toBe(true)
  expect(signingEvidence(context).certificates).toEqual([profile.certificate])
})

it("Given a different private key, when resolving the local producer, then reject before returning evidence", async () => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  await expect(resolveLocalSigningContext({ ...profile, privateKeys: { devicePrivateKey: pair.privateKey } },
    "owner-request", { scopeId: "scope" })).rejects.toThrow(/key|signer/)
})

it("Given identity changes after preparation, when signing, then reject the old local context", async () => {
  const context = await resolveLocalSigningContext(profile, "owner-request", { scopeId: "scope" })
  resetIdentityStorageForTest(); await bootstrapIdentity("Replacement")
  await expect(signWithContext(context, { kind: "owner-request", scopeId: "scope" })).rejects.toThrow(/stale|identity/)
})

it("Given another tab replaces the durable profile while this tab keeps its SDK cache, when resolving a signer, then reject the stale profile", async () => {
  const values = new Map<string, string>()
  const otherTab = new BrowserIdentityStore({
    storageKey: "other-tab-profile",
    requirePersistence: true,
    storage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
      removeItem: key => { values.delete(key) },
    },
  })
  await otherTab.bootstrap("Other device identity")
  const replacement = values.get("other-tab-profile")
  if (!replacement) throw new Error("Test identity was not persisted")
  await writeLocal("tincanban.local_profile.v1", replacement)

  await expect(resolveLocalSigningContext(profile, "owner-request", { scopeId: "scope" }))
    .rejects.toThrow(/stale identity/i)
})

it("Given durable identity storage is absent or malformed, when resolving a signer, then fail closed without replacing it", async () => {
  const original = await readLocal("tincanban.local_profile.v1")
  if (!original) throw new Error("Test identity was not persisted")

  await deleteLocal("tincanban.local_profile.v1")
  await expect(resolveLocalSigningContext(profile, "owner-request", { scopeId: "scope" }))
    .rejects.toThrow(/stale identity/i)
  expect(await readLocal("tincanban.local_profile.v1")).toBeNull()

  const malformed = "{malformed profile"
  await writeLocal("tincanban.local_profile.v1", malformed)
  await expect(resolveLocalSigningContext(profile, "owner-request", { scopeId: "scope" }))
    .rejects.toThrow(/stale identity/i)
  expect(await readLocal("tincanban.local_profile.v1")).toBe(malformed)

  await writeLocal("tincanban.local_profile.v1", original)
  const context = await resolveLocalSigningContext(profile, "owner-request", { scopeId: "scope" })
  const signed = await signWithContext(context, { kind: "owner-request", scopeId: "scope" })
  expect(await verifyEnvelope(signed, profile.device.publicKey)).toBe(true)
})

it("Given local authority changes after preparation, when signing, then reject the former revision", async () => {
  let authority = "revision-1"
  const context = await resolveLocalSigningContext(profile, "owner-request", { scopeId: "scope" },
    { currentAuthority: async () => authority })
  authority = "revision-2"
  await expect(signWithContext(context, { kind: "owner-request", scopeId: "scope" })).rejects.toThrow(/stale|authority/)
})

it.each(["devicePrivateKeyPkcs8", "identityPrivateKeyPkcs8"])(
  "Given another tab replaces durable %s without changing public metadata, when signing, then reject the cached profile",
  async field => {
    const context = await resolveLocalSigningContext(profile, "owner-request", { scopeId: "scope" })
    const raw = await readLocal("tincanban.local_profile.v1")
    if (!raw) throw new Error("Test identity was not persisted")
    const stored = JSON.parse(raw) as { privateKeys: Record<string, string> }
    const replacement = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    stored.privateKeys[field] = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", replacement.privateKey)))
    const changed = JSON.stringify(stored)
    await writeLocal("tincanban.local_profile.v1", changed)
    await expect(signWithContext(context, { kind: "owner-request", scopeId: "scope" })).rejects.toThrow(/stale|key/i)
    expect(await readLocal("tincanban.local_profile.v1")).toBe(changed)
  },
)

it("Given a caller's policy was superseded before signer preparation, when resolving its expected revision, then reject stale record metadata", async () => {
  await expect(resolveLocalSigningContext(profile, "owner-request", { scopeId: "scope" }, {
    expectedAuthority: "revision-1", currentAuthority: async () => "revision-2",
  })).rejects.toThrow(/stale|authority/)
})
