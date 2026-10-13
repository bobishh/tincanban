import { expect, it } from "vitest"
import { mergeAuthorizationRecords, putRecords, records, type WorkspaceChangeAuthorization } from "./workspaceChangeProofStore"

it("Given device certificates in enrollment order, When a proof is saved and reread, Then duplicate merging preserves its canonical representation", () => {
  const record = {
    signed: { signature: "same-proof" }, publicKey: "editor-key", ownerPublicKey: "owner-key",
    certificates: [{ signature: "z-device" }, { signature: "a-device" }],
    ownerCertificates: [{ signature: "z-owner" }, { signature: "a-owner" }],
  } as unknown as WorkspaceChangeAuthorization
  const first = mergeAuthorizationRecords([], [record])
  expect(mergeAuthorizationRecords(first, first)).toEqual(first)
  expect(record.certificates.map(cert => cert.signature)).toEqual(["z-device", "a-device"])
})

it("repairs a stored proof that predates owner authority fields when the proof is replayed", async () => {
  const workspaceId = `proof-repair-${crypto.randomUUID()}`
  const signed = { signature: "same-proof" }
  const legacy = {
    signed,
    publicKey: "editor-key",
    certificates: [{ signature: "editor-certificate" }],
  } as unknown as WorkspaceChangeAuthorization
  const complete = {
    ...legacy,
    ownerPublicKey: "owner-key",
    ownerCertificates: [{ signature: "owner-certificate" }],
  } as WorkspaceChangeAuthorization

  await putRecords(workspaceId, [legacy])
  await expect(putRecords(workspaceId, [complete])).resolves.toBe(true)
  expect(await records(workspaceId)).toEqual([complete])
})

it("retains distinct signed grant provenance variants for one change proof", async () => {
  const workspaceId = `proof-grant-variants-${crypto.randomUUID()}`
  const shared = {
    signed: { signature: "same-proof" },
    publicKey: "editor-key",
    certificates: [{ signature: "editor-certificate" }],
    ownerPublicKey: "owner-key",
    ownerCertificates: [{ signature: "owner-certificate" }],
  }
  const original = { ...shared, grant: { signature: "old-grant" } } as unknown as WorkspaceChangeAuthorization
  const later = { ...shared, grant: { signature: "new-grant" } } as unknown as WorkspaceChangeAuthorization

  await putRecords(workspaceId, [original])
  await putRecords(workspaceId, [later])

  expect((await records(workspaceId)).map(record => record.grant?.signature).sort()).toEqual(["new-grant", "old-grant"])
})
