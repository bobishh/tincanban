import { describe, it, expect, vi } from "vitest"
import { encryptBlindObject, decryptBlindObject, encryptPurposeBoundObject, decryptPurposeBoundObject, decodeBlindBytes, encodeBlindBytes,
  type PurposeBoundBinding } from "./blindEnvelope"

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

describe("purpose-bound encrypted objects", () => {
  const binding = { purpose: "identity-state" as const, subjectId: "person-a", scopeId: "scope-a", keyEpoch: 2 }

  it("round-trips opaque v1 ciphertext and rejects purpose, subject, scope, and epoch substitution", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const body = new TextEncoder().encode(JSON.stringify({ fileName: "private.pdf", privateKey: "secret" }))
    const object = await encryptPurposeBoundObject(binding, key, body)
    expect(object.version).toBe(1)
    expect(Object.keys(object).sort()).toEqual(["ciphertext", "keyEpoch", "nonce", "scopeId", "version"])
    expect(JSON.stringify(object)).not.toContain("private.pdf")
    expect(JSON.stringify(object)).not.toContain("privateKey")
    expect(await decryptPurposeBoundObject(object, binding, key)).toEqual(body)
    await expect(decryptPurposeBoundObject(object, { ...binding, purpose: "attachment" }, key)).rejects.toThrow()
    await expect(decryptPurposeBoundObject(object, { ...binding, subjectId: "person-b" }, key)).rejects.toThrow()
    await expect(decryptPurposeBoundObject(object, { ...binding, scopeId: "scope-b" }, key)).rejects.toThrow()
    await expect(decryptPurposeBoundObject(object, { ...binding, keyEpoch: 3 }, key)).rejects.toThrow()
    await expect(decryptBlindObject(object, binding.scopeId, binding.keyEpoch, key)).rejects.toThrow()
  })

  it("snapshots source binding before asynchronous key import", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const submitted = { ...binding }
    const originalImport = crypto.subtle.importKey.bind(crypto.subtle)
    let started!: () => void
    let release!: () => void
    const importStarted = new Promise<void>(resolve => { started = resolve })
    const importGate = new Promise<void>(resolve => { release = resolve })
    const importSpy = vi.spyOn(crypto.subtle, "importKey").mockImplementation(async (...args) => {
      const imported = await originalImport(...args)
      started()
      await importGate
      return imported
    })
    const encrypted = encryptPurposeBoundObject(submitted, key, new Uint8Array([7, 8, 9]))
    await importStarted
    submitted.subjectId = "mutated-person"
    release()
    let object
    try { object = await encrypted } finally { importSpy.mockRestore() }
    expect(await decryptPurposeBoundObject(object!, binding, key)).toEqual(new Uint8Array([7, 8, 9]))
    await expect(decryptPurposeBoundObject(object!, submitted, key)).rejects.toThrow()
  })

  it("rejects unknown purposes and invalid subject, scope, or epoch before key import", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const invalid: unknown[] = [
      { ...binding, purpose: "workspace" },
      { ...binding, subjectId: "" },
      { ...binding, subjectId: "x".repeat(513) },
      { ...binding, scopeId: "contains space" },
      { ...binding, keyEpoch: 0 },
      { ...binding, keyEpoch: 1.5 },
      { ...binding, keyEpoch: Number.MAX_SAFE_INTEGER + 1 },
    ]
    const importKey = vi.spyOn(crypto.subtle, "importKey")
    try {
      for (const candidate of invalid) {
        await expect(encryptPurposeBoundObject(candidate as PurposeBoundBinding, key, new Uint8Array([1])))
          .rejects.toThrow(/binding/i)
      }
      expect(importKey).not.toHaveBeenCalled()
    } finally { importKey.mockRestore() }
  })
})
