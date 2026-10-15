import { expect, it } from "vitest"
import { attachmentTextPreview } from "./attachmentTextPreview"

it("Given a large unbroken text file, when previewed, then bound rendered text while preserving complete download bytes", () => {
  const bytes = new TextEncoder().encode("File heading\n" + "Z".repeat(384 * 1024))
  const before = bytes.slice()
  const preview = attachmentTextPreview(bytes)
  expect(preview.truncated).toBe(true)
  expect(preview.text).toHaveLength(32 * 1024)
  expect(preview.text.startsWith("File heading\n")).toBe(true)
  expect(bytes).toEqual(before)
})

it("Given a multibyte character crossing the preview boundary, when truncated, then omit the incomplete character", () => {
  const preview = attachmentTextPreview(new TextEncoder().encode("A".repeat(32 * 1024 - 1) + "🐻"))
  expect(preview.truncated).toBe(true)
  expect(preview.text).toBe("A".repeat(32 * 1024 - 1))
  expect(preview.text).not.toContain("�")
})

it("Given a small file, when previewed, then display all text without a truncation notice", () => {
  expect(attachmentTextPreview(new TextEncoder().encode("Complete 🐻"))).toEqual({ text: "Complete 🐻", truncated: false })
})
