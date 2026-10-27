import { zlibSync, unzlibSync } from "fflate"
import { fromBase64Url, toBase64Url } from "../domain/identity"

/** Bound inflated bytes as well as the transport frame; retain signed JSON exactly. */
export function packWorkspaceRoutes<T extends { personId: string }>(value: T, maximumBytes: number): Record<string, unknown> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  if (bytes.length > maximumBytes) throw new Error("Workspace route recovery exceeds size limit")
  return { personId: value.personId, uncompressedBytes: bytes.length, packed: toBase64Url(zlibSync(bytes)) }
}

export function unpackWorkspaceRoutes(personId: string, value: Record<string, unknown>, maximumBytes: number): unknown {
  const { uncompressedBytes, packed } = value
  if (value.personId !== personId || !Number.isSafeInteger(uncompressedBytes) ||
      (uncompressedBytes as number) < 1 || (uncompressedBytes as number) > maximumBytes ||
      typeof packed !== "string" || packed.length > Math.ceil(maximumBytes * 4 / 3) + 1024 ||
      Object.keys(value).some(key => !["personId", "uncompressedBytes", "packed"].includes(key))) {
    throw new Error("Invalid packed workspace route recovery")
  }
  const size = uncompressedBytes as number
  // One extra byte detects truncated declarations without allowing an unbounded allocation.
  const bytes = unzlibSync(fromBase64Url(packed), { out: new Uint8Array(size + 1) })
  if (bytes.length !== size) throw new Error("Packed workspace route recovery size mismatch")
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
}
