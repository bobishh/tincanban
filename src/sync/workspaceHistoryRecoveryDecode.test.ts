import { expect, it } from "vitest"
import { createBlobDescriptorFromId, verifyBlobBytes } from "@meta-uber/mesh-blob"
import { canonicalizeJson, fromBase64Url, sha256Base64Url, toBase64Url } from "../domain/identity"
import type { HistoryRecoveryEvidencePart, HistoryRecoveryRecord } from "./historyRecoveryArchive"
import { decodeWorkspaceRecoveryEvidence } from "./workspaceHistoryRecoveryDecode"

const encoder = new TextEncoder(), workspaceId = "decode-recovery-workspace"
const decoder = new TextDecoder("utf-8", { fatal: true })
const hashJson = async (value: unknown) => sha256Base64Url(encoder.encode(canonicalizeJson(value)))
function evidence(category: string, id: string, input: Uint8Array, size = 256 * 1024): HistoryRecoveryEvidencePart[] {
  const partCount = Math.max(1, Math.ceil(input.length / size))
  return Array.from({ length: partCount }, (_, partIndex) => ({ kind: "local-evidence-part" as const, category, id,
    partIndex, partCount, data: toBase64Url(input.subarray(partIndex * size, (partIndex + 1) * size)) }))
}
async function storedRow(store: string, row: Record<string, unknown>, binaryFields: Array<{ path: string[]; bytes: Uint8Array }> = []) {
  const rowHash = await hashJson([store, row.id])
  const fields = await Promise.all(binaryFields.map(async field => ({ path: field.path,
    id: await hashJson([rowHash, field.path]), byteLength: field.bytes.length, bytes: field.bytes })))
  const metadata = { record: row, binaryFields: fields.map(({ path, id, byteLength }) => ({ path, id, byteLength })) }
  const metadataParts = evidence(`${store}-metadata`, rowHash, encoder.encode(canonicalizeJson(metadata)))
  const binaryParts = fields.flatMap(field => evidence(`${store}-bytes`, field.id, field.bytes))
  return [...binaryParts, ...metadataParts]
}

it("Given an exact received baseline source and peer archive bytes, when decoding recovery evidence, then retain only bytes bound to that original baseline", async () => {
  const baselineId = "B".repeat(43)
  const signedJson = encoder.encode(canonicalizeJson({ payload: { baselineId, workspaceId }, signerKeyId: "device", signature: "sig" }))
  const source = encoder.encode(canonicalizeJson({ version: 1, workspaceId, baselineId, signedJson: toBase64Url(signedJson) }))
  const object = encoder.encode("opaque peer archive object")
  const objectId = await sha256Base64Url(object)
  const row = { id: `${workspaceId}:baseline:${baselineId}`, workspaceId, baselineId, signedJson: null }
  const records = [
    ...await storedRow("receivedBaselines", row, [{ path: ["signedJson"], bytes: signedJson }]),
    ...evidence("peer-history-source", baselineId, source),
    ...evidence("peer-history-object", `${baselineId}:${objectId}`, object),
  ]
  const decoded = await decodeWorkspaceRecoveryEvidence(records, workspaceId)
  expect(decoded.auxiliary.get(`peer-history-source/${baselineId}`)).toEqual({ version: 1, workspaceId, baselineId,
    signedJson: toBase64Url(signedJson) })
  expect(decoded.auxiliary.get(`peer-history-object/${baselineId}:${objectId}`)).toEqual(object)
})

it("Given a staged compact baseline without its cached baselineId field, when decoding its exact peer source evidence, then bind by staged row identity and the original signed routing", async () => {
  const baselineId = "E".repeat(43)
  const signedJson = encoder.encode(canonicalizeJson({ payload: { baselineId, workspaceId }, signerKeyId: "device", signature: "original" }))
  const source = encoder.encode(canonicalizeJson({ version: 1, workspaceId, baselineId, signedJson: toBase64Url(signedJson) }))
  const staged = { id: `${workspaceId}:staged:receive-1`, workspaceId, state: "staged", signedJson: null }
  const records = [...await storedRow("receivedBaselines", staged, [{ path: ["signedJson"], bytes: signedJson }]),
    ...evidence("peer-history-source", baselineId, source)]

  const decoded = await decodeWorkspaceRecoveryEvidence(records, workspaceId)
  expect(decoded.journal.receivedBaselines[0]?.value).toMatchObject({ id: staged.id, state: "staged", workspaceId })
  expect(decoded.auxiliary.get(`peer-history-source/${baselineId}`)).toMatchObject({ baselineId, signedJson: toBase64Url(signedJson) })

  const mismatched = { ...staged, baselineId: "F".repeat(43) }
  const mismatchedRecords = [...await storedRow("receivedBaselines", mismatched, [{ path: ["signedJson"], bytes: signedJson }]),
    ...evidence("peer-history-source", baselineId, source)]
  await expect(decodeWorkspaceRecoveryEvidence(mismatchedRecords, workspaceId)).rejects.toThrow(/exact saved baseline signature/i)
})

