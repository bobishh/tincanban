import { beforeEach, describe, expect, it } from "vitest"
import {
  bootstrapIdentity,
  resetIdentityStorageForTest,
  sha256Base64Url,
  signEnvelope,
  toBase64Url,
  type LocalProfile,
} from "../domain/identity"
import { certHashDefault, createDelegatedCertificate } from "../domain/proofs"
import { verifyChatRecord, type ChatAuthority, type ChatPayload, type ChatRecord } from "./records"
import { createChatRecordFixture as createChatRecord } from "./records.testSupport"
import { verifyPrivateProfileObservation } from "./privateProfileObservation"

describe("private profile observation verification", () => {
  beforeEach(() => resetIdentityStorageForTest())

  async function ownRecord(profile: LocalProfile, kind: "chat-profile" | "chat-message" = "chat-profile") {
    const authority: ChatAuthority = {
      publicKey: profile.identity.publicKey,
      certificates: [profile.certificate],
    }
    return await createChatRecord(profile, [profile.certificate], authority, "not-installed-yet", kind, "Alice")
  }

  async function secondaryDeviceRecord(profile: LocalProfile): Promise<{ record: ChatRecord; delegatedCertificate: LocalProfile["certificate"] }> {
    const deviceKeys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair
    const deviceId = await sha256Base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", deviceKeys.publicKey)))
    const devicePublicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", deviceKeys.publicKey)))
    const delegatedCertificate = await createDelegatedCertificate(
      profile.privateKeys.devicePrivateKey,
      profile.device.deviceId,
      profile.identity.personId,
      deviceId,
      devicePublicKey,
      await certHashDefault(profile.certificate),
    )
    const payload: ChatPayload = {
      kind: "chat-profile",
      version: 1,
      workspaceId: "not-installed-yet",
      personId: profile.identity.personId,
      deviceId,
      id: `${deviceId}:${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      text: "Alice",
      revision: 0,
    }
    return {
      record: {
        signed: await signEnvelope(deviceKeys.privateKey, payload, deviceId),
        publicKey: profile.identity.publicKey,
        certificates: [delegatedCertificate, profile.certificate],
        authority: { publicKey: profile.identity.publicKey, certificates: [profile.certificate] },
      },
      delegatedCertificate,
    }
  }

  async function signPayload(profile: LocalProfile, record: ChatRecord, payload: ChatPayload): Promise<ChatRecord> {
    return {
      ...record,
      signed: await signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId),
    }
  }

  it("accepts an authentic own profile observation without installed workspace authority", async () => {
    const profile = await bootstrapIdentity("Alice")
    const record = await ownRecord(profile)

    await expect(verifyPrivateProfileObservation(record, profile.identity)).resolves.toMatchObject({
      signed: { payload: { personId: profile.identity.personId, text: "Alice" } },
    })
  })

  it("rejects altered signatures, missing certificate ancestry, foreign identities, and non-profile records", async () => {
    const own = await bootstrapIdentity("Alice")
    resetIdentityStorageForTest()
    const other = await bootstrapIdentity("Bob")
    const record = await ownRecord(own)

    const altered = structuredClone(record)
    altered.signed.payload.text = "Mallory"
    await expect(verifyPrivateProfileObservation(altered, own.identity)).rejects.toThrow()

    const missingChain = structuredClone(record)
    missingChain.certificates = []
    await expect(verifyPrivateProfileObservation(missingChain, own.identity)).rejects.toThrow()

    await expect(verifyPrivateProfileObservation(record, other.identity)).rejects.toThrow()
    await expect(verifyPrivateProfileObservation(await ownRecord(own, "chat-message"), own.identity)).rejects.toThrow()
  })

  it("accepts complete delegated author chains and rejects a missing root ancestor", async () => {
    const profile = await bootstrapIdentity("Alice")
    const { record, delegatedCertificate } = await secondaryDeviceRecord(profile)

    await expect(verifyPrivateProfileObservation(record, profile.identity)).resolves.toMatchObject({
      signed: { payload: { personId: profile.identity.personId, kind: "chat-profile" } },
    })
    const missingAncestor = { ...record, certificates: [delegatedCertificate] }
    await expect(verifyPrivateProfileObservation(missingAncestor, profile.identity)).rejects.toThrow()
  })

  it("rejects a foreign root key and malformed signed timestamp, ID, display text, or kind", async () => {
    const profile = await bootstrapIdentity("Alice")
    const record = await ownRecord(profile)
    resetIdentityStorageForTest()
    const foreign = await bootstrapIdentity("Bob")

    await expect(verifyPrivateProfileObservation({ ...record, publicKey: foreign.identity.publicKey }, profile.identity))
      .rejects.toThrow()

    const badTimestamp = await signPayload(profile, record, { ...record.signed.payload, createdAt: "not-a-date" })
    await expect(verifyPrivateProfileObservation(badTimestamp, profile.identity)).rejects.toThrow()

    const badId = await signPayload(profile, record, { ...record.signed.payload, id: "wrong-device:message" })
    await expect(verifyPrivateProfileObservation(badId, profile.identity)).rejects.toThrow()

    const badText = await signPayload(profile, record, { ...record.signed.payload, text: "" })
    await expect(verifyPrivateProfileObservation(badText, profile.identity)).rejects.toThrow()

    const badKind = await signPayload(profile, record, { ...record.signed.payload, kind: "chat-message" })
    await expect(verifyPrivateProfileObservation(badKind, profile.identity)).rejects.toThrow()
  })

  it("snapshots caller data before asynchronous certificate verification", async () => {
    const profile = await bootstrapIdentity("Alice")
    const record = await ownRecord(profile)
    const verification = verifyPrivateProfileObservation(record, profile.identity)
    record.signed.payload.text = "Changed while verifier awaited"

    await expect(verification).resolves.toMatchObject({
      signed: { payload: { text: "Alice" } },
    })
  })

  it("returns the admitted snapshot when shared-chat caller changes input during verification", async () => {
    const profile = await bootstrapIdentity("Alice")
    const record = await ownRecord(profile)
    const verification = verifyChatRecord(record, "not-installed-yet", profile.identity.personId)
    record.signed.payload.text = "Unverified replacement"
    await expect(verification).resolves.toMatchObject({ signed: { payload: { text: "Alice" } } })
  })

  it("does not let private authenticity replace workspace owner or grant authorization", async () => {
    const owner = await bootstrapIdentity("Owner")
    resetIdentityStorageForTest()
    const foreignAuthority = await bootstrapIdentity("Untrusted workspace authority")
    const record = await ownRecord(owner)
    record.authority = {
      publicKey: foreignAuthority.identity.publicKey,
      certificates: [foreignAuthority.certificate],
    }

    await expect(verifyPrivateProfileObservation(record, owner.identity)).resolves.toMatchObject({
      signed: { payload: { personId: owner.identity.personId } },
    })
    await expect(verifyChatRecord(record, "not-installed-yet", owner.identity.personId))
      .rejects.toThrow("Invalid workspace authority")
  })
})
