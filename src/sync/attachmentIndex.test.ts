import { describe, expect, it, vi } from "vitest"
import { mergeAttachmentLocators, parseAttachmentLocators } from "../product-replica/attachmentIndex"
import type { AttachmentLocator } from "../product-replica"

const locator = (blobByte: string, transferId: string, manifestByte: string): AttachmentLocator => ({
  version: 1,
  blobId: `sha256:${blobByte.repeat(43)}`,
  transferId,
  manifestId: manifestByte.repeat(43),
})

describe("private attachment locator index", () => {
  it("reads absent legacy indices as empty and returns stable deduplicated locators", () => {
    expect(parseAttachmentLocators(undefined)).toEqual([])
    const a = locator("A", "transfer-a", "C")
    const b = locator("B", "transfer-b", "D")
    expect(parseAttachmentLocators([b, a, a])).toEqual([a, b])
    expect(mergeAttachmentLocators([b], [a, a])).toEqual([a, b])
  })

  it("retains distinct transfer manifests for one blob without choosing a winner", () => {
    const first = locator("A", "transfer-a", "C")
    const second = locator("A", "transfer-b", "D")
    expect(mergeAttachmentLocators([first], [second])).toEqual([first, second])
  })

  it("sorts mixed-case IDs by ordinal value without locale-sensitive comparison", () => {
    const lower = locator("a", "transfer-a", "C")
    const upper = locator("A", "transfer-a", "C")
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("Locale comparison must not be used")
    })
    try {
      expect(parseAttachmentLocators([lower, upper])).toEqual([upper, lower])
    } finally {
      localeCompare.mockRestore()
    }
  })

  it.each([
    [{ version: 1, blobId: "https://example.test/file", transferId: "x", manifestId: "A".repeat(43) }],
    [{ version: 2, blobId: `sha256:${"A".repeat(43)}`, transferId: "x", manifestId: "A".repeat(43) }],
    [{ version: 1, blobId: `sha256:${"A".repeat(43)}`, transferId: "x", manifestId: "not-base64url" }],
    [{ version: 1, blobId: `sha256:${"A".repeat(43)}`, transferId: "bad id", manifestId: "A".repeat(43) }],
    [{ version: 1, blobId: `sha256:${"A".repeat(43)}`, transferId: "x", manifestId: "A".repeat(43), name: "private.pdf" }],
  ])("rejects malformed or extra locator fields: %j", value => {
    expect(() => parseAttachmentLocators(value)).toThrow()
  })

  it("rejects conflicting manifests for the same blob transfer and an oversized index", () => {
    const first = locator("A", "transfer-a", "C")
    const conflict = locator("A", "transfer-a", "D")
    expect(() => mergeAttachmentLocators([first], [conflict])).toThrow()
    expect(() => parseAttachmentLocators(Array.from({ length: 1025 }, (_, i) =>
      locator((i % 16).toString(16).toUpperCase(), `transfer-${i}`, "C")))).toThrow()
  })
})
