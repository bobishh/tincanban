import { describe, it, expect } from "vitest"
import { encryptBlindObject, decryptBlindObject, decodeBlindBytes, encodeBlindBytes } from "./blindEnvelope"

// Given a client-held content key, when it sends a document through an opaque
// store, then a second authorized client can decrypt but substitutions fail.
describe("blind encrypted replication", () => {
  it("round-trips document bytes without giving storage a content key", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const body = new TextEncoder().encode("Private card: Interview at Example")
    const object = await encryptBlindObject("scope-a", 1, key, body)
    expect(JSON.stringify(object)).not.toContain("Private card")
    expect(Object.keys(object).sort()).toEqual(["ciphertext", "keyEpoch", "nonce", "scopeId", "version"])
    expect(await decryptBlindObject(object, "scope-a", 1, key)).toEqual(body)
    await expect(decryptBlindObject(object, "scope-b", 1, key)).rejects.toThrow()
    await expect(decryptBlindObject({ ...object, keyEpoch: 2 }, "scope-a", 2, key)).rejects.toThrow()
    const tampered = decodeBlindBytes(object.ciphertext)
    tampered[tampered.length - 1] ^= 1
    await expect(decryptBlindObject({ ...object, ciphertext: encodeBlindBytes(tampered) }, "scope-a", 1, key)).rejects.toThrow()
    await expect(decryptBlindObject(object, "scope-a", 1, crypto.getRandomValues(new Uint8Array(32)))).rejects.toThrow()
  })
})
