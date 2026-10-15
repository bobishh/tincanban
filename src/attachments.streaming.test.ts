import { IDBFactory } from "fake-indexeddb"
import { afterEach, expect, it, vi } from "vitest"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it("Given a selected file, when attached, then hash and persist bounded slices without reading the whole File buffer", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.resetModules()
  const { storeAttachment, readAttachment } = await import("./attachments")
  const bytes = new Uint8Array(256 * 1024 + 17).fill(31)
  const file = new File([bytes], "streamed.txt", { type: "text/plain" })
  const whole = vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("Whole file read forbidden"))
  const slices = vi.spyOn(file, "slice")
  const reference = await storeAttachment(file)
  expect(reference).toMatchObject({ type: "blob", fileName: "streamed.txt", byteLength: bytes.length })
  expect(whole).not.toHaveBeenCalled()
  expect(slices).toHaveBeenCalledTimes(4)
  expect(slices.mock.calls.every(([start, end]) => (end ?? 0) - (start ?? 0) <= 256 * 1024)).toBe(true)
  expect(await readAttachment(reference)).toEqual(bytes)
})
