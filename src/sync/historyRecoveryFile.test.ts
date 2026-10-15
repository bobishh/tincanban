import { beforeEach, expect, it } from "vitest"
import { generateIdentityRecovery, identitySeedFromPrivateKey, sealIdentitySeed, toBase64Url } from "@meta-uber/mesh-identity"
import { bootstrapIdentity, canonicalizeJson, resetIdentityStorageForTest, sha256Base64Url } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault } from "../domain/proofs"
import { createIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { sealIdentityDeviceRecovery } from "./identityDeviceRecoveryCodec"
import { exportHistoryRecoveryArchive, type HistoryRecoveryRecord } from "./historyRecoveryArchive"
import { buildArchiveLocators } from "@meta-uber/mesh-replication/history-archive-locators"
import { sealArchiveObject, type EncryptedArchiveObject } from "@meta-uber/mesh-replication/history-archive-crypto"
import { createHistoryRecoveryFileWriter, openHistoryRecoveryFile } from "./historyRecoveryFile"

beforeEach(() => resetIdentityStorageForTest())

async function fixture() {
  const profile = await bootstrapIdentity("History backup owner")
  const words = generateIdentityRecovery("better")
  const seed = await identitySeedFromPrivateKey(profile.privateKeys.identityPrivateKey!, profile.identity.personId)
  const recovery = await sealIdentitySeed(seed, profile.identity.personId, words, "better")
  const transfer = await createIdentityDeviceTransfer(createPersonalRoot(profile, await certHashDefault(profile.certificate)), [profile.certificate])
  const identityRecovery = await sealIdentityDeviceRecovery(transfer, recovery, seed)
  const workspaceId = "workspace-history-backup"
  const scope = { scopeId: "history-scope", keyEpoch: 3, key: new Uint8Array(32).fill(41) }
  const objects = new Map<string, EncryptedArchiveObject>()
  const root = await buildArchiveLocators(scope, { workspaceId, historyEpoch: 2, indexId: "archive-locators" }, [], {
    ensureCurrent: () => {},
    write: async (binding, bytes) => {
      const sealed = await sealArchiveObject(scope, binding, bytes)
      objects.set(sealed.ciphertextId, sealed.object)
      return sealed
    },
  })
  const source = { id: "source", workspaceId, scope, roots: [root],
    signedJson: new Uint8Array(200 * 1024).fill(0x61), authorityEvidence: { retained: "evidence".repeat(30_000) } }
  const archiveRecords: HistoryRecoveryRecord[] = []
  const evidenceBytes = new TextEncoder().encode("private retained local bytes")
  async function* evidence() {
    yield { kind: "local-evidence-part" as const, category: "raw-tail", id: "tail-1", partIndex: 0, partCount: 2,
      data: toBase64Url(evidenceBytes.slice(0, 12)) }
    yield { kind: "local-evidence-part" as const, category: "raw-tail", id: "tail-1", partIndex: 1, partCount: 2,
      data: toBase64Url(evidenceBytes.slice(12)) }
  }
  const manifest = await exportHistoryRecoveryArchive(workspaceId, [source], {
    ensureCurrent: () => {}, write: async record => { archiveRecords.push(record) },
    download: async (_source, id) => objects.get(id),
    evidence: evidence(),
  })
  return { words, seed, identityRecovery, workspaceId, archiveRecords, manifest }
}

async function writeFile(f: Awaited<ReturnType<typeof fixture>>) {
  const writer = await createHistoryRecoveryFileWriter({ workspaceId: f.workspaceId,
    identityRecovery: f.identityRecovery, seed: new Uint8Array(f.seed) })
  for (const record of f.archiveRecords) await writer.write(record)
  return writer.finish()
}

it("Given an exported history archive, when writing and opening its private recovery file, then stream encrypted parts and verify the final transcript before returning records", async () => {
  const f = await fixture(), blob = await writeFile(f)
  const serialized = await blob.text()
  expect(blob.size).toBeLessThan(1024 * 1024)
  expect(serialized).not.toContain(f.words)
  expect(serialized).not.toContain(toBase64Url(new Uint8Array(32).fill(41)))
  expect(serialized).not.toContain("private retained local bytes")
  expect(serialized).not.toContain("retained".repeat(20))
  expect(serialized.split("\n").length).toBeGreaterThan(f.archiveRecords.length + 1)
  const opened = await openHistoryRecoveryFile(blob, f.words)
  expect(opened.header.workspaceId).toBe(f.workspaceId)
  expect(opened.transfer.manifest.personId).toBe(f.identityRecovery.personId)
  expect(opened.records).toEqual(f.archiveRecords)
  expect(opened.records.at(-1)).toEqual(f.manifest)
  expect(f.manifest.evidencePartCount).toBe(2)
  f.seed.fill(0)
})

it("Given encrypted history fragments, when words, bytes, final manifest or row ordering change, then reject before returning decrypted records", async () => {
  const f = await fixture(), blob = await writeFile(f), lines = (await blob.text()).trimEnd().split("\n")
  await expect(openHistoryRecoveryFile(blob, generateIdentityRecovery("better"))).rejects.toThrow()
  const changed = JSON.parse(lines[1]!) as Record<string, unknown>
  const object = changed.object as Record<string, unknown>
  const ciphertext = String(object.ciphertext)
  object.ciphertext = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`
  const tampered = new Blob([[lines[0]!, canonicalizeJson(changed), ...lines.slice(2), ""].join("\n")])
  await expect(openHistoryRecoveryFile(tampered, f.words)).rejects.toThrow(/authentication|integrity|transcript/i)
  await expect(openHistoryRecoveryFile(new Blob([lines.slice(0, -2).join("\n"), ""]), f.words)).rejects.toThrow(/manifest|truncated|incomplete/i)
  await expect(openHistoryRecoveryFile(new Blob([await blob.arrayBuffer(), "{}\n"]), f.words)).rejects.toThrow(/trailing|manifest|row/i)
  f.seed.fill(0)
})

it("Given a seed from another identity, when creating the stream writer, then reject before emitting a recovery header", async () => {
  const f = await fixture(), otherSeed = crypto.getRandomValues(new Uint8Array(32))
  await expect(createHistoryRecoveryFileWriter({ workspaceId: f.workspaceId,
    identityRecovery: f.identityRecovery, seed: otherSeed })).rejects.toThrow(/identity|root/i)
  f.seed.fill(0); otherSeed.fill(0)
})

it("Given an incomplete archive transcript, when finishing the file, then require the encrypted final manifest", async () => {
  const f = await fixture(), writer = await createHistoryRecoveryFileWriter({ workspaceId: f.workspaceId,
    identityRecovery: f.identityRecovery, seed: new Uint8Array(f.seed) })
  for (const record of f.archiveRecords.slice(0, -1)) await writer.write(record)
  await expect(writer.finish()).rejects.toThrow(/final manifest|completion/i)
  f.seed.fill(0)
})

it("Given attachment bytes absent from the recovery source, when authenticating the manifest, then require canonical missing IDs and incomplete coverage", async () => {
  const f = await fixture()
  const manifest = structuredClone(f.manifest) as typeof f.manifest & { missingAttachmentIds?: string[] }
  manifest.missingAttachmentIds = ["sha256:" + "A".repeat(43)]
  const writer = await createHistoryRecoveryFileWriter({ workspaceId: f.workspaceId,
    identityRecovery: f.identityRecovery, seed: new Uint8Array(f.seed) })
  for (const record of f.archiveRecords.slice(0, -1)) await writer.write(record)
  await expect(writer.write(manifest)).rejects.toThrow(/manifest|coverage/i)
  manifest.coverage = "incomplete"
  manifest.missingAttachmentIds = ["blake3:" + "b".repeat(64), "sha256:" + "A".repeat(43)]
  const accepted = await createHistoryRecoveryFileWriter({ workspaceId: f.workspaceId,
    identityRecovery: f.identityRecovery, seed: new Uint8Array(f.seed) })
  for (const record of f.archiveRecords.slice(0, -1)) await accepted.write(record)
  await accepted.write(manifest)
  const opened = await openHistoryRecoveryFile(await accepted.finish(), f.words)
  expect((opened.records.at(-1) as typeof manifest).missingAttachmentIds).toEqual(manifest.missingAttachmentIds)
  f.seed.fill(0)
})

it("Given retained archive sources from rotated key epochs, when writing and opening, then bind each ciphertext to an available epoch in its scope", async () => {
  const f = await fixture()
  const source = f.archiveRecords.find(record => record.kind === "archive-source")!
  const additional = { ...structuredClone(source), id: "older-epoch-source", keyEpoch: 2 }
  const records = [...f.archiveRecords.slice(0, -1), additional]
  let transcript = await sha256Base64Url(new TextEncoder().encode("tincanban/history-recovery/v1"))
  for (const record of records) {
    const rowDigest = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(record)))
    transcript = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson([transcript, rowDigest])))
  }
  const manifest = { ...f.manifest, sourceCount: f.manifest.sourceCount + 1, transcriptDigest: transcript }
  const writer = await createHistoryRecoveryFileWriter({ workspaceId: f.workspaceId,
    identityRecovery: f.identityRecovery, seed: new Uint8Array(f.seed) })
  for (const record of records) await writer.write(record)
  await writer.write(manifest)
  const opened = await openHistoryRecoveryFile(await writer.finish(), f.words)
  expect(opened.records).toContainEqual(additional)
  expect(opened.records.at(-1)).toEqual(manifest)
  f.seed.fill(0)
})

it("Given missing peer plaintext history, when writing and reopening the private file, then retain exact missing pairs and incomplete coverage", async () => {
  const f = await fixture()
  const pair = { baselineId: await sha256Base64Url(new TextEncoder().encode("peer-basis")),
    objectId: await sha256Base64Url(new TextEncoder().encode("peer-original")) }
  const manifest = { ...f.manifest, coverage: "incomplete" as const, missingPeerObjects: [pair] }
  const writer = await createHistoryRecoveryFileWriter({ workspaceId: f.workspaceId, identityRecovery: f.identityRecovery, seed: f.seed })
  for (const record of f.archiveRecords.slice(0, -1)) await writer.write(record)
  await writer.write(manifest)
  const opened = await openHistoryRecoveryFile(await writer.finish(), f.words)
  expect(opened.records.at(-1)).toEqual(manifest)
  f.seed.fill(0)
})

it("Given malformed, duplicate, unsorted or explicitly empty missing-peer coverage, when writing a manifest, then refuse its completion", async () => {
  const f = await fixture(), baselineId = "A".repeat(43)
  const lower = { baselineId, objectId: "A".repeat(43) }, upper = { baselineId, objectId: "E".repeat(43) }
  const invalid = [[], [lower, lower], [upper, lower], [{ baselineId, objectId: "invalid" }],
    [{ ...lower, extra: true }], Array(4097).fill(lower)]
  for (const missingPeerObjects of invalid) {
    const writer = await createHistoryRecoveryFileWriter({ workspaceId: f.workspaceId, identityRecovery: f.identityRecovery, seed: f.seed })
    for (const record of f.archiveRecords.slice(0, -1)) await writer.write(record)
    await expect(writer.write({ ...f.manifest, coverage: "incomplete", missingPeerObjects } as never)).rejects.toThrow(/peer|manifest|coverage/i)
  }
  const writer = await createHistoryRecoveryFileWriter({ workspaceId: f.workspaceId, identityRecovery: f.identityRecovery, seed: f.seed })
  for (const record of f.archiveRecords.slice(0, -1)) await writer.write(record)
  await expect(writer.write({ ...f.manifest, missingPeerObjects: [lower] })).rejects.toThrow(/manifest|coverage/i)
  f.seed.fill(0)
})
