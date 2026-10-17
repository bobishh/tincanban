import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { identitySeedFromPrivateKey } from "@meta-uber/mesh-identity"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, canonicalizeJson, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url } from "../domain/identity"
import { createWorkspaceDoc } from "../test/boardFixture"
import { createIdentityDeviceRecovery } from "../sync/identityDeviceRecovery"
import { exportHistoryRecoveryArchive, type HistoryRecoveryRecord } from "../sync/historyRecoveryArchive"
import { createHistoryRecoveryFileWriter } from "../sync/historyRecoveryFile"
import { inspectPrivateWorkspaceRecovery } from "./workspaceHistoryRecovery"

const encoder = new TextEncoder()
beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})
beforeEach(() => resetIdentityStorageForTest())

async function hash(value: unknown) { return sha256Base64Url(encoder.encode(canonicalizeJson(value))) }
async function* parts(category: string, id: string, bytes: Uint8Array) {
  const size = 256 * 1024, partCount = Math.max(1, Math.ceil(bytes.length / size))
  for (let partIndex = 0; partIndex < partCount; partIndex++) yield {
    kind: "local-evidence-part" as const, category, id, partIndex, partCount,
    data: toBase64Url(bytes.subarray(partIndex * size, (partIndex + 1) * size)),
  }
}

it("Given valid original signed workspace data, when inspecting an encrypted private backup, then return an authenticated Native-admitted preview", async () => {
  const profile = await bootstrapIdentity("Recovery integration owner")
  const workspaceId = crypto.randomUUID()
  const doc = Automerge.from(createWorkspaceDoc(workspaceId, "Original board", profile.identity.personId, "blank"))
  const raw = Automerge.save(doc)
  const owner = { personId: profile.identity.personId, publicKey: profile.identity.publicKey, certificates: [profile.certificate] }
  const authority = { genesisOwner: owner, currentOwner: owner, genesisEpoch: 1, currentEpoch: 1,
    ownershipTransfers: [], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] }
  const signed = await signEnvelope(profile.privateKeys.devicePrivateKey, { kind: "workspace-changes", version: 1,
    workspaceId, hashes: Automerge.getChangesMetaSince(doc, []).map(change => change.hash), personId: owner.personId,
    deviceId: profile.device.deviceId }, profile.device.deviceId)
  const authorization = { version: 1, authority, records: [{ signed, publicKey: owner.publicKey, certificates: owner.certificates,
    ownerPublicKey: owner.publicKey, ownerCertificates: owner.certificates }] }
  const snapshotId = await hash(["snapshots", workspaceId])
  const binaryId = await hash([snapshotId, ["bytes"]])
  const snapshotMetadata = { record: { id: workspaceId, workspaceId, title: "Untrusted title", bytes: null,
    heads: ["untrusted"], savedAt: "2026-10-15T00:00:00.000Z" }, binaryFields: [{ path: ["bytes"], id: binaryId, byteLength: raw.length }] }
  async function* evidence() {
    yield* parts("snapshots-metadata", snapshotId, encoder.encode(canonicalizeJson(snapshotMetadata)))
    yield* parts("snapshots-bytes", binaryId, raw)
    yield* parts("workspace-source", "raw", raw)
    yield* parts("workspace-control", "access", encoder.encode(canonicalizeJson({ authorization, authority: null, credential: null })))
  }
  const records: HistoryRecoveryRecord[] = []
  await exportHistoryRecoveryArchive(workspaceId, [], { ensureCurrent: () => {},
    write: async record => { records.push(record) }, download: async () => undefined, evidence: evidence() })
  const identity = await createIdentityDeviceRecovery("better")
  const seed = await identitySeedFromPrivateKey(profile.privateKeys.identityPrivateKey!, profile.identity.personId)
  try {
    const writer = await createHistoryRecoveryFileWriter({ workspaceId, identityRecovery: identity.file, seed })
    for (const record of records) await writer.write(record)
    const preview = await inspectPrivateWorkspaceRecovery(await writer.finish(), identity.recoveryKey)
    expect(preview).toEqual({ workspaceId, personId: profile.identity.personId, coverage: "complete", missingCount: 0 })
  } finally {
    seed.fill(0)
    Automerge.free(doc)
  }
})
