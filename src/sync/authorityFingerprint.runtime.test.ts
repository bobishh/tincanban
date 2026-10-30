import { expect, it } from "vitest"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { workspaceAuthorityFingerprint } from "./authorityFingerprint"
import type { WorkspaceMeshCredential } from "./peerStore"

it("Given unchanged workspace rights, when Native merges an empty authority batch, then retain the authorization fingerprint", async () => {
  resetIdentityStorageForTest()
  const owner = await bootstrapIdentity()
  const credential: WorkspaceMeshCredential = { version: 1, workspaceId: "empty-authority-refresh",
    ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], transportSecret: "fixture-secret", epoch: 1,
    updatedAt: new Date().toISOString() }
  const plan = meshRustRuntime().state.planAuthorityMerge({ credential, peers: [],
    localPersonId: owner.identity.personId, localDeviceId: owner.device.deviceId, nowMs: Date.now(),
    records: { kind: "departures", records: [] } }) as { credential: WorkspaceMeshCredential }
  expect(workspaceAuthorityFingerprint([plan.credential], [])).toBe(workspaceAuthorityFingerprint([credential], []))
})