it("Given peer history bytes without their exact received baseline source, when decoding, then reject orphans and mismatched original signatures", async () => {
  const baselineId = "C".repeat(43), objectId = "D".repeat(43)
  const signedJson = encoder.encode(canonicalizeJson({ payload: { baselineId, workspaceId }, signerKeyId: "device", signature: "sig" }))
  const object = encoder.encode("opaque peer archive object")
  const objectParts = evidence("peer-history-object", `${baselineId}:${objectId}`, object)
  await expect(decodeWorkspaceRecoveryEvidence(objectParts, workspaceId)).rejects.toThrow(/source|orphan/i)
  const changedSource = encoder.encode(canonicalizeJson({ version: 1, workspaceId, baselineId,
    signedJson: toBase64Url(encoder.encode("different original signature")) }))
  const row = { id: `${workspaceId}:baseline:${baselineId}`, workspaceId, baselineId, signedJson: null }
  const records = [...await storedRow("receivedBaselines", row, [{ path: ["signedJson"], bytes: signedJson }]),
    ...evidence("peer-history-source", baselineId, changedSource), ...objectParts]
  await expect(decodeWorkspaceRecoveryEvidence(records, workspaceId)).rejects.toThrow(/original|baseline|signature/i)
})

it("Given an exact local snapshot row and binary parts, when decoding recovery evidence, then restore typed bytes with the physical journal key", async () => {
  const bytes = new Uint8Array(300_000).fill(37), row = { id: workspaceId, workspaceId, title: "Saved", payload: null }
  const records = await storedRow("snapshots", row, [{ path: ["payload"], bytes }])
  const decoded = await decodeWorkspaceRecoveryEvidence(records, workspaceId)
  expect(decoded.journal.snapshots).toEqual([{ id: workspaceId, value: { ...row, payload: bytes } }])
  expect(decoded.auxiliary.size).toBe(0)
  expect(decoded.attachments).toEqual([])
})

it("Given partitioned original history, when decoding a private backup, then retain archive bytes and original authorization records outside the active tail", async () => {
  const bytes = new Uint8Array([8, 9, 10]), changeId = `${workspaceId}:original-hash`
  const change = { id: changeId, workspaceId, changeHash: "original-hash", archivedUnderBaselineId: "original-basis", bytes: null }
  const proof = { id: `${workspaceId}:basis-proofs`, workspaceId, baselineId: "original-basis",
    records: [{ signed: { payload: { hashes: ["original-hash"] }, signature: "exact-original-signature" } }] }
  const records = [...await storedRow("archivedChanges", change, [{ path: ["bytes"], bytes }]),
    ...await storedRow("archivedAuthorizations", proof)]
  const decoded = await decodeWorkspaceRecoveryEvidence(records, workspaceId)
  expect(decoded.journal.archivedChanges).toEqual([{ id: changeId, value: { ...change, bytes } }])
  expect(decoded.journal.archivedAuthorizations).toEqual([{ id: proof.id, value: proof }])
  expect(decoded.journal.changes).toEqual([])
  expect(decoded.journal.authorizations).toEqual([])
  await expect(decodeWorkspaceRecoveryEvidence(records, "other-board")).rejects.toThrow(/workspace/i)
})

it("Given nested metadata paths containing prototype-special property names, when restoring bytes, then create own data properties without invoking prototype setters", async () => {
  const nested = JSON.parse('{"id":"special-row","workspaceId":"decode-recovery-workspace","value":{"__proto__":null}}') as Record<string, unknown>
  const payload = crypto.getRandomValues(new Uint8Array(3)), records = await storedRow("snapshots", nested,
    [{ path: ["value", "__proto__"], bytes: payload }])
  const decoded = await decodeWorkspaceRecoveryEvidence(records, workspaceId)
  const value = decoded.journal.snapshots[0]!.value as { value: Record<string, unknown> }
  expect(Object.getPrototypeOf(value.value)).toBe(Object.prototype)
  expect(Object.hasOwn(value.value, "__proto__")).toBe(true)
  expect(value.value["__proto__"]).toEqual(payload)
})

