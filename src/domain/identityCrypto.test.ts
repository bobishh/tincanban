import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../localDb", () => {
  throw new Error("Portable identity crypto must not load browser storage")
})

afterEach(() => vi.unstubAllGlobals())

describe("portable identity crypto", () => {
  it("loads without the browser identity store and uses shared identity primitives", async () => {
    vi.stubGlobal("indexedDB", undefined)
    const identity = await import("./identityCrypto")
    const bytes = new TextEncoder().encode('{"a":1}')

    expect(identity.canonicalizeJson({ a: 1 })).toBe('{"a":1}')
    expect(identity.fromBase64Url(identity.toBase64Url(bytes))).toEqual(bytes)
    expect(await identity.sha256Base64Url(bytes)).toBeTruthy()
  })
})
