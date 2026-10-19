import { expect, test } from "vitest"
import { sha256Base64Url, signEnvelope, toBase64Url } from "../domain/identity"
import { verifyRustyWriterPolicyReceipt } from "../product-replica/rustyScopePolicy"

async function fixture() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const key = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  const storage = { origin: "https://rusty.example", scopeId: "workspace-scope", keyEpoch: 1, servicePublicKey: toBase64Url(key) }
  const payload = { kind: "rusty-scope-policy-receipt" as const, version: 1 as const, serviceId: await sha256Base64Url(key),
    scopeId: storage.scopeId, personId: "owner", revision: 4, revoked: false, challengeId: "scope-challenge",
    authorizationHash: "A".repeat(43), minimumWriterVersion: 2 as const }
  const sign = (value = payload) => signEnvelope(pair.privateKey, value, payload.serviceId, "RUSTY/2")
  return { storage, payload, sign }
}

test("Given a pinned signed writer-floor receipt, when verifying maintenance evidence, then retain exact proof without granting application rights", async () => {
  const f = await fixture()
  const receipt = await f.sign()
  expect(await verifyRustyWriterPolicyReceipt(receipt, f.storage, "owner", 3)).toEqual(receipt)
})

test("Given signed but substituted policy metadata, when refreshing access, then reject another scope, owner, floor or revision", async () => {
  const f = await fixture()
  for (const changes of [{ scopeId: "other" }, { personId: "other" }, { revision: 2 }, { revoked: true }, { minimumWriterVersion: undefined }]) {
    const payload = { ...f.payload, ...changes }
    if (payload.minimumWriterVersion === undefined) delete payload.minimumWriterVersion
    const receipt = await f.sign(payload as typeof f.payload)
    await expect(verifyRustyWriterPolicyReceipt(receipt, f.storage, "owner", 3)).rejects.toThrow(/receipt|policy|writer/i)
  }
})

test("Given a tampered receipt or another service pin, when verifying a writer transition, then fail closed", async () => {
  const f = await fixture()
  const receipt = await f.sign()
  await expect(verifyRustyWriterPolicyReceipt({ ...receipt, payload: { ...receipt.payload, revision: 99 } }, f.storage, "owner", 3)).rejects.toThrow()
  await expect(verifyRustyWriterPolicyReceipt(receipt, { ...f.storage, servicePublicKey: "A".repeat(43) }, "owner", 3)).rejects.toThrow()
  await expect(verifyRustyWriterPolicyReceipt({ ...receipt, leaked: "unknown-field" }, f.storage, "owner", 3)).rejects.toThrow()
})
