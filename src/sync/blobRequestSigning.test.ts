import { beforeEach, expect, it } from "vitest"
import { createBlobRequest, verifyBlobRequest } from "@meta-uber/mesh-blob"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { blobRequestSigning } from "./blobRequestSigning"

beforeEach(() => resetIdentityStorageForTest())

it("Given an authorized exact attachment, when signing a peer request, then use the verified device and original wire format", async () => {
  const profile = await bootstrapIdentity("Reader")
  const blobId = `sha256:${"A".repeat(43)}`
  const signing = await blobRequestSigning(profile, "workspace", blobId, async () => "member-and-reference")
  const request = await createBlobRequest(profile, "workspace", blobId, 0, 32, Date.now(), signing)
  expect(await verifyBlobRequest(request, profile.identity, [profile.certificate], "workspace")).toEqual(request)
  await expect(createBlobRequest(profile, "workspace", `sha256:${"B".repeat(43)}`, 0, 32, Date.now(), signing))
    .rejects.toThrow(/binding|attachment/i)
})

it("Given a prepared blob signer, when its transfer generation or member authority changes, then reject before a request escapes", async () => {
  const profile = await bootstrapIdentity("Reader")
  const blobId = `sha256:${"A".repeat(43)}`
  let revision = "session-1"
  const signing = await blobRequestSigning(profile, "workspace", blobId, async () => revision)
  revision = "session-2"
  await expect(createBlobRequest(profile, "workspace", blobId, 0, 32, Date.now(), signing)).rejects.toThrow(/changed|stale/i)
})

it("Given a different private key under unchanged public metadata, when preparing a blob signer, then fail closed", async () => {
  const profile = await bootstrapIdentity("Reader")
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  await expect(blobRequestSigning({ ...profile, privateKeys: { devicePrivateKey: pair.privateKey } },
    "workspace", `sha256:${"A".repeat(43)}`, async () => "member")).rejects.toThrow(/key|profile|signer/i)
})