it("Given duplicate, overlapping, missing, or mis-sized binary references, when decoding journal metadata, then reject the malformed recovery evidence", async () => {
  const row = { id: workspaceId, workspaceId, outer: null }
  const firstBytes = crypto.getRandomValues(new Uint8Array(8)), secondBytes = crypto.getRandomValues(new Uint8Array(4))
  const rowHash = await hashJson(["snapshots", row.id]), outerId = await hashJson([rowHash, ["outer"]])
  const metadata = { record: row, binaryFields: [{ path: ["outer"], id: outerId, byteLength: 8 },
    { path: ["outer", "nested"], id: await hashJson([rowHash, ["outer", "nested"]]), byteLength: 4 }] }
  const metadataParts = evidence("snapshots-metadata", rowHash, encoder.encode(canonicalizeJson(metadata)))
  const binaryParts = evidence("snapshots-bytes", outerId, firstBytes).concat(evidence("snapshots-bytes", metadata.binaryFields[1]!.id, secondBytes))
  await expect(decodeWorkspaceRecoveryEvidence([...binaryParts, ...metadataParts], workspaceId)).rejects.toThrow(/overlap|placeholder|path/i)

  const valid = await storedRow("snapshots", row, [{ path: ["outer"], bytes: firstBytes }])
  const badMetadata = JSON.parse(decoder.decode(fromBase64Url(valid.find(part => part.category === "snapshots-metadata")!.data))) as { record: unknown; binaryFields: Array<{ path: string[]; id: string; byteLength: number }> }
  badMetadata.binaryFields[0]!.byteLength++
  const hash = await hashJson(["snapshots", row.id])
  const altered = [...valid.filter(part => part.category !== "snapshots-metadata"),
    ...evidence("snapshots-metadata", hash, encoder.encode(canonicalizeJson(badMetadata)))]
  await expect(decodeWorkspaceRecoveryEvidence(altered, workspaceId)).rejects.toThrow(/length|binary|integrity/i)
  await expect(decodeWorkspaceRecoveryEvidence(valid.filter(part => part.category !== "snapshots-bytes"), workspaceId)).rejects.toThrow(/missing|binary|part/i)
})

it("Given metadata row IDs and evidence categories bound to another workspace or malformed category, when decoding, then fail before returning records", async () => {
  const row = { id: workspaceId, workspaceId, title: "Saved" }, valid = await storedRow("snapshots", row)
  await expect(decodeWorkspaceRecoveryEvidence(valid, "other-workspace")).rejects.toThrow(/workspace/i)
  await expect(decodeWorkspaceRecoveryEvidence([{ ...valid[0]!, category: "unknown-store-metadata" }], workspaceId)).rejects.toThrow(/category|metadata/i)
  const bad = structuredClone(valid)
  bad[0]!.id = "A".repeat(43)
  await expect(decodeWorkspaceRecoveryEvidence(bad, workspaceId)).rejects.toThrow(/id|metadata|evidence|binding/i)
})

it("Given private attachment metadata and bytes, when decoding, then verify blob identity before returning attachments", async () => {
  const bytes = encoder.encode("restored attachment bytes")
  const blobId = `sha256:${await sha256Base64Url(bytes)}`
  const descriptor = createBlobDescriptorFromId(blobId, bytes.length, "notes.txt", "text/plain")
  const metadata = evidence("attachment-metadata", blobId, encoder.encode(canonicalizeJson({ descriptor })))
  const data = evidence("attachment-bytes", blobId, bytes)
  const decoded = await decodeWorkspaceRecoveryEvidence([...metadata, ...data], workspaceId)
  expect(decoded.attachments).toHaveLength(1)
  await expect(verifyBlobBytes(descriptor, decoded.attachments[0]!.bytes)).resolves.toEqual(bytes)
  const changed = new Uint8Array(decoded.attachments[0]!.bytes); changed[0] ^= 1
  await expect(verifyBlobBytes(descriptor, changed)).rejects.toThrow(/content|hash/i)
})

it("Given auxiliary private state, when decoding, then keep it detached from journal writes and reject inconsistent fragment order", async () => {
  const value = { authority: { personId: "owner" }, credential: null, authorization: { signed: true } }
  const id = "access", parts = evidence("workspace-control", id, encoder.encode(canonicalizeJson(value)), 5)
  const decoded = await decodeWorkspaceRecoveryEvidence(parts as HistoryRecoveryRecord[], workspaceId)
  expect(decoded.auxiliary.get(`workspace-control/${id}`)).toEqual(value)
  const outOfOrder = [...parts].reverse()
  await expect(decodeWorkspaceRecoveryEvidence(outOfOrder as HistoryRecoveryRecord[], workspaceId)).rejects.toThrow(/order|fragment|part/i)
})

it("Given workspace-source evidence, when decoding, then return exact source bytes as auxiliary data", async () => {
  const bytes = crypto.getRandomValues(new Uint8Array([19]))
  const parts = evidence("workspace-source", "raw", bytes)
  const decoded = await decodeWorkspaceRecoveryEvidence(parts as HistoryRecoveryRecord[], workspaceId)
  expect(decoded.auxiliary.get("workspace-source/raw")).toEqual(bytes)
  expect(decoded.journal.snapshots).toEqual([])
})
