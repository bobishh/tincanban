/** Compare JSON payloads without serializing or hashing historical proof arrays. */
import type { IncomingAuthorizationBundle, WorkspaceAdmissionResult } from "./product-replica/workspaceAdmission"
export function equalIncomingPacket(left: { bytes: Uint8Array; authorization: unknown }, right: { bytes: Uint8Array; authorization: unknown }) {
  return right.bytes.buffer instanceof ArrayBuffer && left.bytes.length === right.bytes.length &&
    left.bytes.every((byte, index) => byte === right.bytes[index]) && equalJson(left.authorization, right.authorization)
}

/** Unknown hashes or discarded proof variants must be checked again when local history grows. */
export function fullyVerifiedIncomingInput(raw: unknown, admission: WorkspaceAdmissionResult) {
  if (!admission.decisions || admission.decisions.some(decision => decision.status.type !== "admitted")) return false
  const bundle = raw as IncomingAuthorizationBundle
  const records = bundle.version === 1 ? bundle.records : bundle.pages.flat()
  const admitted = new Set(admission.admittedHashes)
  return records.every(record => {
    const proof = record as { signed: { payload: { hashes: string[] } } }
    return proof.signed.payload.hashes.every(hash => admitted.has(hash)) &&
      admission.verifiedAuthorizations.some(verified => equalJson({ ...(record as object), grant: (record as { grant?: unknown }).grant ?? null }, verified))
  })
}

function equalJson(left: unknown, right: unknown, signed = false, key = ""): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left)) return equalArray(left as unknown[], right, signed, key)
  if (!plainObject(left) || !plainObject(right)) return false
  const keys = Object.keys(left)
  const envelope = signed || (Object.hasOwn(left, "signature") && Object.hasOwn(left, "payload"))
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equalJson(left[key], right[key], envelope, key))
}

function equalArray(left: unknown[], right: unknown, signed: boolean, key: string) {
  if (!Array.isArray(right) || left.length !== right.length) return false
  const values: unknown[] = right
  if (signed || (key !== "certificates" && key !== "ownerCertificates"))
    return left.every((value, index) => equalJson(value, values[index], signed))
  const used = new Set<number>()
  return left.every(value => {
    const index = values.findIndex((candidate, index) => !used.has(index) && equalJson(value, candidate))
    if (index < 0) return false
    used.add(index)
    return true
  })
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}
